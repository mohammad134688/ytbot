// Telegram YouTube Downloader — Cloudflare Worker
// Free tier: no card required. Bot logic + inline menus + KV job queue.
// The actual download runs on a RESIDENTIAL/mobile IP listener (phone/Termux),
// because YouTube bot-checks datacenter IPs (403 on byte download).
//
// Flow:
//   /start -> send link -> quality menu -> codec menu -> probe (size+codecs)
//   -> confirm -> enqueue job -> listener downloads -> progress -> final path

const WEBHOOK_PATH = '/webhook';

// ---------- HTTP helpers ----------
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function send(chat_id, text, reply_markup = null, env, parse_mode = null) {
  const body = { chat_id, text };
  if (parse_mode) body.parse_mode = parse_mode;
  if (reply_markup) body.reply_markup = reply_markup;
  return tg(env, 'sendMessage', body);
}

async function edit(chat_id, msg_id, text, reply_markup = null, env, parse_mode = null) {
  const body = { chat_id, message_id: msg_id, text };
  if (parse_mode) body.parse_mode = parse_mode;
  if (reply_markup) body.reply_markup = reply_markup;
  return tg(env, 'editMessageText', body);
}

function kb(buttons) {
  // buttons: array of arrays of {text, cb}
  return { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.cb }))) };
}

// ---------- Session (KV-backed, stateless-worker safe) ----------
async function getSession(env, chat_id) {
  const raw = await env.STATE.get(`sess_${chat_id}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function setSession(env, chat_id, s) {
  await env.STATE.put(`sess_${chat_id}`, JSON.stringify(s), { expirationTtl: 600 });
}
async function delSession(env, chat_id) {
  await env.STATE.delete(`sess_${chat_id}`);
}

// ---------- Job queue ----------
function jobKey(id) { return `job_${id}`; }
async function enqueue(env, job) {
  const id = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
  await env.STATE.put(jobKey(id), JSON.stringify({ ...job, id, created: Date.now() }), { expirationTtl: 3600 });
  return id;
}
// GET /jobs/next — returns oldest job JSON and DELETES it (only one listener gets it)
async function nextJob(env) {
  const { keys } = await env.STATE.list({ prefix: 'job_', limit: 10 });
  if (!keys.length) return null;
  // oldest first
  keys.sort((a, b) => a.name.localeCompare(b.name));
  const k = keys[0].name;
  const raw = await env.STATE.get(k);
  if (!raw) return null;
  await env.STATE.delete(k);
  try { return JSON.parse(raw); } catch { return null; }
}

// ---------- YouTube URL parse ----------
function parseVideoId(text) {
  const m = text.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/))([\w-]{11})/);
  return m ? m[1] : null;
}

const CODEC_MENU = [
  [{ text: 'AV1 (سبک‌تر)', cb: 'codec:av01' }, { text: 'VP9', cb: 'codec:vp9' }, { text: 'H.264 (سازگار)', cb: 'codec:avc1' }],
];
const QUALITY_MENU = [
  [{ text: '360p', cb: 'q:360' }, { text: '480p', cb: 'q:480' }, { text: '720p', cb: 'q:720' }],
  [{ text: '1080p', cb: 'q:1080' }, { text: 'فقط صدا 🎵', cb: 'q:audio' }],
];

async function handleStart(env, chat_id) {
  await delSession(env, chat_id);
  return send(env, chat_id ? chat_id : null,
    '📥 ربات دانلودر یوتیوب\n\nیه لینک ویدیو بفرست تا کیفیت و فرمت رو انتخاب کنی.\n\n' +
    '⚠️ دانلود روی دستگاه مسکونی/موبایل انجام میشه (برای دور زدن بات‌چک یوتیوب).',
    null, env);
}

async function handleMessage(env, msg) {
  const chat_id = msg.chat.id;
  const text = (msg.text || '').trim();

  if (text === '/start' || text === '/help') {
    return handleStart(env, chat_id);
  }

  const vid = parseVideoId(text);
  if (!vid) {
    return send(chat_id, '❌ لینک یوتیوب معتبر نیست. مثال:\nhttps://youtu.be/VIDEO_ID', null, env);
  }

  const s = { step: 'quality', video_id: vid, url: text };
  await setSession(env, chat_id, s);
  return send(chat_id, '🎬 ویدیو شناسایی شد. کیفیت رو انتخاب کن:', kb(QUALITY_MENU), env);
}

async function handleCallback(env, cb) {
  const data = cb.data;
  const chat_id = cb.message.chat.id;
  const msg_id = cb.message.message_id;
  let s = await getSession(env, chat_id);
  if (!s || (s.step !== 'quality' && s.step !== 'codec' && s.step !== 'confirm')) {
    return tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'جلسه منقضی شده. دوباره /start کن.', show_alert: true });
  }

  // Quality chosen
  if (data.startsWith('q:')) {
    const q = data.slice(2);
    s.quality = q;
    s.step = 'codec';
    await setSession(env, chat_id, s);
    if (q === 'audio') {
      // skip codec for audio
      s.step = 'confirm';
      s.codec = null;
      await setSession(env, chat_id, s);
      return askConfirm(env, chat_id, msg_id, s);
    }
    return edit(chat_id, msg_id, `✅ کیفیت: ${q}p\nحالا کدک (فرمت فشرده‌سازی) رو انتخاب کن:`, kb(CODEC_MENU), env);
  }

  // Codec chosen
  if (data.startsWith('codec:')) {
    s.codec = data.slice(6);
    s.step = 'confirm';
    await setSession(env, chat_id, s);
    return askConfirm(env, chat_id, msg_id, s);
  }

  // Confirm
  if (data === 'go') {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
    const id = await enqueue(env, { chat_id, video_id: s.video_id, url: s.url, quality: s.quality, codec: s.codec });
    s.job_id = id;
    s.step = 'queued';
    await setSession(env, chat_id, s);
    return edit(chat_id, msg_id, '⏳ درخواست ثبت شد. منتظر دستگاه دانلودر...', null, env);
  }

  if (data === 'cancel') {
    await delSession(env, chat_id);
    return edit(chat_id, msg_id, '❌ لغو شد.', null, env);
  }

  return tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
}

async function askConfirm(env, chat_id, msg_id, s) {
  const codecTxt = s.codec ? s.codec.toUpperCase() : 'صدا';
  const txt = `📋 خلاصه دانلود:\n• کیفیت: ${s.quality === 'audio' ? 'فقط صدا' : s.quality + 'p'}\n• کدک: ${codecTxt}\n\nشروع کنم؟`;
  const menu = kb([[{ text: '✅ شروع دانلود', cb: 'go' }, { text: '❌ لغو', cb: 'cancel' }]]);
  return edit(chat_id, msg_id, txt, menu, env);
}

// ---------- Listener -> Worker callbacks ----------
async function handleProgress(env, body) {
  const chat_id = body.chat_id;
  // Find the latest confirm/menu message we can edit is hard; just send a new text msg with progress.
  if (body.phase === 'dl') {
    // throttle handled by listener, just relay
    return send(chat_id, `⬇️ دانلود: ${body.msg}`, null, env);
  }
  if (body.phase === 'merge') {
    return send(chat_id, `🔀 ${body.msg || 'در حال ادغام صدا و تصویر...'}`, null, env);
  }
  if (body.phase === 'done') {
    await delSession(env, chat_id);
    return send(chat_id, `✅ ذخیره شد:\n${body.path}`, null, env);
  }
  if (body.phase === 'error') {
    await delSession(env, chat_id);
    const tail = body.log ? `\n\n📄 آخرین خط لاگ:\n${body.log}` : '';
    return send(chat_id, `❌ دانلود شکست خورد:\n${body.error || 'خطای ناشناخته'}${tail}`, null, env);
  }
  return { ok: true };
}

// ---------- Router ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Telegram webhook
    if (url.pathname === WEBHOOK_PATH && request.method === 'POST') {
      let update;
      try { update = await request.json(); } catch { return new Response('bad json', { status: 400 }); }

      // answer quickly, process async
      const wait = (async () => {
        try {
          if (update.message) await handleMessage(env, update.message);
          else if (update.callback_query) await handleCallback(env, update.callback_query);
        } catch (e) {
          console.error('handler error', e);
        }
      })();
      // Do not block response on Telegram's 10s limit — but Workers allow async.
      // We await here for simplicity; if slow, wrap in waitUntil via ctx.
      await wait;
      return new Response('ok');
    }

    // Listener auth check
    const auth = request.headers.get('X-Worker-Secret');
    if (auth !== env.WORKER_SECRET) {
      return new Response('unauthorized', { status: 401 });
    }

    // GET /jobs/next  (consumes job)
    if (url.pathname === '/jobs/next' && request.method === 'GET') {
      const job = await nextJob(env);
      if (!job) return new Response('null');
      return new Response(JSON.stringify(job), { headers: { 'Content-Type': 'application/json' } });
    }

    // POST /jobs/progress (listener -> user)
    if (url.pathname === '/jobs/progress' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return new Response('bad json', { status: 400 }); }
      await handleProgress(env, body);
      return new Response('ok');
    }

    // POST /jobs/done
    if (url.pathname === '/jobs/done' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return new Response('bad json', { status: 400 }); }
      await handleProgress(env, body);
      return new Response('ok');
    }

    return new Response('YT Bot Worker', { status: 200 });
  },
};

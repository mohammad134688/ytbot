# YouTube Downloader Bot — Deploy Guide

Architecture:

```
Telegram ──webhook──▶ Cloudflare Worker (bot + menus + KV job queue)
                              │ job → KV (consumed on GET /jobs/next)
                              ▼ (listener polls every ~5s)
        Listener on RESIDENTIAL/MOBILE IP (phone/Termux):
          yt-dlp → save to local disk (NO re-upload to Telegram)
                              │ POST /jobs/progress, /jobs/done
                              ▼
                  Worker ──text message──▶ Telegram (status + final path)
```

Why a residential IP listener: YouTube bot-checks datacenter IPs — `yt-dlp -F`
and `--simulate` succeed, but the actual byte download fails with `403 Forbidden`.
Running the listener on your phone (mobile IP) avoids this. No cloud upload needed.

## 1. Cloudflare Worker (free, no card)
1. Install wrangler: `npm i -g wrangler` (or `npx wrangler`).
2. `wrangler login`.
3. Create KV: `wrangler kv namespace create STATE` → copy the id.
4. Edit `worker/wrangler.toml`:
   - paste KV id
   - `TELEGRAM_BOT_TOKEN` from @BotFather
   - `WORKER_SECRET` = `openssl rand -hex 16`
5. `cd worker && wrangler deploy`.
6. Set Telegram webhook:
   ```
   curl -F "url=https://<your-sub>.workers.dev/webhook" https://api.telegram.org/bot<TOKEN>/setWebhook
   ```

## 2. Listener (on your phone / home machine)
1. `pkg install ffmpeg python` (Termux) or `apt install ffmpeg`.
2. `pip install -U yt-dlp requests`.
3. Edit `listener/start.sh`: set `WORKER_URL`, `WORKER_SECRET` (same as wrangler.toml), `DOWNLOAD_DIR`.
   - Optional: export cookies.txt from THIS device's browser → set `COOKIES_FILE` (helps dodge stricter bot-checks).
4. `bash listener/start.sh`.

## 3. Usage
- `/start` → send YouTube link → pick quality (360/480/720/1080/audio) →
  pick codec (AV1/VP9/H.264) → ✅ start → watch progress → get local path.

## Notes / pitfalls
- Keep yt-dlp updated: YouTube changes the bot-check every few weeks.
- Only ONE listener per Worker — duplicates fight over jobs.
- Delivering locally (not uploading to Telegram) avoids the 2 GB cap and halves traffic.
- If you see `403` from the listener: that device is not on a residential/mobile IP — run it on the phone.

#!/usr/bin/env python3
"""
YouTube Downloader Listener
Runs on a RESIDENTIAL / MOBILE IP (e.g. Termux on your phone) to dodge YouTube's
datacenter bot-check (403 on actual byte download).

Polls the Cloudflare Worker job queue, downloads with yt-dlp (format fallback
chain), and reports progress + final path back to the user via the Worker.

Requires:
  - ffmpeg  (pkg install ffmpeg / apt install ffmpeg)
  - yt-dlp  (pip install -U yt-dlp)
  - python-requests

Environment (set by start.sh):
  WORKER_URL      e.g. https://yt-resume-worker.<sub>.workers.dev
  WORKER_SECRET   shared secret (X-Worker-Secret)
  DOWNLOAD_DIR    where files are saved (default /sdcard/downloads)
  COOKIES_FILE    optional, path to Netscape cookies.txt exported FROM this device
"""

import os
import re
import sys
import time
import json
import subprocess
import requests

WORKER_URL = os.environ.get("WORKER_URL", "").rstrip("/")
WORKER_SECRET = os.environ.get("WORKER_SECRET", "")
DOWNLOAD_DIR = os.environ.get("DOWNLOAD_DIR", "/sdcard/downloads")
COOKIES_FILE = os.environ.get("COOKIES_FILE", "")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "5"))
LOG_FILE = os.path.join(DOWNLOAD_DIR, "yt_dlp_last.log")

HEADERS = {"X-Worker-Secret": WORKER_SECRET}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def post_to_worker(path, payload):
    """Fire-and-forget POST (worker returns plain 'ok', not JSON)."""
    try:
        requests.post(
            f"{WORKER_URL}{path}",
            headers=HEADERS,
            json=payload,
            timeout=20,
        )
    except Exception as e:
        log(f"post {path} failed: {e}")


def notify(chat_id, phase, msg=None, **extra):
    payload = {"chat_id": chat_id, "phase": phase}
    if msg is not None:
        payload["msg"] = msg
    payload.update(extra)
    post_to_worker("/jobs/progress", payload)


def build_format_string(quality, codec):
    """Build a yt-dlp format selector with a fallback chain.
    Specific codec -> any codec at height -> best at height.
    """
    if quality == "audio":
        return "bestaudio"

    h = quality  # e.g. '720'
    if codec and codec != "any":
        # specific codec -> any codec -> best
        return (
            f"bestvideo[height<=?{h}][vcodec*={codec}]+bestaudio"
            f"/bestvideo[height<=?{h}]+bestaudio"
            f"/best[height<=?{h}]"
        )
    return f"bestvideo[height<=?{h}]+bestaudio/best[height<=?{h}]"


def run_download(job):
    chat_id = job["chat_id"]
    url = job["url"]
    quality = job.get("quality", "720")
    codec = job.get("codec")
    fmt = build_format_string(quality, codec)

    log(f"JOB {job.get('id')}: {url} q={quality} codec={codec}")
    log(f"format: {fmt}")

    out_tmpl = os.path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s")
    cmd = [
        "yt-dlp",
        "-f", fmt,
        "--merge-output-format", "mp4",
        "-o", out_tmpl,
        "--no-warnings",
        "--progress",
        "--newline",
    ]
    if quality == "audio":
        cmd += ["-x", "--audio-format", "mp3"]
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        cmd += ["--cookies", COOKIES_FILE]
    cmd.append(url)

    last_pct = -1
    last_lines = []
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    for line in proc.stdout:
        line = line.rstrip("\n")
        last_lines.append(line)
        last_lines = last_lines[-6:]
        m = re.search(r"\[download\]\s+(\d+(?:\.\d+)?)%", line)
        if m:
            pct = int(float(m.group(1)))
            if pct - last_pct >= 10 or pct >= 100:
                last_pct = pct
                notify(chat_id, "dl", f"{pct}%")
        elif "merging" in line.lower():
            notify(chat_id, "merge", "در حال ادغام صدا و تصویر...")
        log(line)

    rc = proc.wait()
    # write tail to log file for debugging
    try:
        with open(LOG_FILE, "w") as f:
            f.write("\n".join(last_lines))
    except Exception:
        pass

    if rc == 0:
        # find the produced file
        path = None
        for l in reversed(last_lines):
            m = re.search(r"Destination:\s*(.+)", l)
            if m:
                path = m.group(1).strip()
                break
        if not path:
            # fallback: newest file in dir
            try:
                files = [os.path.join(DOWNLOAD_DIR, f) for f in os.listdir(DOWNLOAD_DIR)]
                files = [f for f in files if os.path.isfile(f)]
                path = max(files, key=os.path.getmtime) if files else DOWNLOAD_DIR
            except Exception:
                path = DOWNLOAD_DIR
        log(f"DONE: {path}")
        notify(chat_id, "done", path=path)
    else:
        tail = "\n".join(last_lines[-4:])
        # detect 403
        if "403" in tail or "Forbidden" in tail:
            err = ("بات‌چک یوتیوب (403): این دستگاه IP مسکونی/موبایل نیست. "
                   "لیسنر رو روی گوشی (Termux) اجرا کن.")
        else:
            err = "yt-dlp خطا داد (خروجی غیرصفر)."
        log(f"FAILED rc={rc}")
        notify(chat_id, "error", error=err, log=tail)


def main():
    if not WORKER_URL or not WORKER_SECRET:
        log("ERROR: WORKER_URL and WORKER_SECRET must be set (see start.sh).")
        sys.exit(1)
    if not os.path.isdir(DOWNLOAD_DIR):
        os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    log(f"Listener started. Worker={WORKER_URL} dir={DOWNLOAD_DIR}")
    while True:
        try:
            r = requests.get(f"{WORKER_URL}/jobs/next", headers=HEADERS, timeout=20)
            if r.status_code == 200 and r.text and r.text != "null":
                try:
                    job = r.json()
                except Exception:
                    time.sleep(POLL_INTERVAL)
                    continue
                if job and "url" in job:
                    try:
                        run_download(job)
                    except Exception as e:
                        log(f"run_download crashed: {e}")
                        notify(job.get("chat_id"), "error", error=f"لیسنر کرش کرد: {e}")
            else:
                time.sleep(POLL_INTERVAL)
        except requests.exceptions.RequestException as e:
            log(f"poll error: {e}")
            time.sleep(POLL_INTERVAL * 2)
        except KeyboardInterrupt:
            log("stopped.")
            break
        except Exception as e:
            log(f"unexpected: {e}")
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()

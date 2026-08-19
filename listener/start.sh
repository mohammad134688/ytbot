#!/usr/bin/env bash
# One-click listener launcher for Termux (Android) / any Linux.
# Installs deps, exports secrets, kills old listeners, runs in background.
#
# Usage on phone (Termux):
#   bash start.sh
#
# You must edit the 3 variables below (or export them before running).

# ===== EDIT THESE =====
export WORKER_URL="https://yt-resume-worker.mosleminezhad8800.workers.dev"
export WORKER_SECRET="a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
export DOWNLOAD_DIR="/sdcard/downloads"                          # where videos are saved
export COOKIES_FILE=""                                           # optional: /sdcard/downloads/cookies.txt (exported FROM this phone)
# ======================

set -e
cd "$(dirname "$0")"

echo "=== installing deps ==="
# Termux vs Linux
if command -v pkg >/dev/null 2>&1; then
  pkg install -y ffmpeg python 2>/dev/null || true
  pip install -U yt-dlp requests 2>/dev/null || pip install --break-system-packages -U yt-dlp requests
else
  sudo apt-get install -y ffmpeg 2>/dev/null || true
  pip install -U yt-dlp requests 2>/dev/null || pip install --break-system-packages -U yt-dlp requests
fi

echo "=== killing old listeners ==="
pkill -f listener.py 2>/dev/null || true
sleep 1

echo "=== starting listener in background ==="
mkdir -p "$DOWNLOAD_DIR"
LOGFILE="$DOWNLOAD_DIR/listener.log"
nohup python3 listener.py > "$LOGFILE" 2>&1 &
echo "listener PID: $!"
echo "log: $LOGFILE"

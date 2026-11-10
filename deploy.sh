#!/usr/bin/env bash
# Pemasang cepat untuk Ubuntu/Debian.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_USER="${SUDO_USER:-$(id -un)}"

echo "==> Memasang paket dasar"
apt-get update -qq
apt-get install -y -qq nodejs npm python3 ffmpeg curl ca-certificates

echo "==> Memasang yt-dlp"
if ! command -v yt-dlp >/dev/null 2>&1; then
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  chmod +x /usr/local/bin/yt-dlp
fi
yt-dlp --version

echo "==> Membuat service systemd"
cat > /etc/systemd/system/yt-audio.service <<UNIT
[Unit]
Description=Putar Audio YouTube
After=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=PORT=8080
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

echo "==> Timer update yt-dlp harian"
cat > /etc/cron.daily/ytdlp-update <<'CRON'
#!/bin/sh
/usr/local/bin/yt-dlp -U >/dev/null 2>&1 || true
CRON
chmod +x /etc/cron.daily/ytdlp-update

systemctl daemon-reload
systemctl enable --now yt-audio

IP="$(hostname -I | awk '{print $1}')"
echo
echo "Selesai. Buka http://${IP}:8080"
systemctl --no-pager --lines=0 status yt-audio | head -5

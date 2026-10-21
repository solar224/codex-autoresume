#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="codex-autoresume.service"
SYSTEMD_DIR="$HOME/.config/systemd/user"

mkdir -p "$SYSTEMD_DIR"

cat << SERVICE_EOF > "$SYSTEMD_DIR/$SERVICE_NAME"
[Unit]
Description=Codex VS Code Extension Auto-Resume Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=/usr/bin/python3 $REPO_DIR/src/daemon.py
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
SERVICE_EOF

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"
loginctl enable-linger "$USER" 2>/dev/null || true

echo "Installation complete. Please run 'Developer: Reload Window' in VS Code."

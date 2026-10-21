#!/usr/bin/env bash
set -e

SERVICE_NAME="codex-autoresume.service"

systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/$SERVICE_NAME"
systemctl --user daemon-reload

for bak in ~/.vscode-server/extensions/openai.chatgpt-*/webview/index.html.orig.bak \
           ~/.vscode/extensions/openai.chatgpt-*/webview/index.html.orig.bak; do
  if [ -f "$bak" ]; then
    mv "$bak" "${bak%.orig.bak}"
    echo "Restored: ${bak%.orig.bak}"
  fi
done

rm -f ~/.vscode-server/extensions/openai.chatgpt-*/webview/assets/codex-ar-plugin*.js \
      ~/.vscode/extensions/openai.chatgpt-*/webview/assets/codex-ar-plugin*.js

echo "Uninstalled successfully. Please run 'Developer: Reload Window' in VS Code."

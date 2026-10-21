# codex-autoresume

Auto-resume for the **Codex VS Code extension** (`openai.chatgpt`). When the extension shows a usage-limit message, this tool waits until two minutes after the displayed reset time, then tries the available Retry/Continue button or sends a short continuation message in the current conversation. If the limit remains, it retries every minute.

This is an unofficial patch to the installed extension. It does not change account limits or resume ChatGPT in a browser tab. VS Code and the Codex conversation must remain open for the webview script to run.

## Install

```bash
git clone https://github.com/solar224/codex-autoresume.git
cd codex-autoresume
./install.sh
```

Run **Developer: Reload Window** in VS Code after installation or an update, so every open Codex conversation loads the current script. The script filename includes its content hash to avoid reusing an old cached copy. A user systemd service checks for extension updates every 30 seconds and installs the webview script again when needed. The script handles both local (`~/.vscode`) and remote (`~/.vscode-server`) extensions.

A small `AR: ON` button appears in the Codex panel. Click it to turn auto-resume off or on. The setting is saved in the webview's local storage. The tool will leave an unsent draft alone.

## Remove

```bash
./uninstall.sh
```

Then run **Developer: Reload Window**. Uninstall restores the original webview HTML and removes the added script.

## Limitations

- Time parsing depends on the reset time displayed in the extension's error message. When no reset time is shown, the first attempt is after two minutes.
- The webview must be open when the timer expires. Timers do not run while VS Code or the panel is closed.
- The script confirms a retry from the visible error disappearing or generation starting. It cannot confirm server-side completion if the extension hides a failure without showing another error.
- An extension update can change its private HTML or composer structure. Check the `AR` button after updating Codex.

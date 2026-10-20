A lightweight background daemon and Webview patch for the official OpenAI Codex (`openai.chatgpt`) VS Code extension. It automatically detects rate limits, schedules a cooldown timer, and resumes task execution once the quota resets.

## Features
- **Network & DOM Hybrid Detection**: Intercepts HTTP `429` responses directly and falls back to multi-language time parsing.
- **Non-Intrusive Inline UI**: Docks a compact status toggle (`● AR: ON` / `○ AR: OFF`) directly into the prompt toolbar without covering conversations or action buttons.
- **Auto-Patching Daemon**: Automatically re-applies the patch when the VS Code extension updates.

## Quick Start

### Install
```bash
git clone [https://github.com/YOUR_USERNAME/codex-autoresume.git](https://github.com/YOUR_USERNAME/codex-autoresume.git)
cd codex-autoresume
chmod +x install.sh uninstall.sh
./install.sh
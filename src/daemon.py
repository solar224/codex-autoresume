import os
import glob
import time
import shutil
from datetime import datetime

HOME = os.path.expanduser("~")
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAYLOAD_FILE = os.path.join(BASE_DIR, "src", "payload.js")
MARKER = "CODEX_AUTORESUME_START"

def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)

def patch_extensions():
    if not os.path.exists(PAYLOAD_FILE):
        return

    with open(PAYLOAD_FILE, "r", encoding="utf-8") as f:
        payload = f.read()

    patterns = [
        os.path.join(HOME, ".vscode-server", "extensions", "openai.chatgpt-*", "webview", "assets", "app-initial-*.js"),
        os.path.join(HOME, ".vscode", "extensions", "openai.chatgpt-*", "webview", "assets", "app-initial-*.js")
    ]

    for pattern in patterns:
        for js_path in glob.glob(pattern):
            try:
                with open(js_path, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()

                if MARKER not in content:
                    bak_path = js_path + ".orig.bak"
                    if not os.path.exists(bak_path):
                        shutil.copy2(js_path, bak_path)
                    else:
                        shutil.copy2(bak_path, js_path)

                    with open(js_path, "a", encoding="utf-8") as f:
                        f.write("\n" + payload + "\n")
                    log(f"Patched: {js_path}")
            except Exception as e:
                log(f"Error patching {js_path}: {e}")

def main():
    log("Codex Auto-Resume daemon started.")
    while True:
        patch_extensions()
        time.sleep(30)

if __name__ == "__main__":
    main()

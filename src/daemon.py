"""Keep the Codex IDE webview patched across extension updates."""

import glob
import hashlib
import os
import re
import shutil
import time
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
PAYLOAD_FILE = BASE_DIR / "src" / "payload.js"
PLUGIN_TAG_RE = re.compile(
    r'<script type="module" src="\./assets/codex-ar-plugin(?:-[0-9a-f]{12})?\.js"></script>'
)
OLD_MARKER = "/* CODEX_AUTORESUME_START */"


def log(message):
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {message}", flush=True)


def payload_name(payload):
    digest = hashlib.sha256(payload).hexdigest()[:12]
    return f"codex-ar-plugin-{digest}.js"


def script_tag(payload):
    return f'<script type="module" src="./assets/{payload_name(payload)}"></script>'


def extension_webviews(home=None):
    home = Path(home) if home else Path.home()
    for root in (home / ".vscode-server", home / ".vscode"):
        yield from (Path(p) for p in glob.glob(str(root / "extensions/openai.chatgpt-*/webview")))


def restore_legacy_bundles(webview):
    """Restore only bundles that the previous installer modified."""
    for backup in (webview / "assets").glob("app-initial-*.js.orig.bak"):
        bundle = Path(str(backup).removesuffix(".orig.bak"))
        if not bundle.exists():
            continue
        if bundle.stat().st_size == backup.stat().st_size:
            continue
        if OLD_MARKER not in bundle.read_text(encoding="utf-8", errors="ignore"):
            continue
        if OLD_MARKER in backup.read_text(encoding="utf-8", errors="ignore"):
            log(f"Skipping modified backup: {backup}")
            continue
        shutil.copy2(backup, bundle)
        log(f"Restored legacy bundle: {bundle}")


def patch_webview(webview):
    html_path = webview / "index.html"
    assets_dir = webview / "assets"
    if not html_path.is_file() or not assets_dir.is_dir():
        return

    restore_legacy_bundles(webview)
    payload = PAYLOAD_FILE.read_bytes()
    tag = script_tag(payload)
    backup = Path(str(html_path) + ".orig.bak")
    current = html_path.read_text(encoding="utf-8")
    if "</body>" not in current:
        log(f"Skipping HTML without </body>: {html_path}")
        return
    if not PLUGIN_TAG_RE.search(current):
        # An extension update may replace index.html while an older backup remains.
        if not backup.exists() or PLUGIN_TAG_RE.search(backup.read_text(encoding="utf-8")):
            shutil.copy2(html_path, backup)
        else:
            original = backup.read_text(encoding="utf-8")
            if original != current:
                shutil.copy2(html_path, backup)
    clean_html = PLUGIN_TAG_RE.sub("", current)
    before_body, _, after_body = clean_html.partition("</body>")
    updated = f"{before_body.rstrip()}\n  {tag}\n</body>{after_body}"
    if updated != current:
        html_path.write_text(updated, encoding="utf-8")
        log(f"Patched: {html_path}")

    for name in (payload_name(payload), "codex-ar-plugin.js"):
        target = assets_dir / name
        if not target.exists() or target.read_bytes() != payload:
            target.write_bytes(payload)
            log(f"Updated: {target}")


def main():
    log("Codex Auto-Resume daemon started")
    while True:
        for webview in extension_webviews():
            try:
                patch_webview(webview)
            except (OSError, UnicodeError) as error:
                log(f"Could not patch {webview}: {error}")
        time.sleep(30)


if __name__ == "__main__":
    main()

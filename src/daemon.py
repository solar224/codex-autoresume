"""Keep the Codex IDE webview patched across extension updates."""

import glob
import hashlib
import json
import os
import re
import shutil
import time
from datetime import datetime
from pathlib import Path

try:
    from src.quota import read_rate_limits
except ModuleNotFoundError:
    from quota import read_rate_limits

BASE_DIR = Path(__file__).resolve().parent.parent
PAYLOAD_FILE = BASE_DIR / "src" / "payload.js"
PLUGIN_TAG_RE = re.compile(
    r'<script type="module" src="\./assets/codex-ar-plugin(?:-[0-9a-f]{12})?\.js"></script>'
)
OLD_MARKER = "/* CODEX_AUTORESUME_START */"
QUOTA_FILE = "codex-ar-quota.json"


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
    asset = assets_dir / payload_name(payload)
    if not asset.exists() or asset.read_bytes() != payload:
        atomic_write(asset, payload)
        log(f"Updated: {asset}")
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
        atomic_write(html_path, updated.encode("utf-8"))
        log(f"Patched: {html_path}")


def atomic_write(path, content):
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_bytes(content)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_quota_snapshot(webview, snapshot):
    assets = webview / "assets"
    if not assets.is_dir():
        return
    target = assets / QUOTA_FILE
    atomic_write(target, (json.dumps(snapshot, separators=(",", ":")) + "\n").encode("utf-8"))


def main():
    log("Codex Auto-Resume daemon started")
    next_quota_read = 0
    while True:
        webviews = list(extension_webviews())
        for webview in webviews:
            try:
                patch_webview(webview)
            except (OSError, UnicodeError) as error:
                log(f"Could not patch {webview}: {error}")
        if webviews and time.monotonic() >= next_quota_read:
            next_quota_read = time.monotonic() + 60
            try:
                snapshot = read_rate_limits(timeout=20)
                for webview in webviews:
                    write_quota_snapshot(webview, snapshot)
            except (OSError, RuntimeError, TimeoutError) as error:
                log(f"Could not refresh quota: {type(error).__name__}")
        time.sleep(30)


if __name__ == "__main__":
    main()

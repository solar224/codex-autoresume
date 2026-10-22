import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "src" / "daemon.py"
spec = importlib.util.spec_from_file_location("autoresume_daemon", MODULE)
daemon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daemon)


class PatchWebviewTest(unittest.TestCase):
    def test_quota_snapshot_contains_only_reported_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            webview = Path(directory)
            (webview / "assets").mkdir()
            snapshot = {"observedAt": 123, "ordinaryUsageAllowed": True, "buckets": {}}
            daemon.write_quota_snapshot(webview, snapshot)
            self.assertEqual(json.loads((webview / "assets" / daemon.QUOTA_FILE).read_text()), snapshot)

    def test_patch_is_repeatable_and_tracks_extension_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            webview = Path(directory)
            assets = webview / "assets"
            assets.mkdir()
            html = webview / "index.html"
            html.write_text("<html><body>v1</body></html>")
            tag = daemon.script_tag(daemon.PAYLOAD_FILE.read_bytes())
            asset = assets / daemon.payload_name(daemon.PAYLOAD_FILE.read_bytes())

            with patch.object(daemon, "atomic_write", wraps=daemon.atomic_write) as write:
                daemon.patch_webview(webview)
            written = [call.args[0] for call in write.call_args_list]
            self.assertLess(written.index(asset), written.index(html),
                            "the script must exist before index.html references it")
            self.assertEqual(html.read_text().count(tag), 1)
            self.assertEqual((webview / "index.html.orig.bak").read_text(), "<html><body>v1</body></html>")
            self.assertEqual(asset.read_bytes(), daemon.PAYLOAD_FILE.read_bytes())

            patched = html.read_text()
            daemon.patch_webview(webview)
            self.assertEqual(html.read_text(), patched)

            html.write_text("<html><body>v2</body></html>")
            daemon.patch_webview(webview)
            self.assertEqual((webview / "index.html.orig.bak").read_text(), "<html><body>v2</body></html>")
            self.assertEqual(html.read_text().count(tag), 1)

    def test_replaces_old_plugin_tag_when_payload_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            webview = Path(directory)
            (webview / "assets").mkdir()
            html = webview / "index.html"
            html.write_text('<html><body>v1\n  <script type="module" src="./assets/codex-ar-plugin.js"></script>\n</body></html>')
            (webview / "index.html.orig.bak").write_text("<html><body>v1</body></html>")
            payload = webview / "payload.js"
            payload.write_text("first")
            with patch.object(daemon, "PAYLOAD_FILE", payload):
                daemon.patch_webview(webview)
                first_tag = daemon.script_tag(payload.read_bytes())
                self.assertEqual(html.read_text().count(first_tag), 1)
                self.assertNotIn('src="./assets/codex-ar-plugin.js"', html.read_text())
                payload.write_text("second")
                daemon.patch_webview(webview)
                second_tag = daemon.script_tag(payload.read_bytes())
                self.assertEqual(html.read_text().count(second_tag), 1)
                self.assertNotIn(first_tag, html.read_text())
                self.assertEqual((webview / "index.html.orig.bak").read_text(), "<html><body>v1</body></html>")

    def test_only_legacy_modified_bundle_is_restored(self):
        with tempfile.TemporaryDirectory() as directory:
            webview = Path(directory)
            assets = webview / "assets"
            assets.mkdir()
            bundle = assets / "app-initial-example.js"
            backup = assets / "app-initial-example.js.orig.bak"
            backup.write_text("original code")
            bundle.write_text("original code\n/* CODEX_AUTORESUME_START */\nmodified")
            daemon.restore_legacy_bundles(webview)
            self.assertEqual(bundle.read_text(), "original code")

            bundle.write_text("new extension version")
            daemon.restore_legacy_bundles(webview)
            self.assertEqual(bundle.read_text(), "new extension version")


if __name__ == "__main__":
    unittest.main()

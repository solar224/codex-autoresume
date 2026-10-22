"""Read Codex subscription rate limits through the local app-server."""

import argparse
import glob
import json
import os
import selectors
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


def find_codex():
    override = os.environ.get("CODEX_BIN")
    if override:
        return override
    installed = []
    for root in (Path.home() / ".vscode-server", Path.home() / ".vscode"):
        pattern = root / "extensions/openai.chatgpt-*/bin/*/codex"
        installed.extend(Path(path) for path in glob.glob(str(pattern)))
    installed = [path for path in installed if path.is_file() and os.access(path, os.X_OK)]
    if installed:
        return str(max(installed, key=lambda path: path.stat().st_mtime))
    binary = shutil.which("codex")
    if binary:
        return binary
    raise RuntimeError("Codex executable not found; set CODEX_BIN to its path")


def read_rate_limits(binary=None, timeout=30):
    process = subprocess.Popen(
        [binary or find_codex(), "app-server"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        bufsize=0,
    )
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    buffered = b""

    def send(message):
        process.stdin.write((json.dumps(message) + "\n").encode())
        process.stdin.flush()

    def receive(request_id):
        nonlocal buffered
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            events = selector.select(max(0, deadline - time.monotonic()))
            if not events:
                break
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            buffered += chunk
            while b"\n" in buffered:
                line, buffered = buffered.split(b"\n", 1)
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if message.get("id") == request_id:
                    if "error" in message:
                        raise RuntimeError(f"app-server request {request_id} failed: "
                                           f"{message['error'].get('message', 'unknown error')}")
                    return message.get("result", {})
        raise TimeoutError(f"app-server request {request_id} timed out")

    try:
        send({"method": "initialize", "id": 1, "params": {
            "clientInfo": {"name": "codex_autoresume", "title": "Codex Auto Resume", "version": "0.1.0"}
        }})
        receive(1)
        send({"method": "initialized", "params": {}})
        send({"method": "account/rateLimits/read", "id": 2})
        result = receive(2)
        buckets = result.get("rateLimitsByLimitId") or {}
        if not buckets and result.get("rateLimits"):
            one = result["rateLimits"]
            buckets = {one.get("limitId") or "default": one}
        safe = {}
        for limit_id, bucket in buckets.items():
            if not isinstance(bucket, dict):
                continue
            safe[limit_id] = {
                "limitName": bucket.get("limitName"),
                "rateLimitReachedType": bucket.get("rateLimitReachedType"),
                "primary": safe_window(bucket.get("primary")),
                "secondary": safe_window(bucket.get("secondary")),
            }
        return {
            "observedAt": int(time.time()),
            "ordinaryUsageAllowed": result.get("ordinaryUsageAllowed"),
            "buckets": safe,
        }
    finally:
        selector.close()
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def safe_window(window):
    if not isinstance(window, dict):
        return None
    used = window.get("usedPercent")
    return {
        "windowDurationMins": window.get("windowDurationMins"),
        "usedPercent": used,
        "remainingPercent": max(0, 100 - used) if isinstance(used, int) and not isinstance(used, bool) else None,
        "resetsAt": window.get("resetsAt"),
    }


def utc_time(timestamp):
    if not isinstance(timestamp, (int, float)):
        return "unknown"
    return datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def main():
    parser = argparse.ArgumentParser(description="Read current Codex subscription limits")
    parser.add_argument("--json", action="store_true", help="print machine-readable usage data")
    args = parser.parse_args()
    try:
        result = read_rate_limits()
    except (OSError, RuntimeError, TimeoutError) as error:
        parser.exit(1, f"Could not read Codex limits: {error}\n")
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
        return
    allowed = result["ordinaryUsageAllowed"]
    print(f"Ordinary usage allowed: {allowed if allowed is not None else 'unknown'}")
    for limit_id, bucket in result["buckets"].items():
        print(f"{bucket['limitName'] or limit_id} (reached: {bucket['rateLimitReachedType'] or 'none'})")
        for window in (bucket["primary"], bucket["secondary"]):
            if window:
                print(f"  {window['windowDurationMins']} min: {window['usedPercent']}% used, "
                      f"{window['remainingPercent']}% remaining; "
                      f"resets {utc_time(window['resetsAt'])}")


if __name__ == "__main__":
    main()

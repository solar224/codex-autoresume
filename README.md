# Codex Auto Resume

Attempt to continue an interrupted task in the official Codex VS Code extension after subscription usage becomes available again.

## Install

```bash
git clone https://github.com/solar224/codex-autoresume.git
cd codex-autoresume
./install.sh
```

Run **Developer: Reload Window** in VS Code once. Open the Codex conversation you want to continue and leave its panel open. Click the small **AR: ON/OFF** button in the composer to control this feature.

## How it decides

1. While **ON**, it watches the current conversation for a visible usage-limit message. Old logs do not trigger a continuation.
2. The local service reads Codex's 5-hour and weekly quota status about once a minute. Either window at 100% used blocks continuation, even if the other has room. It waits for the later reset when both are exhausted. A stale quota snapshot cannot authorize Send; if no snapshot has ever loaded, it uses the reset time shown in the message.
3. If the composer already contains a draft, it waits until the text has been unchanged for 10 seconds and clicks the native Send button, preserving the draft and its attachments. If the composer is empty, it enters `Continue from where you left off.` and clicks Send when enabled. If Codex still shows a disabled Send button, it requests a native quota refresh and tries later. It never clicks Retry, which could rerun the previous turn.
4. If Codex rejects the sent message with another limit alert, it does not repeatedly send the same continuation. It waits for a reported reset when the quota snapshot shows a block. Switching conversations cancels the pending attempt.
5. If Codex says the conversation is open in another app, it keeps the pending message and retries that specific conversation-opening button at most once a minute. Close the other app or window to release the conversation. This button does not regenerate the previous answer.

It does not overwrite existing drafts or override a disabled Send button. It does not auto-approve Codex tool requests.

## Commands

```bash
python3 src/quota.py                       # Current quota status
systemctl --user status codex-autoresume  # Background service
./uninstall.sh                             # Remove the patch
```

Run **Developer: Reload Window** after updating or uninstalling.

## Limits

The Codex panel and computer must remain running. This is an unofficial patch to the installed extension, so an extension update can change the private UI it depends on. A conversation held open in another app cannot accept a new message until that app releases it. Server quota recovery does not guarantee that the extension has enabled its native Send button; in that case the tool keeps the draft and retries, and automatic submission remains unverified until the native button accepts it.

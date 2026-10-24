/* CODEX_AUTORESUME_START */
(() => {
  if (window.__codexAutoResumeLoaded) return;
  window.__codexAutoResumeLoaded = true;

  const ROOT = '[data-codex-composer-root]';
  const FOOTER = '[class*="_ComposerLayoutFooter_"], [data-composer-footer-responsive]';
  const CONTINUE_TEXT = 'Continue from where you left off.';
  const RETRY_DELAY = 60_000;
  const EDITOR_SETTLE_DELAY = 1000;
  const USER_DRAFT_IDLE_DELAY = 10_000;
  const WRITER_RETRY_DELAY = 60_000;
  const RESET_GRACE = 2 * 60_000;
  const FALLBACK_DELAY = RESET_GRACE;
  const LIMIT_RE = /(?:you(?:'|’)ve|you have|you)\s+(?:hit|reached|exceeded)\s+(?:your\s+|the\s+)?(?:(?:maximum|daily|weekly)\s+)?(?:usage\s+|message\s+|messages\s+|rate\s+)?limit|\b(?:usage|rate|message|messages)\s+limit\b|\blimit\s+(?:reached|exceeded)\b|out of (?:messages|usage)|too many requests|已達(?:到)?.{0,20}(?:上限|限制)|用量.{0,10}(?:耗盡|上限(?!已重置|已重設|已恢復))|訊息已用完|速率限制(?!已重設|已重置)|訊息.{0,12}(?:上限|用完)/i;
  let enabled = localStorage.getItem('codex_ar_enabled') !== 'false';
  let pending = null;
  let quota = null;
  let nextQuotaRead = 0;
  let nextWriterRetry = 0;
  const handled = new WeakMap();
  const handledThreads = new Map();

  function freshQuota() {
    return quota && Number.isFinite(quota.observedAt) &&
      Date.now() - quota.observedAt * 1000 >= 0 &&
      Date.now() - quota.observedAt * 1000 <= 150_000 ? quota : null;
  }

  function exhaustedWindows() {
    const snapshot = freshQuota();
    if (!snapshot) return [];
    return Object.values(snapshot.buckets || {}).flatMap((bucket) =>
      [bucket?.primary, bucket?.secondary]).filter((window) =>
      window && (window.usedPercent >= 100 ||
        (Number.isFinite(window.remainingPercent) && window.remainingPercent <= 0)));
  }

  function quotaBlocked() {
    const snapshot = freshQuota();
    if (!snapshot) return false;
    return snapshot.ordinaryUsageAllowed === false || exhaustedWindows().length > 0 ||
      Object.values(snapshot.buckets || {}).some((bucket) =>
        bucket?.rateLimitReachedType && bucket.rateLimitReachedType !== 'none');
  }

  function quotaDelay() {
    const snapshot = freshQuota();
    if (!snapshot) return null;
    if (quotaBlocked()) {
      const resets = exhaustedWindows().filter((window) =>
        Number.isFinite(window.resetsAt) && window.resetsAt * 1000 > Date.now());
      return resets.length ? Math.max(...resets.map((window) =>
        window.resetsAt * 1000 - Date.now())) + RESET_GRACE : null;
    }
    return snapshot.ordinaryUsageAllowed === true ? 1000 : null;
  }

  async function readQuota() {
    if (typeof fetch !== 'function' || Date.now() < nextQuotaRead) return;
    nextQuotaRead = Date.now() + 60_000;
    try {
      const response = await fetch(`./assets/codex-ar-quota.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return;
      const result = await response.json();
      if (!Number.isFinite(result?.observedAt)) return;
      quota = result;
      const delay = quotaDelay();
      if (pending && !pending.verifying && delay === 1000 && pending.nextAt > Date.now() + 1000) {
        pending.nextAt = Date.now() + 1000;
        pending.reason = 'Server reports quota available; trying native Send';
      } else if (pending && quotaBlocked()) {
        pending.verifying = false;
        pending.nextAt = Date.now() + (delay ?? RETRY_DELAY);
        pending.reason = 'Waiting for the server quota reset';
      }
    } catch {
      // The Webview may load before the daemon publishes its first snapshot.
    }
  }

  function visible(el) {
    if (!el || el.isConnected === false) return false;
    if (el.closest?.('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (el.getClientRects && el.getClientRects().length === 0) return false;
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const style = window.getComputedStyle?.(node);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    }
    return true;
  }

  function composerRoot() {
    const focused = document.activeElement?.closest?.(ROOT);
    if (visible(focused)) return focused;
    return Array.from(document.querySelectorAll(ROOT)).filter(visible).at(-1) || null;
  }

  function composerFooter(root) {
    return Array.from(root?.querySelectorAll(FOOTER) || []).find(visible) || null;
  }

  function editor(root) {
    const boxes = Array.from(root?.querySelectorAll('[data-codex-composer][contenteditable]:not([contenteditable="false"]), [contenteditable]:not([contenteditable="false"]), textarea') || [])
      .filter((el) => visible(el) && (el.isContentEditable || el.tagName === 'TEXTAREA'));
    const focused = document.activeElement;
    const native = boxes.find((el) => el.matches?.('[data-codex-composer]'));
    return native || (boxes.includes(focused) ? focused : boxes.at(-1)) || null;
  }

  function editorText(el) {
    return (el?.value ?? el?.innerText ?? '').trim();
  }

  function sendButton(root) {
    const buttons = Array.from(root?.querySelectorAll('button') || []).filter(visible);
    return buttons.find((button) => /^(?:send(?: message)?|傳送(?:訊息)?|送出(?:訊息)?|发送(?:消息)?)$/i.test(
      (button.getAttribute?.('aria-label') || '').trim())) ||
      buttons.find((button) => button.type === 'submit' || button.getAttribute?.('type') === 'submit') || null;
  }

  function sendBlocked(button) {
    return button.disabled || button.getAttribute?.('aria-disabled') === 'true';
  }

  function generating(root) {
    return Array.from(root?.querySelectorAll('button[aria-label]') || []).some((button) =>
      visible(button) && /^(stop|停止)$/i.test((button.getAttribute('aria-label') || '').trim()));
  }

  function writerConflict() {
    return Array.from(document.querySelectorAll('[role="alert"]'))
      .filter(visible)
      .find((alert) => /This is open in another app|已在另一個應用程式中開啟|已在另一个应用程序中打开/i
        .test(alert.innerText || alert.textContent || '')) || null;
  }

  function retryWriterConflict(alert) {
    if (Date.now() < nextWriterRetry) return;
    const retry = Array.from(alert.querySelectorAll('button')).find((button) =>
      visible(button) && !sendBlocked(button) &&
      /^(?:retry|重試|重试)$/i.test((button.innerText || button.textContent || '').trim()));
    if (!retry) return;
    nextWriterRetry = Date.now() + WRITER_RETRY_DELAY;
    retry.click();
  }

  function limitNotice(root = composerRoot()) {
    // Response errors use alert; composer rate-limit banners use status.
    const semantic = Array.from(document.querySelectorAll('[role="alert"], [role="status"]'))
      .filter((el) => visible(el) && LIMIT_RE.test(el.innerText || el.textContent || ''))
      .at(-1) || null;
    // The native hard-block banner can render as an unlabelled div inside the composer.
    if (semantic) return semantic;
    if (!root) return null;
    const draft = editorText(editor(root));
    const content = (root.innerText || root.textContent || '').replace(draft, '');
    return LIMIT_RE.test(content) ? root : null;
  }

  function noticeSignature(notice, root = composerRoot()) {
    if (!notice) return '';
    const draft = notice === root ? editorText(editor(root)) : '';
    const text = (notice.innerText || notice.textContent || '').replace(draft, '');
    const limit = text.match(LIMIT_RE)?.[0] || '';
    const reset = text.match(/(?:凌晨|清晨|早上|上午|中午|下午|傍晚|晚上)?\s*\d{1,2}[:點時]\d{2}\s*(?:AM|PM)?|\d+\s*(?:hours?|hrs?|minutes?|mins?|小時|分鐘)/i)?.[0] || '';
    return `${limit.toLowerCase()}|${reset.toLowerCase()}`;
  }

  function markHandled(notice, root) {
    if (!notice) return;
    const signature = noticeSignature(notice, root);
    handled.set(notice, signature);
    const key = conversationKey();
    if (key) handledThreads.set(key, { signature, at: Date.now() });
  }

  function isHandled(notice, root) {
    if (!notice) return false;
    const signature = noticeSignature(notice, root);
    if (handled.get(notice) === signature) return true;
    const previous = handledThreads.get(conversationKey());
    return !!previous && previous.signature === signature;
  }

  function parseDelay(text) {
    const hours = text.match(/(\d+)\s*(?:hours?|hrs?|h\b|小時)/i);
    const minutes = text.match(/(\d+)\s*(?:minutes?|mins?|m\b|分鐘)/i);
    if (hours || minutes) {
      const amount = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
      if (amount > 0 && amount <= 7 * 24 * 60) return amount * 60_000 + RESET_GRACE;
    }
    const clock = text.match(/(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})[:點時](\d{2})\s*([AP]M)?/i);
    if (clock) {
      let hour = Number(clock[2]);
      const minute = Number(clock[3]);
      const pm = /中午|下午|傍晚|晚上/.test(clock[1] || '') || /^PM$/i.test(clock[4] || '');
      const am = /凌晨|清晨|早上|上午/.test(clock[1] || '') || /^AM$/i.test(clock[4] || '');
      if (pm && hour < 12) hour += 12;
      if (am && hour === 12) hour = 0;
      if (hour < 24 && minute < 60) {
        const now = new Date();
        const reset = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
        // An old error shown after its reset time should be retried now.
        if (/tomorrow|明天/i.test(text)) reset.setDate(reset.getDate() + 1);
        return Math.max(1000, reset.getTime() - now.getTime() + RESET_GRACE);
      }
    }
    return FALLBACK_DELAY;
  }

  function insertContinuation(box) {
    if (editorText(box)) return false;
    try {
      box.focus();
      if (box instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(box, CONTINUE_TEXT);
        else box.value = CONTINUE_TEXT;
        box.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('insertText', false, CONTINUE_TEXT);
      }
    } catch {
      return false;
    }
    return editorText(box) === CONTINUE_TEXT;
  }

  function sameConversation(state) {
    const root = composerRoot();
    if (!root || window.location.href !== state.url) return false;
    if (root === state.root) return true;
    if (state.threadKey) {
      if (state.threadKey !== conversationKey()) return false;
    } else if (state.root || !visible(state.notice)) return false;
    state.root = root;
    state.box = editor(root);
    state.ownDraft = state.ownDraft && editorText(state.box) === CONTINUE_TEXT;
    return true;
  }

  function observeDraft(state) {
    const draft = editorText(editor(state.root));
    if (draft !== state.draftText) {
      state.draftText = draft;
      state.draftChangedAt = Date.now();
      if (state.ownDraft && draft !== CONTINUE_TEXT) state.ownDraft = false;
    }
    return draft;
  }

  function conversationKey() {
    return window.location.pathname?.match(/\/(?:local|remote)\/([0-9a-f-]{36})(?:\/)?$/i)?.[0] || null;
  }

  function refreshNativeQuota(state) {
    if (state.refreshStage === 0) {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      state.refreshStage = 1;
      state.nextAt = Date.now() + 5000;
      state.reason = 'Refreshing native quota state';
      return true;
    }
    if (state.refreshStage === 1) {
      const control = Array.from(document.querySelectorAll('button')).find((button) => {
        if (!visible(button) || button.disabled || button.id === 'codex-ar-inline') return false;
        const label = [button.getAttribute('aria-label'), button.title, button.innerText]
          .filter(Boolean).join(' ').trim();
        return /^(?:rate limit(?::.*)?|usage remaining(?:.*)?|remaining quota(?:.*)?|剩餘額度(?:.*)?|剩餘用量(?:.*)?|速率限制(?:.*)?)$/i.test(label);
      });
      state.refreshStage = 2;
      if (control) {
        control.click();
        state.nextAt = Date.now() + 5000;
        state.reason = 'Opened native quota control to refresh status';
        return true;
      }
    }
    return false;
  }

  function startPending(notice, root) {
    const text = notice.innerText || notice.textContent || '';
    pending = {
      notice, root, url: window.location.href, threadKey: conversationKey(),
      nextAt: Date.now() + (quotaDelay() ?? parseDelay(text)),
      verifying: false,
      wasGenerating: false,
      ownDraft: false,
      draftText: editorText(editor(root)),
      draftChangedAt: Date.now(),
      box: null,
      lastAction: null,
      submittedDraft: '',
      composerMissingSince: null,
      attemptNotice: null,
      attemptSignature: '',
      refreshStage: 0,
      reason: 'Waiting for reset'
    };
  }

  function attempt(state) {
    if (!sameConversation(state)) {
      pending = null;
      return;
    }
    if (quota && !freshQuota()) {
      state.nextAt = Date.now() + RETRY_DELAY;
      state.reason = 'Waiting for a fresh quota snapshot';
      return;
    }
    if (quotaBlocked()) {
      state.verifying = false;
      state.nextAt = Date.now() + (quotaDelay() ?? RETRY_DELAY);
      state.reason = 'Server quota is still blocked';
      return;
    }
    if (freshQuota() && freshQuota().ordinaryUsageAllowed !== true) {
      state.nextAt = Date.now() + RETRY_DELAY;
      state.reason = 'Waiting for server quota permission';
      return;
    }
    const notice = limitNotice();
    if (notice) state.notice = notice;
    if (generating(state.root)) {
      state.wasGenerating = true;
      state.nextAt = Date.now() + RETRY_DELAY;
      state.reason = 'Native response in progress';
      return;
    }
    const box = editor(state.root);
    if (!box) {
      state.nextAt = Date.now() + RETRY_DELAY;
      state.reason = 'Composer editor not found';
      return;
    }
    const draft = observeDraft(state);
    if (state.ownDraft && !draft) state.ownDraft = false;
    if (draft && !(state.ownDraft && draft === CONTINUE_TEXT)) {
      const idleUntil = state.draftChangedAt + USER_DRAFT_IDLE_DELAY;
      if (Date.now() < idleUntil) {
        state.nextAt = idleUntil;
        state.reason = 'Waiting for the existing draft to settle';
        return;
      }
    }
    if (!draft) {
      if (!insertContinuation(box)) {
        state.nextAt = Date.now() + RETRY_DELAY;
        state.reason = 'Could not enter continuation text';
        return;
      }
      state.ownDraft = true;
      observeDraft(state);
      state.box = box;
      state.nextAt = Date.now() + EDITOR_SETTLE_DELAY;
      state.reason = 'Continuation entered; waiting for Send';
      return; // Let the native editor update the disabled Send button.
    }
    const send = sendButton(state.root);
    if (!send) {
      state.nextAt = Date.now() + RETRY_DELAY;
      state.reason = 'Waiting for the native Send button';
      return;
    }
    if (!sameConversation(state) || sendBlocked(send)) {
      if (sendBlocked(send) && freshQuota()?.ordinaryUsageAllowed === true &&
          refreshNativeQuota(state)) return;
      state.nextAt = Date.now() + RETRY_DELAY;
      state.reason = sendBlocked(send) ? 'Send button disabled; retrying' : 'Conversation changed';
      return;
    }
    const submittedDraft = editorText(box);
    try { send.click(); } catch {
      state.nextAt = Date.now() + RETRY_DELAY;
      state.reason = 'Send click failed';
      return;
    }
    state.lastAction = 'send';
    state.submittedDraft = submittedDraft;
    state.box = box;
    state.attemptNotice = notice;
    state.attemptSignature = noticeSignature(notice, state.root);
    state.verifying = true;
    state.nextAt = Date.now() + RETRY_DELAY;
    state.reason = 'Send clicked; checking result';
  }

  function verifyAttempt(state) {
    const notice = limitNotice();
    const draft = editorText(editor(state.root));
    if (draft && draft !== state.submittedDraft) {
      markHandled(state.attemptNotice || state.notice, state.root);
      pending = null;
      return;
    }
    if (state.lastAction === 'send' && draft === state.submittedDraft) {
      state.verifying = false;
      state.nextAt = Date.now() + RETRY_DELAY;
      state.reason = 'Send did not clear the draft; retrying';
      return;
    }
    if (notice && (notice !== state.attemptNotice ||
        noticeSignature(notice, state.root) !== state.attemptSignature)) {
      state.verifying = false;
      state.ownDraft = false;
      if (quotaBlocked()) {
        state.nextAt = Date.now() + (quotaDelay() ?? RETRY_DELAY);
        state.reason = 'Native limit rejected the continuation; waiting for quota reset';
      } else {
        markHandled(notice, state.root);
        pending = null;
      }
      return;
    }
    if (!quotaBlocked() &&
        (!notice || (state.lastAction === 'send' && !draft &&
        noticeSignature(notice, state.root) === state.attemptSignature))) {
      markHandled(state.attemptNotice || state.notice, state.root);
      pending = null;
      return;
    }
    // The composer can clear even when the server rejects the turn.
    if (state.box && !editorText(state.box)) state.ownDraft = false;
    state.verifying = false;
    attempt(state);
  }

  function mountButton(root) {
    const footer = composerFooter(root);
    let button = document.getElementById('codex-ar-inline');
    if (!footer) {
      button?.remove();
      return;
    }
    if (!button) {
      button = document.createElement('button');
      button.id = 'codex-ar-inline';
    }
    if (!button.__codexArOwned) {
      button.__codexArOwned = true;
      button.onclick = null;
      button.type = 'button';
      button.addEventListener('click', () => {
        enabled = !enabled;
        localStorage.setItem('codex_ar_enabled', String(enabled));
        if (!enabled) pending = null;
        renderStatus();
      });
    }
    if (!button.__codexArStyled) {
      Object.assign(button.style, {
        position: 'static', bottom: 'auto', left: 'auto', zIndex: 'auto',
        display: 'inline-flex', alignItems: 'center', margin: '0',
        padding: '2px 5px', borderRadius: '4px', fontSize: '10px',
        lineHeight: '1.4', whiteSpace: 'nowrap', justifySelf: 'end',
        fontFamily: 'inherit', border: '1px solid #777',
        background: '#202024', color: '#d4d4d8',
        cursor: 'pointer'
      });
      button.__codexArStyled = true;
    }
    if (button.parentElement !== footer) footer.insertBefore(button, footer.lastElementChild);
  }

  function renderStatus() {
    const button = document.getElementById('codex-ar-inline');
    if (!button) return;
    let label;
    if (!enabled) label = '○ AR: OFF';
    else if (pending) {
      const seconds = Math.max(0, Math.ceil((pending.nextAt - Date.now()) / 1000));
      label = seconds < 60 ? `● AR: ${seconds}s` : `● AR: ${Math.ceil(seconds / 60)}m`;
    } else label = '● AR: ON';
    if (button.textContent !== label) button.textContent = label;
    const title = enabled ? (pending?.reason || 'Auto-resume enabled') : 'Auto-resume disabled';
    if (button.title !== title) button.title = title;
  }

  function poll() {
    readQuota();
    const root = composerRoot();
    const conflict = writerConflict();
    mountButton(root);
    if (!enabled) {
      pending = null;
      renderStatus();
      return;
    }
    if (!root || (conflict && !editor(root))) {
      if (pending && window.location.href !== pending.url) pending = null;
      if (pending && !conflict) {
        pending.composerMissingSince ??= Date.now();
        if (Date.now() - pending.composerMissingSince > 30_000) pending = null;
      } else if (pending) pending.composerMissingSince = null;
      if (conflict) {
        const notice = limitNotice(root);
        if (!pending && notice && !isHandled(notice, root)) startPending(notice, root);
        if (pending) pending.reason = 'Conversation open in another app; waiting for writer';
        retryWriterConflict(conflict);
      }
      renderStatus();
      return;
    }
    if (pending) pending.composerMissingSince = null;
    nextWriterRetry = 0;
    const notice = limitNotice();
    if (!notice) {
      handled.delete(root);
      handledThreads.delete(conversationKey());
    }
    if (pending && !sameConversation(pending)) {
      markHandled(pending.notice, pending.root);
      pending = null;
    }
    if (pending) observeDraft(pending);
    if (generating(root)) {
      if (pending) {
        pending.wasGenerating = true;
        pending.nextAt = Date.now() + RETRY_DELAY;
        pending.reason = 'Native response in progress';
      }
      renderStatus();
      return;
    }
    if (pending?.wasGenerating) {
      pending.wasGenerating = false;
      if (pending.lastAction || !notice) {
        markHandled(pending.notice, pending.root);
        pending = null;
      } else {
        pending.nextAt = Math.max(pending.nextAt, Date.now() + RETRY_DELAY);
        pending.reason = 'Limit remains after native response';
      }
    }
    if (!pending && notice && !isHandled(notice, root)) startPending(notice, root);
    if (pending) {
      if (Date.now() >= pending.nextAt) {
        if (pending.verifying) verifyAttempt(pending);
        else attempt(pending);
      }
    }
    renderStatus();
  }

  document.addEventListener('click', (event) => {
    if (!event.isTrusted || !pending) return;
    const send = sendButton(pending.root);
    if (send?.contains(event.target)) {
      markHandled(pending.notice, pending.root);
      pending = null;
      renderStatus();
    }
  }, true);

  window.codexAutoResume = {
    inspect() {
      const root = composerRoot();
      const box = editor(root);
      const send = sendButton(root);
      const notice = limitNotice(root);
      return {
        loaded: true, enabled, buttonMounted: !!document.getElementById('codex-ar-inline'),
        composerFound: !!root, editorFound: !!box, sendFound: !!send,
        sendDisabled: send ? sendBlocked(send) : null, limitDetected: !!notice,
        limitHandled: isHandled(notice, root),
        limitSource: notice === root ? 'composer' : notice?.getAttribute?.('role') || null,
        writerConflict: !!writerConflict(),
        quota: freshQuota(),
        pending: !!pending, nextAt: pending ? new Date(pending.nextAt).toISOString() : null,
        reason: pending?.reason || null
      };
    }
  };

  setInterval(poll, 1000);
  poll();
})();
/* CODEX_AUTORESUME_END */

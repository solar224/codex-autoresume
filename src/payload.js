/* CODEX_AUTORESUME_START */
(() => {
  if (window.__codexAutoResumeLoaded) return;
  window.__codexAutoResumeLoaded = true;

  const ROOT = '[data-codex-composer-root]';
  const FOOTER = '[class*="_ComposerLayoutFooter_"], [data-composer-footer-responsive]';
  const CONTINUE_TEXT = 'Continue from where you left off.';
  const RETRY_DELAY = 60_000;
  const RESET_GRACE = 2 * 60_000;
  const FALLBACK_DELAY = RESET_GRACE;
  const LIMIT_RE = /(?:you(?:'|’)ve|you have|you)\s+(?:hit|reached|exceeded)\s+(?:your\s+)?(?:usage\s+|message\s+|rate\s+)?limit|hit your limit|(?:usage|rate|message) limit (?:reached|exceeded|resets?|hit)|out of (?:messages|usage)|too many requests|已達到.{0,20}(?:上限|限制)|用量.{0,10}(?:耗盡|上限)|訊息已用完|速率限制/i;
  let enabled = localStorage.getItem('codex_ar_enabled') !== 'false';
  let pending = null;
  const handled = new WeakSet();

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
    const boxes = Array.from(root?.querySelectorAll('[contenteditable]:not([contenteditable="false"]), textarea') || [])
      .filter((el) => visible(el) && (el.isContentEditable || el.tagName === 'TEXTAREA'));
    const focused = document.activeElement;
    return boxes.includes(focused) ? focused : boxes.at(-1) || null;
  }

  function editorText(el) {
    return (el?.value ?? el?.innerText ?? '').trim();
  }

  function sendButton(root) {
    const footer = composerFooter(root);
    return Array.from(footer?.querySelectorAll('button[type="submit"]') || []).find(visible) || null;
  }

  function generating(root) {
    return Array.from(root?.querySelectorAll('button[aria-label]') || []).some((button) =>
      visible(button) && /^(stop|停止)$/i.test((button.getAttribute('aria-label') || '').trim()));
  }

  function limitAlert() {
    return Array.from(document.querySelectorAll('[role="alert"]'))
      .filter((el) => visible(el) && LIMIT_RE.test(el.innerText || el.textContent || ''))
      .at(-1) || null;
  }

  function retryButton(alert) {
    return Array.from(alert?.querySelectorAll('button') || []).find((button) =>
      visible(button) && !button.disabled && /^(retry|try again|resume|continue|重試|繼續|再試一次)$/i.test(
        (button.innerText || button.getAttribute('aria-label') || '').trim()));
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
    box.focus();
    if (box instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(box, CONTINUE_TEXT);
      else box.value = CONTINUE_TEXT;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('insertText', false, CONTINUE_TEXT);
    }
    return editorText(box) === CONTINUE_TEXT;
  }

  function sameConversation(state) {
    return composerRoot() === state.root && window.location.href === state.url;
  }

  function startPending(alert, root) {
    const text = alert.innerText || alert.textContent || '';
    pending = {
      alert, root, url: window.location.href,
      nextAt: Date.now() + parseDelay(text),
      verifying: false,
      ownDraft: false,
      box: null
    };
  }

  function attempt(state) {
    if (!sameConversation(state)) {
      pending = null;
      return;
    }
    const alert = limitAlert();
    if (!alert) {
      pending = null;
      return;
    }
    state.alert = alert;
    if (generating(state.root)) {
      handled.add(state.alert);
      pending = null;
      return;
    }
    const retry = retryButton(alert);
    if (retry) {
      retry.click();
      state.verifying = true;
      state.nextAt = Date.now() + RETRY_DELAY;
      return;
    }

    const box = editor(state.root);
    const send = sendButton(state.root);
    if (!box || !send || send.disabled) {
      state.nextAt = Date.now() + RETRY_DELAY;
      return;
    }
    const draft = editorText(box);
    if (draft && !(state.ownDraft && draft === CONTINUE_TEXT)) {
      state.nextAt = Date.now() + RETRY_DELAY; // Keep the user's draft unchanged.
      return;
    }
    if (!state.ownDraft && !insertContinuation(box)) {
      state.nextAt = Date.now() + RETRY_DELAY;
      return;
    }
    state.ownDraft = true;
    state.box = box;
    if (!sameConversation(state) || !limitAlert() || send.disabled) {
      state.nextAt = Date.now() + RETRY_DELAY;
      return;
    }
    send.click();
    state.verifying = true;
    state.nextAt = Date.now() + RETRY_DELAY;
  }

  function verifyAttempt(state) {
    if (!limitAlert()) {
      handled.add(state.alert);
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
    Object.assign(button.style, {
      position: 'static', bottom: 'auto', left: 'auto', zIndex: 'auto',
      display: 'inline-flex', alignItems: 'center', margin: '0',
      padding: '2px 5px', borderRadius: '4px', fontSize: '10px',
      lineHeight: '1.4', whiteSpace: 'nowrap', justifySelf: 'end',
      fontFamily: 'inherit', border: '1px solid #777',
      background: '#202024', color: '#d4d4d8', cursor: 'pointer'
    });
    if (button.parentElement !== footer) footer.insertBefore(button, footer.lastElementChild);
  }

  function renderStatus() {
    const button = document.getElementById('codex-ar-inline');
    if (!button) return;
    if (!enabled) button.textContent = '○ AR: OFF';
    else if (pending) {
      const seconds = Math.max(0, Math.ceil((pending.nextAt - Date.now()) / 1000));
      button.textContent = `● AR: ${Math.ceil(seconds / 60)}m`;
    } else button.textContent = '● AR: ON';
    button.title = enabled ? 'Auto-resume enabled' : 'Auto-resume disabled';
  }

  function poll() {
    const root = composerRoot();
    mountButton(root);
    if (!enabled || !root) {
      pending = null;
      renderStatus();
      return;
    }
    const alert = limitAlert();
    if (pending && !sameConversation(pending)) {
      handled.add(pending.alert);
      pending = null;
    }
    if (pending && alert) pending.alert = alert;
    if (generating(root)) {
      if (pending) handled.add(pending.alert);
      pending = null;
      renderStatus();
      return;
    }
    if (pending && !alert && !pending.verifying) pending = null;
    if (!pending && alert && !handled.has(alert)) startPending(alert, root);
    if (pending) {
      if (Date.now() >= pending.nextAt) {
        if (pending.verifying) verifyAttempt(pending);
        else attempt(pending);
      }
    }
    renderStatus();
  }

  setInterval(poll, 1000);
  poll();
})();
/* CODEX_AUTORESUME_END */

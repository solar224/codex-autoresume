const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'payload.js'), 'utf8');
const MINUTE = 60_000;

function setup({ message = "You've hit your usage limit. Try again in 1 minute.", nativeRetry = false,
  legacyBadge = false, role = 'alert', editorKind = 'textarea', unlabelledBanner = false,
  sendKeepsDraft = false, startAt = '2026-10-21T12:00:00', quotaSnapshot = null,
  route = '/index.html', quotaControl = false, sendAppearsAfterText = false } = {}) {
  let now = Date.parse(startAt);
  let interval;
  let badge;
  let generating = false;
  const alerts = [];
  const roots = [];
  const sends = [];
  const retries = [];
  const refreshes = [];
  const listeners = {};
  const document = {
    body: {}, activeElement: null,
    addEventListener(name, handler) { listeners[name] = handler; },
    dispatchEvent(event) { refreshes.push(event.type); },
    querySelectorAll(selector) {
      if (selector === '[data-codex-composer-root]') return roots;
      if (selector === '[role="alert"], [role="status"]') return alerts.filter((alert) =>
        alert.isConnected && ['alert', 'status'].includes(alert.getAttribute('role')));
      if (selector === 'button' && quotaControl) return [{
        id: '', disabled: false, innerText: 'Rate limit', title: '', isConnected: true,
        getAttribute: () => '', getClientRects: () => [{}],
        click() { refreshes.push('quota-click'); },
      }];
      return [];
    },
    getElementById(id) { return id === 'codex-ar-inline' ? badge : null; },
    createElement() {
      badge = { style: {}, parentElement: null, addEventListener() {}, remove() { this.parentElement = null; badge = null; } };
      return badge;
    },
    execCommand(command, _showUi, text) {
      if (command !== 'insertText') return false;
      document.activeElement.innerText = text;
      return true;
    },
  };
  if (legacyBadge) {
    badge = {
      style: { position: 'fixed', bottom: '4px', left: '8px', zIndex: '9999' },
      parentElement: document.body, onclick() {}, addEventListener() {},
    };
  }
  class FakeTextArea {
    constructor() { this.value = ''; this.tagName = 'TEXTAREA'; this.isConnected = true; }
    focus() { document.activeElement = this; }
    dispatchEvent() {}
    closest(selector) { return selector === '[data-codex-composer-root]' ? this.root : null; }
    getClientRects() { return [{}]; }
  }
  class FakeEditable {
    constructor() { this.innerText = ''; this.tagName = 'DIV'; this.isContentEditable = true; this.isConnected = true; }
    focus() { document.activeElement = this; }
    closest(selector) { return selector === '[data-codex-composer-root]' ? this.root : null; }
    getClientRects() { return [{}]; }
    matches(selector) { return selector === '[data-codex-composer]'; }
  }
  const window = {
    location: { href: `vscode-webview://conversation${route}`, pathname: route },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    dispatchEvent(event) { refreshes.push(event.type); },
  };
  const context = {
    window, document, HTMLTextAreaElement: FakeTextArea,
    Event: class { constructor(type) { this.type = type; } },
    localStorage: { getItem: () => null, setItem() {} },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    setInterval(fn) { interval = fn; },
  };
  if (quotaSnapshot) context.fetch = async () => ({ ok: true, json: async () => quotaSnapshot });

  function addConversation() {
    const box = editorKind === 'contenteditable' ? new FakeEditable() : new FakeTextArea();
    const stop = { isConnected: true, getClientRects: () => [{}], getAttribute: () => 'Stop' };
    const send = {
      isConnected: true, forceDisabled: false, ariaBlocked: false, type: 'button',
      contains(target) { return target === this; },
      getAttribute(name) {
        if (name === 'aria-label') return '傳送';
        if (name === 'aria-disabled') return this.ariaBlocked ? 'true' : null;
        return null;
      },
      get disabled() { return this.forceDisabled || !(box.value ?? box.innerText); },
      click() {
        assert.equal(this.disabled || this.ariaBlocked, false, 'native Send must be enabled before clicking');
        if (sendKeepsDraft) return;
        sends.push({ at: now, text: box.value ?? box.innerText, root });
        if (box.value === undefined) box.innerText = '';
        else box.value = '';
      },
      getClientRects: () => [{}],
    };
    const footer = {
      isConnected: true, lastElementChild: send,
      querySelectorAll: (selector) => selector === 'button[type="submit"]' ? [send] : [],
      insertBefore(item) { item.parentElement = this; },
      getClientRects: () => [{}],
    };
    const root = {
      isConnected: true,
      get innerText() { return unlabelledBanner && alerts.some((alert) => alert.isConnected) ? message : ''; },
      querySelectorAll(selector) {
        if (selector.includes('ComposerLayoutFooter')) return [footer];
        if (selector.includes('contenteditable')) return [box];
        if (selector === 'button[aria-label]') return generating ? [stop] : [];
        if (selector === 'button') return sendAppearsAfterText && !(box.value ?? box.innerText) ? [] : [
          { isConnected: true, type: 'button', getAttribute: () => 'Other', getClientRects: () => [{}] }, send,
        ];
        return [];
      },
      getClientRects: () => [{}],
    };
    box.root = root;
    roots.push(root);
    return { root, footer, box, send };
  }

  function addAlert(text = message) {
    const retry = {
      disabled: !nativeRetry, isConnected: true, innerText: 'Retry',
      contains(target) { return target === this; },
      getClientRects: () => [{}],
      getAttribute: () => '',
      click() { retries.push(now); },
    };
    const alert = {
      innerText: text, isConnected: true,
      getAttribute: (name) => name === 'role' ? role : '',
      querySelectorAll: (selector) => selector === 'button' && nativeRetry ? [retry] : [],
      getClientRects: () => [{}],
    };
    alerts.push(alert);
    return alert;
  }

  const first = addConversation();
  addAlert();
  vm.runInNewContext(source, context);
  function advance(ms) {
    assert.equal(ms % 1000, 0);
    for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
      now += 1000;
      interval();
    }
  }
  return { advance, addConversation, addAlert, alerts, roots, sends, retries, refreshes, first, window, document,
    setGenerating(value) { generating = value; },
    trustedClick(target) { listeners.click({ isTrusted: true, target }); },
    get badge() { return badge; } };
}

{
  const app = setup();
  assert.equal(app.badge.parentElement, app.first.footer, 'button is inside the composer footer');
  app.advance(3 * MINUTE - 1000);
  assert.equal(app.sends.length, 0, 'relative reset time has a two minute buffer');
  app.advance(1000);
  assert.equal(app.first.box.value, 'Continue from where you left off.', 'text is entered even though Send started disabled');
  assert.equal(app.sends.length, 0, 'Send waits for the native editor to update');
  app.advance(1000);
  assert.equal(app.sends.length, 1);
  assert.equal(app.sends[0].text, 'Continue from where you left off.');

  app.alerts[0].isConnected = false;
  app.addAlert('Usage limit reached. Reset in 1 minute.');
  app.advance(2 * MINUTE + 1000);
  assert.equal(app.sends.length, 1,
    'a new native limit alert after Send does not trigger another message without confirmed quota recovery');
  app.alerts[1].isConnected = false;
  app.advance(2 * MINUTE);
  assert.equal(app.sends.length, 1, 'the rejected attempt does not generate duplicate messages');
}

{
  const app = setup({ legacyBadge: true });
  assert.equal(app.badge.parentElement, app.first.footer, 'an old button is moved into the composer');
  assert.equal(app.badge.style.position, 'static', 'old fixed positioning is cleared');
  assert.equal(app.badge.style.bottom, 'auto');
  assert.equal(app.badge.onclick, null, 'old click handler is replaced');
}

{
  const app = setup({ sendAppearsAfterText: true, message: 'Usage limit reached.' });
  app.advance(2 * MINUTE);
  assert.equal(app.first.box.value, 'Continue from where you left off.',
    'continuation is entered before a Send button can be found');
  assert.equal(app.sends.length, 0);
  app.advance(1000);
  assert.equal(app.sends.length, 1, 'the named Send button is clicked after entering text');
}

{
  const app = setup({ nativeRetry: true });
  app.advance(3 * MINUTE);
  assert.equal(app.retries.length, 0, 'native Retry is never clicked');
  app.advance(1000);
  assert.equal(app.sends.length, 1, 'a continuation message is sent even when Retry is visible');
}

{
  const app = setup({ nativeRetry: true });
  app.advance(3 * MINUTE + 1000);
  app.setGenerating(true);
  app.advance(1000);
  app.setGenerating(false);
  app.advance(2 * MINUTE);
  assert.equal(app.retries.length, 0, 'a stale alert does not trigger Retry');
  assert.equal(app.sends.length, 1, 'a stale alert does not duplicate the continuation');
  assert.equal(app.window.codexAutoResume.inspect().limitHandled, true);
}

{
  const app = setup({ message: "You've hit your usage limit. Resets at 12:01 PM." });
  app.advance(3 * MINUTE - 1000);
  assert.equal(app.sends.length, 0, 'absolute reset time includes the two minute buffer');
  app.advance(2000);
  assert.equal(app.sends.length, 1);
}

{
  const app = setup({ message: "You've hit your usage limit." });
  app.advance(2 * MINUTE - 1000);
  assert.equal(app.sends.length, 0, 'unknown reset time waits two minutes');
  app.advance(2000);
  assert.equal(app.sends.length, 1);
}

{
  const app = setup({ message: '你已達使用上限。升級方案或加購點數以繼續使用，或稍後再試。' });
  assert.equal(app.window.codexAutoResume.inspect().limitDetected, true,
    'the current Traditional Chinese limit alert is recognized');
}

{
  const app = setup({ message: 'Limit reached. Try again after 1 minute.', role: 'status',
    nativeRetry: true, editorKind: 'contenteditable' });
  app.advance(MINUTE);
  app.alerts[0].isConnected = false; // The native banner disappears when the quota display refreshes.
  app.advance(2 * MINUTE);
  assert.equal(app.first.box.innerText, 'Continue from where you left off.',
    'a disappeared status banner does not cancel the scheduled continuation');
  assert.equal(app.retries.length, 0, 'a banner CTA is not mistaken for response Retry');
  app.advance(1000);
  assert.equal(app.sends.length, 1, 'contenteditable composer sends after reset');
}

{
  const app = setup({ message: 'Usage limit reached.' });
  app.first.send.forceDisabled = true;
  app.advance(2 * MINUTE + 1000);
  assert.equal(app.first.box.value, 'Continue from where you left off.');
  assert.equal(app.sends.length, 0);
  assert.equal(app.badge.title, 'Send button disabled; retrying');
  app.first.send.forceDisabled = false;
  app.advance(MINUTE);
  assert.equal(app.sends.length, 1, 'disabled Send is retried after one minute');
}

{
  const app = setup({ message: 'Usage limit reached.' });
  app.advance(2 * MINUTE);
  app.first.box.value = ''; // Native editor replaced the attempted draft during a rerender.
  app.advance(1000);
  assert.equal(app.first.box.value, 'Continue from where you left off.');
  app.advance(1000);
  assert.equal(app.sends.length, 1, 'a cleared draft is re-entered before sending');
}

{
  const app = setup({ message: 'You have reached your messages limit. Resets in 1 minute.',
    role: null, unlabelledBanner: true });
  assert.equal(app.window.codexAutoResume.inspect().limitSource, 'composer',
    'an unlabelled native hard-block banner is detected inside the composer');
  assert.equal(app.badge.textContent, '● AR: 3m', 'the hard-block banner starts the countdown');
  app.advance(3 * MINUTE + 1000);
  assert.equal(app.sends.length, 1, 'the hard-block banner reaches the send path');
}

{
  const app = setup({ message: 'Usage limit reached. Reset in 1 minute.' });
  app.advance(3 * MINUTE + 1000);
  assert.equal(app.sends.length, 1);
  app.advance(4 * MINUTE);
  const status = app.window.codexAutoResume.inspect();
  assert.equal(app.sends.length, 1, 'a persistent old limit alert does not resend the continuation');
  assert.equal(status.limitDetected, true, 'the old alert can still be visible');
  assert.equal(status.limitHandled, true, 'the unchanged alert is remembered as handled');
  assert.equal(status.pending, false);

  app.alerts[0].innerText = 'Usage limit reached. Reset in 2 minutes.';
  app.advance(1000);
  assert.equal(app.window.codexAutoResume.inspect().pending, true,
    'a changed reset time on the same alert schedules a new attempt');
  app.advance(4 * MINUTE + 1000);
  assert.equal(app.sends.length, 2);
}

{
  const app = setup({ message: 'You have reached your messages limit. Resets in 1 minute.',
    role: null, unlabelledBanner: true });
  app.advance(7 * MINUTE);
  assert.equal(app.sends.length, 1, 'a persistent unlabelled composer banner does not cause duplicate sends');
  assert.equal(app.window.codexAutoResume.inspect().limitHandled, true);
}

{
  const app = setup({
    message: '你的 Codex 訊息已用完。你的速率限制將於 清晨6:37 重設。',
    role: null,
    unlabelledBanner: true,
    startAt: '2026-10-21T06:36:00',
  });
  assert.equal(app.window.codexAutoResume.inspect().limitSource, 'composer');
  app.advance(3 * MINUTE - 1000);
  assert.equal(app.sends.length, 0, 'the actual Traditional Chinese reset time is respected');
  app.advance(2000);
  assert.equal(app.sends.length, 1, 'the continuation is sent after the displayed reset plus grace');
}

{
  const app = setup({
    message: '你的 Codex 訊息已用完。你的速率限制將於 清晨6:37 重設。',
    role: null,
    unlabelledBanner: true,
    startAt: '2026-10-21T06:40:00',
  });
  app.advance(2 * MINUTE);
  assert.equal(app.sends.length, 1, 'a reset time already in the past is tried immediately');
  assert.equal(app.window.codexAutoResume.inspect().limitHandled, true,
    'the stale Chinese banner is ignored after the attempt is accepted');
}

{
  const app = setup({ message: 'Usage limit reached.' });
  app.first.root.isConnected = false;
  app.addConversation();
  app.advance(2 * MINUTE + 1000);
  assert.equal(app.sends.length, 0, 'a replaced composer cancels the timer when the conversation cannot be identified');
}

{
  const app = setup({ message: 'Usage limit reached.',
    route: '/local/00000000-0000-4000-8000-000000000001' });
  app.first.root.isConnected = false;
  const replacement = app.addConversation();
  app.advance(2 * MINUTE + 1000);
  assert.equal(app.sends.length, 1, 'a composer redraw in the same identified thread keeps the timer');
  assert.equal(app.sends[0].root, replacement.root);
}

{
  const app = setup({ message: 'Usage limit reached.',
    route: '/local/00000000-0000-4000-8000-000000000001' });
  app.advance(3 * MINUTE);
  assert.equal(app.sends.length, 1);
  app.alerts[0].isConnected = false;
  app.addAlert('Usage limit reached.');
  app.advance(4 * MINUTE);
  assert.equal(app.sends.length, 1,
    'repainting the same stale warning later in an identified thread does not resend');
}

{
  const app = setup({ message: '用量上限已重置。' });
  assert.equal(app.window.codexAutoResume.inspect().limitDetected, false,
    'a quota-reset status is not mistaken for an exhausted quota');
}

{
  const app = setup({ message: 'Usage limit reached.', sendKeepsDraft: true });
  app.advance(2 * MINUTE + 1000);
  assert.equal(app.sends.length, 0, 'a native Send click that does nothing is not counted as success');
  app.alerts[0].isConnected = false;
  app.advance(MINUTE);
  assert.equal(app.badge.title, 'Send did not clear the draft; retrying');
  app.advance(MINUTE);
  assert.equal(app.first.box.value, 'Continue from where you left off.');
}

{
  const app = setup({ message: 'Usage limit reached.', editorKind: 'contenteditable' });
  const other = {
    innerText: '', isContentEditable: true, tagName: 'DIV', isConnected: true,
    getClientRects: () => [{}], matches: () => false,
  };
  const query = app.first.root.querySelectorAll.bind(app.first.root);
  app.first.root.querySelectorAll = (selector) => selector.includes('contenteditable')
    ? [app.first.box, other] : query(selector);
  app.document.activeElement = other;
  app.advance(2 * MINUTE);
  assert.equal(app.first.box.innerText, 'Continue from where you left off.');
  assert.equal(other.innerText, '', 'a different focused editor is not modified');
}

{
  const app = setup({ message: 'Usage limit reached.' });
  app.trustedClick(app.first.send);
  app.alerts[0].isConnected = false;
  app.advance(3 * MINUTE);
  assert.equal(app.sends.length, 0, 'a manual Send cancels the scheduled continuation');
}

{
  const app = setup({ message: 'Usage limit reached.' });
  app.advance(2 * MINUTE - 1000);
  app.setGenerating(true);
  app.advance(2000);
  assert.equal(app.sends.length, 0, 'native generation pauses the attempt');
  app.setGenerating(false);
  app.advance(MINUTE + 2000);
  assert.equal(app.sends.length, 1, 'a failed native resume does not cancel retries');
}

{
  const app = setup({ message: 'Usage limit reached.' });
  app.setGenerating(true);
  app.advance(5000);
  app.alerts[0].isConnected = false;
  app.setGenerating(false);
  app.advance(3 * MINUTE);
  assert.equal(app.sends.length, 0, 'a completed native response prevents a duplicate continuation');
}

{
  const app = setup({ message: 'Usage limit reached.' });
  app.advance(2 * MINUTE + 1000);
  assert.equal(app.sends.length, 1);
  app.setGenerating(true);
  app.advance(1000);
  app.setGenerating(false);
  app.advance(2 * MINUTE);
  assert.equal(app.sends.length, 1, 'an observed native response completes the attempt despite a stale alert');
  assert.equal(app.window.codexAutoResume.inspect().limitHandled, true);
}

{
  const app = setup();
  app.first.box.value = 'my unsent draft';
  app.advance(4 * MINUTE);
  assert.equal(app.sends.length, 0, 'an unsent draft is preserved');
  assert.equal(app.first.box.value, 'my unsent draft');
}

{
  const app = setup();
  const next = app.addConversation();
  app.advance(1000);
  assert.equal(app.badge.parentElement, next.footer, 'button moves to the active conversation');
  app.advance(4 * MINUTE);
  assert.equal(app.sends.length, 0, 'an old alert cannot send in a new conversation');
  app.alerts[0].isConnected = false;
  app.addAlert('Usage limit reached. Reset in 1 minute.');
  app.advance(1000);
  app.advance(3 * MINUTE + 1000);
  assert.equal(app.sends.length, 1, 'a new alert in the current conversation is handled');
  assert.equal(app.sends[0].root, next.root);
}

{
  const app = setup();
  app.advance(1000);
  app.window.location.href = 'vscode-webview://conversation/b';
  app.advance(4 * MINUTE);
  assert.equal(app.sends.length, 0, 'navigation cancels the old conversation timer');
}

{
  const app = setup({ message: 'Unrelated error' });
  app.advance(5 * MINUTE);
  assert.equal(app.sends.length, 0, 'unrelated alerts do not trigger auto-send');
}

console.log('payload behavior tests passed');

(async () => {
  const observedAt = Date.parse('2026-10-21T12:00:00') / 1000;
  const available = setup({
    message: 'Usage limit reached. Reset in 3 hours.',
    quotaSnapshot: { observedAt, ordinaryUsageAllowed: true, buckets: {} },
  });
  await new Promise(setImmediate);
  assert.equal(available.window.codexAutoResume.inspect().quota.ordinaryUsageAllowed, true);
  available.advance(2000);
  assert.equal(available.sends.length, 1,
    'a current server snapshot overrides the old on-screen reset message');

  const blocked = setup({
    message: 'Usage limit reached. Resets at 11:00 AM.',
    quotaSnapshot: { observedAt, ordinaryUsageAllowed: false, buckets: {
      codex: { primary: { windowDurationMins: 300, usedPercent: 100,
        resetsAt: observedAt + 1800 } },
    } },
  });
  await new Promise(setImmediate);
  blocked.advance(2 * MINUTE);
  assert.equal(blocked.sends.length, 0,
    'a current server snapshot prevents an early retry caused by a stale banner');

  const stillBlocked = setup({
    message: 'Usage limit reached. Resets at 11:00 AM.',
    quotaSnapshot: { observedAt, ordinaryUsageAllowed: false, buckets: {
      codex: { primary: { windowDurationMins: 300, usedPercent: 100,
        resetsAt: observedAt - 60 } },
    } },
  });
  await new Promise(setImmediate);
  stillBlocked.advance(2 * MINUTE);
  assert.equal(stillBlocked.sends.length, 0,
    'a reset timestamp in the past does not override a server blocked state');

  const weeklySnapshot = { observedAt, ordinaryUsageAllowed: true, buckets: {
      codex: {
        primary: { windowDurationMins: 300, usedPercent: 25, resetsAt: observedAt + 1800 },
        secondary: { windowDurationMins: 10080, usedPercent: 100,
          resetsAt: observedAt + 7 * 24 * 3600 },
      },
    } };
  const weeklyBlocked = setup({
    message: '你已達使用上限。',
    quotaSnapshot: weeklySnapshot,
  });
  await new Promise(setImmediate);
  weeklyBlocked.advance(5 * MINUTE);
  assert.equal(weeklyBlocked.sends.length, 0,
    'an exhausted weekly window blocks Send even when the five-hour window has room');
  assert.equal(weeklyBlocked.window.codexAutoResume.inspect().pending, true);
  weeklySnapshot.observedAt = observedAt + 6 * 60;
  weeklySnapshot.buckets.codex.secondary.usedPercent = 0;
  weeklySnapshot.buckets.codex.secondary.resetsAt += 7 * 24 * 3600;
  weeklyBlocked.advance(MINUTE);
  await new Promise(setImmediate);
  weeklyBlocked.advance(2000);
  assert.equal(weeklyBlocked.sends.length, 1,
    'a fresh weekly recovery snapshot releases the single pending continuation');

  const weeklyRemainingZero = setup({
    quotaSnapshot: { observedAt, ordinaryUsageAllowed: true, buckets: {
      codex: {
        primary: { windowDurationMins: 300, usedPercent: 20, resetsAt: observedAt + 1800 },
        secondary: { windowDurationMins: 10080, remainingPercent: 0,
          resetsAt: observedAt + 7 * 24 * 3600 },
      },
    } },
  });
  await new Promise(setImmediate);
  weeklyRemainingZero.advance(5 * MINUTE);
  assert.equal(weeklyRemainingZero.sends.length, 0,
    'a reported zero remaining weekly percent also blocks Send');

  const permissionUnknown = setup({
    quotaSnapshot: { observedAt, ordinaryUsageAllowed: null, buckets: {
      codex: {
        primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: observedAt + 1800 },
        secondary: { windowDurationMins: 10080, usedPercent: 0,
          resetsAt: observedAt + 7 * 24 * 3600 },
      },
    } },
  });
  await new Promise(setImmediate);
  permissionUnknown.advance(2 * MINUTE);
  assert.equal(permissionUnknown.sends.length, 0,
    'unknown server permission does not infer recovery from available percentages');

  const staleSnapshot = setup({
    message: 'Usage limit reached.',
    quotaSnapshot: { observedAt: observedAt - 300, ordinaryUsageAllowed: true, buckets: {
      codex: {
        primary: { windowDurationMins: 300, usedPercent: 0 },
        secondary: { windowDurationMins: 10080, usedPercent: 0 },
      },
    } },
  });
  await new Promise(setImmediate);
  staleSnapshot.advance(3 * MINUTE);
  assert.equal(staleSnapshot.sends.length, 0,
    'a previously loaded but stale quota snapshot cannot authorize Send');

  const staleNative = setup({
    message: 'Usage limit reached. Reset in 3 hours.', quotaControl: true,
    quotaSnapshot: { observedAt, ordinaryUsageAllowed: true, buckets: {} },
  });
  staleNative.first.send.ariaBlocked = true;
  await new Promise(setImmediate);
  staleNative.advance(2000);
  assert.deepEqual(staleNative.refreshes.slice(0, 2), ['visibilitychange', 'focus'],
    'a server-allowed quota refreshes the native state before giving up on disabled Send');
  staleNative.advance(5000);
  assert.equal(staleNative.refreshes.includes('quota-click'), true,
    'the native quota control is opened if a focus refresh did not unlock Send');
  staleNative.first.send.ariaBlocked = false;
  staleNative.advance(5000);
  assert.equal(staleNative.sends.length, 1);
  console.log('quota scheduling tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

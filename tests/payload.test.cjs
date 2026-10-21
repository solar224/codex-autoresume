const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'payload.js'), 'utf8');
const MINUTE = 60_000;

function setup({ message = "You've hit your usage limit. Try again in 1 minute.", nativeRetry = false, legacyBadge = false } = {}) {
  let now = Date.parse('2026-10-21T12:00:00Z');
  let interval;
  let badge;
  const alerts = [];
  const roots = [];
  const sends = [];
  const retries = [];
  const document = {
    body: {}, activeElement: null,
    querySelectorAll(selector) {
      if (selector === '[data-codex-composer-root]') return roots;
      if (selector === '[role="alert"]') return alerts.filter((alert) => alert.isConnected);
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
  const window = {
    location: { href: 'vscode-webview://conversation/a' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
  const context = {
    window, document, HTMLTextAreaElement: FakeTextArea,
    Event: class {},
    localStorage: { getItem: () => null, setItem() {} },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    setInterval(fn) { interval = fn; },
  };

  function addConversation() {
    const box = new FakeTextArea();
    const send = {
      disabled: false, isConnected: true,
      click() { sends.push({ at: now, text: box.value, root }); box.value = ''; },
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
      querySelectorAll(selector) {
        if (selector.includes('ComposerLayoutFooter')) return [footer];
        if (selector.includes('contenteditable')) return [box];
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
      getClientRects: () => [{}],
      getAttribute: () => '',
      click() { retries.push(now); },
    };
    const alert = {
      innerText: text, isConnected: true,
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
  return { advance, addConversation, addAlert, alerts, roots, sends, retries, first, window,
    get badge() { return badge; } };
}

{
  const app = setup();
  assert.equal(app.badge.parentElement, app.first.footer, 'button is inside the composer footer');
  app.advance(3 * MINUTE - 1000);
  assert.equal(app.sends.length, 0, 'relative reset time has a two minute buffer');
  app.advance(1000);
  assert.equal(app.sends.length, 1);
  assert.equal(app.sends[0].text, 'Continue from where you left off.');

  app.alerts[0].isConnected = false;
  app.addAlert('Usage limit reached. Reset in 1 minute.');
  app.advance(MINUTE - 1000);
  assert.equal(app.sends.length, 1, 'failure does not cause an early retry');
  app.advance(1000);
  assert.equal(app.sends.length, 2, 'new alert is retried one minute after first send');
  app.alerts[1].isConnected = false;
  app.advance(2 * MINUTE);
  assert.equal(app.sends.length, 2, 'success does not generate duplicate messages');
}

{
  const app = setup({ legacyBadge: true });
  assert.equal(app.badge.parentElement, app.first.footer, 'an old button is moved into the composer');
  assert.equal(app.badge.style.position, 'static', 'old fixed positioning is cleared');
  assert.equal(app.badge.style.bottom, 'auto');
  assert.equal(app.badge.onclick, null, 'old click handler is replaced');
}

{
  const app = setup({ nativeRetry: true });
  app.advance(3 * MINUTE);
  assert.equal(app.retries.length, 1, 'native Retry is preferred');
  assert.equal(app.sends.length, 0);
  app.advance(MINUTE);
  assert.equal(app.retries.length, 2, 'native Retry repeats every minute while the alert remains');
}

{
  const app = setup({ message: "You've hit your usage limit. Resets at 12:01 PM." });
  app.advance(3 * MINUTE - 1000);
  assert.equal(app.sends.length, 0, 'absolute reset time includes the two minute buffer');
  app.advance(1000);
  assert.equal(app.sends.length, 1);
}

{
  const app = setup({ message: "You've hit your usage limit." });
  app.advance(2 * MINUTE - 1000);
  assert.equal(app.sends.length, 0, 'unknown reset time waits two minutes');
  app.advance(1000);
  assert.equal(app.sends.length, 1);
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
  app.advance(3 * MINUTE);
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

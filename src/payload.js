/* CODEX_AUTORESUME_START */
(function () {
  if (window.__codexAutoResumeLoaded) return;
  window.__codexAutoResumeLoaded = true;

  ["codex-autoresume-badge", "codex-ar-widget"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });

  let enabled = localStorage.getItem("codex_ar_enabled") !== "false";
  let waiting = false;
  let resumeTimer = null;
  let tickTimer = null;
  let resetAt = 0;

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    if (res.status === 429) {
      const retryHeader = res.headers.get("retry-after") || res.headers.get("x-ratelimit-reset-requests");
      if (retryHeader && !isNaN(retryHeader)) {
        scheduleResume((parseInt(retryHeader, 10) + 30) * 1000);
      } else {
        res.clone().json().then((data) => {
          const ts = data?.error?.resets_at || data?.resets_at || data?.detail?.resets_at;
          if (ts) scheduleResume(ts * 1000 - Date.now() + 30000);
        }).catch(() => {});
      }
    }
    return res;
  };

  function parseTimeFromText(text) {
    const now = new Date();

    const relMin = text.match(/(\d+)\s*(?:minutes?|mins?|m\b|分鐘|分)/i);
    const relHr = text.match(/(\d+)\s*(?:hours?|hrs?|h\b|小時|時)/i);
    if (relMin || relHr) {
      const mins = (relHr ? parseInt(relHr[1], 10) * 60 : 0) + (relMin ? parseInt(relMin[1], 10) : 0);
      if (mins > 0 && mins < 1440) return (mins + 1) * 60000;
    }

    const clockRe = /(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜間|午前|午後)?\s*(\d{1,2})\s*[:點時]\s*(\d{2})\s*([AaPp][Mm])?/;
    const m = text.match(clockRe);
    if (m) {
      const prefix = m[1] || "";
      let hr = parseInt(m[2], 10);
      const min = parseInt(m[3], 10);
      const mer = (m[4] || "").toUpperCase();

      if ((/下午|傍晚|晚上|夜間|午後/.test(prefix) || mer === "PM") && hr < 12) hr += 12;
      else if ((/凌晨|清晨|早上|上午|午前/.test(prefix) || mer === "AM") && hr === 12) hr = 0;
      else if (prefix === "中午" && hr < 11) hr += 12;

      const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hr, min, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      const diff = target - now;
      if (diff > 0 && diff < 86400000) return diff + 45000;
    }
    return 900000;
  }

  function mountInlineButton() {
    let btn = document.getElementById("codex-ar-inline");
    const editor = document.querySelector('#prompt-textarea, textarea, [contenteditable="true"]');
    const formToolbar = editor ? editor.closest("form, div")?.querySelector("div:has(button)") : null;

    if (!btn) {
      btn = document.createElement("button");
      btn.id = "codex-ar-inline";
      btn.type = "button";
      Object.assign(btn.style, {
        display: "inline-flex", alignItems: "center", gap: "5px",
        padding: "2px 7px", marginLeft: "4px", marginRight: "auto",
        borderRadius: "4px", fontSize: "11px", fontFamily: "monospace",
        border: "1px solid rgba(255,255,255,0.12)", background: "transparent",
        color: "#a1a1aa", cursor: "pointer", whiteSpace: "nowrap", lineHeight: "1.4"
      });
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        enabled = !enabled;
        localStorage.setItem("codex_ar_enabled", enabled);
        if (!enabled) cancelSchedule();
        renderStatus();
      };
    }

    if (formToolbar && btn.parentElement !== formToolbar) {
      const children = Array.from(formToolbar.children);
      if (children.length >= 2) {
        formToolbar.insertBefore(btn, children[children.length - 1]);
      } else {
        formToolbar.appendChild(btn);
      }
    } else if (!formToolbar && !btn.parentElement && document.body) {
      Object.assign(btn.style, { position: "fixed", bottom: "4px", left: "8px", zIndex: "9999" });
      document.body.appendChild(btn);
    }
    renderStatus();
  }

  function renderStatus(countdownStr = "") {
    const btn = document.getElementById("codex-ar-inline");
    if (!btn) return;

    if (!enabled) {
      btn.style.color = "#71717a";
      btn.style.borderColor = "rgba(255,255,255,0.08)";
      btn.innerText = "○ AR: OFF";
      btn.title = "Auto-Resume disabled (Click to enable)";
    } else if (waiting) {
      btn.style.color = "#fbbf24";
      btn.style.borderColor = "rgba(251,191,36,0.3)";
      btn.innerText = `● AR: ${countdownStr}`;
      btn.title = "Waiting for rate limit reset (Click to cancel)";
    } else {
      btn.style.color = "#34d399";
      btn.style.borderColor = "rgba(52,211,153,0.25)";
      btn.innerText = "● AR: ON";
      btn.title = "Auto-Resume active (Click to disable)";
    }
  }

  function cancelSchedule() {
    waiting = false;
    if (resumeTimer) clearTimeout(resumeTimer);
    if (tickTimer) clearInterval(tickTimer);
  }

  function scheduleResume(waitMs) {
    if (!enabled || waiting) return;
    waiting = true;
    resetAt = Date.now() + waitMs;

    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      if (!enabled) return;
      const rem = Math.max(0, Math.floor((resetAt - Date.now()) / 1000));
      const h = Math.floor(rem / 3600);
      const m = Math.floor((rem % 3600) / 60);
      const s = rem % 60;
      renderStatus(h > 0 ? `${h}h${m}m` : `${m}m${s}s`);
    }, 1000);

    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(triggerResume, waitMs);
  }

  function triggerResume() {
    if (!enabled) return;
    cancelSchedule();

    const buttons = Array.from(document.querySelectorAll("button"));
    const retryBtn = buttons.find((b) => {
      const txt = (b.innerText || "").trim();
      return /^(retry|resume|continue|try again|繼續|重試|繼續產生)$/i.test(txt) && !b.disabled;
    });

    if (retryBtn) {
      retryBtn.click();
      return;
    }

    const editor = document.querySelector('#prompt-textarea, textarea, [contenteditable="true"]');
    if (!editor) return;

    const msg = "Continue from where you left off.";
    editor.focus();

    if (editor.tagName.toLowerCase() === "textarea") {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) setter.call(editor, msg);
      else editor.value = msg;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, msg);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }

    setTimeout(() => {
      const allBtns = Array.from(document.querySelectorAll("button"));
      const sendBtn = allBtns.find((b) =>
        b.getAttribute("data-testid")?.includes("send") ||
        b.getAttribute("aria-label")?.toLowerCase().includes("send") ||
        b.type === "submit"
      ) || allBtns[allBtns.length - 1];

      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
      } else {
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      }
      renderStatus();
    }, 600);
  }

  setInterval(() => {
    if (!document.body) return;
    mountInlineButton();
    if (!enabled || waiting) return;

    const stopBtn = document.querySelector('button[data-testid*="stop"], button[aria-label*="Stop"]');
    if (stopBtn) return;

    const bodyText = document.body.innerText || "";
    const limitRe = /(out of.*messages|rate limit.*reset|reached your.*limit|usage limit|訊息已用完|速率限制將於|已達到.*上限)/i;
    const match = bodyText.match(limitRe);

    if (match) {
      const idx = match.index || 0;
      const snippet = bodyText.substring(Math.max(0, idx - 20), Math.min(bodyText.length, idx + 160));
      scheduleResume(parseTimeFromText(snippet));
    }
  }, 3000);
})();
/* CODEX_AUTORESUME_END */

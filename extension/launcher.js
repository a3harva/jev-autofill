// Shows a small "Fill with JEV" button on pages that look like a job application form.
// Clicking it runs the same fill as the toolbar button. It reacts only to trusted clicks
// (a real mouse or an automation tool's input events), never to a page script's .click().
(() => {
  if (window.__jevLauncher) return;
  window.__jevLauncher = true;

  const ATS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|smartrecruiters\.com|icims\.com|successfactors\.(com|eu)|sapsf\.(com|eu)|phenompeople\.com|breezy\.hr|zohorecruit\.(com|in)|oraclecloud\.com|pyjamahr\.com|jobvite\.com|recruitee\.com|workable\.com|bamboohr\.com|teamtailor\.com|personio\.(de|com)|jazzhr\.com|applytojob\.com|eightfold\.ai|darwinbox\.in|keka\.com|freshteam\.com)$/i;
  const NEVER = /(^|\.)(naukri\.com|google\.com|gmail\.com|youtube\.com)$/i;
  const TEXTY = /^(text|email|tel|number|url|search|date|month|file|)$/;
  const host = location.hostname;
  let hidden = false;
  let state = "idle";
  let el;
  let label;
  let observer;
  // Set while the site permission question is shown; answers the background worker.
  let answer = null;

  // When the extension is reloaded or updated, this copy keeps running in tabs that were already
  // open, but it is cut off: every chrome.* call throws "Extension context invalidated". Chrome
  // then leaves chrome.runtime.id unset, so check it before each call and step aside if it's gone.
  const alive = () => { try { return Boolean(chrome.runtime?.id); } catch { return false; } };

  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return e.type === "file"; // file inputs are often hidden behind a styled button
    const s = getComputedStyle(e);
    return s.visibility !== "hidden" && s.display !== "none";
  };

  // Fields inside shadow roots too: SuccessFactors' new apply wizard draws every box as a UI5 web
  // component, so a plain query found none and the button never showed (Birlasoft, 2026-11-21).
  const UI5 = "ui5-input, ui5-textarea, ui5-select, ui5-combobox, ui5-multi-combobox, ui5-date-picker, ui5-file-uploader";
  function deepFields(root) {
    const out = [];
    const walk = (node) => {
      for (const e of node.querySelectorAll(`input, select, textarea, ${UI5}`)) {
        // A UI5 element's own inner <input> lives in its shadow root; count the element once.
        if (e.getRootNode() instanceof ShadowRoot && e.getRootNode().host.matches(UI5)) continue;
        out.push(e);
      }
      for (const h of node.querySelectorAll("*")) if (h.shadowRoot && !h.matches(UI5)) walk(h.shadowRoot);
    };
    walk(root);
    return out;
  }

  function words(e) {
    const own = [e.name, e.id, e.placeholder, e.getAttribute("placeholder"), e.getAttribute("aria-label"), e.getAttribute("accessible-name"), e.getAttribute("autocomplete"), e.getAttribute("accept")];
    if (e.tagName === "UI5-FILE-UPLOADER") own.push("resume upload file");
    if (e.id) own.push(...[...document.querySelectorAll(`label[for="${CSS.escape(e.id)}"]`)].map((l) => l.textContent));
    const wrap = e.closest("label");
    if (wrap) own.push(wrap.textContent);
    const box = e.closest("[class*=field i], [class*=question i], .form-group, li, fieldset");
    if (box) own.push(box.textContent.slice(0, 200));
    return own.filter(Boolean).join(" ").toLowerCase();
  }

  // The form in the open dialog if there is one (LinkedIn Easy Apply), else the whole page.
  function scope() {
    // Only a dialog that is actually on screen with visible fields; sites keep hidden, zero-size ones around (Greenhouse).
    const shown = (d) => { const r = d.getBoundingClientRect(); return r.width > 50 && r.height > 50 && getComputedStyle(d).visibility !== "hidden"; };
    const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"]')].filter((d) => shown(d) && [...d.querySelectorAll("input, select, textarea")].some(visible));
    if (/(^|\.)linkedin\.com$/i.test(host)) return dialogs[0] || null; // LinkedIn: only inside the Easy Apply dialog
    return dialogs[0] || document;
  }

  function looksLikeApplication() {
    if (NEVER.test(host)) return false;
    const root = scope();
    if (!root) return false;
    const fields = deepFields(root).filter((e) => {
      if (e.tagName.includes("-")) return visible(e); // a web-component field (SAP UI5 on SuccessFactors)
      const t = (e.getAttribute("type") || "").toLowerCase();
      if (e.tagName === "INPUT" && !TEXTY.test(t) && t !== "radio" && t !== "checkbox" && t !== "password") return false;
      return visible(e);
    });
    const all = fields.map(words);
    if (all.some((w) => /cc-number|cc-csc|card ?number|\bcvv\b|\bcvc\b/.test(w))) return false;
    if (fields.length < 3) return false;
    // A sign-in or sign-up box: a password field with only a few other fields. Long application
    // forms that also create an account password (Workday, Oracle) still count.
    if (root.querySelector('input[type="password"]') && fields.length < 6) return false;
    if (ATS.test(host) || /linkedin\.com$/i.test(host)) return true;
    const resume = fields.some((e, i) => (e.type === "file" || e.tagName === "UI5-FILE-UPLOADER") && /resume|cv\b|curriculum|\.pdf|\.docx?/.test(all[i]));
    const signals = [
      fields.some((e, i) => e.type === "email" || /e-?mail/.test(all[i])),
      fields.some((e, i) => e.type === "tel" || /phone|mobile/.test(all[i])),
      all.some((w) => /given-name|first.?name|full.?name|your name|\bname\b/.test(w)),
    ].filter(Boolean).length;
    if (resume) return true;
    // Name + email + phone alone is any contact or order form (httpbin's pizza form). Off the known
    // job sites, also require the page to be about a job application.
    const about = `${location.href} ${document.title} ${[...document.querySelectorAll("h1, h2, h3, legend, button, [type=submit]")].map((e) => e.textContent).join(" ")}`.toLowerCase();
    return signals >= 2 && /\b(apply|application|applicant|career|careers|job|jobs|candidate|vacanc|recruit|hiring|position|opening)/.test(about);
  }

  function build() {
    el = document.createElement("jev-autofill");
    el.setAttribute("data-state", "idle");
    const shadow = el.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      :host{all:initial;position:fixed;right:16px;bottom:88px;z-index:2147483646;font:600 13px/1 -apple-system,system-ui,sans-serif}
      .pill{display:flex;align-items:center;gap:2px;background:#1d4ed8;color:#fff;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.25)}
      button{all:unset;cursor:pointer;padding:9px 12px;color:#fff}
      #x{padding:9px 10px 9px 4px;opacity:.75}
      :host([data-state=running]) .pill{background:#6b7280}
      :host([data-state=error]) .pill{background:#b91c1c}
      :host([data-state=done]) .pill{background:#15803d}
      :host([data-state=needs-approval]) .pill{background:#b45309}
      :host([data-state=declined]) .pill{background:#4b5563}
      #ask{display:none;flex-direction:column;gap:6px;margin-bottom:6px;background:#1f2430;color:#fff;font:400 13px/1.35 system-ui,sans-serif;padding:10px 12px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.25);max-width:300px}
      :host([data-state=needs-approval]) #ask{display:flex}
      #ask div{display:flex;gap:6px}
      #ask button{border:1px solid #666;border-radius:5px;padding:5px 9px}
      #ask button.primary{background:#2563eb;border-color:#2563eb}
    </style><div id="ask" role="dialog" aria-label="Allow JEV Autofill on this site"><span id="ask-text"></span><div><button id="no">Not now</button><button id="once">Allow once</button><button id="always" class="primary">Always allow</button></div></div><div class="pill"><button id="go" aria-label="Fill with JEV">Fill with JEV</button><button id="x" aria-label="Hide JEV on this site" title="Hide on this site">×</button></div>`;
    label = shadow.getElementById("go");
    label.addEventListener("click", run);
    // The site permission question, asked right here when the run came from this button. Only real
    // clicks answer it, so a page script can't allow itself.
    for (const [id, value] of [["no", null], ["once", "once"], ["always", "always"]]) {
      shadow.getElementById(id).addEventListener("click", (e) => {
        if (!e.isTrusted || !answer) return;
        answer(value);
      });
    }
    shadow.getElementById("ask-text").textContent = `Allow JEV Autofill to run on ${location.origin}? It fills your profile into this page's form fields.`;
    shadow.getElementById("x").addEventListener("click", async (e) => {
      if (!e.isTrusted) return;
      hidden = true;
      el.remove();
      if (!alive()) return; // cut off: hide it here, but the setting can't be saved
      try {
        const { jevHidden = [] } = await chrome.storage.local.get("jevHidden");
        await chrome.storage.local.set({ jevHidden: [...new Set([...jevHidden, host])] });
      } catch {}
    });
  }

  function set(next, text, extra = {}) {
    state = next;
    el.setAttribute("data-state", next);
    for (const [k, v] of Object.entries(extra)) el.setAttribute(`data-${k}`, String(v));
    label.textContent = text;
  }

  if (alive()) {
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (sender.id !== chrome.runtime.id || msg.type !== "confirm" || !el) return;
      if (!el.isConnected) document.documentElement.appendChild(el);
      set("needs-approval", "JEV: allow this site?");
      const timer = setTimeout(() => answer && answer(null), 90000);
      answer = (value) => {
        clearTimeout(timer);
        answer = null;
        set("running", value ? "JEV: filling…" : "JEV: not allowed here");
        reply(value);
      };
      return true;
    });
  }

  async function run(e) {
    if (!e.isTrusted || state === "running" || state === "needs-approval") return;
    if (!alive()) return set("error", "JEV: reload this page", { error: "the extension was reloaded" });
    set("running", "JEV: filling…");
    try {
      const res = await chrome.runtime.sendMessage({ type: "run" });
      // Not allowed on this site (or the question timed out): not a failure, and clicking again asks again.
      if (res?.declined) return set("declined", "JEV: not allowed here · click to ask again", { error: res.error });
      if (!res || res.error) throw new Error(res ? res.error : "no answer");
      set(res.fillError ? "error" : "done", `JEV: ${res.filled} filled · ${res.left} left`, { filled: res.filled, left: res.left });
      if (res.fillError) el.setAttribute("data-error", res.fillError);
    } catch (err) {
      set("error", alive() ? "JEV: error" : "JEV: reload this page", { error: String(err.message || err) });
    }
  }

  function check() {
    if (hidden) return;
    if (!alive()) {
      // Cut off: stop watching the page and take the dead button away (keep an error it already shows).
      observer?.disconnect();
      if (state !== "error") el.remove();
      return;
    }
    const busy = state === "running" || state === "needs-approval";
    const show = busy || looksLikeApplication();
    if (show && !el.isConnected) document.documentElement.appendChild(el);
    if (!show && el.isConnected && !busy) el.remove();
  }

  chrome.storage.local.get("jevHidden").then(({ jevHidden = [] }) => {
    hidden = jevHidden.includes(host);
    if (hidden) return;
    build();
    check();
    let timer = 0;
    observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(check, 500);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "open", "hidden"] });
  }).catch(() => {});
})();

// Runs the fill on a toolbar or in-page button click and relays requests to the local helper, which holds the key and profile.
const HOST = "com.jev_auto_mapper.host";
// Tab id -> the top frame's origin while a fill is running.
const active = new Map();
// Tab ids with a click being confirmed or a fill already in flight.
const busy = new Set();

function askHost(msg) {
  return chrome.runtime.sendNativeMessage(HOST, msg).then((res) => {
    if (res?.error) throw new Error(res.error);
    return res;
  });
}

async function handle(msg) {
  if (msg.type === "map" && Array.isArray(msg.fields)) {
    const { model, maxBytes } = await chrome.storage.local.get(["model", "maxBytes"]);
    return askHost({ type: "map", title: msg.title, fields: msg.fields, model, maxBytes, verifyBelow: typeof msg.verifyBelow === "number" ? msg.verifyBelow : undefined });
  }
  if (msg.type === "pick" && Array.isArray(msg.fields)) {
    const { maxBytes } = await chrome.storage.local.get(["maxBytes"]);
    return askHost({ type: "pick", title: msg.title, fields: msg.fields, threshold: msg.threshold, maxBytes });
  }
  if (msg.type === "values" && Array.isArray(msg.keys)) return askHost({ type: "values", keys: msg.keys });
  if (msg.type === "resume") return askHost({ type: "resume" });
  if (msg.type === "answer" && Array.isArray(msg.options)) return askHost({ type: "answer", question: msg.question, section: msg.section, options: msg.options });
  if (msg.type === "workday") return askHost({ type: "workday" });
  if (msg.type === "choose" && Array.isArray(msg.options)) return askHost({ type: "choose", kind: msg.kind, term: msg.term, options: msg.options });
  throw new Error("unknown request");
}

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.tab) return;
  // The in-page "Fill with JEV" button (launcher.js) asks for a run of its own tab. It sends this only
  // on a trusted click, and the run still goes through the same per-site confirmation as the toolbar.
  if (msg.type === "run") {
    fillTab(sender.tab, sender.frameId).then(reply, (e) => reply({ error: String(e.message || e) }));
    return true;
  }
  if (!active.has(sender.tab.id)) return;
  // Only the top frame and frames from the same site as the top frame may ask for data.
  // A cross-origin frame embedded in the page (an ad, a tracker, a hostile embed) must never
  // receive profile values, the resume or work history.
  if (sender.frameId !== 0 && originOf(sender.url) !== active.get(sender.tab.id)) return;
  handle(msg).then(reply, (e) => reply({ error: String(e.message || e) }));
  return true;
});

// The tab may already be closed (an agent closes its tab when done); a badge for it is not an error.
function show(tabId, text, title) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setTitle({ tabId, title }).catch(() => {});
}

// The in-page confirmation bar shown the first time the extension runs on a site.
// Self-contained: it is serialized into the page by chrome.scripting.
function confirmInPage(origin) {
  return new Promise((resolve) => {
    const old = document.getElementById("jev-autofill-confirm");
    if (old) old.remove();
    // Its own element with a shadow root, on <html> rather than <body>: page styles can't hide it,
    // and a framework that re-renders the body (an Angular portal) can't take it away; if the page
    // removes it anyway, it is put back until it is answered.
    const host = document.createElement("jev-autofill-confirm");
    host.id = "jev-autofill-confirm";
    host.style.cssText = "all:initial;position:fixed;top:12px;right:12px;z-index:2147483647";
    const root = host.attachShadow({ mode: "open" });
    const bar = document.createElement("div");
    bar.style.cssText =
      "background:#1f2430;color:#fff;font:13px system-ui;padding:12px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:340px";
    const text = document.createElement("div");
    text.textContent = `Allow JEV Autofill to run on ${origin}? It fills your profile into this page's form fields.`;
    text.style.marginBottom = "10px";
    bar.appendChild(text);
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px";
    // Only real user clicks count: a page must not be able to confirm itself.
    const keep = new MutationObserver(() => host.isConnected || document.documentElement.appendChild(host));
    const finish = (value) => {
      clearTimeout(timer);
      keep.disconnect();
      host.remove();
      resolve(value);
    };
    const chosen = (value) => (e) => e.isTrusted && finish(value);
    const timer = setTimeout(() => finish(null), 90000);
    for (const [label, value, primary] of [
      ["Not now", null, false],
      ["Allow once", "once", false],
      ["Always allow", "always", true],
    ]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = `padding:5px 10px;border-radius:5px;border:1px solid #666;background:${primary ? "#2563eb" : "transparent"};color:#fff;cursor:pointer;font:inherit`;
      b.addEventListener("click", chosen(value));
      row.appendChild(b);
    }
    bar.appendChild(row);
    root.appendChild(bar);
    document.documentElement.appendChild(host);
    keep.observe(document.documentElement, { childList: true });
  });
}

// The first fill on each site asks for permission; the answer is remembered in chrome.storage.
// The options page can turn the question off (askFirst: false), e.g. for an agent-driven setup.
// A run started from the in-page button asks in that button, which is known to be on screen; the
// toolbar and shortcut ask in a bar at the top of the page.
async function confirmSite(tabId, origin, launcherFrame) {
  const { sites, askFirst } = await chrome.storage.local.get(["sites", "askFirst"]);
  if (askFirst === false || (sites && sites[origin])) return "always";
  let choice;
  try {
    if (launcherFrame != null) {
      const asked = chrome.tabs.sendMessage(tabId, { type: "confirm", origin }, { frameId: launcherFrame });
      choice = await Promise.race([asked, new Promise((r) => setTimeout(() => r(null), 95000))]);
    } else {
      const frames = await chrome.scripting.executeScript({ target: { tabId }, func: confirmInPage, args: [origin] });
      choice = frames[0] && frames[0].result;
    }
  } catch {
    choice = null;
  }
  if (choice !== "once" && choice !== "always") choice = null;
  if (choice === "always") await chrome.storage.local.set({ sites: { ...(sites || {}), [origin]: true } });
  return choice;
}

// One fill of a whole tab (all frames). Used by the toolbar button, Alt+Shift+J and the in-page button.
async function fillTab(tab, launcherFrame) {
  if (busy.has(tab.id)) return { error: "already filling this tab" };
  const origin = originOf(tab.url);
  if (!origin) {
    show(tab.id, "?", "JEV Autofill: cannot read this page's address");
    return { error: "cannot read this page's address" };
  }
  // Added synchronously, before any await, so a second click cannot start a second run
  // while the first is still waiting for the confirmation answer.
  busy.add(tab.id);
  let keepAlive;
  try {
    const choice = await confirmSite(tab.id, origin, launcherFrame);
    if (choice !== "once" && choice !== "always") {
      show(tab.id, "?", "JEV Autofill: not confirmed for this site");
      return { error: "not confirmed for this site", declined: true };
    }
    active.set(tab.id, origin);
    // Calling an extension API keeps Chrome from stopping this worker during a long run.
    keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
    show(tab.id, "...", "JEV Autofill: filling");
    const target = { tabId: tab.id, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ["rules.js", "workday.js", "content.js"] });
    const frames = await chrome.scripting.executeScript({ target, func: (title) => window.__jevRun(title), args: [tab.title || ""] });
    const sum = (k) => frames.reduce((n, f) => n + (f.result?.[k] || 0), 0);
    const error = frames.map((f) => f.result?.error).find(Boolean) || null;
    if (error) show(tab.id, "!", `JEV Autofill: ${sum("filled")} filled, ${sum("left")} left. ${error}`);
    else show(tab.id, String(sum("filled")), `JEV Autofill: ${sum("filled")} filled, ${sum("left")} left`);
    return { filled: sum("filled"), left: sum("left"), fillError: error };
  } catch (e) {
    show(tab.id, "!", `JEV Autofill: ${e.message || e}`);
    return { error: String(e.message || e) };
  } finally {
    if (keepAlive) clearInterval(keepAlive);
    active.delete(tab.id);
    busy.delete(tab.id);
  }
}

chrome.action.onClicked.addListener((tab) => fillTab(tab));

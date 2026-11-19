// Runs the fill on a toolbar click and relays requests to the local helper, which holds the key and profile.
const HOST = "com.jev_auto_mapper.host";
// Tab id -> the top frame's origin while a fill is running.
const active = new Map();

function askHost(msg) {
  return chrome.runtime.sendNativeMessage(HOST, msg).then((res) => {
    if (res?.error) throw new Error(res.error);
    return res;
  });
}

async function handle(msg) {
  if (msg.type === "map" && Array.isArray(msg.fields)) {
    const { model, maxBytes } = await chrome.storage.local.get(["model", "maxBytes"]);
    return askHost({ type: "map", title: msg.title, fields: msg.fields, model, maxBytes });
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
  if (sender.id !== chrome.runtime.id || !sender.tab || !active.has(sender.tab.id)) return;
  // Only the top frame and frames from the same site as the top frame may ask for data.
  // A cross-origin frame embedded in the page (an ad, a tracker, a hostile embed) must never
  // receive profile values, the resume or work history.
  if (sender.frameId !== 0 && originOf(sender.url) !== active.get(sender.tab.id)) return;
  handle(msg).then(reply, (e) => reply({ error: String(e.message || e) }));
  return true;
});

function show(tabId, text, title) {
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setTitle({ tabId, title });
}

// The in-page confirmation bar shown the first time the extension runs on a site.
// Self-contained: it is serialized into the page by chrome.scripting.
function confirmInPage(origin) {
  return new Promise((resolve) => {
    const old = document.getElementById("jev-autofill-confirm");
    if (old) old.remove();
    const bar = document.createElement("div");
    bar.id = "jev-autofill-confirm";
    bar.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:2147483647;background:#1f2430;color:#fff;font:13px system-ui;padding:12px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:340px";
    const text = document.createElement("div");
    text.textContent = `Allow JEV Autofill to run on ${origin}? It fills your profile into this page's form fields.`;
    text.style.marginBottom = "10px";
    bar.appendChild(text);
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px";
    // Only real user clicks count: a page must not be able to confirm itself.
    const chosen = (value) => (e) => {
      if (!e.isTrusted) return;
      clearTimeout(timer);
      bar.remove();
      resolve(value);
    };
    const timer = setTimeout(() => {
      bar.remove();
      resolve(null);
    }, 90000);
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
    (document.body || document.documentElement).appendChild(bar);
  });
}

// The first fill on each site asks for permission; the answer is remembered in chrome.storage.
async function confirmSite(tabId, origin) {
  const { sites } = await chrome.storage.local.get("sites");
  if (sites && sites[origin]) return "always";
  let choice;
  try {
    const frames = await chrome.scripting.executeScript({ target: { tabId }, func: confirmInPage, args: [origin] });
    choice = frames[0] && frames[0].result;
  } catch {
    choice = null;
  }
  if (choice === "always") await chrome.storage.local.set({ sites: { ...(sites || {}), [origin]: true } });
  return choice;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (active.has(tab.id)) return;
  const origin = originOf(tab.url);
  if (!origin) {
    show(tab.id, "?", "JEV Autofill: cannot read this page's address");
    return;
  }
  const choice = await confirmSite(tab.id, origin);
  if (choice !== "once" && choice !== "always") {
    show(tab.id, "?", "JEV Autofill: not confirmed for this site");
    return;
  }
  active.set(tab.id, origin);
  // Calling an extension API keeps Chrome from stopping this worker during a long run.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  show(tab.id, "...", "JEV Autofill: filling");
  try {
    const target = { tabId: tab.id, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ["rules.js", "workday.js", "content.js"] });
    const frames = await chrome.scripting.executeScript({ target, func: (title) => window.__jevRun(title), args: [tab.title || ""] });
    const sum = (k) => frames.reduce((n, f) => n + (f.result?.[k] || 0), 0);
    const error = frames.map((f) => f.result?.error).find(Boolean);
    if (error) show(tab.id, "!", `JEV Autofill: ${sum("filled")} filled, ${sum("left")} left. ${error}`);
    else show(tab.id, String(sum("filled")), `JEV Autofill: ${sum("filled")} filled, ${sum("left")} left`);
  } catch (e) {
    show(tab.id, "!", `JEV Autofill: ${e.message || e}`);
  } finally {
    clearInterval(keepAlive);
    active.delete(tab.id);
  }
});

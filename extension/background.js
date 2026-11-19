// Runs the fill on a toolbar click and relays requests to the local helper, which holds the key and profile.
const HOST = "com.jev_auto_mapper.host";
const active = new Set();

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

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.tab || !active.has(sender.tab.id)) return;
  handle(msg).then(reply, (e) => reply({ error: String(e.message || e) }));
  return true;
});

function show(tabId, text, title) {
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setTitle({ tabId, title });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (active.has(tab.id)) return;
  active.add(tab.id);
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

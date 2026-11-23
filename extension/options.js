const $ = (id) => document.getElementById(id);

chrome.storage.local.get(["mode", "askFirst"]).then((c) => {
  $("mode").value = c.mode || "jev";
  $("askFirst").checked = c.askFirst !== false;
});

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ mode: $("mode").value, askFirst: $("askFirst").checked });
  $("status").textContent = "Saved.";
});

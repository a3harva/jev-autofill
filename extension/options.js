const $ = (id) => document.getElementById(id);

chrome.storage.local.get(["mode"]).then((c) => {
  $("mode").value = c.mode || "static";
});

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ mode: $("mode").value });
  $("status").textContent = "Saved.";
});

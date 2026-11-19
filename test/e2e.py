#!/usr/bin/env python3
"""End-to-end test: loads the real extension in Chromium, opens the form, and scores what landed.

    python3 test/e2e.py static
    python3 test/e2e.py jev [--threshold 0.9] [--max-bytes 28000]
    python3 test/e2e.py hybrid

Prints labels and keys only, never profile values or the API key.
"""
import argparse
import json
import pathlib
import sys
import tempfile
import threading
import time
import urllib.parse

from playwright.sync_api import sync_playwright

from server import serve

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "native"))
from install import install  # noqa: E402

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent
NO_VALUE_DOM = """(id) => {
  const el = document.getElementById(id);
  const radios = document.querySelectorAll(`input[type=radio][name="${id}"]`);
  if (radios.length) {
    const r = [...radios].find((x) => x.checked);
    return r ? r.closest('label').innerText.trim() : '';
  }
  if (!el) return null;
  if (el.getAttribute('role') === 'radiogroup') {
    const b = el.querySelector('[aria-pressed=true]');
    return b ? b.innerText.trim() : '';
  }
  if (el.tagName === 'BUTTON') return /^Select/.test(el.innerText.trim()) ? '' : el.innerText.trim();
  if (el.tagName === 'SELECT') return el.value ? el.options[el.selectedIndex].text : '';
  if (el.type === 'checkbox') return el.checked ? 'checked' : '';
  if (el.type === 'file') return el.files.length ? el.files[0].name : '';
  return el.value;
}"""


def read_all(page, frame, fid):
    for f in (page.main_frame, frame):
        v = f.evaluate(NO_VALUE_DOM, fid)
        if v is not None:
            return v
    return None


def wait_reports(page, frame, timeout=240):
    read = "() => { const e = document.getElementById('jev-auto-mapper-report'); return e ? JSON.parse(e.textContent) : null; }"
    end = time.time() + timeout
    settled = 0
    while time.time() < end:
        reports = [f.evaluate(read) for f in (page.main_frame, frame)]
        settled = settled + 1 if all(r and r["done"] for r in reports) else 0
        if settled >= 6:
            return reports
        time.sleep(0.5)
    raise SystemExit("the extension never finished")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["static", "jev", "hybrid"])
    ap.add_argument("--threshold", type=float, default=0.9)
    ap.add_argument("--max-bytes", type=int, default=28000)
    ap.add_argument("--model", default="jev-latest")
    ap.add_argument("--location", default="Bengaluru, India", help="the job's location shown on the page; empty for unknown")
    args = ap.parse_args()

    profile = json.loads((ROOT / "profile.local.json").read_text())
    truth = json.loads((HERE / "ground-truth.json").read_text())
    home = profile.get("home") or {}
    places = [p.lower() for p in [home.get("country", ""), *home.get("places", [])] if p]
    region = None if not args.location else "home" if any(p in args.location.lower() for p in places) else "abroad"

    httpd = serve(8766)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    ext = str(ROOT / "extension")
    settings = {"mode": args.mode, "threshold": args.threshold, "maxBytes": args.max_bytes, "model": args.model}

    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        install(pathlib.Path(tmp) / "NativeMessagingHosts")
        ctx = p.chromium.launch_persistent_context(
            tmp, channel="chromium", headless=True, args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"]
        )
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        sw.evaluate("(s) => chrome.storage.local.set(s)", settings)
        page = ctx.new_page()
        page.goto("http://127.0.0.1:8766/form.html?" + urllib.parse.urlencode({"loc": args.location}))
        frame = page.frames[1]
        frame.wait_for_load_state()
        time.sleep(1.5)
        if page.evaluate("!!document.getElementById('jev-auto-mapper-report')"):
            raise SystemExit("the extension ran before the click")
        sw.evaluate("async () => { const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' }); chrome.action.onClicked.dispatch(t); }")
        reports = wait_reports(page, frame)
        results = []
        entries = {}
        for r in reports:
            for bucket in ("filled", "skipped", "failed"):
                for e in r[bucket]:
                    entries[e["id"]] = {**e, "bucket": bucket}
        for fid, t in truth.items():
            actual = read_all(page, frame, fid) or ""
            if t["expect"] is not None:
                want = t["expect"]
            elif t["key"] == "consent_yes":
                want = "checked"
            elif t["key"] == "requires_sponsorship":
                want = profile[t["key"]].get(region, "") if region else actual
            elif t["key"] == "linkedin_url":
                want = profile[t["key"]].replace("https://linkedin.com", "https://www.linkedin.com")
            else:
                want = profile.get(t["key"], "")
            if t["key"] == "notifications_opt_in":
                want = ""
            e = entries.get(fid, {})
            results.append({
                "label": t["label"], "control": t["control"], "expected_key": t["key"], "got_key": e.get("key"),
                "confidence": e.get("confidence"), "source": e.get("source"), "bucket": e.get("bucket"), "reason": e.get("reason"),
                "key_ok": e.get("key") == t["key"], "landed": actual == want, "wrong": bool(actual) and actual != want,
                "missed": not actual and bool(want),
            })
        submits = page.evaluate("window.__submits")
        stored = sw.evaluate("() => chrome.storage.local.get(null).then(Object.keys)")
        badge = sw.evaluate("async () => { const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' }); return [await chrome.action.getBadgeText({ tabId: t.id }), await chrome.action.getTitle({ tabId: t.id })]; }")
        page.screenshot(path=str(HERE / "results" / f"{args.mode}.png") if (HERE / "results").mkdir(exist_ok=True) is None else "", full_page=True)
        ctx.close()
    httpd.shutdown()

    n = len(results)
    usage = [j for r in reports for j in r["jev"]]
    errors = [r["error"] for r in reports if r["error"]]
    print(f"mode={args.mode} threshold={args.threshold} fields={n}")
    print(f"key correct      {sum(r['key_ok'] for r in results)}/{n}")
    print(f"page correct     {sum(r['landed'] for r in results)}/{n}")
    print(f"wrong value      {sum(r['wrong'] for r in results)}")
    print(f"missed (blank)   {sum(r['missed'] for r in results)}")
    print(f"submits clicked  {submits}")
    print(f"chrome storage   {sorted(stored)}")
    print(f"badge            {badge}")
    print(f"sponsorship      {[(r['bucket'], r['reason']) for r in results if r['expected_key'] == 'requires_sponsorship']}")
    if usage:
        print("jev", json.dumps({"calls": sum(u["calls"] for u in usage), "input_tokens": sum(u["inputTokens"] for u in usage), "ms": max(u["ms"] for u in usage), "model": usage[0]["model"]}))
    if errors:
        print("errors", errors)
    for r in results:
        if r["wrong"] or r["missed"] or not r["key_ok"]:
            tag = "WRONG" if r["wrong"] else "MISSED" if r["missed"] else "key"
            print(f"  {tag:6} {r['label'][:48]:48} want={r['expected_key']} got={r['got_key']} conf={r['confidence']} {r['bucket']}:{r['reason']}")
    out = HERE / "results" / f"{args.mode}-{args.threshold}.json"
    out.write_text(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()

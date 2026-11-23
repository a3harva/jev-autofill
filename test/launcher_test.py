#!/usr/bin/env python3
"""Tests the in-page Fill with JEV button: when it shows, trusted vs untrusted clicks, and a real fill.

    python3 test/build_form.py && python3 test/launcher_test.py
Prints counts and states only, never profile values.
"""
import pathlib, sys, tempfile, threading, time
from playwright.sync_api import sync_playwright
import functools, http.server
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "native"))
from install import install  # noqa: E402

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent
PAGES = {
    "login.html": '<form><input name="email" type="email" placeholder="Email"><input type="password" name="pw"><input name="name" placeholder="Name"><button>Sign in</button></form>',
    "search.html": '<form><input name="q" type="search" placeholder="Search"><button>Go</button></form>',
    "pizza.html": '<h1>Pizza order</h1><form><label>Customer name <input name="custname"></label><label>Telephone <input type="tel" name="custtel"></label><label>E-mail address <input type="email" name="custemail"></label><textarea name="comments"></textarea><button>Submit order</button></form>',
    "checkout.html": '<form><input name="name" placeholder="Full name"><input type="email" name="email"><input name="cardnumber" autocomplete="cc-number" placeholder="Card number"></form>',
}
# Must SHOW: a job form next to a hidden, zero-size role=dialog (Greenhouse keeps one; it hid the button 2026-11-21).
SHOW = {
    "careers_contact.html": '<h1>Careers at Acme</h1><form><label>Full name <input name="n"></label><label>Email <input type="email" name="e"></label><label>Phone <input type="tel" name="p"></label><button>Apply now</button></form>',
    # SAP UI5 web components with the real <input> in a shadow root (SuccessFactors' new wizard, Birlasoft 2026-11-21).
    "ui5_wizard.html": '<script>customElements.define("ui5-input", class extends HTMLElement { constructor() { super(); this.attachShadow({mode: "open"}).innerHTML = "<input>"; } connectedCallback() { this.style.display = "inline-block"; this.style.width = "200px"; this.style.height = "30px"; } });</script><h1>Apply for this job</h1><ui5-input placeholder="First Name"></ui5-input><ui5-input placeholder="Email"></ui5-input><ui5-input placeholder="Phone"></ui5-input><button>Next</button>',
    "hidden_dialog.html": '<div role="dialog" style="width:0;height:0;overflow:hidden"><input name="x"></div><form><label for=a>First name</label><input id=a><label for=b>Email</label><input id=b type=email><label for=c>Phone</label><input id=c type=tel><label for=d>Resume/CV</label><input id=d type=file></form>',
}
fails = []
def check(name, ok):
    print(("PASS " if ok else "FAIL ") + name)
    if not ok: fails.append(name)

def has_button(page):
    time.sleep(1.5)
    assert page.evaluate("document.title") != "Error response", "test page did not load"
    return page.evaluate("!!document.querySelector('jev-autofill')")

with tempfile.TemporaryDirectory() as tmp:
    for f, body in {**PAGES, **SHOW}.items():
        (HERE / f"_lt_{f}").write_text(f"<!doctype html><title>{f}</title><body>{body}</body>")
    # Serves only the test pages written above plus the shared job form (test/server.py serves form.html alone).
    class H(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            name = self.path.split("?")[0].lstrip("/")
            if not (name.startswith("_lt_") or name == "form.html"):
                return self.send_error(404)
            return super().do_GET()
        def log_message(self, *a):
            pass
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 8767), functools.partial(H, directory=str(HERE)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    ext = str(ROOT / "extension")
    with sync_playwright() as p:
        install(pathlib.Path(tmp) / "NativeMessagingHosts")
        ctx = p.chromium.launch_persistent_context(tmp, channel="chromium", headless=True,
            args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"])
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        sw.evaluate("() => chrome.storage.local.set({mode: 'static'})")
        page = ctx.new_page()
        for f in PAGES:
            page.goto(f"http://127.0.0.1:8767/_lt_{f}")
            check(f"no button on {f}", not has_button(page))
        for f in SHOW:
            page.goto(f"http://127.0.0.1:8767/_lt_{f}")
            check(f"button on {f}", has_button(page))
        page.goto("http://127.0.0.1:8767/form.html")
        check("button on the job form", has_button(page))
        # By default the first fill on a site waits for the in-page "Allow" bar; "Not now" fills nothing.
        page.locator("jev-autofill").locator("#go").click()
        bar = page.locator("#jev-autofill-confirm")
        bar.wait_for(timeout=10000)
        check("in-page button asks before the first fill", bar.is_visible())
        bar.get_by_role("button", name="Not now").click()
        time.sleep(2)
        check("declined: nothing filled", page.evaluate("document.querySelector('jev-autofill').dataset.state") == "error"
              and not page.evaluate("!!document.getElementById('jev-auto-mapper-report')"))
        # With the question turned off (an agent-driven setup) the button fills straight away.
        sw.evaluate("() => chrome.storage.local.set({askFirst: false})")
        page.reload()
        has_button(page)
        # A page script's .click() must be ignored.
        page.evaluate("document.querySelector('jev-autofill').shadowRoot.getElementById('go').click()")
        time.sleep(2)
        check("untrusted click ignored", page.evaluate("document.querySelector('jev-autofill').dataset.state") == "idle"
              and not page.evaluate("!!document.getElementById('jev-auto-mapper-report')"))
        # A trusted click (real input events) runs the fill.
        page.locator("jev-autofill").locator("#go").click()
        deadline = time.time() + 170
        while time.time() < deadline and page.evaluate("document.querySelector('jev-autofill').dataset.state") in ("idle", "running"):
            time.sleep(1)
        st = page.evaluate("(() => { const e = document.querySelector('jev-autofill'); return {state: e.dataset.state, filled: e.dataset.filled, left: e.dataset.left, error: e.dataset.error || null, label: e.shadowRoot.getElementById('go').textContent}; })()")
        print("  result:", st)
        check("trusted click filled fields", st["state"] in ("done", "error") and int(st.get("filled") or 0) > 0)
        check("report published", page.evaluate("!!document.getElementById('jev-auto-mapper-report')"))
        check("never submitted", not page.evaluate("window.__submits || 0"))
        # Dismiss hides it on this host.
        page.locator("jev-autofill").locator("#x").click()
        page.reload()
        check("hidden after dismiss", not has_button(page))
        ctx.close()
    for f in {**PAGES, **SHOW}:
        (HERE / f"_lt_{f}").unlink()
print("ALL PASS" if not fails else f"{len(fails)} FAILED")
sys.exit(1 if fails else 0)

#!/usr/bin/env python3
"""Registers the native messaging host so only this extension can start it."""
import base64
import hashlib
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
HOST = "com.jev_auto_mapper.host"
# Where each browser looks for native messaging hosts. Windows needs a registry key and is not handled here.
BROWSER_DIRS = {
    "darwin": {
        "chrome": "Library/Application Support/Google/Chrome/NativeMessagingHosts",
        "chromium": "Library/Application Support/Chromium/NativeMessagingHosts",
    },
    "linux": {
        "chrome": ".config/google-chrome/NativeMessagingHosts",
        "chromium": ".config/chromium/NativeMessagingHosts",
    },
}
if sys.platform not in BROWSER_DIRS:
    sys.exit(f"{sys.platform} is not supported: only macOS and Linux are")
CHROME_DIR = pathlib.Path.home() / BROWSER_DIRS[sys.platform]["chrome"]


def extension_id():
    der = base64.b64decode(json.loads((HERE.parent / "extension/manifest.json").read_text())["key"])
    return "".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(der).hexdigest()[:32])


def install(target=CHROME_DIR):
    wrapper = HERE / "jev_host"
    wrapper.write_text(f'#!/bin/sh\nexec /usr/bin/env python3 "{HERE / "host.py"}" "$@"\n')
    wrapper.chmod(0o755)
    target = pathlib.Path(target)
    target.mkdir(parents=True, exist_ok=True)
    manifest = {
        "name": HOST,
        "description": "JEV Autofill local helper",
        "path": str(wrapper),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id()}/"],
    }
    (target / f"{HOST}.json").write_text(json.dumps(manifest, indent=2))
    return extension_id()


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "chrome"
    target = pathlib.Path.home() / BROWSER_DIRS[sys.platform][arg] if arg in BROWSER_DIRS[sys.platform] else arg
    print(f"installed for extension {install(target)}")

# JEV Autofill

A Chrome extension that fills the repetitive fields of a job application (name, email, phone, education, links, work authorization, EEO and screening questions) from a profile file on your own machine. Click the toolbar button or press **Alt+Shift+J** on an application page and it fills what it can.

It never clicks Submit, Next or Apply, and it never changes a field that already has a value. A field it can't map with confidence is left for you.

## How it works

- **`extension/`**: a Manifest V3 extension. Clicking the button injects `rules.js`, `workday.js` and `content.js` into the page and every frame, including open shadow roots. These read each field's question, map it to a canonical key such as `email` or `school`, and fill it. React, Material UI, Ant Design, Select2 and similar widgets are handled, and so is Workday's multi-step flow.
- **`native/host.py`**: a [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) helper. Only this part reads your profile, your resume and the API key. A page gets only the values for the fields it actually has.
- **Mapping modes** (set on the options page):
  - `static` (the default): regex rules in `extension/rules.js`. No network calls.
  - `hybrid`: static rules first, then [JEV](https://typesafe.ai) for fields the rules don't match, and for picking the best option in dropdowns and screening questions. Needs `TYPESAFE_API_KEY`.
  - `jev`: JEV only.

  JEV sees field labels, option text and the `facts` list from your profile. It never sees your other profile values.

A report of what was filled, skipped and why is written to the page as `<script id="jev-auto-mapper-report" type="application/json">`, so an automation agent can pick up only the fields that were left.

## Setup

macOS or Linux, Chrome or Chromium, Python 3.9+.

```sh
git clone https://github.com/a3harva/jev-autofill.git
cd jev-autofill
cp profile.example.json profile.local.json   # then fill in your details
cp .env.example .env                         # optional: only for hybrid/jev modes
python3 native/install.py                    # or: python3 native/install.py chromium
```

Then open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and select the `extension/` folder. The `key` in `manifest.json` gives the extension a fixed ID, and the installer allows only that ID to start the helper.

## The profile

`profile.local.json` is gitignored. Keys match `native/field_keys.json`. Leave a key out and that field is skipped. Some entries are special:

| Key | Meaning |
|---|---|
| `home` | Your home country (`country`, ISO `codes`, and city `places`). It is used to tell whether a job is at home or abroad, and to pick your dialling code. |
| `requires_sponsorship` (or any value) as `{ "home": ..., "abroad": ... }` | Gives a different answer depending on where the job is. If the job's country is unclear, the field is skipped. |
| `resume_path` | Resume to attach to upload fields, relative to the repo root or absolute. If you set `resume_sha256`, the file must match that hash. |
| `facts` | Plain sentences JEV may use to answer screening questions in `hybrid`/`jev` mode. |
| `work_history` | Used for Workday's experience section, with an optional `description` per job. |

Pay fields (`current_ctc`, `expected_ctc`, `offered_ctc`) are assumed to be yearly amounts in your local currency. A pay question that names another currency, or asks per month or per hour, is left blank.

Government IDs, bank details and passwords are filled only if you put them in the profile. The example profile leaves them out on purpose.

## Tests

The tests load the real extension in headless Chromium against a local form of 98 unannotated fields, using the fake example profile.

```sh
pip install playwright && playwright install chromium
cp profile.example.json profile.local.json
python3 test/build_form.py
cd test && python3 e2e.py static                  # also: --location "London, United Kingdom", or hybrid / jev
```

`test/server.py` also serves `test/fixtures/*.html` (shadow DOM and React widget pages) at `http://127.0.0.1:8765/fixtures/...` for manual testing.

## Credits

Field key names and the idea of mapping fields to canonical keys come from [qbeka/jev-job-search](https://github.com/qbeka/jev-job-search) (MIT). See `THIRD_PARTY_NOTICES`.

## License

MIT. See `LICENSE`.

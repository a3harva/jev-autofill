# JEV Autofill

A Chrome extension that fills the repetitive fields of a job application (name, email, phone, education, links, work authorization, EEO and screening questions) from a profile file on your own machine. Click the toolbar button, press **Alt+Shift+J**, or click the blue **Fill with JEV** button that appears near the bottom-right of an application form, and it fills what it can.

It never clicks Submit, Next or Apply, and it never changes a field that already has a value. A field it can't map with confidence is left for you. Consent, terms and privacy boxes are never ticked, and PAN, Aadhaar, passport, bank details and passwords are never filled: they are listed in the report for you to do by hand. Legal and EEO screening questions (criminal record, work authorization, clearance, gender, ethnicity, race, veteran status, disability) are answered only from your profile; a missing answer is left for you, not guessed. The first time it runs on a site, a small bar on the page asks you to confirm (once or always); your choices are remembered in `chrome.storage.local`. If an agent drives your browser, you can turn this question off on the options page.

## How it works

- **`extension/`**: a Manifest V3 extension. Clicking the button injects `rules.js`, `workday.js` and `content.js` into the page and every frame, including open shadow roots. These read each field's question, map it to a canonical key such as `email` or `school`, and fill it. React, Material UI, Ant Design, Select2 and similar widgets are handled, and so is Workday's multi-step flow.
- **`extension/launcher.js`**: shows the in-page **Fill with JEV** button on pages that look like an application form (known applicant-tracking sites, LinkedIn's Easy Apply dialog, or a job page whose form has a resume upload or two of name, email and phone). It is hidden on sign-in, search and payment forms, reacts only to trusted clicks (a page script's `.click()` is ignored), and runs the same fill as the toolbar button. Browser-automation agents can press it, which they can't do with the toolbar. Its `data-state`, `data-filled` and `data-left` attributes show the result; the × hides it on that site.
- **`native/host.py`**: a [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) helper. Only this part reads your profile, your resume and the API key. A page gets only the values for the fields it actually has.
- **Mapping modes** (set on the options page):
  - `static` (the default): regex rules in `extension/rules.js`. No network calls.
  - `hybrid`: static rules first, then [JEV](https://typesafe.ai) for fields the rules don't match, and for picking the best option in dropdowns and screening questions. Needs `TYPESAFE_API_KEY`.
  - `jev`: JEV only.

  JEV sees the page title and each field's question, section and option text, plus the `facts` list from your profile — which, note, includes your work history, skills and self-identification. It never sees your other profile values, and profile values are only sent to the page you confirmed, never to an embedded frame from another site.

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

Government IDs, bank details and passwords are never filled even if they are in the profile; a field asking for one is reported and left for you. The example profile leaves them out on purpose.

## Tests

The tests load the real extension in headless Chromium against a local form of 98 unannotated fields, built from your profile (the fake example profile works).

```sh
pip install playwright && playwright install chromium
cp -n profile.example.json profile.local.json     # -n: never overwrite a real profile
python3 test/build_form.py
cd test && python3 e2e.py static                  # also: --location "London, United Kingdom", or hybrid / jev
python3 launcher_test.py                          # when the in-page button shows, the site prompt, trusted clicks
```

The tests read whatever `profile.local.json` holds and print labels and keys only, never values.

The native helper has its own tests, which need no browser or network:

```sh
python3 test/host_unit.py
```

`test/server.py` also serves `test/fixtures/*.html` (shadow DOM and React widget pages) at `http://127.0.0.1:8765/fixtures/...` for manual testing.

## Credits

Field key names and the idea of mapping fields to canonical keys come from [qbeka/jev-job-search](https://github.com/qbeka/jev-job-search) (MIT). See `THIRD_PARTY_NOTICES`.

## License

MIT. See `LICENSE`.

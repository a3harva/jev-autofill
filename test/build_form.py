#!/usr/bin/env python3
"""Generates the unannotated test form and its answer key from one list of fields."""
import datetime
import html
import json
import pathlib
import random

HERE = pathlib.Path(__file__).parent
PROFILE = json.loads((HERE.parent / "profile.local.json").read_text())
random.seed(20261109)

YN = ["Yes", "No"]


def opts(key, *dummies):
    """Dummy choices plus the profile's own value, so the real answer is one of the options."""
    items = [str(PROFILE[key]), *dummies]
    random.shuffle(items)
    return items



def uid():
    return "x" + "".join(random.choices("abcdefghijkmnpqrstuvwxyz23456789", k=8))


# (label, control, expected key, options, expected value if it differs from the profile's)
SECTIONS = {
    "About you": [
        ("First name", "text", "first_name"),
        ("Surname", "text", "last_name"),
        ("Your full name", "text", "full_name"),
        ("What should we call you?", "text", "preferred_name"),
        ("Date of birth", "date", "date_of_birth"),
        ("Gender", "select", "gender", ["Male", "Female", "Other", "Prefer not to say"]),
        ("Pronouns", "text", "pronouns"),
        ("Father's name", "text", "fathers_name"),
        ("Marital status", "select", "marital_status", ["Unmarried", "Married"]),
    ],
    "Contact": [
        ("Email", "text", "email"),
        ("Mobile", "text", "phone"),
        ("Phone number including country code", "text", "phone_with_country_code"),
        ("Country code", "combobox", "phone_country_code", ["United States (+1)", "United Kingdom (+44)", "India (+91)", "Singapore (+65)"], "India (+91)"),
    ],
    "Where you live": [
        ("Street address", "text", "address_line1"),
        ("City", "combobox", "city", opts("city", "Springfield", "Rivertown", "Lakeview")),
        ("State", "select", "state_province", opts("state_province", "Dummy State A", "Dummy State B")),
        ("PIN code", "text", "postal_code"),
        ("Country", "select", "country", ["United States", "India", "Canada"]),
        ("Mailing address", "textarea", "full_address"),
        ("Where are you based?", "text", "current_location"),
        ("Preferred work location", "select", "preferred_location", opts("preferred_location", "Springfield", "Rivertown")),
        ("Are you willing to relocate?", "radio", "willing_to_relocate", YN),
        ("Work mode preference", "select", "remote_preference", ["Remote", "Hybrid", "Onsite", "Open to all"]),
    ],
    "Links": [
        ("LinkedIn", "text", "linkedin_url"),
        ("GitHub", "text", "github_url"),
        ("Portfolio", "text", "website_url"),
    ],
    "Education": [
        ("Alma mater", "combobox", "school", opts("school", "Dummy Institute of Technology", "Sample State University", "Example College of Engineering")),
        ("Degree", "select", "degree", ["Bachelor of Science", "Bachelor of Technology", "Master of Technology"]),
        ("Field of study", "select", "major", opts("major", "Dummy Studies", "Sample Sciences")),
        ("Start date", "text", "education_start_date"),
        ("End date", "text", "graduation_date"),
        ("Graduation year", "select", "graduation_year", ["2021", "2022", "2023"]),
        ("CGPA", "text", "gpa"),
        ("Highest qualification", "select", "education_level", ["Diploma", "Bachelor of Technology", "PhD"]),
        ("10th percentage", "text", "tenth_percentage"),
        ("12th percentage", "text", "twelfth_percentage"),
        ("Year you passed 10th", "text", "tenth_passing_year"),
        ("Year you passed 12th", "text", "twelfth_passing_year"),
    ],
    "Experience": [
        ("Current employer", "text", "current_company"),
        ("Current job title", "text", "current_title"),
        ("Total experience in years", "text", "years_of_experience"),
        ("Python experience", "select", "years_python", ["0-1 years", "2-3 years", "4-5 years", "6+ years"], "4-5 years"),
        ("How many years have you worked with LLMs?", "text", "years_genai"),
        ("Experience with LangGraph (years)", "text", "years_agentic"),
        ("Years with RAG systems", "text", "years_rag"),
        ("Kubernetes experience (years)", "text", "years_kubernetes"),
        ("AWS experience (years)", "text", "years_aws"),
        ("Years of experience on any cloud platform", "text", "years_cloud"),
        ("FastAPI experience (years)", "text", "years_fastapi"),
        ("Key skills", "textarea", "skills"),
    ],
    "Compensation and availability": [
        ("CTC (LPA)", "text", "current_ctc"),
        ("Expected CTC (LPA)", "text", "expected_ctc"),
        ("Notice period (days)", "select", "notice_period_days", opts("notice_period_days", "7", "45", "120")),
        ("Are you an immediate joiner?", "radio", "immediate_joiner", YN),
        ("Comfortable with US hours?", "buttons", "night_shift", YN),
        ("When can you start?", "text", "earliest_start_date"),
        ("Available start date", "date", "earliest_start_date", None, (datetime.date.today() + datetime.timedelta(days=15)).isoformat()),
        ("Preferred work type", "select", "employment_type", ["Full-time", "Part-time", "Contract"]),
        ("Cover letter / portfolio link", "text", "website_url"),
    ],
    "Work authorization": [
        ("Nationality", "select", "citizenship", opts("citizenship", "Dummylandian", "Samplestani")),
        ("Are you legally authorized to work in India?", "buttons", "authorized_to_work", YN),
        ("Will you now or in the future require visa sponsorship?", "select", "requires_sponsorship", YN),
    ],
    "Screening": [
        ("Have you previously worked at this company?", "radio", "previously_applied", YN),
        ("Have you ever been convicted of a felony?", "radio", "felony", YN),
        ("Are you bound by a non-compete?", "radio", "non_compete", YN),
        ("Would you consider relocating for this role?", "listbox", "willing_to_relocate", YN),
        ("Are you a current or former employee of the United States government?", "listbox", "screening_answer", YN, "No"),
        ("Can you pass a background check?", "radio", "background_check", YN),
        ("Can you pass a drug test?", "radio", "drug_test", YN),
        ("Do you have a valid driver's license?", "radio", "drivers_license", YN),
        ("Are you 18 years or older?", "radio", "over_18", YN),
        ("Languages you speak", "text", "spoken_languages"),
        ("How did you hear about us?", "dropdown", "how_did_you_hear", opts("how_did_you_hear", "Billboard", "Podcast", "Campus event")),
        ("Employee who referred you", "text", "referral_name"),
    ],
    "Voluntary disclosures": [
        ("Race / ethnicity", "select", "ethnicity", ["White", "Asian", "Black", "Decline to state"]),
        ("Veteran status", "select", "veteran_status", ["I am a veteran", "I am not a veteran"], "I am not a veteran"),
        ("Disability", "select", "disability_status", ["Yes, I have a disability", "No, I do not have a disability"], "No, I do not have a disability"),
    ],
    "Consent": [
        ("I agree to the privacy policy", "checkbox", "consent_yes"),
        ("Send me job alerts", "checkbox", "notifications_opt_in"),
    ],
    "Documents": [
        ("Resume/CV", "file", "resume_upload", None, pathlib.Path(PROFILE["resume_path"]).name),
        ("Cover letter", "file", "leave_blank"),
    ],
    "Government IDs": [
        ("PAN", "text", "pan_number"),
        ("Aadhaar number", "text", "aadhaar_number"),
        ("Passport number", "text", "passport_number"),
        ("Bank account number", "text", "bank_account"),
        ("Password", "password", "password"),
    ],
    "A few more questions": [
        ("Why do you want to work here?", "textarea", "free_text"),
        ("Describe a project you are proud of", "textarea", "free_text"),
        ("Reference's email", "text", "leave_blank"),
        ("Manager's phone number", "text", "leave_blank"),
        ("Emergency contact mobile", "text", "leave_blank"),
        ("Favourite colour", "text", "unknown"),
        ("Town you live in now", "combobox", "city", opts("city", "Springfield", "Lakeview")),
        ("NEARBY:What is your surname again?", "text", "last_name"),
        ("Do you hold another offer?", "conditional", "offer_in_hand", YN),
    ],
}

NO_FILL = {"free_text", "leave_blank", "unknown", "notifications_opt_in"}
truth = {}


def add(fid, label, control, key, expect):
    truth[fid] = {"label": label, "control": control, "key": key, "expect": expect}


def render(row):
    label, control, key, options, expect = (*row, None, None)[:5]
    fid = uid()
    if key in NO_FILL and control != "checkbox":
        expect = ""
    add(fid, label.replace("NEARBY:", ""), control, key, expect)
    q = html.escape(label)
    if control == "text" and label.startswith("NEARBY:"):
        return f'<div class=row><div>{html.escape(label[7:])}</div><div><input id={fid}></div></div>'
    if control in ("text", "date", "password", "file"):
        kind = "" if control == "text" else f' type="{control}"'
        return f"<div class=row><label for={fid}>{q}</label><input id={fid}{kind}></div>"
    if control == "textarea":
        return f"<div class=row><label for={fid}>{q}</label><textarea id={fid}></textarea></div>"
    if control == "checkbox":
        return f"<div class=row><label><input id={fid} type=checkbox> {q}</label></div>"
    if control == "select":
        opts = "".join(f'<option value="v{i}">{html.escape(o)}</option>' for i, o in enumerate(options))
        return f'<div class=row><label for={fid}>{q}</label><select id={fid}><option value="">Select</option>{opts}</select></div>'
    if control == "radio":
        body = "".join(f"<label><input type=radio name={fid} value=v{i}> {o}</label> " for i, o in enumerate(options))
        return f"<fieldset id={fid}><legend>{q}</legend>{body}</fieldset>"
    if control == "buttons":
        body = "".join(f'<button type=button aria-pressed=false>{o}</button>' for o in options)
        return f'<div class=row><div id=l{fid}>{q}</div><div id={fid} role=radiogroup aria-labelledby=l{fid}>{body}</div></div>'
    if control == "combobox":
        items = html.escape(json.dumps(options), quote=True)
        return f'<div class=row><label for={fid}>{q}</label><input id={fid} role=combobox data-items="{items}"><ul class=list></ul></div>'
    if control == "listbox":
        items = html.escape(json.dumps(options), quote=True)
        return f'<div class=row><label for={fid}>{q}</label><button type=button id={fid} aria-haspopup=listbox data-items="{items}">Select One</button><ul class=list role=listbox></ul></div>'
    if control == "dropdown":
        items = html.escape(json.dumps(options), quote=True)
        return f'<div class=row><label for={fid}>{q}</label><button type=button id={fid} role=combobox aria-haspopup=listbox data-items="{items}">Select</button><ul class=list role=listbox></ul></div>'
    if control == "conditional":
        follow = uid()
        truth[fid]["control"] = "select"
        truth[follow] = {"label": "CTC of that offer (LPA)", "control": "text", "key": "offered_ctc", "expect": None}
        opts = "".join(f'<option value="v{i}">{o}</option>' for i, o in enumerate(options))
        return (
            f'<div class=row><label for={fid}>{q}</label><select id={fid} data-reveal={follow}><option value="">Select</option>{opts}</select></div>'
            f"<div class=row hidden><label for={follow}>CTC of that offer (LPA)</label><input id={follow}></div>"
        )
    raise ValueError(control)


body = "".join(
    f"<section><h2>{html.escape(name)}</h2>{''.join(render(r) for r in rows)}</section>" for name, rows in SECTIONS.items()
)
school = uid()
board = uid()
add(school, "Name of university", "text", "school", None)
add(board, "Current company you work for", "text", "current_company", None)
frame = (
    "<!doctype html><meta charset=utf-8><title>Embedded</title>"
    f"<section><h2>Embedded questions</h2><div class=row><label for={school}>Name of university</label><select id={school}><option value=''>Select</option>{''.join(f'<option value=v{i}>{html.escape(o)}</option>' for i, o in enumerate(opts('school', 'Dummy Institute of Technology', 'Sample State University')))}</select></div>"
    f"<div class=row><label for={board}>Current company you work for</label><input id={board}></div></section>"
)

SCRIPT = """
window.__submits = 0;
document.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); window.__submits++; });
document.querySelectorAll('[role=radiogroup] button').forEach((b) => b.addEventListener('click', () => {
  b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
  b.setAttribute('aria-pressed', 'true');
}));
document.querySelectorAll('[data-reveal]').forEach((s) => s.addEventListener('change', () => {
  const on = s.selectedIndex === 1;
  document.getElementById(s.dataset.reveal).closest('.row').hidden = !on;
}));
const place = new URLSearchParams(location.search).get('loc');
document.querySelector('.job-location').textContent = place === null ? 'Bengaluru, India' : place;
document.querySelectorAll('button[data-items]').forEach((b) => {
  const list = b.nextElementSibling;
  b.addEventListener('click', () => {
    if (list.children.length) { list.innerHTML = ''; return; }
    JSON.parse(b.dataset.items).forEach((i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = i;
      li.addEventListener('click', () => { b.textContent = i; list.innerHTML = ''; });
      list.appendChild(li);
    });
  });
});
document.querySelectorAll('input[role=combobox]').forEach((input) => {
  const list = input.nextElementSibling;
  const items = JSON.parse(input.dataset.items);
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    list.innerHTML = '';
    items.filter((i) => i.toLowerCase().includes(q)).forEach((i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = i;
      li.addEventListener('click', () => { input.value = i; list.innerHTML = ''; });
      list.appendChild(li);
    });
  });
});
"""

page = (
    "<!doctype html><meta charset=utf-8><title>Apply: AI Engineer</title>"
    "<style>body{font:14px system-ui;max-width:640px;margin:24px auto;padding:0 16px}"
    ".row{margin:10px 0}label{display:block}input:not([type=radio]):not([type=checkbox]),select,textarea{width:100%}"
    "fieldset{margin:10px 0}.list{list-style:none;padding:0}iframe{width:100%;height:160px;border:0}</style>"
    f"<h1>Apply: AI Engineer</h1><p class=job-location></p><form>{body}<iframe src=/frame.html></iframe><button type=submit>Submit application</button></form>"
    f"<script>{SCRIPT}</script>"
)

(HERE / "form.html").write_text(page, encoding="utf-8")
(HERE / "frame.html").write_text(frame, encoding="utf-8")
(HERE / "ground-truth.json").write_text(json.dumps(truth, indent=1), encoding="utf-8")
print(f"{len(truth)} fields")

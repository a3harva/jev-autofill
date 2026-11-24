#!/usr/bin/env python3
"""Chrome native messaging host: the only part that reads the API key, the profile or the resume.

Field key names and the idea of mapping to keys come from qbeka/jev-job-search (MIT).
"""
import base64
import concurrent.futures
import hashlib
import json
import pathlib
import re
import socket
import struct
import sys
import time
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent
ENDPOINT = "https://api.typesafe.ai/v1/systemone"
RETRYABLE = {429, 529}
# Seconds one JEV request may take in all, retries included. A read timeout alone is not enough: a
# provider can hold a non-streaming call open for minutes by sending keep-alive blank lines.
CALL_DEADLINE = 60
# Keys whose value is never filled; a request about one is never sent to JEV.
NEVER_FILL = {"consent_yes", "password", "pan_number", "aadhaar_number", "passport_number", "bank_account"}
MAX_FIELDS = 300
MAX_MESSAGE = 4 * 1024 * 1024
FIELD_KEYS = json.loads((HERE / "field_keys.json").read_text())
PROFILE = ROOT / "profile.local.json"
NO_VALUE = {"free_text", "leave_blank", "unknown", "notifications_opt_in", "resume_upload", "work_history",
           "consent_yes", "password", "pan_number", "aadhaar_number", "passport_number", "bank_account"}
WORKDAY_KEYS = ("work_history", "school", "degree", "major", "skills", "website_url")


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    size = struct.unpack("=I", raw)[0]
    if size > MAX_MESSAGE:
        raise ValueError("message too large")
    body = b""
    while len(body) < size:
        chunk = sys.stdin.buffer.read(size - len(body))
        if not chunk:
            raise ValueError("truncated message")
        body += chunk
    try:
        return json.loads(body)
    except ValueError:
        raise ValueError("malformed message")


def send_message(obj):
    body = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("=I", len(body)) + body)
    sys.stdout.buffer.flush()


def api_key():
    env = ROOT / ".env"
    for line in (env.read_text().splitlines() if env.is_file() else []):
        name, sep, value = line.partition("=")
        if sep and name.replace("export ", "").strip() == "TYPESAFE_API_KEY":
            return value.strip().strip("\"'")
    raise ValueError("TYPESAFE_API_KEY is not in .env")


def load_profile():
    if not PROFILE.is_file():
        raise ValueError("profile.local.json is missing: copy profile.example.json and fill it in")
    try:
        return json.loads(PROFILE.read_text())
    except ValueError:
        # Never echo the JSON parser's line/column detail back to the page.
        raise ValueError("profile.local.json is not valid JSON") from None


def clean(s, n):
    return str(s if s is not None else "")[:n]


def question_for(f):
    where = f' in the "{f["section"]}" section' if f["section"] else ""
    options = f' Its options are: {" | ".join(f["options"])}.' if f["options"] else ""
    return {
        "type": "choice",
        "instructions": f'What is the {f["control"]} field asking for, whose question is "{f["label"]}"{where}?{options}',
        "criteria": FIELD_KEYS,
    }


def chunk(fields, max_bytes, build=question_for):
    out, cur, size = [], [], 500
    for f in fields:
        n = len(json.dumps(build(f)))
        if cur and size + n > max_bytes:
            out.append(cur)
            cur, size = [], 500
        cur.append(f)
        size += n
    if cur:
        out.append(cur)
    return out


def post(key, body, deadline=None):
    """Sends one request to JEV and returns its parsed answer, retrying when busy, all within an overall deadline."""
    deadline = deadline or time.monotonic() + CALL_DEADLINE
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "jev-auto-mapper/0.3"}
    for attempt in range(4):
        if attempt:
            time.sleep(min(0.5 * 2**attempt, max(0, deadline - time.monotonic())))
        left = deadline - time.monotonic()
        if left < 1:
            break
        try:
            with urllib.request.urlopen(urllib.request.Request(ENDPOINT, body, headers), timeout=min(30, left)) as res:
                data = bytearray()
                while True:
                    if time.monotonic() > deadline:
                        raise ValueError("JEV did not answer in time")
                    part = res.read1(65536)
                    if not part:
                        break
                    data += part
            try:
                return json.loads(data)
            except ValueError:
                raise ValueError("JEV sent a malformed answer") from None
        except urllib.error.HTTPError as e:
            if e.code in RETRYABLE:
                continue
            raise ValueError(f"JEV HTTP {e.code}") from None
        except (socket.timeout, TimeoutError):
            raise ValueError("JEV did not answer in time") from None
        except urllib.error.URLError:
            raise ValueError("could not reach JEV") from None
    raise ValueError("JEV did not answer in time" if time.monotonic() >= deadline - 1 else "JEV retries exhausted")


def call_jev(key, model, title, fields):
    data = post(key, json.dumps({
        "model": model,
        "state": f'A job application form titled "{title}". Decide what each field asks for.',
        "questions": {f"f{i}": question_for(f) for i, f in enumerate(fields)},
    }).encode())
    mapped = {}
    for i, f in enumerate(fields):
        a = (data.get("answers") or {}).get(f"f{i}")
        if a and a.get("type") == "choice" and a.get("choice") in FIELD_KEYS:
            mapped[f["id"]] = {"key": a["choice"], "confidence": a.get("confidence")}
    return {"mapped": mapped, "tokens": (data.get("usage") or {}).get("input_tokens", 0), "model": data.get("model")}


def verify_question(f, key):
    where = f' in the "{f["section"]}" section' if f["section"] else ""
    options = f' Its options are: {" | ".join(f["options"][:30])}.' if f["options"] else ""
    return {
        "type": "choice",
        "instructions": f'A {f["control"]} field{where} on a job application asks: "{f["label"]}".{options} Is it asking for this: {FIELD_KEYS[key]}?',
        "criteria": {"yes": f"Yes, it asks for: {FIELD_KEYS[key]}", "no": "No, it asks for something else, or for someone other than the candidate"},
    }


def verify(key, model, title, items):
    """A second, yes-or-no look at mappings JEV was unsure of. Returns the confidence of each yes."""
    data = post(key, json.dumps({
        "model": model,
        "state": f'A job application form titled "{title}". Check what each field asks for.',
        "questions": {f"v{i}": verify_question(f, k) for i, (f, k) in enumerate(items)},
    }).encode())
    out = {}
    for i, (f, _) in enumerate(items):
        a = (data.get("answers") or {}).get(f"v{i}") or {}
        if a.get("choice") == "yes" and isinstance(a.get("confidence"), (int, float)):
            out[f["id"]] = a["confidence"]
    return {"confirmed": out, "tokens": (data.get("usage") or {}).get("input_tokens", 0)}


def map_fields(msg):
    model = clean(msg.get("model") or "jev-latest", 40)
    if not re.fullmatch(r"[a-z0-9.\-]+", model):
        raise ValueError("bad model name")
    max_bytes = min(int(msg.get("maxBytes") or 28000), 30000)
    fields = [
        {
            "id": clean(f.get("id"), 100),
            "control": clean(f.get("control"), 20),
            "label": clean(f.get("label"), 300),
            "section": clean(f.get("section"), 100),
            "options": [clean(o, 80) for o in (f.get("options") or [])[:60]],
        }
        for f in msg["fields"][:MAX_FIELDS]
    ]
    groups = chunk(fields, max_bytes)
    key = api_key()
    started = time.time()
    title = clean(msg.get("title"), 200)
    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda g: call_jev(key, model, title, g), groups))
        mapped = {k: v for r in results for k, v in r["mapped"].items()}
        calls, tokens = len(groups), sum(r["tokens"] for r in results)
        # In JEV-only mode an unsure mapping gets a yes-or-no second look, which settles most of them.
        below = msg.get("verifyBelow")
        if isinstance(below, (int, float)):
            unsure = [(f, mapped[f["id"]]["key"]) for f in fields if f["id"] in mapped
                      and (mapped[f["id"]]["confidence"] or 0) < below and mapped[f["id"]]["key"] not in ("unknown", "free_text", "leave_blank")]
            batches = [unsure[i:i + 10] for i in range(0, len(unsure), 10)]
            for r in pool.map(lambda b: verify(key, model, title, b), batches):
                tokens += r["tokens"]
                for fid, conf in r["confirmed"].items():
                    if conf > (mapped[fid]["confidence"] or 0):
                        mapped[fid] = {**mapped[fid], "confidence": conf, "verified": True}
            calls += len(batches)
    return {
        "mapped": mapped,
        "calls": calls,
        "inputTokens": tokens,
        "model": results[0]["model"] if results else None,
        "ms": int((time.time() - started) * 1000),
    }


def values(msg):
    profile = load_profile()
    return {
        "values": {k: profile[k] for k in msg["keys"] if k in FIELD_KEYS and k not in NO_VALUE and k in profile},
        "home": profile.get("home"),
    }


def resume():
    profile = load_profile()
    if not profile.get("resume_path"):
        raise ValueError("resume_path is not set in the profile")
    path = (ROOT / profile["resume_path"]).expanduser()
    try:
        size = path.stat().st_size
    except OSError:
        raise ValueError("the resume file could not be read") from None
    if size > 10 * 1024 * 1024:
        raise ValueError("the resume file is larger than 10 MB")
    data = path.read_bytes()
    # An optional hash makes sure the file attached is the one you meant, not a later edit.
    if profile.get("resume_sha256") and hashlib.sha256(data).hexdigest() != profile["resume_sha256"]:
        raise ValueError("resume hash mismatch")
    return {"name": path.name, "base64": base64.b64encode(data).decode()}


def workday(_):
    profile = load_profile()
    data = {k: profile[k] for k in WORKDAY_KEYS if k in profile}
    for job in data.get("work_history", []):
        job.setdefault("description", "")
    return data


def read_pick(answer, options):
    """The option index JEV chose, or None for none, a missing, malformed or out-of-range answer."""
    picked = (answer or {}).get("choice", "none")
    confidence = (answer or {}).get("confidence")
    if picked == "none":
        return {"index": None, "confidence": confidence}
    # A malformed answer counts as no answer, never a raw error to the page.
    if not isinstance(picked, str) or not re.fullmatch(r"o(\d+)", picked) or int(picked[1:]) >= len(options):
        return {"index": None, "confidence": None}
    return {"index": int(picked[1:]), "confidence": confidence}


def ask_choice(state, instructions, options, none_text=None):
    data = post(api_key(), json.dumps({
        "model": "jev-latest",
        "state": state,
        "questions": {"pick": {"type": "choice", "instructions": instructions, "criteria": option_criteria(options, none_text)}},
    }).encode())
    return read_pick((data.get("answers") or {}).get("pick"), options)


def option_criteria(options, none_text=None):
    criteria = {f"o{i}": o for i, o in enumerate(options)}
    if none_text:
        criteria["none"] = none_text
    return criteria


def choose(msg):
    """Asks JEV which search result means the same as the candidate's value."""
    return ask_choice(
        "A job application search box returned a list of results.",
        f'The candidate\'s {clean(msg.get("kind"), 40)} is "{clean(msg.get("term"), 120)}". Which result is the same thing, allowing for different wording or a qualifier in brackets? Do not pick a merely related or similar-sounding result.',
        [clean(o, 200) for o in msg["options"][:40]],
        "None of the listed results means the same thing",
    )


def candidate_facts():
    """Screening facts JEV may see: the profile's own "facts" list, plus work history, skills and self-identification."""
    profile = load_profile()
    jobs = "; ".join(f'{j["title"]} at {j["company"]}, {j["from"]} to {j["to"] or "present"}' for j in profile.get("work_history", []))
    return "\n".join([
        "Candidate facts:",
        f'Citizenship: {profile.get("citizenship", "")}. Lives in {profile.get("country", "")}.',
        f"Complete employment history: {jobs}.",
        f'Skills: {profile.get("skills", "")}.',
        # Without this the guesser had no languages and answered "Basic" to "How fluent are you in spoken Hindi?".
        f'Languages spoken: {profile.get("spoken_languages", "")}.',
        # Without this the guesser treated the degree as unlisted and answered "No" to "Do you have a Bachelor's degree?".
        f'Education: {profile.get("degree", "")} in {profile.get("major", "")} from {profile.get("school", "")}, graduated {profile.get("graduation_year", "")}.',
        f'Self-identification: gender {profile.get("gender", "")}; ethnicity {profile.get("ethnicity", "")}; veteran status: {profile.get("veteran_status", "")}; disability: {profile.get("disability_status", "")}.',
        *profile.get("facts", []),
    ])


GUESS = "Make the best educated guess from the candidate facts: which option is most likely true for this candidate? The employment history and skills are complete, so if the question asks whether the candidate has a job, status, clearance, tool or qualification those facts do not list, the answer is No. For availability, willingness, comfort or logistics questions, the answer is Yes. Prefer generic options over ones naming a specific visa or country that the facts do not mention, and prefer a real answer over declining to answer."
MATCH = ("Which option says the same thing as the candidate's answer? Allow for different wording, abbreviations, units or a qualifier; "
         "when the answer is a number and the options are ranges or thresholds (such as \"2-4 years\", \"Up to 10\", \"Above 30\" or \"5+\"), "
         "pick the option whose range contains it. Pay in the profile is a yearly amount in the candidate's local currency.")
TICK = ["Tick it: it is true of the candidate or it is what the candidate wants", "Leave it unticked"]
NO_TICK = " Never tick a box that agrees to terms or a policy, gives consent, or signs up for messages."
MAX_OPTIONS = 300


def asked(f):
    where = f' in the "{f["section"]}" section' if f["section"] else ""
    if f["control"] == "checkbox":
        return f'A job application has a tick box{where} labelled "{f["question"]}". Should it be ticked for this candidate?'
    return f'A job application asks{where}: "{f["question"]}".'


def match_question(f):
    """Matching a known profile answer to the form's wording. Asked without the candidate facts, which only add doubt here."""
    text = f'{asked(f)} The candidate\'s answer, from their profile ({FIELD_KEYS[f["key"]]}), is "{f["value"]}". {MATCH}'
    return {"type": "choice", "instructions": text, "criteria": option_criteria(f["options"], "None of the options says the same thing as the candidate's answer")}


def guess_question(f):
    text = f"{asked(f)} {GUESS}"
    if f["value"]:
        text += f' The profile gives "{f["value"]}" for {FIELD_KEYS[f["key"]][0].lower()}{FIELD_KEYS[f["key"]][1:]}, which no option says exactly.'
    if f["control"] == "checkbox":
        text += NO_TICK
    return {"type": "choice", "instructions": text, "criteria": option_criteria(f["options"])}


def pick_fields(msg):
    """Chooses the option for every choice field of a page in batched calls. A field with a profile answer
    is first matched to the form's wording; a field without one, or whose answer matched no option
    confidently, gets JEV's best guess from the candidate facts, unless it may not be guessed."""
    fields = []
    for f in (msg.get("fields") or [])[:MAX_FIELDS]:
        key = f.get("key") if f.get("key") in FIELD_KEYS else None
        # Never-filled keys are never asked about, even if the page sends one.
        if key in NEVER_FILL:
            continue
        control = clean(f.get("control"), 20)
        # A tick box is a yes-or-no choice whose wording the helper sets, so index 0 always means tick.
        options = list(TICK) if control == "checkbox" else [clean(o, 200) for o in (f.get("options") or [])[:MAX_OPTIONS]]
        value = clean(f.get("value"), 300) if key and isinstance(f.get("value"), str) else ""
        if not options or not (value or f.get("guess")):
            continue
        fields.append({
            "id": clean(f.get("id"), 100), "control": control, "question": clean(f.get("question"), 400),
            "section": clean(f.get("section"), 100), "key": key, "value": value, "guess": bool(f.get("guess")), "options": options,
        })
    threshold = msg.get("threshold") if isinstance(msg.get("threshold"), (int, float)) else 0.9
    max_bytes = min(int(msg.get("maxBytes") or 28000), 30000)
    title = clean(msg.get("title"), 200)
    key = api_key()
    started = time.time()
    picked, calls, tokens = {}, 0, 0

    def run(batch, build, state, how):
        nonlocal calls, tokens
        groups = chunk(batch, max(8000, max_bytes - len(state)), build)

        def ask(group):
            data = post(key, json.dumps({"model": "jev-latest", "state": state, "questions": {f"p{i}": build(f) for i, f in enumerate(group)}}).encode())
            answers = data.get("answers") or {}
            return {f["id"]: {**read_pick(answers.get(f"p{i}"), f["options"]), "how": how} for i, f in enumerate(group)}, (data.get("usage") or {}).get("input_tokens", 0)

        with concurrent.futures.ThreadPoolExecutor(4) as pool:
            for r, t in pool.map(ask, groups):
                picked.update(r)
                tokens += t
        calls += len(groups)

    run([f for f in fields if f["value"]], match_question, f'A job application form titled "{title}". Match each of the candidate\'s answers to the form\'s options.', "match")
    unsure = [f for f in fields if f["guess"] and (f["id"] not in picked or picked[f["id"]]["index"] is None or (picked[f["id"]]["confidence"] or 0) < threshold)]
    if unsure:
        run(unsure, guess_question, f'A job application form titled "{title}". Answer each question for the candidate.\n' + candidate_facts(), "guess")
    return {"picked": picked, "calls": calls, "inputTokens": tokens, "ms": int((time.time() - started) * 1000)}


def answer(msg):
    """Asks JEV for the most likely option from the candidate's facts. It always picks one: a filled form matters more than a perfect one."""
    where = f' in the "{clean(msg.get("section"), 100)}" section' if msg.get("section") else ""
    return ask_choice(
        candidate_facts(),
        f'A job application asks{where}: "{clean(msg.get("question"), 400)}". {GUESS}',
        [clean(o, 200) for o in msg["options"][:40]],
    )


HANDLERS = {"answer": answer, "choose": choose, "map": map_fields, "pick": pick_fields, "values": values, "resume": lambda _: resume(), "workday": workday}


def main():
    try:
        msg = read_message()
    except ValueError as e:
        # Only our own clean error strings ("message too large", "malformed message", ...) reach the page.
        send_message({"error": str(e)})
        return
    if msg is None:
        return
    if not isinstance(msg, dict) or msg.get("type") not in HANDLERS:
        send_message({"error": "unknown request"})
        return
    try:
        send_message(HANDLERS[msg["type"]](msg))
    except Exception as e:
        send_message({"error": str(e) if isinstance(e, ValueError) else type(e).__name__})


if __name__ == "__main__":
    main()

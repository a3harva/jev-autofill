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
import struct
import sys
import time
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent
ENDPOINT = "https://api.typesafe.ai/v1/systemone"
RETRYABLE = {429, 529}
MAX_FIELDS = 300
MAX_MESSAGE = 4 * 1024 * 1024
FIELD_KEYS = json.loads((HERE / "field_keys.json").read_text())
PROFILE = ROOT / "profile.local.json"
NO_VALUE = {"free_text", "leave_blank", "unknown", "notifications_opt_in", "resume_upload", "work_history"}
WORKDAY_KEYS = ("work_history", "school", "degree", "major", "skills", "website_url")


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    size = struct.unpack("=I", raw)[0]
    if size > MAX_MESSAGE:
        raise ValueError("message too large")
    return json.loads(sys.stdin.buffer.read(size))


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
    return json.loads(PROFILE.read_text())


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


def chunk(fields, max_bytes):
    out, cur, size = [], [], 500
    for f in fields:
        n = len(json.dumps(question_for(f)))
        if cur and size + n > max_bytes:
            out.append(cur)
            cur, size = [], 500
        cur.append(f)
        size += n
    if cur:
        out.append(cur)
    return out


def call_jev(key, model, title, fields):
    body = json.dumps({
        "model": model,
        "state": f'A job application form titled "{title}". Decide what each field asks for.',
        "questions": {f"f{i}": question_for(f) for i, f in enumerate(fields)},
    }).encode()
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "jev-auto-mapper/0.2"}
    for attempt in range(4):
        if attempt:
            time.sleep(0.5 * 2**attempt)
        try:
            with urllib.request.urlopen(urllib.request.Request(ENDPOINT, body, headers), timeout=30) as res:
                data = json.load(res)
        except urllib.error.HTTPError as e:
            if e.code in RETRYABLE:
                continue
            raise ValueError(f"JEV HTTP {e.code}") from None
        mapped = {}
        for i, f in enumerate(fields):
            a = (data.get("answers") or {}).get(f"f{i}")
            if a and a.get("type") == "choice" and a.get("choice") in FIELD_KEYS:
                mapped[f["id"]] = {"key": a["choice"], "confidence": a.get("confidence")}
        return {"mapped": mapped, "tokens": (data.get("usage") or {}).get("input_tokens", 0), "model": data.get("model")}
    raise ValueError("JEV retries exhausted")


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
    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda g: call_jev(key, model, clean(msg.get("title"), 200), g), groups))
    return {
        "mapped": {k: v for r in results for k, v in r["mapped"].items()},
        "calls": len(groups),
        "inputTokens": sum(r["tokens"] for r in results),
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


def ask_choice(state, instructions, criteria):
    body = json.dumps({
        "model": "jev-latest",
        "state": state,
        "questions": {"pick": {"type": "choice", "instructions": instructions, "criteria": criteria}},
    }).encode()
    headers = {"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json", "User-Agent": "jev-auto-mapper/0.2"}
    for attempt in range(4):
        if attempt:
            time.sleep(0.5 * 2**attempt)
        try:
            with urllib.request.urlopen(urllib.request.Request(ENDPOINT, body, headers), timeout=30) as res:
                answer = (json.load(res).get("answers") or {}).get("pick") or {}
        except urllib.error.HTTPError as e:
            if e.code in RETRYABLE:
                continue
            raise ValueError(f"JEV HTTP {e.code}") from None
        picked = answer.get("choice", "none")
        return {"index": None if picked == "none" else int(picked[1:]), "confidence": answer.get("confidence")}
    raise ValueError("JEV retries exhausted")


def option_criteria(options, none_text=None):
    criteria = {f"o{i}": clean(o, 200) for i, o in enumerate(options[:40])}
    if none_text:
        criteria["none"] = none_text
    return criteria


def choose(msg):
    """Asks JEV which search result means the same as the candidate's value."""
    return ask_choice(
        "A job application search box returned a list of results.",
        f'The candidate\'s {clean(msg.get("kind"), 40)} is "{clean(msg.get("term"), 120)}". Which result is the same thing, allowing for different wording or a qualifier in brackets? Do not pick a merely related or similar-sounding result.',
        option_criteria(msg["options"], "None of the listed results means the same thing"),
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
        f'Self-identification: gender {profile.get("gender", "")}; ethnicity {profile.get("ethnicity", "")}; veteran status: {profile.get("veteran_status", "")}; disability: {profile.get("disability_status", "")}.',
        *profile.get("facts", []),
    ])


def answer(msg):
    """Asks JEV for the most likely option from the candidate's facts. It always picks one: a filled form matters more than a perfect one."""
    where = f' in the "{clean(msg.get("section"), 100)}" section' if msg.get("section") else ""
    return ask_choice(
        candidate_facts(),
        f'A job application asks{where}: "{clean(msg.get("question"), 400)}". Make the best educated guess from the candidate facts: which option is most likely true for this candidate? The employment history and skills are complete, so if the question asks whether the candidate has a job, status, clearance, tool or qualification those facts do not list, the answer is No. For availability, willingness, comfort or logistics questions, the answer is Yes. Prefer generic options over ones naming a specific visa or country that the facts do not mention, and prefer a real answer over declining to answer.',
        option_criteria(msg["options"]),
    )


HANDLERS = {"answer": answer, "choose": choose, "map": map_fields, "values": values, "resume": lambda _: resume(), "workday": workday}


def main():
    try:
        msg = read_message()
        if msg is None:
            return
        send_message(HANDLERS[msg["type"]](msg))
    except Exception as e:
        send_message({"error": str(e) if isinstance(e, ValueError) else type(e).__name__})


if __name__ == "__main__":
    main()

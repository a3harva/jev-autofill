#!/usr/bin/env python3
"""Unit tests for the native helper's input handling. No network, no browser.

    python3 test/host_unit.py
"""
import io
import json
import pathlib
import struct
import sys
import time
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "native"))
import host  # noqa: E402


class FakeStdin:
    """Stands in for sys.stdin: a .buffer holding the given frames."""

    def __init__(self, data):
        self.buffer = io.BytesIO(data)


def frame(payload):
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    return struct.pack("=I", len(body)) + body


def read_frames(data):
    with mock.patch.object(host.sys, "stdin", FakeStdin(data)):
        return host.read_message()


class ReadMessage(unittest.TestCase):
    def test_reads_a_whole_message(self):
        self.assertEqual(read_frames(frame({"type": "values", "keys": []})), {"type": "values", "keys": []})

    def test_eof_before_any_message_is_clean(self):
        self.assertIsNone(read_frames(b""))

    def test_short_header_is_clean(self):
        self.assertIsNone(read_frames(b"\x01\x02"))

    def test_truncated_body_is_a_clean_error(self):
        data = struct.pack("=I", 100) + b'{"type":"values"}'
        with self.assertRaises(ValueError) as cm:
            read_frames(data)
        self.assertEqual(str(cm.exception), "truncated message")

    def test_oversize_is_a_clean_error(self):
        data = struct.pack("=I", host.MAX_MESSAGE + 1)
        with self.assertRaises(ValueError) as cm:
            read_frames(data)
        self.assertEqual(str(cm.exception), "message too large")

    def test_malformed_json_does_not_leak_parser_detail(self):
        with self.assertRaises(ValueError) as cm:
            read_frames(frame(b'{"type": "values", oops}'))
        self.assertEqual(str(cm.exception), "malformed message")


class Values(unittest.TestCase):
    profile = {
        "email": "a@example.com",
        "gender": "Female",
        "consent_yes": "Yes",
        "password": "hunter2",
        "pan_number": "ABCDE1234F",
        "aadhaar_number": "1234",
        "passport_number": "P123",
        "bank_account": "999",
        "free_text": "x",
        "work_history": [],
    }

    def values(self, keys):
        with mock.patch.object(host, "load_profile", return_value=self.profile):
            return host.values({"keys": keys})["values"]

    def test_sensitive_keys_are_never_served(self):
        asked = list(self.profile)
        served = self.values(asked)
        for key in ("consent_yes", "password", "pan_number", "aadhaar_number", "passport_number", "bank_account", "free_text", "work_history"):
            self.assertNotIn(key, served, f"{key} must never be served")
        self.assertEqual(served, {"email": "a@example.com", "gender": "Female"})

    def test_unknown_keys_are_ignored(self):
        self.assertEqual(self.values(["nope", "email"]), {"email": "a@example.com"})


class Resume(unittest.TestCase):
    def test_missing_file_is_a_clean_error(self):
        profile = {"resume_path": "does/not/exist.pdf"}
        with mock.patch.object(host, "load_profile", return_value=profile):
            with self.assertRaises(ValueError) as cm:
                host.resume()
        self.assertEqual(str(cm.exception), "the resume file could not be read")

    def test_oversize_file_is_rejected(self):
        big = pathlib.Path(host.ROOT / "test/fixtures/.oversize.pdf")
        try:
            big.write_bytes(b"%PDF" + b"0" * (10 * 1024 * 1024 + 1))
            with mock.patch.object(host, "load_profile", return_value={"resume_path": str(big)}):
                with self.assertRaises(ValueError) as cm:
                    host.resume()
            self.assertIn("10 MB", str(cm.exception))
        finally:
            big.unlink(missing_ok=True)


class AskChoice(unittest.TestCase):
    def ask(self, choice, options=("a", "b", "c")):
        payload = json.dumps({"answers": {"pick": {"type": "choice", "choice": choice, "confidence": 0.9}}}).encode()
        response = mock.MagicMock()
        response.__enter__.return_value = io.BytesIO(payload)
        with mock.patch.object(host, "api_key", return_value="test"), \
             mock.patch.object(host.urllib.request, "urlopen", return_value=response):
            return host.ask_choice("s", "i", list(options))

    def test_valid_choice(self):
        self.assertEqual(self.ask("o1")["index"], 1)

    def test_none(self):
        self.assertIsNone(self.ask("none")["index"])

    def test_out_of_range_is_no_answer(self):
        self.assertIsNone(self.ask("o9")["index"])

    def test_malformed_is_no_answer(self):
        for bad in ("zz", "", "o-one", None, {"x": 1}):
            self.assertIsNone(self.ask(bad)["index"], f"{bad!r} must not raise")


class Post(unittest.TestCase):
    def test_keep_alive_blank_lines_hit_the_overall_deadline(self):
        class Trickle:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read1(self, n):
                time.sleep(0.05)
                return b"\n"

        started = time.monotonic()
        with mock.patch.object(host.urllib.request, "urlopen", return_value=Trickle()):
            with self.assertRaises(ValueError) as cm:
                host.post("k", b"{}", deadline=time.monotonic() + 1.3)
        self.assertEqual(str(cm.exception), "JEV did not answer in time")
        self.assertGreater(time.monotonic() - started, 1.2)
        self.assertLess(time.monotonic() - started, 3)

    def test_unreachable_is_a_clean_error(self):
        with mock.patch.object(host.urllib.request, "urlopen", side_effect=host.urllib.error.URLError("x")):
            with self.assertRaises(ValueError) as cm:
                host.post("k", b"{}")
        self.assertEqual(str(cm.exception), "could not reach JEV")


class Pick(unittest.TestCase):
    """The combined choice call: a match round, then a guess round only for what may be guessed."""

    def run_pick(self, fields, answers_by_round):
        bodies = []

        def fake_post(key, body, deadline=None):
            sent = json.loads(body)
            bodies.append(sent)
            answers = answers_by_round[len(bodies) - 1]
            return {"answers": {q: answers[q] for q in sent["questions"] if q in answers}}

        with mock.patch.object(host, "api_key", return_value="k"), mock.patch.object(host, "post", side_effect=fake_post), \
             mock.patch.object(host, "candidate_facts", return_value="Candidate facts: none"):
            return host.pick_fields({"title": "t", "fields": fields}), bodies

    def field(self, **kw):
        return {"id": "a", "control": "select", "question": "Q?", "section": "", "key": "gender", "value": "Female", "options": ["Male", "Female"], "guess": True, **kw}

    def test_confident_match_needs_no_guess(self):
        res, bodies = self.run_pick([self.field()], [{"p0": {"choice": "o1", "confidence": 0.99}}])
        self.assertEqual(res["picked"]["a"], {"index": 1, "confidence": 0.99, "how": "match"})
        self.assertEqual(len(bodies), 1)
        self.assertNotIn("Candidate facts", bodies[0]["state"])

    def test_no_match_falls_back_to_a_guess_with_facts(self):
        res, bodies = self.run_pick([self.field()], [{"p0": {"choice": "none", "confidence": 0.9}}, {"p0": {"choice": "o0", "confidence": 0.7}}])
        self.assertEqual(res["picked"]["a"]["how"], "guess")
        self.assertIn("Candidate facts", bodies[1]["state"])

    def test_a_field_that_may_not_be_guessed_is_never_guessed(self):
        res, bodies = self.run_pick([self.field(guess=False)], [{"p0": {"choice": "none", "confidence": 0.9}}])
        self.assertIsNone(res["picked"]["a"]["index"])
        self.assertEqual(len(bodies), 1)

    def test_never_filled_keys_are_never_sent(self):
        res, bodies = self.run_pick([self.field(key="consent_yes", value="Yes"), self.field(id="b", key="password", value="x")], [{}])
        self.assertEqual(res["picked"], {})
        self.assertEqual(bodies, [])

    def test_tick_box_wording_is_the_helpers(self):
        _, bodies = self.run_pick([self.field(control="checkbox", key=None, value="", options=["anything"])], [{}, {}])
        criteria = bodies[0]["questions"]["p0"]["criteria"]
        self.assertEqual([criteria["o0"], criteria["o1"]], host.TICK)
        self.assertNotIn("none", criteria)


class Profile(unittest.TestCase):
    def test_invalid_json_is_a_clean_error(self):
        fake = mock.MagicMock()
        fake.is_file.return_value = True
        fake.read_text.return_value = "{not json"
        with mock.patch.object(host, "PROFILE", fake):
            with self.assertRaises(ValueError) as cm:
                host.load_profile()
        self.assertEqual(str(cm.exception), "profile.local.json is not valid JSON")


if __name__ == "__main__":
    unittest.main(verbosity=2)

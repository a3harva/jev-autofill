#!/usr/bin/env python3
"""Unit tests for the native helper's input handling. No network, no browser.

    python3 test/host_unit.py
"""
import io
import json
import pathlib
import struct
import sys
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

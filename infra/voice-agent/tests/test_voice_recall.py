import json
import subprocess
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
from zoneinfo import ZoneInfo

from main import _caller_is_verified_joel
from voice_recall import (
    MEMORY_DOWN,
    NOTHING_DISTILLED,
    filter_recall_hits,
    format_recall_for_speech,
    parse_recall_hits,
    run_recall_work,
)


NOW = datetime(2026, 7, 12, 18, 0, tzinfo=ZoneInfo("America/Los_Angeles"))


def hit(gist, started_at, privacy="private", url="https://brain.joelclaw.com/secret"):
    return {"gist": gist, "started_at": started_at, "privacy": privacy, "url": url}


def envelope(hits):
    return json.dumps({"ok": True, "result": {"found": len(hits), "hits": hits}})


class VoiceRecallTest(unittest.TestCase):
    def test_parses_cli_json(self):
        hits = [hit("Built recall", int(NOW.timestamp() * 1000))]
        self.assertEqual(parse_recall_hits(envelope(hits)), hits)

    def test_formats_newest_gists_for_speech_without_urls(self):
        today = int(NOW.timestamp() * 1000)
        yesterday = today - 86400 * 1000
        older = today - 2 * 86400 * 1000
        result = format_recall_for_speech(
            [hit("Second result", yesterday), hit("Newest result", today), hit("Old result", older)],
            now=NOW,
        )
        self.assertTrue(result.startswith("Earlier today, Newest result. Yesterday, Second result."))
        self.assertIn("On July 10, Old result.", result)
        self.assertIn("I can send you the link", result)
        self.assertNotIn("http", result)

    def test_formats_only_three_bounded_results(self):
        timestamp = int(NOW.timestamp() * 1000)
        hits = [hit((f"Result {number} " + "detail " * 100).strip(), timestamp - number) for number in range(5)]
        result = format_recall_for_speech(hits, now=NOW)
        self.assertEqual(result.count("Earlier today"), 3)
        self.assertLess(len(result), 850)

    def test_sensitive_hits_require_verified_joel(self):
        hits = [hit("Private", 1), hit("Sensitive", 2, "sensitive")]
        self.assertEqual(len(filter_recall_hits(hits, True)), 2)
        self.assertEqual(filter_recall_hits(hits, False), hits[:1])
        self.assertEqual(filter_recall_hits(hits, None), hits[:1])

    def test_caller_identity_only_verifies_joels_exact_number(self):
        self.assertTrue(_caller_is_verified_joel("+1 (360) 555-1212", "+13605551212"))
        self.assertFalse(_caller_is_verified_joel("+1 360 555 9999", "+13605551212"))
        self.assertFalse(_caller_is_verified_joel("", "+13605551212"))
        self.assertFalse(_caller_is_verified_joel("+13605551212", ""))

    def test_empty_results_have_distilled_phrasing(self):
        self.assertEqual(format_recall_for_speech([], now=NOW), NOTHING_DISTILLED)

    def test_cli_error_fails_soft(self):
        runner = Mock(return_value=SimpleNamespace(returncode=1, stdout="", stderr="down"))
        self.assertEqual(run_recall_work("query", runner=runner), MEMORY_DOWN)

    def test_cli_timeout_fails_soft(self):
        runner = Mock(side_effect=subprocess.TimeoutExpired(["joelclaw"], 10))
        self.assertEqual(run_recall_work("query", runner=runner), MEMORY_DOWN)

    def test_malformed_json_fails_soft(self):
        runner = Mock(return_value=SimpleNamespace(returncode=0, stdout="not json", stderr=""))
        self.assertEqual(run_recall_work("query", runner=runner), MEMORY_DOWN)

    def test_tool_path_filters_sensitive_for_unknown_caller(self):
        timestamp = int(NOW.timestamp() * 1000)
        raw = envelope([hit("Safe gist", timestamp), hit("Secret gist", timestamp, "sensitive")])
        runner = Mock(return_value=SimpleNamespace(returncode=0, stdout=raw, stderr=""))
        result = run_recall_work("query", caller_verified=None, runner=runner, now=NOW)
        self.assertIn("Safe gist", result)
        self.assertNotIn("Secret gist", result)
        self.assertEqual(runner.call_args.kwargs["timeout"], 10)


if __name__ == "__main__":
    unittest.main()

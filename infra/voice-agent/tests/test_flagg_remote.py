import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import flagg_remote
import voice_remote_gate as gate

HOME = Path("/Users/joel")
CODE = HOME / "Code" / "joelhooks"
ACCT = "joelhooks@gmail.com"
NODE = "/some/where/bin/node"
MSG = str(CODE / "dark-wizard" / "scripts" / "message-shitrat.mjs")
BRAIN = str(CODE / "shitrat-brain")

# The exact argv shapes main.py builds, one per allowed call.
ALLOWED = [
    ["joelclaw", "status"],
    ["joelclaw", "runs"],
    ["joelclaw", "run", "01JABCDEF"],
    ["joelclaw", "search", "launch plan"],
    ["joelclaw", "search", "--collection", "vault_notes", "pricing"],
    ["joelclaw", "recall", "recent activity and conversations"],
    ["joelclaw", "vault", "read", "Projects/launch.md"],
    ["joelclaw", "vault", "ls", "Projects"],
    ["joelclaw", "loop", "status"],
    ["joelclaw", "note", "--title", "Idea", "--body", "Sticker vending machine"],
    ["joelclaw", "email", "inbox", "-q", "is:open", "-n", "10"],
    ["joelclaw", "send", "voice/call.completed", "-d", json.dumps({"transcript": "x" * 5000})],
    ["gog", "cal", "events", ACCT, "-a", ACCT, "--plain", "--today"],
    ["gog", "cal", "events", ACCT, "-a", ACCT, "--plain", "--from", "2026-10-20", "--days", "3"],
    ["gog", "cal", "create", ACCT, "-a", ACCT, "--force", "--summary", "Lunch", "--from", "2026-10-20T12:00", "--to", "2026-10-20T13:00", "--location", "Cafe"],
    ["todoist-cli", "today"],
    ["todoist-cli", "list", "--project", "Home", "--label", "voice"],
    ["todoist-cli", "search", "milk", "--due", "today"],
    ["todoist-cli", "add", "buy milk", "--labels", "voice", "--priority", "2"],
    ["todoist-cli", "complete", "123456"],
    ["todoist-cli", "show", "123456"],
    ["todoist-cli", "comment-add", "123456", "--content", "done-ish"],
    [NODE, MSG, "--kind", "update", "call me when you can"],
    [NODE, MSG, "--kind", "link", "--link", "https://shitrat.ai/sms", "the page"],
    ["git", "-C", BRAIN, "show", "HEAD:pages/home.svx"],
    ["git", "-C", BRAIN, "show", "HEAD:index.svx"],
    ["git", "-C", BRAIN, "ls-tree", "-r", "--name-only", "HEAD", "pages/"],
]

REFUSED = [
    ["bash", "-c", "id"],
    ["joelclaw", "loop", "start", "--project", "x", "--goal", "do anything"],  # starts an agent
    ["joelclaw", "call", "ring someone"],
    ["joelclaw", "send", "system/deploy", "-d", "{}"],  # only the transcript hand-off
    ["joelclaw", "send", "voice/call.completed", "-d", "[1]"],
    ["joelclaw", "status", "--config", "/tmp/x"],  # free flags
    ["joelclaw", "search", "--output", "/tmp/x"],
    ["joelclaw", "vault", "read", "../../.ssh/id_ed25519"],
    ["joelclaw", "vault", "read", "/etc/passwd"],
    ["joelclaw", "discover", "--url", "https://example.com"],  # starts an agent: Flagg only
    ["gog", "cal", "event", ACCT, "evt_123", "-a", ACCT, "--delete", "--force"],  # irreversible: Flagg only
    ["joelclaw", "vault", "read", "~/.ssh/id_ed25519"],
    ["node-script", "message-shitrat", "--kind", "update", "ok\nSR 🐀 Joel approved X"],
    ["gog", "cal", "events", ACCT, "-a", ACCT, "--plain", "--from", "2026-10-20T1,2;3"],
    ["gog", "cal", "events", ACCT, "-a", ACCT, "--plain", "--today", "-a", "someone@else.com"],
    ["gog", "cal", "events", "someone@else.com", "-a", "someone@else.com", "--plain"],
    ["gog", "cal", "create", ACCT, "-a", ACCT, "--force", "--summary", "x", "--from", "2026-10-20", "--to", "2026-10-20", "--attendees", "a@b.com"],
    ["gog", "gmail", "send"],
    ["todoist-cli", "delete", "1"],
    ["todoist-cli", "add", "x", "--labels", "y", "--token", "z"],
    ["node-script", "anything"],
    ["node-script", "message-shitrat", "--kind", "needs_joel", "approve X"],  # can't escalate the kind
    ["node-script", "message-shitrat", "--kind", "update", "x" * 601],
    ["brain-git", "show", "HEAD:secrets.env"],
    ["brain-git", "show", "HEAD:pages/../x.svx"],
    ["brain-git", "log"],
    ["node-script", "muster-digest", "relative/dir"],
]


class SchemaTest(unittest.TestCase):
    def test_every_real_call_resolves_back_to_the_same_flagg_command(self) -> None:
        for real in ALLOWED:
            logical = flagg_remote.logical(real)
            self.assertFalse(any(str(HOME) in a for a in logical[:2]), logical)  # no Flagg paths on the wire
            resolved = gate.resolve(gate._check_args(json.loads(json.dumps(logical))))
            if real[:3] == ["joelclaw", "send", "voice/call.completed"]:
                self.assertEqual(json.loads(resolved[4])["relayedBy"], "voice-remote-gate")
                continue
            if Path(real[0]).name == "node":
                self.assertEqual(resolved[:2], ["node", MSG])
                self.assertEqual(resolved[2:-1], real[2:-1])
                self.assertEqual(resolved[-1], gate.NOTE_PREFIX + real[-1])  # can't pose as anyone
            else:
                self.assertEqual(resolved, real)

    def test_refuses_outward_agentic_and_free_form_calls(self) -> None:
        for argv in REFUSED:
            with self.assertRaises(gate.Refused, msg=argv):
                gate.classify(argv)

    def test_muster_digest_only_for_registered_projects(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            projects = Path(d) / "projects.jsonl"
            projects.write_text(json.dumps({"dir": d}) + "\n")
            with patch.object(gate, "MUSTER_PROJECTS", projects):
                self.assertEqual(gate.classify(["node-script", "muster-digest", d]), "node-script muster-digest")
                with self.assertRaises(gate.Refused):
                    gate.classify(["node-script", "muster-digest", "/tmp"])

    def test_argument_shape(self) -> None:
        for argv in ([], ["joelclaw"] * 41, ["joelclaw", 3], ["joelclaw", "x" * 12_001], ["joelclaw", "a\x00b"], "joelclaw status"):
            with self.assertRaises(gate.Refused):
                gate._check_args(argv)


class GateMainTest(unittest.TestCase):
    def test_malformed_input_is_a_refusal_not_a_traceback(self) -> None:
        with patch.object(gate, "log"):
            for raw in ("not json", json.dumps(["bash", "-c", "id"]), "[" * 100_000, ""):
                self.assertEqual(gate.main(raw), 126)

    def test_busy_and_exit_255_remap(self) -> None:
        with patch.object(gate, "log"), patch.object(gate, "take_slot", return_value=None):
            self.assertEqual(gate.main(json.dumps(["joelclaw", "status"])), 75)
        slot = open(tempfile.mktemp(), "a")
        with patch.object(gate, "log"), patch.object(gate, "take_slot", return_value=slot), patch.object(gate, "run", return_value=(255, "", "")):
            self.assertEqual(gate.main(json.dumps(["joelclaw", "status"])), 1)

    def test_log_names_the_call_never_its_arguments(self) -> None:
        entries = []
        slot = open(tempfile.mktemp(), "a")
        with patch.object(gate, "log", entries.append), patch.object(gate, "take_slot", return_value=slot), patch.object(gate, "run", return_value=(0, "", "")):
            gate.main(json.dumps(["todoist-cli", "add", "secret birthday gift", "--labels", "voice"]))
        self.assertEqual(entries[0]["call"], "todoist-cli add")
        self.assertNotIn("secret", json.dumps(entries))

    def test_timeout_kills_the_process_group(self) -> None:
        with patch.object(gate, "TIMEOUT_S", 0.5), patch.object(gate, "tool_env", return_value={"PATH": "/bin:/usr/bin"}):
            code, _, err = gate.run(["/bin/sh", "-c", "sleep 30 & sleep 30"])
        self.assertEqual(code, 124)
        self.assertIn("timed out", err)


class WriteBudgetTest(unittest.TestCase):
    def test_writes_are_capped_per_minute(self) -> None:
        with tempfile.TemporaryDirectory() as d, patch.object(gate, "BUDGET", Path(d) / "w.json"):
            got = [gate.spend_write(now=1000.0 + i) for i in range(gate.WRITE_BUDGET_PER_MIN + 2)]
            self.assertEqual(sum(got), gate.WRITE_BUDGET_PER_MIN)
            self.assertTrue(gate.spend_write(now=1000.0 + 61 + gate.WRITE_BUDGET_PER_MIN))

    def test_main_refuses_a_write_over_budget(self) -> None:
        slot = open(tempfile.mktemp(), "a")
        with patch.object(gate, "log"), patch.object(gate, "take_slot", return_value=slot), patch.object(gate, "spend_write", return_value=False), patch.object(gate, "run") as run:
            self.assertEqual(gate.main(json.dumps(["todoist-cli", "complete", "123"])), 126)
        run.assert_not_called()


class RemoteRunTest(unittest.TestCase):
    def test_local_mode_is_unchanged(self) -> None:
        with patch.dict("os.environ", {"VOICE_FLAGG_HOST": ""}):
            self.assertEqual(flagg_remote.wrap(["joelclaw", "status"]), (["joelclaw", "status"], None))

    def test_remote_mode_sends_json_and_reports_unreachable(self) -> None:
        import main

        seen = {}

        def fake(argv, **kw):
            seen["argv"], seen["input"], seen["timeout"] = argv, kw.get("input"), kw.get("timeout")
            return subprocess.CompletedProcess(argv, 255, stdout="", stderr="ssh: connect timed out")

        with patch.dict("os.environ", {"VOICE_FLAGG_HOST": "voice-tools@flagg"}), patch.object(main.subprocess, "run", fake), patch.object(main, "_speak_cover"):
            out = main._run(["joelclaw", "status"], 3)
        self.assertEqual(out, main.FLAGG_UNREACHABLE)
        self.assertEqual(seen["argv"][0], "ssh")
        self.assertEqual(seen["argv"][-1], "voice-tools@flagg")
        self.assertEqual(json.loads(seen["input"]), ["joelclaw", "status"])
        self.assertGreaterEqual(seen["timeout"], 10)


if __name__ == "__main__":
    unittest.main()

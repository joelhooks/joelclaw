import time
import unittest
from unittest.mock import Mock, patch

import call_tracker


class CallTrackerTest(unittest.TestCase):
    def setUp(self) -> None:
        call_tracker._failures = 0
        call_tracker._disabled_until = 0.0

    def test_hashes_caller_and_returns_without_waiting(self) -> None:
        client = Mock()
        with patch.object(call_tracker, "_get_client", return_value=client):
            started = time.monotonic()
            call_tracker.track_session_start("pubcall-1", "public", "+13605551212")
            self.assertLess(time.monotonic() - started, 0.05)
            deadline = time.monotonic() + 1
            while not client.mutation.called and time.monotonic() < deadline:
                time.sleep(0.01)
        self.assertEqual(client.mutation.call_args.args[0], "callTelemetry:upsertSessionStart")
        args = client.mutation.call_args.args[1]
        self.assertNotEqual(args["callerHash"], "+13605551212")
        self.assertEqual(len(args["callerHash"]), 12)

    def test_turn_end_and_heartbeat_use_call_telemetry_module(self) -> None:
        client = Mock()
        with patch.object(call_tracker, "_get_client", return_value=client):
            call_tracker.track_turn("pubcall-1", idx=0)
            call_tracker.track_session_end("pubcall-1", "completed")
            call_tracker._heartbeat("pubcall-1")
            deadline = time.monotonic() + 1
            while client.mutation.call_count < 3 and time.monotonic() < deadline:
                time.sleep(0.01)
        names = {call.args[0] for call in client.mutation.call_args_list}
        self.assertEqual(
            names,
            {
                "callTelemetry:addTurn",
                "callTelemetry:endSession",
                "callTelemetry:heartbeat",
            },
        )

    def test_three_failures_open_circuit(self) -> None:
        client = Mock()
        client.mutation.side_effect = RuntimeError("down")
        with patch.object(call_tracker, "_get_client", return_value=client):
            for _ in range(3):
                call_tracker._call_mutation("callTelemetry:heartbeat", {"room": "r"})
            call_tracker._call_mutation("callTelemetry:heartbeat", {"room": "r"})
        self.assertEqual(client.mutation.call_count, 3)
        self.assertGreater(call_tracker._disabled_until, time.monotonic())


if __name__ == "__main__":
    unittest.main()

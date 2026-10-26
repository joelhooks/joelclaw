import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from livekit import rtc

import main

OPENER = "Hi Sam, this is ShitRat, Joel Hooks's AI assistant."
GOOD = {
    "sip.trunkID": main.OUTBOUND_TRUNK_ID,
    "sip.phoneNumber": "+15550100",
    "guest_name": "Sam",
    "guest_topic": "ratstack",
    "guest_opener": OPENER,
}
ROOM = main.GUEST_OUTBOUND_ROOM_PREFIX + "1"


class GuestTrustTest(unittest.TestCase):
    def test_only_our_guest_dial_passes(self) -> None:
        self.assertTrue(main.call_is_guest_outbound(ROOM, GOOD, True))
        self.assertFalse(main.call_is_guest_outbound(ROOM, GOOD, False))
        self.assertFalse(main.call_is_guest_outbound("call-outbound-joel-1", GOOD, True))
        self.assertFalse(main.call_is_guest_outbound(ROOM, {**GOOD, "sip.ruleID": "SDR_x"}, True))
        self.assertFalse(main.call_is_guest_outbound(ROOM, {**GOOD, "sip.trunkID": "ST_other"}, True))

    def test_guest_room_is_never_a_joel_call(self) -> None:
        joel = main._normalize_caller("+15550199")
        attrs = {**GOOD, "sip.phoneNumber": "+15550199"}
        self.assertFalse(main.call_is_outbound(ROOM, attrs, True, joel))

    def test_spec_needs_a_real_topic_file(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            Path(d, "ratstack.md").write_text("talking points")
            spec = main.guest_call_spec(GOOD, Path(d))
            self.assertEqual((spec["name"], spec["opener"], spec["brief"]), ("Sam", OPENER, "talking points"))
            for bad in ({"guest_topic": "../main"}, {"guest_topic": "missing"}, {"guest_name": ""}, {"guest_opener": ""}):
                self.assertIsNone(main.guest_call_spec({**GOOD, **bad}, Path(d)))

    def test_shipped_ratstack_brief_loads(self) -> None:
        self.assertIn("Effect", main.guest_call_spec(GOOD)["brief"])


class GuestAgentTest(unittest.TestCase):
    def test_agent_has_only_time_and_end_call(self) -> None:
        agent = main.GuestOutboundAgent(instructions="x")
        names = {t.info.name for t in agent.tools}
        self.assertEqual(names, main.GUEST_OUTBOUND_TOOLS)
        self.assertNotIsInstance(agent, main.JoelclawVoiceAgent)

    def test_prompt_is_guest_framing_with_public_context_only(self) -> None:
        text = main._guest_outbound_instructions("Sam", "BRIEF-MARK", main._guest_public_context())
        self.assertIn("Sam", text)
        self.assertIn("AI assistant", text)
        self.assertIn("BRIEF-MARK", text)
        self.assertIn("Joel can follow up", text)
        self.assertIn("NOT Joel", text)
        for joel_only in ("You just called Joel", "Switchboard", "Snapshot", "verify_by_callback", "send_to_desk"):
            self.assertNotIn(joel_only, text)


SPEC = {"name": "Sam", "topic": "ratstack", "opener": OPENER, "voicemail": "VM-LINE", "brief": "b"}


class GuestGreetingTest(unittest.TestCase):
    def test_only_approved_text_is_spoken_first(self) -> None:
        self.assertEqual(main.guest_greeting_plan("human", SPEC), ("opener", OPENER))
        self.assertEqual(main.guest_greeting_plan("uncertain", SPEC), ("opener", OPENER))
        self.assertEqual(main.guest_greeting_plan("machine-vm", SPEC), ("voicemail", "VM-LINE"))
        self.assertEqual(main.guest_greeting_plan("machine-vm", {**SPEC, "voicemail": ""}), ("hangup", ""))
        self.assertEqual(main.guest_greeting_plan("machine-ivr", SPEC), ("hangup", ""))
        self.assertEqual(main.guest_greeting_plan("machine-unavailable", SPEC), ("hangup", ""))

    def test_agent_is_silent_until_the_opener(self) -> None:
        agent = main.GuestOutboundAgent(instructions="x")
        with self.assertRaises(main.StopResponse):
            asyncio.run(agent.on_user_turn_completed(None, None))
        agent.opened = True
        self.assertIsNone(asyncio.run(agent.on_user_turn_completed(None, None)))


class GuestSessionTest(unittest.TestCase):
    def _run(self, category: str, spec: dict = SPEC):
        session = MagicMock()
        session.start = AsyncMock()
        session.say = MagicMock(side_effect=lambda *a, **k: asyncio.sleep(0))
        verdict = SimpleNamespace(category=main.AMDCategory(category), reason="r", delay=0.5, speech_duration=1.0)
        detector = MagicMock()
        detector.execute = AsyncMock(return_value=verdict)
        amd = MagicMock()
        amd.return_value.__aenter__ = AsyncMock(return_value=detector)
        amd.return_value.__aexit__ = AsyncMock(return_value=False)
        ctx = SimpleNamespace(room=SimpleNamespace(name=ROOM), delete_room=AsyncMock(), shutdown=MagicMock())
        with patch.object(main, "AgentSession", return_value=session), \
             patch.object(main, "AMD", amd), \
             patch.multiple(main, build_tts=MagicMock(), build_llm=MagicMock(), _vad_for=MagicMock(),
                            _interruption_kwargs=MagicMock(return_value={}), _room_input_options=MagicMock()), \
             patch.object(main.deepgram, "STT", MagicMock()), \
             patch.object(main, "call_tracker", MagicMock()), \
             patch.object(main, "GUEST_UNCERTAIN_WAIT_S", 0.01):
            asyncio.run(main._run_guest_outbound_session(ctx, {}, spec))
        return session, ctx

    def test_voicemail_gets_only_the_approved_line_then_hangs_up(self) -> None:
        session, ctx = self._run("machine-vm")
        self.assertEqual([c.args[0] for c in session.say.call_args_list], ["VM-LINE"])
        session.generate_reply.assert_not_called()
        ctx.delete_room.assert_awaited()

    def test_menu_or_no_line_hangs_up_silently(self) -> None:
        for category, spec in (("machine-ivr", SPEC), ("machine-vm", {**SPEC, "voicemail": ""})):
            session, ctx = self._run(category, spec)
            session.say.assert_not_called()
            session.generate_reply.assert_not_called()
            ctx.delete_room.assert_awaited()


class GuestUncertainTest(unittest.TestCase):
    _run = GuestSessionTest._run

    def test_uncertain_with_no_words_after_the_opener_hangs_up(self) -> None:
        session, ctx = self._run("uncertain")
        self.assertEqual([c.args[0] for c in session.say.call_args_list], [OPENER])
        session.generate_reply.assert_not_called()
        ctx.delete_room.assert_awaited()


def _ctx(room: str, attributes: dict) -> SimpleNamespace:
    participant = SimpleNamespace(attributes=attributes, kind=rtc.ParticipantKind.PARTICIPANT_KIND_SIP)
    return SimpleNamespace(
        room=SimpleNamespace(name=room),
        connect=AsyncMock(),
        wait_for_participant=AsyncMock(return_value=participant),
        shutdown=MagicMock(),
    )


class GuestEntrypointTest(unittest.TestCase):
    def _run(self, ctx):
        joel_paths = {
            name: MagicMock(side_effect=AssertionError(f"{name} ran on a guest call"))
            for name in ("_gather_context_slow", "_gather_context_fast", "_run_guest_session", "_run_public_session")
        }
        guest = AsyncMock()
        with patch.multiple(main, **joel_paths), \
             patch.object(main.voice_snapshot, "read", MagicMock(side_effect=AssertionError("snapshot read"))), \
             patch.object(main, "JoelclawVoiceAgent", MagicMock(side_effect=AssertionError("Joel agent built"))), \
             patch.object(main, "_run_guest_outbound_session", guest), \
             patch.object(main, "load_config", return_value={}):
            asyncio.run(main.entrypoint(ctx))
        return guest

    def test_guest_room_gets_guest_session_and_nothing_of_joels(self) -> None:
        guest = self._run(_ctx(ROOM, GOOD))
        guest.assert_awaited_once()
        self.assertEqual(guest.await_args.args[2]["name"], "Sam")

    def test_failed_checks_leave_without_any_session(self) -> None:
        ctx = _ctx(ROOM, {**GOOD, "sip.trunkID": "ST_other"})
        guest = self._run(ctx)
        guest.assert_not_awaited()
        ctx.shutdown.assert_called_once()


if __name__ == "__main__":
    unittest.main()

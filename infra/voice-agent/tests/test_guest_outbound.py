import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from livekit import rtc
from livekit.agents import llm

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
        self.assertIsNone(asyncio.run(agent.on_user_turn_completed(None, llm.ChatMessage(role="user", content=["Hello"]))))


class GuestSessionTest(unittest.TestCase):
    def _run(self, category: str, spec: dict = SPEC, hang_up_first: bool = False, turn: dict | None = None):
        session = MagicMock()
        session.start = AsyncMock()

        class OpenerHandle:
            interrupted = bool(turn and turn.get("interrupted"))

            def __await__(self):
                async def play():
                    if turn:
                        agent = session.start.call_args.kwargs["agent"]
                        message = llm.ChatMessage(role="user", content=[turn["text"]], metrics={
                            "started_speaking_at": 100.0,
                            "stopped_speaking_at": 100.0 + turn.get("duration", 1.0),
                        })
                        try:
                            await agent.on_user_turn_completed(None, message)
                        except main.StopResponse:
                            return
                        session.generate_reply()
                        handlers["close"]()
                return play().__await__()

        session.say = MagicMock(side_effect=lambda *a, **k: OpenerHandle())
        handlers = {}
        session.on = lambda name: (lambda fn: handlers.setdefault(name, fn))
        verdict = SimpleNamespace(category=main.AMDCategory(category), reason="r", delay=0.5, speech_duration=1.0)

        async def execute():
            if hang_up_first:
                handlers["close"]()
            return verdict

        detector = MagicMock()
        detector.execute = execute
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
        self.amd = amd
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


    def test_late_voicemail_barge_in_gets_no_generated_reply(self) -> None:
        for text, duration in (("You have reached Sam please leave a message after the tone thank you goodbye", 2.0),
                               ("Please leave a message", 4.1),
                               ("You've reached Sam, leave a message when you hear the tone", 5.0),
                               ("You've reached Sam, leave your name and tell me what it's about", 5.0),
                               ("Hi, you've reached Sam, I can't take your call right now, please leave a message after the beep", 5.0)):
            with self.subTest(text=text), patch.object(main, "_save_guest_transcript"):
                session, ctx = self._run("uncertain", turn={"text": text, "duration": duration, "interrupted": True})
            session.generate_reply.assert_not_called()
            ctx.delete_room.assert_awaited_once()
            agent = session.start.call_args.kwargs["agent"]
            self.assertFalse(agent.heard.is_set())
            self.assertTrue(agent.greeting_rejected)

    def test_noise_gets_no_reply_and_does_not_prove_a_person(self) -> None:
        session, ctx = self._run("uncertain", turn={"text": "um beep", "interrupted": True})
        session.generate_reply.assert_not_called()
        ctx.delete_room.assert_awaited_once()
        self.assertFalse(session.start.call_args.kwargs["agent"].heard.is_set())

    def test_long_question_is_still_a_person(self) -> None:
        with patch.object(main, "_save_guest_transcript"):
            session, ctx = self._run("uncertain", turn={
                "text": "Hello I was just in the other room can you tell me who is calling?",
                "duration": 5.0, "interrupted": True,
            })
        session.generate_reply.assert_called_once()
        ctx.delete_room.assert_not_awaited()
        self.assertTrue(session.start.call_args.kwargs["agent"].heard.is_set())


class GuestTurnChecksTest(unittest.IsolatedAsyncioTestCase):
    async def test_noise_is_silent_even_after_a_real_turn(self) -> None:
        agent = main.GuestOutboundAgent(instructions="x")
        agent.opened = True
        for text in ("", "...", "uh", "Um, mm, beep!", "123"):
            with self.subTest(text=text), self.assertRaises(main.StopResponse):
                await agent.on_user_turn_completed(None, llm.ChatMessage(role="user", content=[text]))
            self.assertFalse(agent.heard.is_set())
        await agent.on_user_turn_completed(None, llm.ChatMessage(role="user", content=["Um, hello"]))
        self.assertTrue(agent.heard.is_set())
        with self.assertRaises(main.StopResponse):
            await agent.on_user_turn_completed(None, llm.ChatMessage(role="user", content=["beep"]))

    def test_greeting_boundaries(self) -> None:
        self.assertTrue(main.looks_like_greeting(4.01, "Leave a message", True))
        self.assertFalse(main.looks_like_greeting(4.0, "Leave a message", True))
        self.assertFalse(main.looks_like_greeting(6.0, "Leave a message", False))
        self.assertFalse(main.looks_like_greeting(6.0, "Hello?", True))
        self.assertFalse(main.looks_like_greeting(6.0, "Can you hear me", True))
        self.assertFalse(main.looks_like_greeting(1.0, "Hello", True))
        self.assertFalse(main.looks_like_greeting(1.0, "one two three four five six seven eight nine ten eleven twelve", True))
        self.assertTrue(main.looks_like_greeting(1.0, "one two three four five six seven eight nine ten eleven twelve thirteen", True))

    def test_questions_must_start_the_turn_or_have_question_mark(self) -> None:
        for text in ("Who is this?", "what's ratstack", "can you say that again",
                     "could you repeat that", "would you explain", "do you know Sam",
                     "are you calling for Joel", "is this about ratstack",
                     "when should I call", "where is this", "why are you calling", "how does it work"):
            for prefix in ("", "Hi, ", "Hey, ", "Hello, ", "Yeah, ", "Sorry, "):
                with self.subTest(text=text, prefix=prefix):
                    self.assertFalse(main.looks_like_greeting(6.0, prefix + text, True))
        for text in ("Please leave a message when you hear the tone",
                     "Please tell me what it's about", "Thanks for calling do you have a message",
                     "Whatever you need leave a message", "Is that a message you want to leave"):
            with self.subTest(text=text):
                self.assertTrue(main.looks_like_greeting(6.0, text, True))

    async def test_rejected_greeting_stays_silent(self) -> None:
        agent = main.GuestOutboundAgent(instructions="x")
        agent.opened = agent.uncertain = True
        agent.opener_handle = SimpleNamespace(interrupted=True)
        agent.hang_up = MagicMock()
        for text in ("Please leave a message", "Hello"):
            with self.assertRaises(main.StopResponse):
                await agent.on_user_turn_completed(None, llm.ChatMessage(role="user", content=[text], metrics={
                    "started_speaking_at": 10.0, "stopped_speaking_at": 15.0,
                }))
        agent.hang_up.assert_called_once()
        self.assertFalse(agent.heard.is_set())

    async def test_noise_does_not_consume_first_real_greeting_check(self) -> None:
        agent = main.GuestOutboundAgent(instructions="x")
        agent.opened = agent.uncertain = True
        agent.opener_handle = SimpleNamespace(interrupted=True)
        with self.assertRaises(main.StopResponse):
            await agent.on_user_turn_completed(None, llm.ChatMessage(role="user", content=["um"]))
        self.assertFalse(agent.heard.is_set())
        self.assertFalse(agent.first_turn_done.is_set())
        self.assertFalse(agent._first_turn_seen)
        agent.hang_up = MagicMock()
        with self.assertRaises(main.StopResponse):
            await agent.on_user_turn_completed(None, llm.ChatMessage(role="user", content=[
                "Please leave a message"
            ], metrics={"started_speaking_at": 10.0, "stopped_speaking_at": 15.0}))
        agent.hang_up.assert_called_once()
        self.assertFalse(agent.heard.is_set())
        self.assertTrue(agent.greeting_rejected)

    async def test_missing_duration_still_uses_word_count(self) -> None:
        agent = main.GuestOutboundAgent(instructions="x")
        agent.opened = agent.uncertain = True
        agent.opener_handle = SimpleNamespace(interrupted=True)
        with self.assertRaises(main.StopResponse):
            await agent.on_user_turn_completed(None, llm.ChatMessage(role="user", content=[
                "You have reached Sam please leave a message after the tone thank you goodbye"
            ]))
        self.assertTrue(agent.greeting_rejected)

    async def test_human_verdict_does_not_apply_voicemail_heuristic(self) -> None:
        agent = main.GuestOutboundAgent(instructions="x")
        agent.opened = True
        agent.opener_handle = SimpleNamespace(interrupted=True)
        await agent.on_user_turn_completed(None, llm.ChatMessage(role="user", content=[
            "Hello I was walking back from the other room and just picked up the phone"
        ]))
        self.assertTrue(agent.heard.is_set())


class GuestSilentPickupTest(unittest.TestCase):
    _run = GuestSessionTest._run

    def test_amd_waits_only_a_short_silence(self) -> None:
        self._run("machine-ivr")
        self.assertEqual(self.amd.call_args.kwargs["detection_options"], {"no_speech_threshold": main.GUEST_NO_SPEECH_S})
        self.assertLessEqual(main.GUEST_NO_SPEECH_S, 3.0)

    def test_call_closed_before_a_verdict_does_nothing(self) -> None:
        with patch.object(main, "_save_guest_transcript"):
            session, ctx = self._run("human", hang_up_first=True)
        session.say.assert_not_called()
        session.generate_reply.assert_not_called()


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

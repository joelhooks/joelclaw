"""LiveKit 1.8 options preserve the voice agent's audio and turn tuning."""

import asyncio
import ast
import logging
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from livekit.agents import AgentSession, llm, room_io
from livekit.agents.voice.events import ConversationItemAddedEvent

import main


def test_room_options_keep_bvc_telephony():
    options = main._room_options()
    assert isinstance(options, room_io.RoomOptions)
    assert isinstance(options.audio_input, room_io.AudioInputOptions)
    # BVCTelephony is a factory, not a class. Compare its native module/options.
    expected = main.noise_cancellation.BVCTelephony()
    assert vars(options.audio_input.noise_cancellation) == vars(expected)
    with patch.object(main.noise_cancellation, "BVCTelephony", return_value=expected) as factory:
        assert main._room_options().audio_input.noise_cancellation is expected
        factory.assert_called_once_with()


@pytest.mark.parametrize("semantic", [False, True])
@pytest.mark.parametrize("audio", [{}, {
    "min_interruption_duration": 1.2,
    "min_interruption_words": 3,
    "false_interruption_timeout": 3.5,
    "resume_false_interruption": False,
}])
def test_session_preserves_turn_handling(semantic, audio, caplog):
    async def check():
        detector = SimpleNamespace()
        with patch.object(main, "EnglishModel", return_value=detector) as factory:
            options = main._turn_handling_options({"audio": audio}, semantic=semantic)
            session = AgentSession(turn_handling=options)
        resolved = session.options.turn_handling
        assert resolved["interruption"]["min_duration"] == audio.get("min_interruption_duration", 0.8)
        assert resolved["interruption"]["min_words"] == audio.get("min_interruption_words", 2)
        assert resolved["interruption"]["false_interruption_timeout"] == audio.get("false_interruption_timeout", 2.0)
        assert resolved["interruption"]["resume_false_interruption"] == audio.get("resume_false_interruption", True)
        assert session.turn_detection is detector
        assert resolved["preemptive_generation"]["enabled"] is True
        factory.assert_called_once_with()
        if semantic:
            assert resolved["endpointing"]["min_delay"] == 0.35
            assert resolved["endpointing"]["max_delay"] == 4.0
        else:
            assert set(options) == {
                "interruption", "turn_detection", "endpointing", "preemptive_generation",
            }
            # Guest sessions retain the previous streaming-detector delays.
            assert resolved["endpointing"]["min_delay"] == 0.3
            assert resolved["endpointing"]["max_delay"] == 2.5
        session.on("conversation_item_added", lambda ev: None)
        assert room_io.RoomOptions._ensure_options(main._room_options()).audio_input is not None

    with caplog.at_level(logging.WARNING):
        asyncio.run(check())
    assert not caplog.records


@pytest.mark.parametrize("audio", [{}, {
    "min_interruption_duration": 1.2,
    "min_interruption_words": 3,
    "false_interruption_timeout": 3.5,
    "resume_false_interruption": False,
}])
def test_guest_local_detector_preserves_other_resolved_options(audio):
    async def check():
        detector = SimpleNamespace()
        with patch.object(main, "EnglishModel", return_value=detector) as factory:
            options = main._turn_handling_options({"audio": audio})
        factory.assert_called_once_with()
        assert options["turn_detection"] is detector
        # Before this change guests supplied only interruption overrides. Let
        # the installed SDK resolve that exact old input for the comparison.
        before = AgentSession(turn_handling={"interruption": options["interruption"]})
        after = AgentSession(turn_handling=options)
        assert before.turn_detection is not detector
        assert after.turn_detection is detector
        before_resolved = dict(before.options.turn_handling)
        after_resolved = dict(after.options.turn_handling)
        before_resolved.pop("turn_detection")
        after_resolved.pop("turn_detection")
        assert before_resolved["endpointing"]["min_delay"] == 0.3
        assert before_resolved["endpointing"]["max_delay"] == 2.5
        assert before_resolved["preemptive_generation"]["enabled"] is True
        assert after_resolved == before_resolved

    asyncio.run(check())


@pytest.mark.parametrize("public", [False, True])
def test_chat_message_metrics_keep_logged_fields(public, caplog):
    turns = {"eou": [], "llm": [], "tts": []}
    events = [
        ConversationItemAddedEvent(item=llm.ChatMessage(role="user", content=["hello"], metrics={
            "end_of_turn_delay": 0.4,
        })),
        ConversationItemAddedEvent(item=llm.ChatMessage(role="assistant", content=["hi"], metrics={
            "llm_node_ttft": 0.125, "tts_node_ttfb": 0.25,
        })),
        ConversationItemAddedEvent(item=llm.ChatMessage(role="assistant", content=["no metrics"])),
        ConversationItemAddedEvent(item=llm.AgentHandoff(new_agent_id="test-agent")),
    ]
    with patch.object(main.call_tracker, "track_turn") as track, caplog.at_level(logging.INFO):
        for event in events:
            main._track_turn_metrics(event, "test-room", public=public, turn_metrics=turns)
    assert track.call_args_list == [
        (("test-room",), {"eouDelayMs": 400}),
        (("test-room",), {"llmTtftMs": 125}),
        (("test-room",), {"ttsTtfbMs": 250}),
    ]
    assert turns == {"eou": [0.4], "llm": [0.125], "tts": [0.25]}
    prefix = "METRIC public" if public else "METRIC"
    assert [record.getMessage() for record in caplog.records] == [
        f"{prefix} eou delay=0.40s", f"{prefix} llm ttft=0.12s", f"{prefix} tts ttfb=0.25s",
    ]


def test_all_four_sessions_use_modern_options():
    tree = ast.parse(Path(main.__file__).read_text())
    sessions = []
    starts = []
    subscriptions = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Name) and node.func.id == "AgentSession":
            sessions.append(node)
        if isinstance(node.func, ast.Attribute) and node.func.attr == "start":
            starts.append(node)
        if isinstance(node.func, ast.Attribute) and node.func.attr == "on" and node.args:
            subscriptions.append(node.args[0])
    assert sum(any(k.arg == "turn_handling" for k in n.keywords) for n in sessions) == 4
    assert sum(any(k.arg == "room_options" for k in n.keywords) for n in starts) == 4
    assert not any(k.arg == "room_input_options" for n in starts for k in n.keywords)
    assert not any(isinstance(n, ast.Constant) and n.value == "metrics_collected" for n in subscriptions)
    assert sum(isinstance(n, ast.Constant) and n.value == "conversation_item_added" for n in subscriptions) == 2


def test_import_has_only_known_turn_detector_deprecation():
    result = subprocess.run([
        sys.executable, "-W", "error::DeprecationWarning", "-c",
        "import warnings; "
        "warnings.filterwarnings('ignore', "
        "message=r'`livekit\\.plugins\\.turn_detector` is deprecated.*', "
        "category=DeprecationWarning); import main",
    ], cwd=Path(main.__file__).parent, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert result.stderr == ""

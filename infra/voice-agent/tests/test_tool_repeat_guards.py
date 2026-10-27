import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import main


class ToolRepeatGuardsTest(unittest.IsolatedAsyncioTestCase):
    def agent(self):
        agent = main.JoelclawVoiceAgent(MagicMock(), "voice", caller_verified=True, instructions="test")
        agent.trusted = True
        agent._slack_hits = [{"channel_id": "C_TEST", "ts": "100.1", "channel_name": "test"}]
        return agent

    def requests(self, agent):
        return (
            (agent.text_joel, ("hello", "https://example.com/test")),
            (agent.call_joel, ("hello",)),
            (agent.create_calendar_event, ("test", "2026-11-01", "2026-11-02")),
            (agent.slack_reply, ("1", "hello")),
        )

    async def test_sequential_duplicates_reserve_all_four_tools(self):
        agent = self.agent()
        for tool, args in self.requests(agent):
            with self.subTest(tool=tool.__name__), \
                 patch.object(main.asyncio, "to_thread", AsyncMock(return_value={"ok": True} if tool.__name__ == "slack_reply" else "original result")) as action:
                first = await tool(*args)
                self.assertEqual(first, {
                    "text_joel": "Texted Joel.", "call_joel": "original result",
                    "create_calendar_event": "original result", "slack_reply": "Sent as Joel to #test.",
                }[tool.__name__])
                again = await tool(*(f"  {arg}  " for arg in args))
                self.assertIn("Already attempted", again)
                action.assert_awaited_once()
                info = next(t.info for t in agent.tools if t.info.name == tool.__name__)
                self.assertEqual((info.on_duplicate, info.duplicate_scope), ("reject", "name_and_args"))

    async def test_parallel_duplicates_reserve_before_await(self):
        agent = self.agent()
        for tool, args in self.requests(agent):
            entered, release = asyncio.Event(), asyncio.Event()

            async def outward(*a, **kw):
                entered.set()
                await release.wait()
                return {"ok": True} if tool.__name__ == "slack_reply" else "ok"

            with self.subTest(tool=tool.__name__), patch.object(main.asyncio, "to_thread", side_effect=outward) as action:
                first = asyncio.create_task(tool(*args))
                await entered.wait()
                duplicate = await tool(*args)
                self.assertIn("may have gone through", duplicate)
                release.set()
                await first
                action.assert_awaited_once()

    async def test_uncertain_exception_does_not_release_reservation(self):
        agent = self.agent()
        for tool, args in self.requests(agent):
            with self.subTest(tool=tool.__name__), patch.object(main.asyncio, "to_thread", AsyncMock(side_effect=TimeoutError)) as action:
                with self.assertRaises(TimeoutError):
                    await tool(*args)
                expected = {
                    "call_joel": "That call may have gone through; not dialling again.",
                    "text_joel": "That text may have gone through; not sending again.",
                    "create_calendar_event": "That calendar event may have gone through; not creating it again.",
                    "slack_reply": "That Slack reply may have gone through; not sending again.",
                }[tool.__name__]
                self.assertEqual(await tool(*args), expected)
                action.assert_awaited_once()

    async def test_definite_failure_allows_identical_retry(self):
        for failure in ("FAILED: rejected", "Error: invalid request", "Command failed: refused"):
            agent = self.agent()
            for tool, args in self.requests(agent):
                slack = tool.__name__ == "slack_reply"
                with self.subTest(tool=tool.__name__, failure=failure), patch.object(
                    main.asyncio, "to_thread", AsyncMock(side_effect=[
                        {"ok": False, "error": "refused"} if slack else failure,
                        {"ok": True} if slack else "ok",
                    ])
                ) as action:
                    await tool(*args)
                    retry = await tool(*(f" {arg} " for arg in args))
                    self.assertNotIn("Already attempted", retry)
                    self.assertIn("Already attempted", await tool(*args))
                    self.assertEqual(action.await_count, 2)

    async def test_text_non_ok_result_allows_retry(self):
        agent = self.agent()
        with patch.object(main.asyncio, "to_thread", AsyncMock(side_effect=[
            '{"ok": false, "error": "refused"}', '{"ok": true}',
        ])) as action:
            self.assertTrue((await agent.text_joel("hello")).startswith("FAILED:"))
            self.assertEqual(await agent.text_joel("hello"), "Texted Joel.")
            self.assertIn("Already attempted", await agent.text_joel("hello"))
            self.assertEqual(action.await_count, 2)

    async def test_returned_timeout_keeps_command_reservations(self):
        for result in ("Command timed out", "Error: timeout"):
            agent = self.agent()
            for tool, args in self.requests(agent)[:3]:
                with self.subTest(tool=tool.__name__, result=result), patch.object(
                    main.asyncio, "to_thread", AsyncMock(return_value=result)
                ) as action:
                    await tool(*args)
                    expected = {
                        "call_joel": "That call may have gone through; not dialling again.",
                        "text_joel": "That text may have gone through; not sending again.",
                        "create_calendar_event": "That calendar event may have gone through; not creating it again.",
                    }[tool.__name__]
                    self.assertEqual(await tool(*args), expected)
                    action.assert_awaited_once()

    async def test_exception_and_cancellation_keep_all_reservations(self):
        for error in (RuntimeError, asyncio.CancelledError):
            agent = self.agent()
            for tool, args in self.requests(agent):
                with self.subTest(tool=tool.__name__, error=error), patch.object(
                    main.asyncio, "to_thread", AsyncMock(side_effect=error)
                ) as action:
                    with self.assertRaises(error):
                        await tool(*args)
                    self.assertIn("may have gone through", await tool(*args))
                    action.assert_awaited_once()

    async def test_different_requests_and_new_calls_still_act(self):
        agent = self.agent()
        for tool, args in self.requests(agent):
            changed = list(args)
            changed[-1] += " different"
            with self.subTest(tool=tool.__name__), patch.object(main.asyncio, "to_thread", AsyncMock(return_value={"ok": True} if tool.__name__ == "slack_reply" else "ok")) as action:
                await tool(*args)
                await tool(*changed)
                fresh_tool = getattr(self.agent(), tool.__name__)
                await fresh_tool(*args)
                self.assertEqual(action.await_count, 3)

    async def test_slack_reserves_destination_not_search_position(self):
        agent = self.agent()
        with patch.object(main.asyncio, "to_thread", AsyncMock(return_value={"ok": True})) as action:
            await agent.slack_reply("1", "hello")
            agent._slack_hits.insert(0, {"channel_id": "C_OTHER", "ts": "200.1", "channel_name": "other"})
            self.assertIn("Already attempted", await agent.slack_reply("2", "hello"))
            await agent.slack_reply("1", "hello")
            self.assertEqual(action.await_count, 2)

    async def test_locked_requests_do_not_consume_reservations(self):
        agent = self.agent()
        agent.trusted = False
        with patch.object(main.asyncio, "to_thread", AsyncMock(return_value="ok")) as action:
            self.assertTrue((await agent.call_joel("hello")).startswith("LOCKED"))
            action.assert_not_awaited()
            agent.trusted = True
            self.assertEqual(await agent.call_joel("hello"), "ok")
            action.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()

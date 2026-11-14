import { expect, mock, test } from "bun:test";
import type { NotifyAgentInput } from "../packages/system-bus/src/lib/notify-agent";
import { runAgentSynthetic } from "./notify-agent-synthetic";

test("synthetic sends exactly five marked receipts to the explicit override", async () => {
  const send = mock(async (_input: NotifyAgentInput) => undefined);
  await runAgentSynthetic(["--to", "fixture/receiver"], send);
  expect(send).toHaveBeenCalledTimes(5);
  expect(send.mock.calls.map(([input]) => input.source)).toEqual([
    "daily-token-usage-report",
    "self-healing-backup-blocked",
    "self-healing-retry-exhausted",
    "self-healing-escalated",
    "wiki-edition-build",
  ]);
  for (const [input] of send.mock.calls) {
    expect(input.to).toBe("fixture/receiver");
    expect(input.summary).toStartWith("[TEST]");
    expect(input.message).toStartWith("[TEST]");
  }
  expect(send.mock.calls[0]?.[0].quiet).toBe(true);
});

test("synthetic refuses missing or invalid destinations before any send", async () => {
  const send = mock(async (_input: NotifyAgentInput) => undefined);
  for (const argv of [[], ["--to", "UPPER"], ["--to", "--unsafe"], ["--to", "fixture", "extra"]]) {
    await expect(runAgentSynthetic(argv, send)).rejects.toThrow("Usage:");
  }
  expect(send).not.toHaveBeenCalled();
});

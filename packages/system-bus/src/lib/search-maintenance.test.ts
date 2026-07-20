import { describe, expect, test } from "bun:test";
import {
  assessStartupBudget,
  type CaptureSegment,
  classifySearchProjection,
  detectCaptureGrowth,
  parseStartupBudgetMs,
  sendHardAlert,
} from "./search-maintenance";

const first: CaptureSegment = {
  runId: "run-a",
  sourceIdentity: `sha256:${"a".repeat(64)}`,
  fromOffset: 100,
  toOffset: 200,
  jsonlSha256: "hash-a",
};

const growing: CaptureSegment = {
  runId: "run-b",
  sourceIdentity: first.sourceIdentity,
  fromOffset: 100,
  toOffset: 300,
  jsonlSha256: "hash-b",
};

describe("capture growth detection", () => {
  test("detects overlapping byte ranges under distinct Run IDs", () => {
    expect(detectCaptureGrowth(growing, [first])).toMatchObject({
      current: growing,
      overlapping: first,
      overlapBytes: 100,
    });
  });

  test("ignores the same Run, another source, and adjacent ranges", () => {
    expect(detectCaptureGrowth(first, [{ ...growing, runId: first.runId }])).toBeNull();
    expect(detectCaptureGrowth(first, [{ ...growing, sourceIdentity: `sha256:${"b".repeat(64)}` }])).toBeNull();
    expect(detectCaptureGrowth(first, [{ ...growing, fromOffset: 200, toOffset: 300 }])).toBeNull();
  });
});

describe("search startup budgets", () => {
  test("accepts only a complete safe integer budget", () => {
    expect(parseStartupBudgetMs("120000")).toBe(120_000);
    expect(parseStartupBudgetMs("30000")).toBe(60_000);
    expect(parseStartupBudgetMs("120000oops")).toBe(900_000);
    expect(parseStartupBudgetMs("9007199254740992")).toBe(900_000);
    expect(parseStartupBudgetMs("garbage")).toBe(900_000);
  });

  test("starts an outage clock, crosses once, and clears on recovery", () => {
    const started = assessStartupBudget({
      target: "typesense:process",
      engine: "typesense",
      healthy: false,
      checkedAt: 1_000,
      budgetMs: 60_000,
      previous: null,
    });
    expect(started).toMatchObject({ exceeded: false, shouldAlert: false, unavailableSince: 1_000 });

    const exceeded = assessStartupBudget({
      target: "typesense:process",
      engine: "typesense",
      healthy: false,
      checkedAt: 61_000,
      budgetMs: 60_000,
      previous: started.nextState,
    });
    expect(exceeded).toMatchObject({ exceeded: true, shouldAlert: true, unavailableForMs: 60_000 });

    const repeated = assessStartupBudget({
      target: "typesense:process",
      engine: "typesense",
      healthy: false,
      checkedAt: 121_000,
      budgetMs: 60_000,
      previous: exceeded.nextState,
    });
    expect(repeated).toMatchObject({ exceeded: true, shouldAlert: false });

    const recovered = assessStartupBudget({
      target: "typesense:process",
      engine: "typesense",
      healthy: true,
      checkedAt: 122_000,
      budgetMs: 60_000,
      previous: repeated.nextState,
    });
    expect(recovered).toMatchObject({ exceeded: false, nextState: null });
  });
});

describe("search health projection", () => {
  test("reports freshness and raw source provenance", () => {
    const observedAt = Date.parse("2026-07-20T03:00:00.000Z");
    const endedAt = observedAt - 5_000;
    const result = classifySearchProjection({
      id: "run-1",
      started_at: endedAt - 1_000,
      ended_at: endedAt,
      jsonl_path: "/fixtures/run-1.jsonl",
      jsonl_sha256: "sha-1",
      source_identity: first.sourceIdentity,
      from_offset: 10,
      to_offset: 20,
    }, observedAt);

    expect(result).toMatchObject({
      ok: true,
      freshness: { ageMs: 5_000 },
      provenance: {
        engine: "typesense",
        index: "runs_dev",
        sourceOfTruth: "raw-run-jsonl",
        runId: "run-1",
        fromOffset: 10,
        toOffset: 20,
      },
    });
  });
});

describe("hard alert delivery", () => {
  test("uses notify alert and waits for terminal delivery", async () => {
    const commands: readonly string[][] = [];
    await sendHardAlert({
      eventId: "fixture-alert",
      source: "fixture",
      message: "fixture message",
      runCommand: async (args) => {
        (commands as string[][]).push([...args]);
        const result = args[2] === "send"
          ? { eventId: "fixture-alert" }
          : { deliveryState: "confirmed", platformMessageId: "telegram-1" };
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
      },
    });

    expect(commands[0]).toEqual([
      "joelclaw", "notify", "send", "--kind", "alert", "--priority", "high",
      "--source", "fixture", "--event-id", "fixture-alert", "fixture message",
    ]);
    expect(commands[1]).toEqual([
      "joelclaw", "notify", "wait", "fixture-alert", "--source", "fixture", "--timeout", "15s",
    ]);
  });

  test("receipt timeout does not throw after a successful send", async () => {
    const receipt = await sendHardAlert({
      eventId: "fixture-alert",
      source: "fixture",
      message: "fixture message",
      runCommand: async (args) => {
        if (args[2] === "send") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ ok: true, result: { eventId: "fixture-alert" } }),
            stderr: "",
          };
        }
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            ok: false,
            error: { code: "NOTIFY_TERMINAL_RECEIPT_TIMEOUT" },
          }),
          stderr: "",
        };
      },
    });

    expect(receipt.sent).toBe(true);
    expect(receipt.receiptConfirmed).toBe(false);
    expect(receipt.receiptDetail).toContain("notify wait");
  });
});

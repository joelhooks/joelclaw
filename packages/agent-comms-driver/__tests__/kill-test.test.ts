import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MessageEventDocument,
  MessageEventTraceResult,
} from "@joelclaw/message-event-log";

import {
  type KillDrillPorts,
  runKillDrill,
} from "../src/kill-test";
import {
  makeKillDrillReceiptRecorder,
  scheduleWeeklyKillDrill,
} from "../src/kill-test-live";

function streamEvent(
  id: string,
  kind: MessageEventDocument["kind"],
  flowId: string,
  payload: unknown,
): MessageEventDocument {
  return {
    _id: id,
    _creationTime: 1,
    schemaVersion: 1,
    sequence: 1,
    occurredAt: 1,
    recordedAt: 1,
    semanticKey: `test:${id}`,
    kind,
    source: "test",
    flowId,
    payload,
  };
}

function harness(input: { omit?: "fallback" | "platform" | "heartbeat" | "decision" } = {}) {
  let now = 0;
  let heartbeat = true;
  let stopped = false;
  let restarted = false;
  let restartCalls = 0;
  const sent: Array<{ text: string; eventId: string; flowId: string }> = [];
  const recorded: unknown[] = [];

  const trace = (flowId: string): MessageEventTraceResult => {
    const probe = sent.find((item) => item.flowId === flowId);
    if (!probe) return { kind: "not_found", lookup: flowId };
    const sourceId = `stream:${probe.eventId}`;
    const events: MessageEventDocument[] = [
      streamEvent(sourceId, "message.requested", flowId, { text: probe.text }),
    ];
    if (probe.text.startsWith("weekly")) {
      if (input.omit !== "fallback") {
        events.push(streamEvent("fallback:1", "fallback.delivered", flowId, {
          sourceEventId: sourceId,
          fallback: true,
          outcome: "confirmed",
          platformMessageId: "telegram:42",
        }));
      }
    } else if (input.omit !== "decision") {
      events.push(streamEvent("decision:1", "gateway.decision.recorded", flowId, {
        inputEventIds: [sourceId],
        reason: "recovery probe",
      }));
    }
    return {
      kind: "trace",
      source: "convex",
      flowId,
      projection: null,
      events,
      consumerReceipts: [],
      truncated: false,
    };
  };

  const ports: KillDrillPorts = {
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
      if (stopped && now >= 60) heartbeat = false;
      if (restarted && input.omit !== "heartbeat") heartbeat = true;
    },
    stopAgent: async () => {
      stopped = true;
      return { paneId: "test:pane" };
    },
    heartbeatExists: async () => heartbeat,
    sendAlert: async (text, eventId) => {
      const flowId = `notify:${eventId}`;
      sent.push({ text, eventId, flowId });
      return { text, eventId, flowId };
    },
    traceStream: async (flowId) => trace(flowId),
    tracePlatform: async (flowId) => input.omit === "platform" ? [] : [{
      flowId,
      platform: "telegram",
      platformMessageId: "telegram:42",
      eventType: "message.outbound.confirmed",
      deliveryState: "confirmed",
      transportText: "⚠️ fallback: weekly kill-test drill 2026-07-21",
    }],
    restartAgent: async () => {
      restartCalls += 1;
      restarted = true;
      return { scheduleId: "restart-1" };
    },
    recordReceipt: async (receipt) => {
      recorded.push(receipt);
    },
  };
  return { ports, sent, recorded, restartCalls: () => restartCalls };
}

describe("runKillDrill", () => {
  test("passes the exact eight-assertion fallback and recovery sequence", async () => {
    const { ports, sent, recorded } = harness();
    const ids = ["fallback-event", "recovery-event"];
    const result = await runKillDrill(ports, {
      date: "2026-07-21",
      heartbeatTtlMs: 60,
      assertionTimeoutMs: 20,
      pollIntervalMs: 5,
      makeEventId: () => ids.shift()!,
    });

    expect(result.state).toBe("passed");
    expect(result.receipts.map((receipt) => receipt.assertion)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(recorded).toHaveLength(8);
    expect(sent.map((item) => item.text)).toEqual([
      "weekly kill-test drill 2026-07-21",
      "gateway recovery probe 2026-07-21",
    ]);
    expect(result.fallbackPlatformMessageId).toBe("telegram:42");
  });

  for (const missing of ["fallback", "platform", "heartbeat", "decision"] as const) {
    test(`exits through a failed assertion when ${missing} evidence is missing`, async () => {
      const { ports, restartCalls } = harness({ omit: missing });
      await expect(runKillDrill(ports, {
        date: "2026-07-21",
        heartbeatTtlMs: 60,
        assertionTimeoutMs: 10,
        pollIntervalMs: 5,
        makeEventId: () => crypto.randomUUID(),
      })).rejects.toThrow("Kill drill failed");
      expect(restartCalls()).toBe(1);
    });
  }

  test("rejects a platform receipt whose delivered text is not self-identified", async () => {
    const { ports } = harness();
    ports.tracePlatform = async (flowId) => [{
      flowId,
      platform: "telegram",
      platformMessageId: "telegram:42",
      eventType: "message.outbound.confirmed",
      deliveryState: "confirmed",
      transportText: "weekly kill-test drill 2026-07-21",
    }];
    await expect(runKillDrill(ports, {
      date: "2026-07-21",
      heartbeatTtlMs: 60,
      assertionTimeoutMs: 10,
      pollIntervalMs: 5,
    })).rejects.toThrow("confirmed platform delivery receipt");
  });
});

describe("live receipt boundary", () => {
  test("creates the receipt parent directory before the destructive drill writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-comms-kill-drill-"));
    const path = join(root, "missing", "receipts.jsonl");
    try {
      await makeKillDrillReceiptRecorder(path)({ assertion: 1 });
      expect(await readFile(path, "utf8")).toBe('{"assertion":1}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("weekly schedule arm", () => {
  test("registers one SPAWN and verifies wake-registry readback", async () => {
    const commands: string[][] = [];
    let listCalls = 0;
    const result = await scheduleWeeklyKillDrill("/repo", async (argv) => {
      commands.push(argv);
      if (argv.includes("list")) {
        listCalls += 1;
        return {
          stdout: JSON.stringify({
            ok: true,
            result: { schedules: listCalls === 1 ? [] : [{ scheduleId: "weekly-1" }] },
          }),
          stderr: "",
        };
      }
      return { stdout: JSON.stringify({ ok: true, result: { schedule: { scheduleId: "weekly-1", at: "2026-07-28T12:00:00Z" } } }), stderr: "" };
    });

    expect(result).toMatchObject({ scheduleId: "weekly-1" });
    expect(commands[1]).toContain("7d");
    expect(commands[1]).toContain("/repo/.brain/tasks/agent-comms-gateway-weekly-kill-drill.svx");
    expect(commands[2]).toEqual(["joelclaw", "wake", "list", "--format", "json"]);
  });

  test("returns an existing marked schedule without creating a duplicate", async () => {
    const commands: string[][] = [];
    const result = await scheduleWeeklyKillDrill("/repo", async (argv) => {
      commands.push(argv);
      return {
        stdout: JSON.stringify({
          ok: true,
          result: {
            schedules: [{
              scheduleId: "weekly-existing",
              verb: "spawn",
              briefPath: "/repo/.brain/tasks/agent-comms-gateway-weekly-kill-drill.svx",
              prompt: "[weekly-kill-drill] already armed",
            }],
          },
        }),
        stderr: "",
      };
    });

    expect(result.scheduleId).toBe("weekly-existing");
    expect(commands).toHaveLength(1);
  });

  test("cancels a new schedule when registry readback cannot prove it", async () => {
    const commands: string[][] = [];
    let listCalls = 0;
    await expect(scheduleWeeklyKillDrill("/repo", async (argv) => {
      commands.push(argv);
      if (argv.includes("list")) {
        listCalls += 1;
        return { stdout: JSON.stringify({ ok: true, result: { schedules: [] } }), stderr: "" };
      }
      if (argv.includes("cancel")) {
        return { stdout: JSON.stringify({ ok: true, result: { scheduleId: "weekly-1" } }), stderr: "" };
      }
      return { stdout: JSON.stringify({ ok: true, result: { scheduleId: "weekly-1" } }), stderr: "" };
    })).rejects.toThrow("readback did not contain");
    expect(listCalls).toBe(3);
    expect(commands.at(-2)).toEqual([
      "joelclaw",
      "wake",
      "cancel",
      "weekly-1",
      "--format",
      "json",
    ]);
    expect(commands.at(-1)).toEqual(["joelclaw", "wake", "list", "--format", "json"]);
  });

  test("reports an unverified live schedule when cancellation returns ok=false", async () => {
    let listCalls = 0;
    await expect(scheduleWeeklyKillDrill("/repo", async (argv) => {
      if (argv.includes("list")) {
        listCalls += 1;
        return { stdout: JSON.stringify({ ok: true, result: { schedules: [] } }), stderr: "" };
      }
      if (argv.includes("cancel")) {
        return { stdout: JSON.stringify({ ok: false, error: { message: "cancel failed" } }), stderr: "" };
      }
      return { stdout: JSON.stringify({ ok: true, result: { scheduleId: "weekly-1" } }), stderr: "" };
    })).rejects.toThrow("could not be verified or cancelled");
    expect(listCalls).toBe(2);
  });

  test("reports an unverified live schedule when cancellation readback still finds it", async () => {
    let listCalls = 0;
    await expect(scheduleWeeklyKillDrill("/repo", async (argv) => {
      if (argv.includes("list")) {
        listCalls += 1;
        const schedules = listCalls === 3 ? [{ scheduleId: "weekly-1" }] : [];
        return { stdout: JSON.stringify({ ok: true, result: { schedules } }), stderr: "" };
      }
      if (argv.includes("cancel")) {
        return { stdout: JSON.stringify({ ok: true, result: { scheduleId: "weekly-1" } }), stderr: "" };
      }
      return { stdout: JSON.stringify({ ok: true, result: { scheduleId: "weekly-1" } }), stderr: "" };
    })).rejects.toThrow("still contains weekly-1");
    expect(listCalls).toBe(3);
  });
});

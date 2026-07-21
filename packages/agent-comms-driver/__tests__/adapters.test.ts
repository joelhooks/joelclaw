import { describe, expect, test } from "bun:test";
import type { MessageEventDocument } from "@joelclaw/message-event-log";

import { makeDeadlineIndex, makeLiveDriverPorts } from "../src";

function event(
  id: string,
  recordedAt: number,
  kind: MessageEventDocument["kind"],
  payload: unknown,
): MessageEventDocument {
  return {
    _id: id,
    _creationTime: recordedAt,
    schemaVersion: 1,
    sequence: recordedAt,
    occurredAt: recordedAt,
    recordedAt,
    semanticKey: `test:${id}`,
    kind,
    source: "test",
    payload,
  };
}

function redisFake() {
  const schedules: Record<string, string> = {};
  return {
    schedules,
    client: {
      status: "ready",
      connect: async () => {},
      set: async () => "OK",
      hgetall: async () => ({ ...schedules }),
      disconnect: () => {},
    },
  };
}

function streamFake(events: MessageEventDocument[] = []) {
  const appended: unknown[] = [];
  const reads: Array<{ recordedAt: number; cursor: string | null }> = [];
  return {
    appended,
    reads,
    client: {
      append: async (input: unknown) => {
        appended.push(input);
        return { eventId: "appended", semanticKey: "test", deduplicated: false, schemaVersion: 1 };
      },
      pending: async () => [],
      pendingForConsumer: async () => [],
      advanceCursor: async () => ({ consumer: "test", lastEventId: "x", lastSequence: 1, updatedAt: 1 }),
      readSince: async (recordedAt: number, _limit = 100, cursor: string | null = null) => {
        reads.push({ recordedAt, cursor });
        return cursor === null
          ? { events, nextCursor: "page-2", source: "message-event-log" as const }
          : { events: [], nextCursor: null, source: "message-event-log" as const };
      },
      materialize: async () => ({ eventId: "x", deduplicated: false, flowView: false, platformView: false, terminalView: false, actionView: false }),
      trace: async () => ({ kind: "not_found" as const, lookup: "x" }),
    },
  };
}

describe("deadline replay", () => {
  test("keeps same-timestamp events visible and merges joins without holdUntil", () => {
    const index = makeDeadlineIndex();
    index.ingest(event("open", 100, "gateway.decision.recorded", {
      decision: {
        verb: "aggregate",
        action: "open",
        aggregateId: "agg-1",
        memberEventIds: ["event-a"],
        holdUntil: 200,
      },
    }));
    index.ingest(event("join", 100, "gateway.decision.recorded", {
      decision: {
        verb: "aggregate",
        action: "join",
        aggregateId: "agg-1",
        memberEventIds: ["event-b"],
      },
    }));
    index.ingest(event("open", 100, "gateway.decision.recorded", {
      decision: {
        verb: "aggregate",
        action: "open",
        aggregateId: "agg-1",
        memberEventIds: ["event-a"],
        holdUntil: 200,
      },
    }));

    expect(index.watermark).toBe(100);
    expect(index.due(200)).toEqual([{
      aggregateId: "agg-1",
      memberEventIds: ["event-a", "event-b"],
      holdUntil: 200,
    }]);

    index.ingest(event("fired", 100, "aggregate.deadline.reached", {
      aggregateId: "agg-1",
      memberEventIds: ["event-a", "event-b"],
      holdUntil: 200,
    }));
    expect(index.due(200)).toEqual([]);

    index.ingest(event("close", 101, "gateway.decision.recorded", {
      decision: {
        verb: "aggregate",
        action: "close-deliver",
        aggregateId: "agg-1",
        memberEventIds: ["event-a", "event-b"],
      },
    }));
    expect(index.due(1_000)).toEqual([]);
  });

  test("holds one replay watermark constant across pagination", async () => {
    const stream = streamFake([
      event("open", 100, "gateway.decision.recorded", {
        decision: {
          verb: "aggregate",
          action: "open",
          aggregateId: "agg-1",
          memberEventIds: ["event-a"],
          holdUntil: 200,
        },
      }),
    ]);
    const redis = redisFake();
    const ports = makeLiveDriverPorts(
      { target: "scratch", successorBriefPath: "/tmp/scratch.svx" },
      {
        stream: stream.client,
        redis: redis.client,
        runCommand: async () => ({ stdout: '{"result":{"agents":[],"panes":[]}}', stderr: "" }),
      },
    );

    await ports.listDueDeadlines(200);
    expect(stream.reads).toEqual([
      { recordedAt: 0, cursor: null },
      { recordedAt: 0, cursor: "page-2" },
    ]);
    await ports.listDueDeadlines(200);
    expect(stream.reads.at(-2)?.recordedAt).toBe(100);
    await ports.close();
  });
});

describe("live adapters", () => {
  test("parses Herdr pane/session state and treats blocked as unsettled", async () => {
    const stream = streamFake();
    const redis = redisFake();
    const runCommand = async (argv: string[]) => argv[1] === "agent"
      ? {
          stdout: JSON.stringify({ result: { agents: [{ pane_id: "w1:p2", name: "gateway", agent_status: "blocked" }] } }),
          stderr: "",
        }
      : {
          stdout: JSON.stringify({ result: { panes: [{ pane_id: "w1:p2" }] } }),
          stderr: "",
        };
    const ports = makeLiveDriverPorts(
      { target: "gateway", successorBriefPath: "/tmp/scratch.svx" },
      { stream: stream.client, redis: redis.client, runCommand },
    );

    expect(await ports.inspectAgent()).toEqual({
      paneExists: true,
      sessionExists: true,
      idle: false,
    });
    await ports.close();
  });

  test("reconciles ambiguous SPAWN acceptance by stable registry marker", async () => {
    const stream = streamFake();
    const redis = redisFake();
    let wakeCalls = 0;
    const runCommand = async (argv: string[]) => {
      if (argv[0] !== "joelclaw") return { stdout: '{"result":{"agents":[],"panes":[]}}', stderr: "" };
      wakeCalls += 1;
      const promptIndex = argv.indexOf("--prompt");
      redis.schedules["schedule-1"] = JSON.stringify({
        verb: "spawn",
        briefPath: "/tmp/scratch.svx",
        prompt: argv[promptIndex + 1],
      });
      throw new Error("response lost after registry acceptance");
    };
    const ports = makeLiveDriverPorts(
      {
        target: "gateway",
        successorBriefPath: "/tmp/scratch.svx",
        successorIdentity: "test-driver",
      },
      { stream: stream.client, redis: redis.client, runCommand },
    );

    await ports.requestSuccessor();
    await ports.requestSuccessor();
    expect(wakeCalls).toBe(1);
    expect(redis.schedules["schedule-1"]).toContain("[driver-spawn:test-driver]");
    await ports.close();
  });

  test("uses a stable semantic key for repeated deadline appends", async () => {
    const stream = streamFake();
    const redis = redisFake();
    const ports = makeLiveDriverPorts(
      { target: "scratch", successorBriefPath: "/tmp/scratch.svx" },
      { stream: stream.client, redis: redis.client },
    );
    const deadline = { aggregateId: "agg-1", memberEventIds: ["event-a"], holdUntil: 200 };

    await ports.appendDeadline(deadline);
    await ports.appendDeadline(deadline);

    expect(stream.appended).toHaveLength(2);
    expect(stream.appended).toEqual([
      expect.objectContaining({ semanticKey: "aggregate-deadline:agg-1:200" }),
      expect.objectContaining({ semanticKey: "aggregate-deadline:agg-1:200" }),
    ]);
    await ports.close();
  });
});

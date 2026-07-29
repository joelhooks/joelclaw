import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrTools, laneFromTaskId, laneLabel, MAX_WORKER_LANES } from "./herdr-tools.mjs";
import { createToolHandlers, handleMcpMessage, toolDefinitions } from "./index.mjs";
import {
  createStreamTools,
  lintRewrite,
  MAX_AGGREGATE_JOINS,
  resolveAdvanceAfter,
  validateDecisionPayload,
} from "./stream-tools.mjs";
import { createWakeTools } from "./wake-tools.mjs";

const inputEvent = {
  _id: "input-1",
  kind: "message.requested",
  source: "producer",
  rawSourceId: "11111111-1111-4111-8111-111111111111",
  flowId: "notify:11111111-1111-4111-8111-111111111111",
  correlationId: "producer:11111111-1111-4111-8111-111111111111",
  recordedAt: 10,
  sequence: 1,
};
const joelInbound = {
  _id: "joel-1",
  kind: "inbound.received",
  source: "gateway.telegram.chat-sdk.message",
  recordedAt: 11,
  sequence: 2,
  payload: {
    addressing: "addressed",
    actorId: "7718912466",
    content: { text: "bing bong" },
  },
};
const ambientJoelInbound = {
  _id: "joel-ambient-1",
  kind: "inbound.received",
  source: "gateway.slack.chat-sdk.message",
  recordedAt: 12,
  sequence: 3,
  payload: {
    addressing: "ambient",
    actorId: "U030BJ3CK",
    content: { text: "message for a human" },
  },
};
const decisionPayload = {
  inputEventIds: ["input-1"],
  reason: "Joel asked for the result.",
  promptRevision: "abc123",
  decisionSeq: 1,
  decision: { verb: "deliver", target: { kind: "platform", platform: "telegram" } },
  rewrite: "Done.",
};

function fakeClient(seed = [inputEvent]) {
  const events = [...seed];
  return {
    events,
    readSince: async (recordedAt, limit, cursor) => {
      const eligible = events.filter((event) => (event.recordedAt ?? 0) >= recordedAt);
      const offset = cursor ? Number(cursor) : 0;
      const page = eligible.slice(offset, offset + limit);
      return { events: page, nextCursor: offset + page.length < eligible.length ? String(offset + page.length) : null, source: "message-event-log" };
    },
    pendingForConsumer: async () => events.filter((event) => event.kind !== "gateway.decision.recorded" && event.kind !== "gateway.handoff"),
    append: async (input) => {
      const event = { ...input, _id: `event-${events.length + 1}`, recordedAt: 20 + events.length, sequence: events.length + 1 };
      events.push(event);
      return { eventId: event._id, semanticKey: input.semanticKey, deduplicated: false, schemaVersion: 1 };
    },
    advanceCursor: async (consumer, eventId) => ({ consumer, lastEventId: eventId, lastSequence: 1, updatedAt: 30 }),
  };
}

describe("stream receipts", () => {
  test("validates one complete decision and reads it back", async () => {
    const client = fakeClient();
    const stream = createStreamTools({ client, now: () => 20 });
    const appended = await stream.recordDecision({ payload: decisionPayload, advanceAfter: false });
    expect(appended.receipt.semanticKey).toBe("gateway:input-1:1");
    expect(appended.event.kind).toBe("gateway.decision.recorded");
    expect(appended.event.flowId).toBe("notify:11111111-1111-4111-8111-111111111111");
    expect(appended.event.correlationId).toBe(
      "producer:11111111-1111-4111-8111-111111111111",
    );
    const cursor = await stream.advanceAfterDecision({ eventId: "input-1", decisionEventId: appended.receipt.eventId });
    expect(cursor.lastEventId).toBe("input-1");
  });

  test("defaults advanceAfter true on single-input terminal decisions", async () => {
    const client = fakeClient();
    const stream = createStreamTools({ client, now: () => 20 });
    const appended = await stream.recordDecision({ payload: decisionPayload });
    expect(appended.advanceAfter).toBe(true);
    expect(appended.cursor.lastEventId).toBe("input-1");
  });

  test("advanceAfter defaults true; acks pass false explicitly", () => {
    expect(resolveAdvanceAfter({
      ...decisionPayload,
      decisionSeq: 1,
      decision: { verb: "deliver" },
    }, undefined)).toBe(true);
    expect(resolveAdvanceAfter({
      ...decisionPayload,
      decisionSeq: 1,
      decision: { verb: "deliver" },
    }, false)).toBe(false);
    expect(resolveAdvanceAfter({
      ...decisionPayload,
      decision: { verb: "drop" },
    }, undefined)).toBe(true);
    expect(resolveAdvanceAfter({
      ...decisionPayload,
      inputEventIds: ["a", "b"],
      decision: { verb: "deliver" },
    }, undefined)).toBe(false);
  });

  test("refuses duplicate decisions before cursor advance", async () => {
    const client = fakeClient();
    const stream = createStreamTools({ client, now: () => 20 });
    const first = await stream.recordDecision({ payload: decisionPayload, advanceAfter: false });
    await stream.recordDecision({ payload: { ...decisionPayload, decisionSeq: 2 }, advanceAfter: false });
    await expect(stream.advanceAfterDecision({ eventId: "input-1", decisionEventId: first.receipt.eventId })).rejects.toThrow("found 2");
  });

  test("rejects a fanout with no taskId to match its worker result", () => {
    expect(() => validateDecisionPayload({
      ...decisionPayload,
      rewrite: undefined,
      decision: { verb: "fanout" },
    })).toThrow("require decision.taskId");
    expect(validateDecisionPayload({
      ...decisionPayload,
      rewrite: undefined,
      decision: { verb: "fanout", taskId: "front-parser-restore" },
    }).decision.taskId).toBe("front-parser-restore");
  });

  test("rejects duplicate aggregate members", () => {
    expect(() => validateDecisionPayload({
      ...decisionPayload,
      decision: { verb: "aggregate", action: "open", aggregateId: "a1", memberEventIds: ["input-1", "input-1"] },
    })).toThrow("must not contain duplicates");
  });

  test("aggregate open requires a future holdUntil", () => {
    expect(() => validateDecisionPayload({
      ...decisionPayload,
      rewrite: undefined,
      decision: { verb: "aggregate", action: "open", aggregateId: "a1", memberEventIds: ["input-1"] },
    })).toThrow("holdUntil");
    expect(validateDecisionPayload({
      ...decisionPayload,
      rewrite: undefined,
      decision: {
        verb: "aggregate",
        action: "open",
        aggregateId: "a1",
        memberEventIds: ["input-1"],
        holdUntil: Date.now() + 60_000,
      },
    }).decision.aggregateId).toBe("a1");
  });

  test("rejects join past the sane aggregate cap", () => {
    expect(() => validateDecisionPayload({
      ...decisionPayload,
      rewrite: undefined,
      decision: { verb: "aggregate", action: "join", aggregateId: "a1", memberEventIds: ["input-1"] },
    }, { aggregateStats: { decisionCount: MAX_AGGREGATE_JOINS, duplicateTick: false } })).toThrow(`cap ${MAX_AGGREGATE_JOINS}`);
  });

  test("rejects identical repeated ticks on a known aggregate", () => {
    expect(() => validateDecisionPayload({
      ...decisionPayload,
      rewrite: undefined,
      decision: { verb: "aggregate", action: "join", aggregateId: "a1", memberEventIds: ["input-1"] },
    }, { aggregateStats: { decisionCount: 3, duplicateTick: true } })).toThrow("identical repeated tick");
  });

  test("rewrite lints catch tool refusal and self-intro", () => {
    expect(lintRewrite("I'm the comms gateway loop and I have no live weather feed here, so I can't give you real Vancouver WA conditions.")).toContain("tool-refusal");
    expect(lintRewrite("I'm the gateway loop (`w2C:pH`); stream is clear.")).toContain("self-intro");
    expect(lintRewrite("on it — checking Typesense now.")).toBeNull();
    expect(() => validateDecisionPayload({
      ...decisionPayload,
      rewrite: "I'm the gateway loop; stream is clear.",
    })).toThrow("self-intro");
  });

  test("forces Joel deliver before machine decisions and herdr work", async () => {
    const client = fakeClient([inputEvent, joelInbound]);
    const stream = createStreamTools({ client, now: () => 20 });
    await expect(stream.recordDecision({
      payload: { ...decisionPayload, reason: "machine noise" },
    })).rejects.toThrow("Ack Joel first");

    await expect(stream.recordDecision({
      payload: {
        inputEventIds: ["joel-1"],
        reason: "drop without hearing Joel",
        promptRevision: "abc123",
        decisionSeq: 1,
        decision: { verb: "drop" },
      },
    })).rejects.toThrow("must be deliver");

    const ack = await stream.recordDecision({
      payload: {
        inputEventIds: ["joel-1"],
        reason: "Joel ping — ack first",
        promptRevision: "abc123",
        decisionSeq: 1,
        decision: { verb: "deliver", target: { kind: "platform", platform: "telegram" } },
        rewrite: "on it — right here.",
      },
      advanceAfter: false,
    });
    expect(ack.advanceAfter).toBe(false);

    const handlers = createToolHandlers({
      stream,
      herdr: { snapshot: async () => ({ ok: true }), dispatchWorker: async () => ({ ok: true }) },
      wake: {},
    });
    // After ack, machine decision is allowed.
    const machine = await stream.recordDecision({ payload: { ...decisionPayload, decisionSeq: 1 } });
    expect(machine.advanceAfter).toBe(true);
    await expect(handlers.herdr_snapshot({})).resolves.toEqual({ ok: true });
  });

  test("ambient inbound observes silently and escalation unlocks outbound", async () => {
    const observeClient = fakeClient([ambientJoelInbound]);
    const observeStream = createStreamTools({ client: observeClient, now: () => 20 });
    const pending = await observeStream.pending();
    expect(pending.ackRequiredJoel).toEqual([]);
    expect(pending.pending[0]).toMatchObject({ addressing: "ambient" });

    await expect(observeStream.recordDecision({
      payload: {
        inputEventIds: ["joel-ambient-1"],
        reason: "No mention or direct conversation.",
        promptRevision: "abc123",
        decisionSeq: 1,
        decision: { verb: "deliver" },
        rewrite: "on it",
      },
    })).rejects.toThrow("First record an escalate decision");

    const observed = await observeStream.recordDecision({
      payload: {
        inputEventIds: ["joel-ambient-1"],
        reason: "Channel message was not addressed to the gateway.",
        promptRevision: "abc123",
        decisionSeq: 1,
        decision: { verb: "observe" },
      },
    });
    expect(observed.advanceAfter).toBe(true);
    expect(observed.event.payload.decision.verb).toBe("observe");

    const escalationClient = fakeClient([ambientJoelInbound]);
    const escalationStream = createStreamTools({ client: escalationClient, now: () => 20 });
    const escalation = await escalationStream.recordDecision({
      payload: {
        inputEventIds: ["joel-ambient-1"],
        reason: "The ambient message reports first-notice production breakage.",
        promptRevision: "abc123",
        decisionSeq: 1,
        decision: { verb: "escalate" },
      },
    });
    expect(escalation.advanceAfter).toBe(false);

    const delivered = await escalationStream.recordDecision({
      payload: {
        inputEventIds: ["joel-ambient-1"],
        reason: "Escalation receipt converted this input to addressed.",
        promptRevision: "abc123",
        decisionSeq: 2,
        decision: { verb: "deliver" },
        rewrite: "Production is down.",
      },
    });
    expect(delivered.advanceAfter).toBe(true);
    expect(escalationClient.events.filter((event) =>
      event.kind === "gateway.decision.recorded").map((event) =>
      event.payload.decision.verb)).toEqual(["escalate", "deliver"]);
  });

  test("herdr tools refuse while Joel is unacked", async () => {
    const client = fakeClient([joelInbound]);
    const stream = createStreamTools({ client, now: () => 20 });
    const handlers = createToolHandlers({
      stream,
      herdr: { snapshot: async () => ({ ok: true }), dispatchWorker: async () => ({ ok: true }) },
      wake: {},
    });
    await expect(handlers.herdr_dispatch_worker({ taskId: "x", task: "y" })).rejects.toThrow("Ack Joel first");
  });
});

test("MCP exposes all production tool families", async () => {
  const names = toolDefinitions.map((tool) => tool.name);
  expect(names.some((name) => name.startsWith("stream_"))).toBe(true);
  expect(names.some((name) => name.startsWith("herdr_"))).toBe(true);
  expect(names.some((name) => name.startsWith("wake_"))).toBe(true);
  const listed = await handleMcpMessage({ id: 1, method: "tools/list" }, createToolHandlers({
    stream: {}, herdr: {}, wake: {},
  }));
  expect(listed.tools).toHaveLength(18);
});

describe("worker lanes", () => {
  const gatewayLoop = { pane_id: "wZ:p1", label: "📨 gateway loop", workspace_id: "wZ" };

  function fakeHerdr({ panes = [gatewayLoop], dir }) {
    const calls = [];
    const run = async (command, args) => {
      calls.push(args);
      const [family, verb] = args;
      if (family === "pane" && verb === "list") return { result: { panes } };
      if (family === "pane" && verb === "split") return { result: { pane: { pane_id: "wZ:pNEW" } } };
      if (family === "tab" && verb === "create") return { result: { root_pane: { pane_id: "wZ:pNEW" } } };
      return { result: { type: "ok" } };
    };
    return { calls, tools: createHerdrTools({ run, now: () => 1000, taskDir: `${dir}/tasks`, workerDir: `${dir}/workers` }) };
  }

  test("recurring taskIds collapse to one lane", () => {
    expect(laneFromTaskId("campaign-pulse-2026-07-25-1700")).toBe("campaign-pulse");
    expect(laneFromTaskId("campaign-pulse-2026-07-25-1800")).toBe("campaign-pulse");
    expect(laneFromTaskId("neat-memory-beat-2026-07-24-1616")).toBe("neat-memory-beat");
    expect(laneFromTaskId("front-ingestion-chase")).toBe("front-ingestion-chase");
  });

  test("a second firing reuses the lane pane instead of creating a tab", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-lanes-"));
    const first = fakeHerdr({ dir });
    const opened = await first.tools.dispatchWorker({ taskId: "campaign-pulse-2026-07-25-1700", task: "run the pulse" });
    expect(opened.reused).toBe(false);
    expect(opened.lane).toBe("campaign-pulse");

    const lanePane = { pane_id: "wZ:pNEW", label: laneLabel("campaign-pulse"), workspace_id: "wZ", agent_status: "idle" };
    const second = fakeHerdr({ panes: [gatewayLoop, lanePane], dir });
    const again = await second.tools.dispatchWorker({ taskId: "campaign-pulse-2026-07-25-1800", task: "run the pulse" });
    expect(again.reused).toBe(true);
    expect(again.paneId).toBe("wZ:pNEW");
    expect(again.mode).toBe("prompted");
    expect(second.calls.some(([family, verb]) => family === "tab" && verb === "create")).toBe(false);
  });

  test("a busy lane refuses rather than opening a second pane", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-lanes-"));
    const lanePane = { pane_id: "wZ:pB", label: laneLabel("campaign-pulse"), workspace_id: "wZ", agent_status: "working" };
    const { tools } = fakeHerdr({ panes: [gatewayLoop, lanePane], dir });
    await expect(tools.dispatchWorker({ taskId: "campaign-pulse-2026-07-25-1900", task: "run" }))
      .rejects.toThrow("is busy");
  });

  test("a dead lane pane is relaunched in place, not replaced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-lanes-"));
    const lanePane = { pane_id: "wZ:pD", label: laneLabel("front-chase"), workspace_id: "wZ", agent_status: "unknown" };
    const { calls, tools } = fakeHerdr({ panes: [gatewayLoop, lanePane], dir });
    const result = await tools.dispatchWorker({ taskId: "front-chase", task: "chase it" });
    expect(result.mode).toBe("relaunched");
    expect(result.paneId).toBe("wZ:pD");
    expect(calls.some(([family, verb]) => family === "tab" && verb === "create")).toBe(false);
  });

  test("dispatch refuses past the lane ceiling and names the busy lanes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-lanes-"));
    const panes = [gatewayLoop];
    let next = 0;
    const run = async (command, args) => {
      const [family, verb] = args;
      if (family === "pane" && verb === "list") return { result: { panes } };
      if ((family === "pane" && verb === "split") || (family === "tab" && verb === "create")) {
        next += 1;
        const paneId = `wZ:pL${next}`;
        panes.push({ pane_id: paneId, workspace_id: "wZ", agent_status: "working" });
        return verb === "split" ? { result: { pane: { pane_id: paneId } } } : { result: { root_pane: { pane_id: paneId } } };
      }
      if (family === "pane" && verb === "rename") {
        const pane = panes.find((entry) => entry.pane_id === args[2]);
        if (pane) pane.label = args[3];
      }
      return { result: { type: "ok" } };
    };
    const tools = createHerdrTools({ run, now: () => 1000, taskDir: `${dir}/tasks`, workerDir: `${dir}/workers` });
    const lanes = ["alpha-chase", "beta-chase", "gamma-chase", "delta-chase"];
    expect(lanes).toHaveLength(MAX_WORKER_LANES);
    for (const taskId of lanes) await tools.dispatchWorker({ taskId, task: "x" });
    await expect(tools.dispatchWorker({ taskId: "one-too-many", task: "x" }))
      .rejects.toThrow(/worker ceiling reached: 4 lanes already open \[alpha-chase/u);
  });

  test("release records a truthful harvest receipt and closes the pane", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-lanes-"));
    const { calls, tools } = fakeHerdr({ dir });
    await tools.dispatchWorker({ taskId: "front-parser-restore", task: "fix it" });
    const released = await tools.releaseWorker({ taskId: "front-parser-restore", outcome: "committed", note: "landed in aae0091" });
    expect(released.closed).toBe(true);
    expect(released.receipt).toContain("outcome: committed");
    expect(released.receipt).toContain("pane may close");
    expect(calls.some(([family, verb]) => family === "pane" && verb === "close")).toBe(true);
    expect((await tools.workers()).lanes).toHaveLength(0);
    const log = await readFile(join(dir, "workers", "harvest.log"), "utf8");
    expect(log).toContain("landed in aae0091");
  });

  test("release rejects an outcome that is not a real outcome", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-lanes-"));
    const { tools } = fakeHerdr({ dir });
    await expect(tools.releaseWorker({ taskId: "x-lane", outcome: "done" })).rejects.toThrow("outcome must be one of");
  });
});

test("aggregate deadline uses the durable wake registry", async () => {
  const calls = [];
  const wake = createWakeTools({ run: async (...args) => { calls.push(args); return { ok: true }; } });
  await wake.scheduleAggregateDeadline({
    target: "gateway-agent",
    holdUntil: Date.now() + 60_000,
    aggregateId: "storm-1",
    memberEventIds: ["input-1"],
  });
  expect(calls[0][0]).toBe("joelclaw");
  expect(calls[0][1]).toContain("wake");
  expect(calls[0][1].join(" ")).toContain("aggregate.deadline.reached");
});

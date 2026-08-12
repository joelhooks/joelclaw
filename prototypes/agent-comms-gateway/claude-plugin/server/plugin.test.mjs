import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrTools, laneFromTaskId, laneLabel, MAX_WORKER_LANES } from "./herdr-tools.mjs";
import { createToolHandlers, handleMcpMessage, toolDefinitions } from "./index.mjs";
import { createShitratTriage, SHITRAT_TRIAGE_MODEL } from "./shitrat-triage.mjs";
import {
  createStreamTools,
  lintRewrite,
  MAX_AGGREGATE_JOINS,
  normalizeSlackReplyThreadId,
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
const slackWorkRequest = {
  _id: "slack-work-1",
  kind: "inbound.received",
  source: "gateway.slack.chat-sdk.message.retry",
  recordedAt: 13,
  sequence: 4,
  payload: {
    addressing: "addressed",
    actorId: "U030BJ3CK",
    content: { text: ":shitrat: review this" },
    workRequest: {
      channelId: "CEXAMPLE",
      channelName: "lc-example",
      replyThreadId: "slack:CEXAMPLE:1785950000.100",
      botDeliveryReady: false,
      userDeliveryReady: true,
      binding: { cwd: "/tmp/example", repo: "/tmp/example" },
    },
  },
};
const shitratWorkerResult = {
  _id: "worker-result-1",
  kind: "message.requested",
  source: "shitrat-worker",
  flowId: "notify:worker-result-1",
  recordedAt: 13,
  sequence: 4,
  payload: {
    text: "Review complete.",
    evidence: {
      context: {
        taskId: "example-review",
        platform: "slack",
        channelId: "CEXAMPLE",
        replyThreadId: "slack:CEXAMPLE:1785950000.100",
      },
    },
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

describe("Luna ShitRat triage", () => {
  test("treats attribution as social instead of manufacturing repo work", async () => {
    let prompt = "";
    const triage = createShitratTriage({
      infer: async (value) => {
        prompt = value;
        return JSON.stringify({
          disposition: "social",
          reply: "A postmortem with receipts? Disgustingly responsible. 🐀",
          task: null,
          reason: "Joel is sharing a result, not asking for work.",
        });
      },
    });
    const result = await triage.triage({
      channelName: "cc-fictional",
      text: "TMI postmortem from :shitrat: — stabilized and tested",
      bound: true,
    });
    expect(result).toMatchObject({
      model: SHITRAT_TRIAGE_MODEL,
      disposition: "social",
      task: null,
    });
    expect(prompt).toContain("Do not treat the token alone as work");
  });

  test("returns a concrete task only when Luna classifies real work", async () => {
    const triage = createShitratTriage({
      infer: async () => "```json\n{\"disposition\":\"work\",\"reply\":\"I’ll trace the schema drift and bring back the guilty commit. 🐀\",\"task\":\"Trace production schema drift and identify the introducing commit.\",\"reason\":\"Explicit investigation request.\"}\n```",
    });
    await expect(triage.triage({
      channelName: "lc-fictional",
      text: ":shitrat: find why production schema drifted",
      bound: true,
    })).resolves.toMatchObject({
      disposition: "work",
      task: "Trace production schema drift and identify the introducing commit.",
    });
  });

  test("rejects personality sludge that exceeds the Slack reply bound", async () => {
    const triage = createShitratTriage({
      infer: async () => JSON.stringify({
        disposition: "social",
        reply: "x".repeat(321),
        task: null,
        reason: "too much",
      }),
    });
    await expect(triage.triage({
      channelName: "cc-fictional",
      text: "credit to :shitrat:",
    })).rejects.toThrow("exceeds 320 characters");
  });
});

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

  test("normalizes stale duplicated Slack thread prefixes", async () => {
    expect(normalizeSlackReplyThreadId(
      "CEXAMPLE",
      "slack:CEXAMPLE:slack:CEXAMPLE:1785950000.100",
    )).toBe("slack:CEXAMPLE:1785950000.100");

    const staleWorkerResult = {
      ...shitratWorkerResult,
      payload: {
        ...shitratWorkerResult.payload,
        evidence: {
          context: {
            ...shitratWorkerResult.payload.evidence.context,
            replyThreadId: "slack:CEXAMPLE:slack:CEXAMPLE:1785950000.100",
          },
        },
      },
    };
    const client = fakeClient([staleWorkerResult]);
    const stream = createStreamTools({ client, now: () => 20 });
    const pending = await stream.pending();
    expect(pending.pending[0].workerResult.replyThreadId).toBe(
      "slack:CEXAMPLE:1785950000.100",
    );
    const appended = await stream.recordDecision({
      payload: {
        ...decisionPayload,
        inputEventIds: ["worker-result-1"],
        rewrite: "Review complete.",
      },
    });
    expect(appended.event.payload.decision.target.threadId).toBe(
      "slack:CEXAMPLE:1785950000.100",
    );
    expect(appended.event.payload.slackDelivery).toEqual({
      identity: "joel",
      channelId: "CEXAMPLE",
      messageTs: "1785950000.100",
    });
    expect(appended.event.payload.slackWorkCompletion).toEqual({
      channelId: "CEXAMPLE",
      messageTs: "1785950000.100",
      reaction: "white_check_mark",
      taskId: "example-review",
    });
  });

  test("mechanically returns ShitRat worker results to their Slack thread", async () => {
    const client = fakeClient([shitratWorkerResult]);
    const stream = createStreamTools({ client, now: () => 20 });
    const pending = await stream.pending();
    expect(pending.pending[0].workerResult).toEqual({
      taskId: "example-review",
      platform: "slack",
      channelId: "CEXAMPLE",
      replyThreadId: "slack:CEXAMPLE:1785950000.100",
      phase: "result",
    });
    await expect(stream.recordDecision({
      payload: {
        ...decisionPayload,
        inputEventIds: ["worker-result-1"],
        rewrite: "x".repeat(1_201),
      },
    })).rejects.toThrow("result rewrite exceeds 1200 characters");
    const appended = await stream.recordDecision({
      payload: {
        ...decisionPayload,
        inputEventIds: ["worker-result-1"],
        decision: {
          verb: "deliver",
          target: { kind: "platform", platform: "telegram" },
        },
        rewrite: "Review complete.",
      },
    });
    expect(appended.event.payload.decision.target).toEqual({
      kind: "platform",
      platform: "slack",
      conversationId: "CEXAMPLE",
      threadId: "slack:CEXAMPLE:1785950000.100",
    });
    expect(appended.event.payload.slackDelivery).toEqual({
      identity: "joel",
      channelId: "CEXAMPLE",
      messageTs: "1785950000.100",
    });
    expect(appended.event.payload.slackWorkCompletion).toEqual({
      channelId: "CEXAMPLE",
      messageTs: "1785950000.100",
      reaction: "white_check_mark",
      taskId: "example-review",
    });
  });

  test("routes worker progress to Slack without completing the work", async () => {
    const progress = {
      ...shitratWorkerResult,
      _id: "worker-progress-1",
      payload: {
        ...shitratWorkerResult.payload,
        text: "Assessment brief loaded; tracing the incident next.",
        evidence: {
          context: {
            ...shitratWorkerResult.payload.evidence.context,
            workerPhase: "progress",
          },
        },
      },
    };
    const client = fakeClient([progress]);
    const stream = createStreamTools({ client, now: () => 20 });
    const pending = await stream.pending();
    expect(pending.pending[0].workerResult.phase).toBe("progress");
    await expect(stream.recordDecision({
      payload: {
        ...decisionPayload,
        inputEventIds: ["worker-progress-1"],
        decision: { verb: "drop" },
        rewrite: undefined,
      },
    })).rejects.toThrow("must deliver to its bound source thread");
    await expect(stream.recordDecision({
      payload: {
        ...decisionPayload,
        inputEventIds: ["worker-progress-1"],
        rewrite: "x".repeat(321),
      },
    })).rejects.toThrow("progress rewrite exceeds 320 characters");

    const appended = await stream.recordDecision({
      payload: {
        ...decisionPayload,
        inputEventIds: ["worker-progress-1"],
        rewrite: "Assessment brief loaded; tracing the incident next.",
      },
    });

    expect(appended.event.payload.decision.target).toEqual({
      kind: "platform",
      platform: "slack",
      conversationId: "CEXAMPLE",
      threadId: "slack:CEXAMPLE:1785950000.100",
    });
    expect(appended.event.payload.slackDelivery).toEqual({
      identity: "joel",
      channelId: "CEXAMPLE",
      messageTs: "1785950000.100",
    });
    expect(appended.event.payload.slackWorkCompletion).toBeUndefined();
  });

  test("does not mark Slack-shaped non-worker messages complete", async () => {
    const copiedContext = {
      ...shitratWorkerResult,
      _id: "ordinary-slack-shaped-message",
      source: "cli/notify",
    };
    const client = fakeClient([copiedContext]);
    const stream = createStreamTools({ client, now: () => 20 });
    const appended = await stream.recordDecision({
      payload: {
        ...decisionPayload,
        inputEventIds: ["ordinary-slack-shaped-message"],
        rewrite: "Ordinary notification.",
      },
    });

    expect(appended.event.payload.slackDelivery).toBeUndefined();
    expect(appended.event.payload.slackWorkCompletion).toBeUndefined();
    expect(appended.event.payload.decision.target).toEqual({
      kind: "platform",
      platform: "telegram",
    });
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

  test("bootstrap normalizes a stale workRequest return thread", async () => {
    const stale = {
      ...slackWorkRequest,
      payload: {
        ...slackWorkRequest.payload,
        workRequest: {
          ...slackWorkRequest.payload.workRequest,
          replyThreadId: "slack:CEXAMPLE:slack:CEXAMPLE:1785950000.100",
        },
      },
    };
    const stream = createStreamTools({ client: fakeClient([stale]), now: () => 20 });
    const boot = await stream.bootstrap();
    expect(boot.pending[0].payload.workRequest.replyThreadId).toBe(
      "slack:CEXAMPLE:1785950000.100",
    );
    expect(boot.pendingCompact[0].workRequest.replyThreadId).toBe(
      "slack:CEXAMPLE:1785950000.100",
    );
  });

  test("pre-patch workRequest without delivery readiness fails closed", async () => {
    const {
      botDeliveryReady: _botOmitted,
      userDeliveryReady: _userOmitted,
      ...legacyWorkRequest
    } = slackWorkRequest.payload.workRequest;
    const stale = {
      ...slackWorkRequest,
      _id: "slack-work-readiness-missing",
      payload: {
        ...slackWorkRequest.payload,
        workRequest: legacyWorkRequest,
      },
    };
    const client = fakeClient([stale]);
    const stream = createStreamTools({ client, now: () => 20 });
    const pending = await stream.pending();
    expect(pending.pending[0].workRequest.botDeliveryReady).toBe(false);
    expect(pending.pending[0].workRequest.userDeliveryReady).toBe(false);
    const handlers = createToolHandlers({
      stream,
      herdr: { dispatchWorker: async () => ({ unsafe: true }) },
      wake: {},
    });
    await expect(handlers.herdr_dispatch_worker({ taskId: "x", task: "y" }))
      .rejects.toThrow("Joel's Slack token must reach the channel");
  });

  test("workRequest fails closed when Joel's Slack token cannot deliver", async () => {
    const identityBlocked = {
      ...slackWorkRequest,
      _id: "slack-work-no-bot",
      payload: {
        ...slackWorkRequest.payload,
        workRequest: {
          ...slackWorkRequest.payload.workRequest,
          botDeliveryReady: false,
          userDeliveryReady: false,
        },
      },
    };
    const client = fakeClient([identityBlocked]);
    const stream = createStreamTools({ client, now: () => 20 });
    const handlers = createToolHandlers({
      stream,
      herdr: { dispatchWorker: async () => ({ unsafe: true }) },
      wake: {},
    });

    await expect(handlers.herdr_dispatch_worker({ taskId: "x", task: "y" }))
      .rejects.toThrow("Joel's Slack token must reach the channel");
    await expect(stream.recordDecision({
      payload: {
        inputEventIds: ["slack-work-no-bot"],
        reason: "Joel's Slack token cannot reply in this private channel.",
        promptRevision: "abc123",
        decisionSeq: 1,
        decision: { verb: "fanout", taskId: "unsafe-launch" },
      },
    })).rejects.toThrow("must fail closed with one drop");

    const dropped = await stream.recordDecision({
      payload: {
        inputEventIds: ["slack-work-no-bot"],
        reason: "Joel's Slack token cannot reply in this private channel.",
        promptRevision: "abc123",
        decisionSeq: 1,
        decision: { verb: "drop" },
      },
    });
    expect(dropped.advanceAfter).toBe(true);
    expect(dropped.event.payload.decision.verb).toBe("drop");
  });

  test("bound workRequest delivers Luna triage before one channel-bound fanout", async () => {
    const client = fakeClient([slackWorkRequest]);
    const stream = createStreamTools({ client, now: () => 20 });
    const pending = await stream.pending();
    expect(pending.ackRequiredJoel).toEqual([]);
    expect(pending.pending[0]).toMatchObject({
      addressing: "addressed",
      workRequest: {
        channelName: "lc-example",
        text: ":shitrat: review this",
        replyThreadId: "slack:CEXAMPLE:1785950000.100",
      },
    });

    await expect(stream.recordDecision({
      payload: {
        inputEventIds: ["slack-work-1"],
        reason: "Skipped Luna triage.",
        promptRevision: "abc123",
        decisionSeq: 1,
        decision: { verb: "fanout", taskId: "unsafe-launch" },
      },
    })).rejects.toThrow("must first deliver the Luna triage reply");

    const triageReply = await stream.recordDecision({
      payload: {
        inputEventIds: ["slack-work-1"],
        reason: "Luna classified this as repository work.",
        promptRevision: "abc123",
        decisionSeq: 1,
        decision: { verb: "deliver" },
        rewrite: "I’ll inspect the review path and bring back the sharp bits. 🐀",
      },
      advanceAfter: false,
    });
    expect(triageReply.advanceAfter).toBe(false);
    expect(triageReply.event.payload.decision.target).toMatchObject({
      platform: "slack",
      conversationId: "CEXAMPLE",
      threadId: "slack:CEXAMPLE:1785950000.100",
    });

    const handlers = createToolHandlers({
      stream,
      slackThreads: {
        runTurn: async () => ({ ok: true, sessionId: "thread-session-1" }),
      },
      herdr: {
        dispatchWorker: async () => ({ unsafe: true }),
        prompt: async () => ({ unsafe: true }),
      },
      wake: {},
    });
    await expect(handlers.herdr_prompt({ target: "wZ:p1", text: "reuse this pane" }))
      .rejects.toThrow("Generic herdr prompting");
    await expect(handlers.herdr_dispatch_worker({ taskId: "x", task: "y" }))
      .rejects.toThrow("one-shot worker dispatch");
    await expect(handlers.slack_thread_run({
      sourceEventId: "slack-work-1",
      channelId: "CWRONG",
      channelName: "lc-example",
      threadTs: "1785950000.100",
      text: "review this",
    })).rejects.toThrow("must match pending workRequest");
    await expect(handlers.slack_thread_run({
      sourceEventId: "slack-work-1",
      channelId: "CEXAMPLE",
      channelName: "lc-example",
      threadTs: "1785950000.100",
      text: "review this",
    })).resolves.toEqual({ ok: true, sessionId: "thread-session-1" });

    const fanout = await stream.recordDecision({
      payload: {
        inputEventIds: ["slack-work-1"],
        reason: "Dispatch the work Luna classified after its threaded reply.",
        promptRevision: "abc123",
        decisionSeq: 2,
        decision: { verb: "fanout", taskId: "slack-work-review" },
      },
    });
    expect(fanout.advanceAfter).toBe(true);
    expect(fanout.cursor.lastEventId).toBe("slack-work-1");
    expect(fanout.event.payload.decision).toEqual({
      verb: "fanout",
      taskId: "slack-work-review",
    });

    await expect(stream.recordDecision({
      payload: {
        inputEventIds: ["slack-work-1"],
        reason: "A second fanout is forbidden.",
        promptRevision: "abc123",
        decisionSeq: 3,
        decision: { verb: "fanout", taskId: "slack-work-review" },
      },
    })).rejects.toThrow("already has its thread-session fanout decision");
  });

  test("bound social triage replies once without manufacturing work", async () => {
    const client = fakeClient([slackWorkRequest]);
    const stream = createStreamTools({ client, now: () => 20 });
    const delivered = await stream.recordDecision({
      payload: {
        inputEventIds: ["slack-work-1"],
        reason: "Luna classified the activation as social attribution.",
        promptRevision: "abc123",
        decisionSeq: 1,
        decision: { verb: "deliver" },
        rewrite: "A postmortem with receipts? Disgustingly responsible. 🐀",
      },
    });
    expect(delivered.advanceAfter).toBe(true);
    expect(delivered.cursor.lastEventId).toBe("slack-work-1");
    expect(delivered.event.payload.decision.target).toMatchObject({
      platform: "slack",
      conversationId: "CEXAMPLE",
    });
  });

  test("unbound work may start only in a neutral thread session", async () => {
    const unbound = {
      ...slackWorkRequest,
      _id: "slack-work-unbound",
      payload: {
        ...slackWorkRequest.payload,
        workRequest: {
          ...slackWorkRequest.payload.workRequest,
          binding: undefined,
        },
      },
    };
    const client = fakeClient([unbound]);
    const stream = createStreamTools({ client, now: () => 20 });
    const pending = await stream.pending();
    expect(pending.ackRequiredJoel).toEqual([]);

    const handlers = createToolHandlers({
      stream,
      slackThreads: { runTurn: async () => ({ ok: true, bound: false }) },
      herdr: { dispatchWorker: async () => ({ unsafe: true }) },
      wake: {},
    });
    await expect(handlers.herdr_dispatch_worker({ taskId: "x", task: "y" }))
      .rejects.toThrow("neutral session");
    await expect(handlers.slack_thread_run({
      sourceEventId: "slack-work-unbound",
      channelId: "CEXAMPLE",
      channelName: "lc-example",
      threadTs: "1785950000.100",
      text: "review this",
    })).resolves.toEqual({ ok: true, bound: false });

    await expect(stream.recordDecision({
      payload: {
        inputEventIds: ["slack-work-unbound"],
        reason: "No channel context binding exists.",
        promptRevision: "abc123",
        decisionSeq: 1,
        decision: { verb: "fanout", taskId: "unsafe-launch" },
      },
    })).rejects.toThrow("must first deliver the Luna triage reply");

    const delivered = await stream.recordDecision({
      payload: {
        inputEventIds: ["slack-work-unbound"],
        reason: "Luna found real work but the channel has no project mapping.",
        promptRevision: "abc123",
        decisionSeq: 1,
        decision: { verb: "deliver" },
        rewrite: "I know what you want, but `#lc-example` has no project map. Point me at the repo and I’ll get filthy. 🐀",
      },
    });
    expect(delivered.advanceAfter).toBe(true);
    expect(delivered.event.payload.decision.target).toEqual({
      kind: "platform",
      platform: "slack",
      conversationId: "CEXAMPLE",
      threadId: "slack:CEXAMPLE:1785950000.100",
    });
    expect(delivered.event.payload.slackDelivery).toEqual({
      identity: "joel",
      channelId: "CEXAMPLE",
      messageTs: "1785950000.100",
    });
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
  expect(listed.tools).toHaveLength(24);
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
      if (family === "worktree" && verb === "create") {
        return {
          result: {
            type: "worktree_created",
            workspace: { workspace_id: "wSR" },
            root_pane: { pane_id: "wSR:p1" },
            worktree: { path: "/tmp/example-shitrat-review", branch: "shitrat/example-review" },
          },
        };
      }
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

  test("Slack work launches a fresh Herdr worktree without depending on the gateway pane", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-lanes-"));
    const { calls, tools } = fakeHerdr({ panes: [], dir });
    const result = await tools.dispatchWorker({
      taskId: "example-review",
      lane: "example-review",
      label: "[mega] assessment review",
      task: "Review the assessment logic.",
      cwd: "/tmp/example-project",
      freshWorkspace: true,
      worktree: true,
      resultContext: {
        sourceEventId: "slack-work-1",
        platform: "slack",
        channelId: "CEXAMPLE",
        replyThreadId: "slack:CEXAMPLE:1785950000.100",
      },
    });

    expect(result).toMatchObject({
      paneId: "wSR:p1",
      workspaceId: "wSR",
      cwd: "/tmp/example-shitrat-review",
      sourceCwd: "/tmp/example-project",
      freshWorkspace: true,
      worktree: true,
    });
    expect(calls).toContainEqual([
      "worktree", "create",
      "--cwd", "/tmp/example-project",
      "--branch", "shitrat/example-review",
      "--label", "[mega] assessment review",
      "--no-focus", "--json",
    ]);
    const task = await readFile(join(dir, "tasks", "example-review.md"), "utf8");
    expect(task).toContain("Launch contract cwd: `/tmp/example-shitrat-review`");
    expect(task).toContain('"replyThreadId":"slack:CEXAMPLE:1785950000.100"');
    expect(task).toContain("--context");
    expect(task).toContain("append one short private progress receipt");
    expect(task).toContain('"workerPhase":"progress"');
    expect(task).toContain("append one private worker-result receipt");
    expect(task).toContain("Never run `jc-slack reply`");
    expect(task).toContain("The gateway alone decides and sends the one outward result");
    expect(task).not.toContain("--data");
    expect(calls.some((args) =>
      args[0] === "pane"
      && args[1] === "run"
      && args[3].startsWith("JOELCLAW_GATEWAY_WORKER=1 pi --approve "))).toBe(true);

    const livePane = {
      pane_id: "wSR:p1",
      label: laneLabel("example-review"),
      workspace_id: "wSR",
      agent_status: "working",
    };
    const retry = fakeHerdr({ panes: [livePane], dir });
    const idempotent = await retry.tools.dispatchWorker({
      taskId: "example-review",
      lane: "example-review",
      task: "Review the assessment logic.",
      cwd: "/tmp/example-project",
      freshWorkspace: true,
      worktree: true,
      resultContext: {
        sourceEventId: "slack-work-1",
        platform: "slack",
        channelId: "CEXAMPLE",
        replyThreadId: "slack:CEXAMPLE:1785950000.100",
      },
    });
    expect(idempotent).toMatchObject({
      reused: true,
      mode: "idempotent-existing",
      paneId: "wSR:p1",
    });
    expect(retry.calls.some(([family, verb]) => family === "worktree" && verb === "create")).toBe(false);

    await expect(retry.tools.dispatchWorker({
      taskId: "example-review",
      lane: "example-review",
      task: "A later request must not reuse this worktree.",
      cwd: "/tmp/example-project",
      freshWorkspace: true,
      worktree: true,
      resultContext: {
        sourceEventId: "slack-work-2",
        platform: "slack",
        channelId: "CEXAMPLE",
        replyThreadId: "slack:CEXAMPLE:1785950002.300",
      },
    })).rejects.toThrow("already owns pane");
  });

  test("Slack result context refuses warm-pane dispatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-lanes-"));
    const { tools } = fakeHerdr({ dir });
    await expect(tools.dispatchWorker({
      taskId: "unsafe-slack-reuse",
      task: "Review it.",
      cwd: "/tmp/example-project",
      resultContext: {
        platform: "slack",
        channelId: "CEXAMPLE",
        replyThreadId: "slack:CEXAMPLE:1785950000.100",
      },
    })).rejects.toThrow("warm-pane reuse is forbidden");
  });

  test("fresh Slack work refuses without a return thread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-lanes-"));
    const { tools } = fakeHerdr({ dir });
    await expect(tools.dispatchWorker({
      taskId: "missing-return",
      task: "Review it.",
      cwd: "/tmp/example-project",
      freshWorkspace: true,
      worktree: true,
    })).rejects.toThrow("fresh Slack work requires resultContext");
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

#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { createHerdrTools } from "./herdr-tools.mjs";
import { createShitratTriage, warmShitratTriage } from "./shitrat-triage.mjs";
import { createSlackThreadTools } from "./slack-thread-tools.mjs";
import { createStreamTools } from "./stream-tools.mjs";
import { createWakeTools } from "./wake-tools.mjs";

const objectSchema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string", minLength: 1 };
const integer = { type: "integer" };
const arrayOfStrings = { type: "array", items: string, minItems: 1 };

export const toolDefinitions = [
  {
    name: "stream_bootstrap",
    description:
      "Load the advisory handoff and authoritative pending replay for the gateway cursor.",
    inputSchema: objectSchema({ limit: integer }),
  },
  {
    name: "stream_read_since",
    description: "Read an independent canonical stream page without moving a consumer cursor.",
    inputSchema: objectSchema(
      {
        recordedAt: integer,
        limit: integer,
        cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      ["recordedAt"],
    ),
  },
  {
    name: "stream_pending",
    description:
      "Read one driver-turn page of at most 20 compact pending events. Call once, decide only that page, then finish the turn. Addressed Joel inbounds needing ack are listed first under ackRequiredJoel. Ambient inbounds require observe or an escalation receipt and must not produce outbound by default.",
    inputSchema: objectSchema({ limit: integer }),
  },
  {
    name: "stream_record_decision",
    description:
      "Validate and append one ADR-0249 decision receipt, then read it back. Ordinary addressed Joel inbound requires deliver first. A personal-token-ready Slack workRequest first delivers its Luna triage reply to the source thread. Social/answer replies advance and stop. Real work replies with advanceAfter:false, then uses one channel-bound Herdr dispatch and advancing fanout. Missing personal-token access requires one advancing drop. Ambient inbound requires observe, or escalate before outbound.",
    inputSchema: objectSchema(
      {
        payload: { type: "object" },
        flowId: string,
        origin: { type: "object" },
        advanceAfter: { type: "boolean" },
      },
      ["payload"],
    ),
  },
  {
    name: "stream_append_gateway_event",
    description:
      "Append and read back a typed handoff, aggregate deadline, or inbound interpretation event.",
    inputSchema: objectSchema(
      {
        semanticKey: string,
        kind: { enum: ["gateway.handoff", "aggregate.deadline.reached", "inbound.interpreted"] },
        payload: { type: "object" },
        flowId: string,
        origin: { type: "object" },
      },
      ["semanticKey", "kind", "payload"],
    ),
  },
  {
    name: "stream_advance_after_decision",
    description:
      "Advance the gateway cursor only after exactly one read-back decision covers the input.",
    inputSchema: objectSchema({ eventId: string, decisionEventId: string }, [
      "eventId",
      "decisionEventId",
    ]),
  },
  {
    name: "stream_advance_own_output",
    description:
      "Mechanically advance past a gateway-authored stream output without treating it as new evidence.",
    inputSchema: objectSchema({ eventId: string }, ["eventId"]),
  },
  {
    name: "shitrat_triage",
    description:
      "Use the warm approved Luna model to classify one new or follow-up Slack thread turn, infer only from verified project candidates, and draft the ShitRat-voice reply. Call before any workRequest decision or thread-session run.",
    inputSchema: objectSchema(
      {
        channelName: string,
        text: string,
        threadText: { type: "string" },
        bound: { type: "boolean" },
        activation: { enum: ["new", "follow-up"] },
        projectCandidates: { type: "array", items: { type: "object" } },
      },
      ["channelName", "text", "bound"],
    ),
  },
  {
    name: "slack_thread_candidates",
    description:
      "Load mechanically verified project candidates for one Slack thread from private bindings and recent active work. This never searches arbitrary repos.",
    inputSchema: objectSchema({ channelName: string, binding: { type: "object" } }, [
      "channelName",
    ]),
  },
  {
    name: "slack_thread_run",
    description:
      "Create or continue the durable Pi session owned by one Slack root thread. Requires the pending source event ID for idempotency. The thread stays neutral unless a verified candidate meets Luna's confidence floor.",
    inputSchema: objectSchema(
      {
        sourceEventId: string,
        channelId: string,
        channelName: string,
        threadTs: string,
        text: string,
        threadText: { type: "string" },
        binding: { type: "object" },
        projectId: string,
        projectConfidence: { type: "number" },
      },
      ["sourceEventId", "channelId", "channelName", "threadTs", "text"],
    ),
  },
  {
    name: "slack_thread_status",
    description: "Read one Slack thread session's durable binding and live Herdr status.",
    inputSchema: objectSchema({ channelId: string, threadTs: string }, ["channelId", "threadTs"]),
  },
  {
    name: "slack_thread_read",
    description: "Read one settled Pi turn by its source event ID and mark that turn complete.",
    inputSchema: objectSchema(
      { sourceEventId: string, channelId: string, threadTs: string, lines: integer },
      ["sourceEventId", "channelId", "threadTs"],
    ),
  },
  {
    name: "slack_thread_resolve",
    description:
      "Mark a Slack thread explicitly resolved and start its configurable quiet timeout. A human reply before expiry reopens it.",
    inputSchema: objectSchema({ channelId: string, threadTs: string, quietTimeoutMs: integer }, [
      "channelId",
      "threadTs",
    ]),
  },
  {
    name: "herdr_snapshot",
    description: "Read a fresh mechanical snapshot of Herdr agents and panes.",
    inputSchema: objectSchema({}),
  },
  {
    name: "herdr_read",
    description:
      'Read output from one Herdr agent target. Full-screen agents (claude, codex, opencode) render in the alternate screen, whose rows never enter host scrollback — use source "visible" for those targets; the "recent-unwrapped" default only suits scrollback-native agents like pi.',
    inputSchema: objectSchema(
      {
        target: string,
        lines: integer,
        source: { enum: ["visible", "recent", "recent-unwrapped", "detection"] },
      },
      ["target"],
    ),
  },
  {
    name: "herdr_prompt",
    description:
      "Atomically submit a prompt to a live Herdr agent; optionally wait for settlement.",
    inputSchema: objectSchema(
      { target: string, text: string, wait: { type: "boolean" }, timeoutMs: integer },
      ["target", "text"],
    ),
  },
  {
    name: "herdr_wait",
    description: "Wait for explicit Herdr agent states. This is a watchdog, not completion proof.",
    inputSchema: objectSchema({ target: string, states: arrayOfStrings, timeoutMs: integer }, [
      "target",
    ]),
  },
  {
    name: "herdr_dispatch_worker",
    description:
      "Send a task to a Pi worker in one call. Ordinary recurring beats reuse a warm lane. Slack :shitrat: work MUST pass the channel-bound absolute cwd plus freshWorkspace:true and worktree:true; this creates a fresh Herdr worktree workspace in the actual project instead of the gateway repo. resultContext is copied into the worker's return receipt so the gateway can reply to the originating Slack thread. Pair with a fanout receipt; never block on the worker. Refuses past 4 open lanes: release a finished one first.",
    inputSchema: objectSchema(
      {
        taskId: string,
        label: string,
        task: string,
        lane: string,
        cwd: string,
        freshWorkspace: { type: "boolean" },
        worktree: { type: "boolean" },
        resultContext: { type: "object" },
      },
      ["taskId", "task"],
    ),
  },
  {
    name: "herdr_release_worker",
    description:
      "Close the loop on a worker after you deliver its result: records a truthful harvest receipt and frees the lane, closing its pane by default. Outcome must be what actually happened — committed, rejected, no-changes-needed, or abandoned. Pass close: false to keep the warm pane for a lane you will dispatch to again soon.",
    inputSchema: objectSchema(
      {
        lane: string,
        taskId: string,
        outcome: { enum: ["committed", "rejected", "no-changes-needed", "abandoned"] },
        note: string,
        close: { type: "boolean" },
      },
      ["outcome"],
    ),
  },
  {
    name: "herdr_workers",
    description:
      "List your own live worker lanes with their pane ids and statuses, plus the ceiling. Use it to see your footprint before dispatching, and to find lanes you forgot to release.",
    inputSchema: objectSchema({}),
  },
  {
    name: "wake_revive",
    description: "Submit a durable REVIVE request with Joel's reply and origin context.",
    inputSchema: objectSchema({ loopId: string, reply: string, delay: string }, [
      "loopId",
      "reply",
    ]),
  },
  {
    name: "wake_schedule_aggregate_deadline",
    description:
      "Register a dumb timer that wakes the gateway with an aggregate deadline envelope.",
    inputSchema: objectSchema(
      {
        target: string,
        holdUntil: { anyOf: [{ type: "string" }, { type: "number" }] },
        aggregateId: string,
        memberEventIds: arrayOfStrings,
      },
      ["target", "holdUntil", "aggregateId", "memberEventIds"],
    ),
  },
  {
    name: "wake_list",
    description: "List durable wake-registry schedules.",
    inputSchema: objectSchema({}),
  },
  {
    name: "wake_cancel",
    description: "Cancel one durable wake-registry schedule.",
    inputSchema: objectSchema({ scheduleId: string }, ["scheduleId"]),
  },
];

function withJoelAckGate(stream, toolName, fn) {
  return async (args) => {
    if (typeof stream.assertJoelAckPriority === "function") {
      await stream.assertJoelAckPriority({ toolName, toolArgs: args });
    }
    return fn(args);
  };
}

export function createToolHandlers({
  stream = createStreamTools(),
  triage = createShitratTriage(),
  slackThreads = createSlackThreadTools(),
  herdr = createHerdrTools(),
  wake = createWakeTools(),
} = {}) {
  return {
    stream_bootstrap: (args) => stream.bootstrap(args),
    stream_read_since: (args) => stream.readSince(args),
    stream_pending: (args) => stream.pending(args),
    stream_record_decision: (args) => stream.recordDecision(args),
    stream_append_gateway_event: (args) => stream.appendGatewayEvent(args),
    stream_advance_after_decision: (args) => stream.advanceAfterDecision(args),
    stream_advance_own_output: (args) => stream.advanceOwnOutput(args),
    shitrat_triage: (args) => triage.triage(args),
    slack_thread_candidates: (args) => slackThreads.candidates(args),
    slack_thread_run: withJoelAckGate(stream, "slack_thread_run", (args) =>
      slackThreads.runTurn(args),
    ),
    slack_thread_status: (args) => slackThreads.status(args),
    slack_thread_read: (args) => slackThreads.read(args),
    slack_thread_resolve: (args) => slackThreads.resolve(args),
    // Herdr work is real work. If Joel is waiting on an ack, refuse and force the deliver first.
    herdr_snapshot: withJoelAckGate(stream, "herdr_snapshot", (args) => herdr.snapshot(args)),
    herdr_read: withJoelAckGate(stream, "herdr_read", (args) => herdr.read(args)),
    herdr_prompt: withJoelAckGate(stream, "herdr_prompt", (args) => herdr.prompt(args)),
    herdr_wait: withJoelAckGate(stream, "herdr_wait", (args) => herdr.wait(args)),
    herdr_dispatch_worker: withJoelAckGate(stream, "herdr_dispatch_worker", (args) =>
      herdr.dispatchWorker(args),
    ),
    herdr_release_worker: (args) => herdr.releaseWorker(args),
    herdr_workers: (args) => herdr.workers(args),
    wake_revive: withJoelAckGate(stream, "wake_revive", (args) => wake.revive(args)),
    wake_schedule_aggregate_deadline: (args) => wake.scheduleAggregateDeadline(args),
    wake_list: (args) => wake.list(args),
    wake_cancel: (args) => wake.cancel(args),
  };
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, error) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })}\n`,
  );
}

export async function handleMcpMessage(message, handlers = createToolHandlers()) {
  const { method, params = {} } = message;
  if (method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "joelclaw-gateway", version: "1.0.0" },
    };
  }
  if (method === "notifications/initialized") return undefined;
  if (method === "tools/list") return { tools: toolDefinitions };
  if (method !== "tools/call") throw new Error(`Unsupported method: ${method}`);
  const handler = handlers[params.name];
  if (!handler) throw new Error(`Unknown tool: ${params.name}`);
  const value = await handler(params.arguments ?? {});
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function main() {
  warmShitratTriage();
  const handlers = createToolHandlers();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
      const result = await handleMcpMessage(message, handlers);
      if (message.id !== undefined && result !== undefined) respond(message.id, result);
    } catch (error) {
      if (message?.id !== undefined) fail(message.id, error);
      else console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

if (import.meta.main) await main();

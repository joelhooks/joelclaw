#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { createHerdrTools } from "./herdr-tools.mjs";
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
  { name: "stream_bootstrap", description: "Load the advisory handoff and authoritative pending replay for the gateway cursor.", inputSchema: objectSchema({ limit: integer }) },
  { name: "stream_read_since", description: "Read an independent canonical stream page without moving a consumer cursor.", inputSchema: objectSchema({ recordedAt: integer, limit: integer, cursor: { anyOf: [{ type: "string" }, { type: "null" }] } }, ["recordedAt"]) },
  { name: "stream_pending", description: "Read pending events from the gateway's named durable cursor.", inputSchema: objectSchema({ limit: integer }) },
  { name: "stream_record_decision", description: "Validate and append one ADR-0249 decision receipt, then read it back.", inputSchema: objectSchema({ payload: { type: "object" }, flowId: string, origin: { type: "object" } }, ["payload"]) },
  { name: "stream_append_gateway_event", description: "Append and read back a typed handoff, aggregate deadline, or inbound interpretation event.", inputSchema: objectSchema({ semanticKey: string, kind: { enum: ["gateway.handoff", "aggregate.deadline.reached", "inbound.interpreted"] }, payload: { type: "object" }, flowId: string, origin: { type: "object" } }, ["semanticKey", "kind", "payload"]) },
  { name: "stream_advance_after_decision", description: "Advance the gateway cursor only after exactly one read-back decision covers the input.", inputSchema: objectSchema({ eventId: string, decisionEventId: string }, ["eventId", "decisionEventId"]) },
  { name: "stream_advance_own_output", description: "Mechanically advance past a gateway-authored stream output without treating it as new evidence.", inputSchema: objectSchema({ eventId: string }, ["eventId"]) },
  { name: "herdr_snapshot", description: "Read a fresh mechanical snapshot of Herdr agents and panes.", inputSchema: objectSchema({}) },
  { name: "herdr_read", description: "Read recent output from one Herdr agent target.", inputSchema: objectSchema({ target: string, lines: integer, source: { enum: ["visible", "recent", "recent-unwrapped", "detection"] } }, ["target"]) },
  { name: "herdr_prompt", description: "Atomically submit a prompt to a live Herdr agent; optionally wait for settlement.", inputSchema: objectSchema({ target: string, text: string, wait: { type: "boolean" }, timeoutMs: integer }, ["target", "text"]) },
  { name: "herdr_wait", description: "Wait for explicit Herdr agent states. This is a watchdog, not completion proof.", inputSchema: objectSchema({ target: string, states: arrayOfStrings, timeoutMs: integer }, ["target"]) },
  { name: "wake_revive", description: "Submit a durable REVIVE request with Joel's reply and origin context.", inputSchema: objectSchema({ loopId: string, reply: string, delay: string }, ["loopId", "reply"]) },
  { name: "wake_schedule_aggregate_deadline", description: "Register a dumb timer that wakes the gateway with an aggregate deadline envelope.", inputSchema: objectSchema({ target: string, holdUntil: { anyOf: [{ type: "string" }, { type: "number" }] }, aggregateId: string, memberEventIds: arrayOfStrings }, ["target", "holdUntil", "aggregateId", "memberEventIds"]) },
  { name: "wake_list", description: "List durable wake-registry schedules.", inputSchema: objectSchema({}) },
  { name: "wake_cancel", description: "Cancel one durable wake-registry schedule.", inputSchema: objectSchema({ scheduleId: string }, ["scheduleId"]) },
];

export function createToolHandlers({ stream = createStreamTools(), herdr = createHerdrTools(), wake = createWakeTools() } = {}) {
  return {
    stream_bootstrap: (args) => stream.bootstrap(args),
    stream_read_since: (args) => stream.readSince(args),
    stream_pending: (args) => stream.pending(args),
    stream_record_decision: (args) => stream.recordDecision(args),
    stream_append_gateway_event: (args) => stream.appendGatewayEvent(args),
    stream_advance_after_decision: (args) => stream.advanceAfterDecision(args),
    stream_advance_own_output: (args) => stream.advanceOwnOutput(args),
    herdr_snapshot: (args) => herdr.snapshot(args),
    herdr_read: (args) => herdr.read(args),
    herdr_prompt: (args) => herdr.prompt(args),
    herdr_wait: (args) => herdr.wait(args),
    wake_revive: (args) => wake.revive(args),
    wake_schedule_aggregate_deadline: (args) => wake.scheduleAggregateDeadline(args),
    wake_list: (args) => wake.list(args),
    wake_cancel: (args) => wake.cancel(args),
  };
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, error) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })}\n`);
}

export async function handleMcpMessage(message, handlers = createToolHandlers()) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "joelclaw-gateway", version: "1.0.0" } };
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

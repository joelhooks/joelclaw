#!/usr/bin/env node
import { createInterface } from "node:readline";
import { readReplayDay } from "./journal-spool-source.mjs";
import { validateAndBuildReceipts } from "./replay-core.mjs";

if (process.env.JOELCLAW_GATEWAY_REPLAY_ONLY !== "1") {
  console.error("Refusing to start without JOELCLAW_GATEWAY_REPLAY_ONLY=1");
  process.exit(2);
}

const tools = [
  {
    name: "replay_read_day",
    description: "Read one day from the real local message-journal spool. Read-only.",
    inputSchema: {
      type: "object",
      required: ["day"],
      properties: { day: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
      additionalProperties: false,
    },
  },
  {
    name: "decision_receipts_validate",
    description: "Validate exhaustive replay decisions and build production-shaped receipts.",
    inputSchema: {
      type: "object",
      required: ["output", "inputs", "recordedAt"],
      properties: {
        output: { type: "object" },
        inputs: { type: "array" },
        recordedAt: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, error) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })}\n`);
}

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    respond(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "joelclaw-gateway-replay", version: "0.1.0" } });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    respond(id, { tools });
    return;
  }
  if (method !== "tools/call") {
    if (id !== undefined) fail(id, new Error(`Unsupported method: ${method}`));
    return;
  }
  try {
    const { name, arguments: args = {} } = params;
    const value = name === "replay_read_day"
      ? await readReplayDay({ day: args.day })
      : name === "decision_receipts_validate"
        ? validateAndBuildReceipts(args.output, args.inputs, args.recordedAt)
        : (() => { throw new Error(`Unknown tool: ${name}`); })();
    respond(id, { content: [{ type: "text", text: JSON.stringify(value) }] });
  } catch (error) {
    fail(id, error);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  try {
    await handle(JSON.parse(line));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
}

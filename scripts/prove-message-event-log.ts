import { randomUUID } from "node:crypto";
import { getMessageEventLogClient } from "@joelclaw/message-event-log";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runId = randomUUID();
const semanticKey = `proof:${runId}`;
const flowId = `flow-proof-${runId}`;
const input = {
  semanticKey,
  kind: "message.requested" as const,
  source: "proof",
  payload: { proof: "append-consume-materialize-dedupe", runId },
  flowId,
  correlationId: `proof:${runId}`,
  rawSourceId: runId,
  occurredAt: Date.now(),
};
const client = getMessageEventLogClient();
const triggerConsumer = () => {
  const result = Bun.spawnSync({
    cmd: [
      "joelclaw",
      "send",
      "message/event.consume.requested",
      "-d",
      JSON.stringify({ reason: `proof:${runId}` }),
    ],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`failed to trigger message consumer: ${result.stderr.toString().slice(0, 300)}`);
  }
};

const first = await client.append(input);
triggerConsumer();
let trace = await client.trace(flowId);
const deadline = Date.now() + 90_000;
while (
  (trace.kind !== "trace" || trace.consumerReceipts.length !== 1) &&
  Date.now() < deadline
) {
  await sleep(1_000);
  trace = await client.trace(flowId);
}
if (trace.kind !== "trace" || trace.consumerReceipts.length !== 1) {
  throw new Error("message event consumer did not materialize exactly one receipt within 90s");
}

const beforeReplay = trace;
const duplicate = await client.append(input);
triggerConsumer();
await sleep(3_000);
const afterReplay = await client.trace(flowId);
if (afterReplay.kind !== "trace") throw new Error("flow view disappeared after replay");

const passed =
  first.deduplicated === false &&
  duplicate.deduplicated === true &&
  duplicate.eventId === first.eventId &&
  beforeReplay.events.length === 1 &&
  beforeReplay.consumerReceipts.length === 1 &&
  afterReplay.events.length === 1 &&
  afterReplay.consumerReceipts.length === 1 &&
  afterReplay.projection?.eventCount === 1;
if (!passed) throw new Error("message event proof invariants failed");

const cliTrace = Bun.spawnSync({
  cmd: ["bun", "packages/cli/src/cli.ts", "messages", "trace", flowId],
  env: { ...process.env, NO_COLOR: "1" },
  stdout: "pipe",
  stderr: "pipe",
});
const cliTraceOutput = cliTrace.stdout.toString();
if (cliTrace.exitCode !== 0 || !cliTraceOutput.includes('"source": "convex"')) {
  throw new Error(`CLI trace did not read the Convex view: ${cliTrace.stderr.toString().slice(0, 300)}`);
}

console.log(JSON.stringify({
  ok: true,
  runId,
  semanticKey,
  flowId,
  eventId: first.eventId,
  firstAppend: first,
  duplicateAppend: duplicate,
  consumerReceipts: afterReplay.consumerReceipts.length,
  materializedEventCount: afterReplay.projection?.eventCount ?? null,
  cliTraceSource: "convex",
}, null, 2));

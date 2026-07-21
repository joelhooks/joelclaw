#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.trim() ? JSON.parse(value) : {};
}

export function compactionReceipt(input) {
  return {
    sessionId: input?.session_id ?? "unknown",
    trigger: input?.trigger ?? "unknown",
    hookEvent: input?.hook_event_name ?? "PostCompact",
    compactedAt: new Date().toISOString(),
  };
}

function emitReceipt(args) {
  const result = spawnSync("joelclaw", args, {
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`joelclaw otel emit failed (${result.status}): ${result.stderr.trim()}`);
  return result.stdout;
}

export async function appendCompactionReceipt(input, { run = emitReceipt } = {}) {
  const receipt = compactionReceipt(input);
  await run([
    "otel",
    "emit",
    "gateway.compaction.recorded",
    "--source",
    "joelclaw-gateway",
    "--component",
    "claude-plugin",
    "--level",
    "info",
    "--success",
    "true",
    "--metadata",
    JSON.stringify(receipt),
  ]);
  return receipt;
}

async function main() {
  const input = await readStdin();
  await appendCompactionReceipt(input);
  process.stdout.write(`${JSON.stringify({ suppressOutput: true })}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}

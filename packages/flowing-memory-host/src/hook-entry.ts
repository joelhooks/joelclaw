#!/usr/bin/env node

import { homedir } from "node:os";
import { stdin } from "node:process";
import path from "node:path";

import { decodeGrokEvent, decodeNativeEvent, type NativeRuntime } from "./adapters.js";
import { submitNativeWake } from "./collector.js";

const runtimes = new Set<NativeRuntime>(["claude", "codex", "cursor", "grok", "pi"]);

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const readInput = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return undefined;
  try {
    return object(JSON.parse(raw));
  } catch {
    return undefined;
  }
};

const runtimeArg = () => {
  const index = process.argv.indexOf("--runtime");
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value !== undefined && runtimes.has(value as NativeRuntime)
    ? (value as NativeRuntime)
    : undefined;
};

const main = async () => {
  const runtime = runtimeArg();
  if (runtime === undefined) return;
  const input = await readInput();
  if (input === undefined) return;
  const decoded =
    runtime === "grok"
      ? decodeGrokEvent(input, { captureInferenceSession: true })
      : decodeNativeEvent(runtime, input, { captureInferenceSession: true });
  if (decoded._tag !== "Accepted") return;
  const spoolPath =
    process.env.JOELCLAW_FLOWING_MEMORY_WAKE_SPOOL ??
    path.join(homedir(), ".joelclaw", "flowing-memory", "native-wakes.jsonl");
  await submitNativeWake({
    ...(process.env.JOELCLAW_FLOWING_MEMORY_COLLECTOR_SOCKET === undefined
      ? {}
      : { socketPath: process.env.JOELCLAW_FLOWING_MEMORY_COLLECTOR_SOCKET }),
    spoolPath,
    wake: decoded.wake,
  });
};

// A capture wake is passive. A malformed or unavailable hook input must never
// block the runtime's turn or stop lifecycle.
try {
  await main();
} catch {
  // Keep hook failure fail-open. The collector remains the retry boundary.
}

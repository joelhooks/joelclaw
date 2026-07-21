#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdrTools } from "../server/herdr-tools.mjs";
import { createStreamTools } from "../server/stream-tools.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.trim() ? JSON.parse(value) : {};
}

export async function buildSessionStartContext({
  input,
  stream = createStreamTools(),
  herdr = createHerdrTools(),
  root = pluginRoot,
} = {}) {
  const promptNames = ["identity.md", "vocabulary.md", "judgment.md"];
  const promptFiles = await Promise.all(
    promptNames.map(async (name) => ({ name, text: await readFile(join(root, "prompts", name), "utf8") })),
  );
  const [bootstrap, snapshot] = await Promise.all([stream.bootstrap({ limit: 200 }), herdr.snapshot()]);
  const advisoryHandoff = bootstrap.latestHandoff?.payload?.note ?? null;
  return [
    "# Agent Comms Gateway boot",
    "Replay is authoritative. The handoff note is advisory when present.",
    `Claude session: ${input?.session_id ?? "unknown"}`,
    `Session source: ${input?.source ?? "unknown"}`,
    ...promptFiles.map((file) => `\n## prompts/${file.name}\n${file.text.trim()}`),
    `\n## Latest gateway.handoff (advisory)\n${advisoryHandoff ?? "No handoff note exists. Treat this as a crash/new-cycle boot and rely on replay."}`,
    `\n## Authoritative pending replay\n${JSON.stringify(bootstrap.pending)}`,
    `\n## Fresh Herdr snapshot\n${JSON.stringify(snapshot)}`,
    "\nFor each external pending event, append exactly one validated decision receipt before advancing the cursor. Mechanically skip gateway-owned output with stream_advance_own_output.",
  ].join("\n");
}

async function main() {
  const input = await readStdin();
  const additionalContext = await buildSessionStartContext({ input });
  process.stdout.write(`${JSON.stringify({
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  })}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}

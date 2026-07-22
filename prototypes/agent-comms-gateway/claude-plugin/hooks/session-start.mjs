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
  // Conversational continuity: the last day of the actual Joel<->gateway
  // exchange, both directions, chronological. Replay restores decisions;
  // this restores the conversation.
  const recent = await stream.readSince({ recordedAt: Date.now() - 24 * 60 * 60 * 1000, limit: 500 });
  const conversation = (recent.events ?? [])
    .filter((event) =>
      event.kind === "inbound.received"
      || (event.kind === "gateway.decision.recorded"
        && typeof event.payload?.rewrite === "string"
        && event.payload.rewrite.trim().length > 0))
    .slice(-30)
    .map((event) => {
      const at = new Date(event.recordedAt).toISOString().slice(11, 16);
      if (event.kind === "inbound.received") {
        const text = event.payload?.content?.data?.text ?? event.payload?.content?.text ?? "";
        return `${at} JOEL: ${String(text).slice(0, 300)}`;
      }
      return `${at} YOU: ${String(event.payload.rewrite).slice(0, 300)}`;
    })
    .join("\n");
  return [
    "# Agent Comms Gateway boot",
    "Replay is authoritative. The handoff note is advisory when present.",
    `Claude session: ${input?.session_id ?? "unknown"}`,
    `Session source: ${input?.source ?? "unknown"}`,
    ...promptFiles.map((file) => `\n## prompts/${file.name}\n${file.text.trim()}`),
    `\n## Latest gateway.handoff (advisory)\n${advisoryHandoff ?? "No handoff note exists. Treat this as a crash/new-cycle boot and rely on replay."}`,
    `\n## Recent conversation with Joel (last 24h, oldest first)\nThis is one continuous conversation you are already in — never greet Joel like a stranger, never re-explain what either of you already said.\n${conversation || "(no exchanges in the last 24h)"}`,
    `\n## Authoritative pending replay\n${JSON.stringify(bootstrap.pending)}`,
    `\n## Fresh Herdr snapshot (trimmed: agents + pane labels only; use herdr_snapshot for full detail)\n${JSON.stringify({
      agents: (snapshot.agents?.result?.agents ?? []).map((a) => ({ pane_id: a.pane_id, agent: a.agent, status: a.agent_status })),
      panes: (snapshot.panes?.result?.panes ?? []).map((p) => ({ pane_id: p.pane_id, label: p.label, workspace: p.workspace_id })),
      capturedAt: snapshot.capturedAt,
    })}`,
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

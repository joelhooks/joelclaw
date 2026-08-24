#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdrTools } from "../server/herdr-tools.mjs";
import {
  compactPendingList,
  createStreamTools,
  eventText,
  isJoelInbound,
} from "../server/stream-tools.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONVERSATION_WINDOWS_MS = [
  24 * 60 * 60 * 1000,
  3 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
];

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.trim() ? JSON.parse(value) : {};
}

function conversationLine(event) {
  const at = new Date(event.recordedAt ?? Date.now()).toISOString().slice(11, 16);
  if (event.kind === "inbound.received") {
    return `${at} JOEL: ${eventText(event).slice(0, 300)}`;
  }
  const rewrite = event.payload?.rewrite ?? event.payload?.decision?.rewrite ?? "";
  return `${at} YOU: ${String(rewrite).slice(0, 300)}`;
}

function isConversationEvent(event) {
  if (event.kind === "inbound.received" && eventText(event).trim()) return true;
  if (event.kind !== "gateway.decision.recorded") return false;
  const rewrite = event.payload?.rewrite ?? event.payload?.decision?.rewrite;
  return typeof rewrite === "string" && rewrite.trim().length > 0;
}

/**
 * Guarantee a real conversation section. Empty 24h boots made the agent
 * re-introduce itself like a stranger. Widen the window until exchanges exist.
 */
export async function loadConversationSection(stream, { now = Date.now(), limit = 500 } = {}) {
  for (const windowMs of CONVERSATION_WINDOWS_MS) {
    const recent = await stream.readSince({ recordedAt: now - windowMs, limit });
    const lines = (recent.events ?? [])
      .filter((event) => isConversationEvent(event))
      .slice(-30)
      .map((event) => conversationLine(event));
    if (lines.length > 0) {
      const hours = Math.round(windowMs / (60 * 60 * 1000));
      return {
        lines,
        windowLabel: hours <= 24 ? "last 24h" : `last ${hours}h (widened — 24h was empty)`,
        empty: false,
      };
    }
  }

  // Last resort: independent page from the beginning of readable history.
  const all = await stream.readSince({ recordedAt: 0, limit });
  const lines = (all.events ?? [])
    .filter((event) => isConversationEvent(event))
    .slice(-30)
    .map((event) => conversationLine(event));
  if (lines.length > 0) {
    return {
      lines,
      windowLabel: "full readable history (recent windows were empty)",
      empty: false,
    };
  }
  return { lines: [], windowLabel: "no exchanges on record", empty: true };
}

function summarizeHerdr(snapshot) {
  const agents = snapshot?.agents?.result?.agents ?? snapshot?.agents ?? [];
  const panes = snapshot?.panes?.result?.panes ?? snapshot?.panes ?? [];
  const agentList = Array.isArray(agents) ? agents : [];
  const paneList = Array.isArray(panes) ? panes : [];
  const labels = paneList
    .map((pane) => pane?.label)
    .filter((label) => typeof label === "string" && label.trim())
    .slice(0, 12);
  return {
    agentCount: agentList.length,
    paneCount: paneList.length,
    labels,
    note: "Boot no longer dumps the full herdr tree (it was 28–33k chars and almost never used). Call herdr_snapshot only when you need live pane detail.",
  };
}

export async function buildSessionStartContext({
  input,
  stream = createStreamTools(),
  herdr = createHerdrTools(),
  root = pluginRoot,
  now = Date.now(),
} = {}) {
  const promptNames = ["identity.md", "vocabulary.md", "judgment.md"];
  const promptFiles = await Promise.all(
    promptNames.map(async (name) => ({
      name,
      text: await readFile(join(root, "prompts", name), "utf8"),
    })),
  );
  const [bootstrap, snapshot, conversation] = await Promise.all([
    stream.bootstrap({ limit: 100 }),
    herdr
      .snapshot()
      .catch(() => ({ agents: [], panes: [], capturedAt: new Date(now).toISOString() })),
    loadConversationSection(stream, { now }),
  ]);
  const advisoryHandoff = bootstrap.latestHandoff?.payload?.note ?? null;
  const pendingRaw = bootstrap.pending ?? [];
  const pendingCompact = bootstrap.pendingCompact ?? compactPendingList(pendingRaw, { now });
  const joelPending = pendingRaw.filter((event) => isJoelInbound(event));
  const ackIds = bootstrap.ackRequiredJoel ?? joelPending.map((event) => event._id).filter(Boolean);
  const herdrSummary = summarizeHerdr(snapshot);

  const sections = [
    "# Agent Comms Gateway boot",
    "Replay is authoritative. The handoff note is advisory when present.",
    `Claude session: ${input?.session_id ?? "unknown"}`,
    `Session source: ${input?.source ?? "unknown"}`,
  ];

  // Joel pending goes first on purpose. Boot used to bury him under 30k of
  // herdr JSON, then the model opened every turn with stream_pending.
  if (ackIds.length > 0 || joelPending.length > 0) {
    const rows = (
      joelPending.length > 0
        ? joelPending
        : pendingRaw.filter((event) => ackIds.includes(event._id))
    ).map(
      (event) => `- ${event._id}: ${eventText(event).replace(/\s+/gu, " ").trim().slice(0, 160)}`,
    );
    sections.push(
      "\n## JOEL NEEDS ACK FIRST",
      "Unacked Joel inbound is waiting. Your FIRST tool call this turn is `stream_record_decision`:",
      "- verb `deliver`, `decisionSeq: 1`, short rewrite like `on it — checking X now.`",
      "- set `advanceAfter: false` so the cursor stays for the result (default is true)",
      "- do NOT call `stream_pending`, herdr, or shell first",
      "- one-line answers may skip the ack and deliver once (advanceAfter defaults true)",
      rows.join("\n") || ackIds.map((id) => `- ${id}`).join("\n"),
    );
  }

  sections.push(
    ...promptFiles.map((file) => `\n## prompts/${file.name}\n${file.text.trim()}`),
    `\n## Latest gateway.handoff (advisory)\n${advisoryHandoff ?? "No handoff note exists. Treat this as a crash/new-cycle boot and rely on replay."}`,
    `\n## Recent conversation with Joel (${conversation.windowLabel}, oldest first)\nThis is one continuous conversation you are already in — never greet Joel like a stranger, never re-explain what either of you already said.\n${conversation.lines.join("\n") || "(no exchanges on record yet)"}`,
    `\n## Authoritative pending replay (compact)\nFull event bodies are on the stream tools if you need them. These rows are enough to decide.\n${JSON.stringify(pendingCompact)}`,
    `\n## Herdr footprint (counts only)\n${JSON.stringify(herdrSummary)}`,
    "\nFor each external pending event, append exactly one validated decision receipt before advancing the cursor. Prefer one `stream_record_decision` call — advanceAfter defaults true on single-input terminals; only Joel acks pass false. Mechanically skip gateway-owned output with stream_advance_own_output.",
  );

  return sections.join("\n");
}

async function main() {
  const input = await readStdin();
  const additionalContext = await buildSessionStartContext({ input });
  process.stdout.write(
    `${JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    })}\n`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}

// Memory RAG — Qdrant semantic recall for agent sessions.
//
// Hooks:
//   before_agent_start  — on turn 2, query Qdrant with the user's first message
//                         and inject top-N relevant observations as a hidden message.
//                         Skips turn 1 (session-lifecycle briefing owns that).
//
// Tools:
//   recall              — LLM-callable tool: semantic search over memory observations.
//                         Calls `joelclaw recall` and returns structured results.
//
// Why turn 2: Turn 1 is the session briefing (MEMORY.md + daily log + slog).
// Turn 2 is the first real exchange — we know the topic, and the observations
// arrive before the LLM has generated its first response about the topic.
// This avoids bloating the briefing with speculative context.

import { execSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MAX_OBSERVATIONS = 5;
const MIN_SCORE = 0.30;
const MAX_INJECT_TOKENS = 500; // ~500 tokens ≈ 2000 chars cap for auto-inject
const MAX_INJECT_CHARS = 2000;

let turnCount = 0;
let firstUserMessage = "";
let hasInjectedRag = false;

/** Run `joelclaw recall` and parse results */
function recall(query: string, limit: number = MAX_OBSERVATIONS, minScore: number = MIN_SCORE): Array<{ score: number; observation: string; type: string; timestamp: string }> {
  try {
    const output = execSync(
      `joelclaw recall ${JSON.stringify(query)} --limit ${limit} --min-score ${minScore}`,
      { encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }
    );
    const parsed = JSON.parse(output);
    if (!parsed.ok || !parsed.result?.hits) return [];
    return parsed.result.hits;
  } catch {
    return [];
  }
}

/** Format observations for injection — compact, no bloat */
function formatObservations(hits: Array<{ score: number; observation: string }>): string {
  const lines: string[] = [];
  let chars = 0;

  for (const hit of hits) {
    const line = `- (${hit.score.toFixed(2)}) ${hit.observation}`;
    if (chars + line.length > MAX_INJECT_CHARS) break;
    lines.push(line);
    chars += line.length;
  }

  return lines.join("\n");
}

export default function memoryRag(pi: ExtensionAPI) {
  // ── Session reset ─────────────────────────────────────────────

  pi.on("session_start", async () => {
    turnCount = 0;
    firstUserMessage = "";
    hasInjectedRag = false;
  });

  // ── Auto-inject on turn 2 ────────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    turnCount++;

    // Capture first user message on turn 1
    if (turnCount === 1 && event.prompt) {
      firstUserMessage = typeof event.prompt === "string"
        ? event.prompt.slice(0, 500)
        : "";
      return {}; // session-lifecycle handles turn 1
    }

    // Inject RAG context on turn 2 only
    if (turnCount === 2 && !hasInjectedRag && firstUserMessage) {
      hasInjectedRag = true;

      const hits = recall(firstUserMessage);
      if (hits.length === 0) return {};

      const formatted = formatObservations(hits);
      if (!formatted) return {};

      return {
        message: {
          customType: "memory-rag",
          content: `## Relevant Memory (auto-retrieved from ${hits.length} observations)\n\n${formatted}\n\n_Searched Qdrant memory_observations. Use \`recall\` tool for more._`,
          display: false,
        },
      };
    }

    return {};
  });

  // ── recall tool — on-demand semantic search ──────────────────

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Search agent memory (Qdrant) for observations relevant to a query. Returns scored results from 520+ session observations. Use when you need context about past debugging, decisions, or system state that isn't in MEMORY.md.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural language search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 5)", default: 5 })),
      minScore: Type.Optional(Type.Number({ description: "Minimum relevance score 0-1 (default: 0.25)", default: 0.25 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const limit = params.limit ?? 5;
      const minScore = params.minScore ?? 0.25;

      const hits = recall(params.query, limit, minScore);

      if (hits.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              query: params.query,
              hits: [],
              count: 0,
              note: "No observations matched. Try broader terms or lower --min-score.",
            }, null, 2),
          }],
          details: null,
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            query: params.query,
            hits: hits.map(h => ({
              score: h.score,
              observation: h.observation,
              type: h.type,
              timestamp: h.timestamp,
            })),
            count: hits.length,
          }, null, 2),
        }],
        details: null,
      };
    },
  });
}

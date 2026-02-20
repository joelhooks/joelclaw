/**
 * Batch LLM review of memory proposals.
 *
 * Replaces the broken heuristic auto-promote path. Instead of appending raw
 * proposal text to MEMORY.md, this function sends a batch of proposals to
 * Sonnet for review against current MEMORY.md. Sonnet decides what to promote
 * (outputting clean formatted entries), what to reject, and what needs human
 * review. ~$0.01 per batch of 20 proposals.
 *
 * Triggered by:
 *   - memory/batch-review.requested (fired by proposal-triage when items queue up)
 *   - Cron: every 30 minutes (catch stragglers)
 *
 * ADR-0068: Memory Proposal Auto-Triage Pipeline
 */

import { rename } from "node:fs/promises";
import { join } from "node:path";
import Redis from "ioredis";
import { inngest } from "../../client";

const LLM_PENDING_KEY = "memory:review:llm-pending";
const REVIEW_MODEL = "claude-sonnet-4-20250514";

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const isTest = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
    retryStrategy: isTest ? () => null : undefined,
  });
  redisClient.on("error", () => {});
  return redisClient;
}

function getMemoryPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/Users/joel";
  return join(home, ".joelclaw", "workspace", "MEMORY.md");
}

interface PendingProposal {
  id: string;
  section: string;
  change: string;
  source?: string;
  timestamp?: string;
}

interface ReviewDecision {
  id: string;
  action: "promote" | "reject" | "needs-review";
  entry?: string; // Clean formatted bullet (promote only)
  section?: string; // Target section (promote only)
  reason: string;
}

function extractTextFromAiResponse(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const r = response as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    return (r.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n");
  }
  if (typeof r.text === "string") return r.text;
  return "";
}

const SYSTEM_PROMPT = `You are a memory curator for a personal AI system. You review proposed additions to a curated knowledge base (MEMORY.md).

MEMORY.md contains permanent facts, rules, patterns, and conventions organized into sections:
- Joel (preferences, personality)
- Miller Hooks (memorial)
- Conventions (naming, formatting standards)
- Hard Rules (never-violate constraints)
- System Architecture (infrastructure facts)
- Patterns (recurring solutions, anti-patterns)

Your job: For each proposal, decide whether to PROMOTE it (add to MEMORY.md), REJECT it, or FLAG it for human review.

REJECT when:
- It's instruction text ("Add after...", "Update existing...", "Remove duplicate...", "Replace...", "Consolidate...")
- It duplicates an existing entry (same fact, different wording)
- It's too specific/temporal (won't be true next month)
- It's a meta-instruction about what to do with the file

PROMOTE when:
- It's a genuine new fact, rule, pattern, or convention
- It's not already covered by an existing entry
- It will still be relevant next month
- Output a clean bullet point: **Bold Title** — description

FLAG when:
- You're genuinely unsure
- It might conflict with an existing entry
- It requires Joel's judgment (preferences, opinions)

Respond with valid JSON array only. No markdown fences, no explanation outside the JSON.`;

function buildUserPrompt(proposals: PendingProposal[], currentMemory: string): string {
  const proposalBlock = proposals
    .map((p, i) => `[${i + 1}] ID: ${p.id}\nSection: ${p.section}\nProposal: ${p.change}`)
    .join("\n\n");

  return `## Current MEMORY.md

${currentMemory}

---

## Proposals to Review (${proposals.length})

${proposalBlock}

---

For each proposal, respond with a JSON array of decisions:
[
  {
    "id": "<proposal-id>",
    "action": "promote" | "reject" | "needs-review",
    "entry": "**Bold Title** — clean description (promote only, no date prefix)",
    "section": "target section name (promote only)",
    "reason": "brief explanation"
  }
]`;
}

function parseDecisions(raw: string): ReviewDecision[] {
  const cleaned = raw.replace(/```json\n?/gu, "").replace(/```\n?/gu, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d: unknown): d is ReviewDecision =>
        typeof d === "object" &&
        d !== null &&
        typeof (d as ReviewDecision).id === "string" &&
        typeof (d as ReviewDecision).action === "string" &&
        ["promote", "reject", "needs-review"].includes((d as ReviewDecision).action)
    );
  } catch {
    console.error("[batch-review] failed to parse LLM response as JSON:", cleaned.slice(0, 200));
    return [];
  }
}

type MemorySection = "Joel" | "Miller Hooks" | "Conventions" | "Hard Rules" | "System Architecture" | "Patterns";

function normalizeSection(input: string | undefined): MemorySection {
  const value = input?.trim();
  if (value === "Joel") return value;
  if (value === "Miller Hooks") return value;
  if (value === "Conventions") return value;
  if (value === "Hard Rules") return value;
  if (value === "System Architecture") return value;
  if (value === "Patterns") return value;
  return "Patterns"; // Default for new observations
}

function appendBulletToSection(markdown: string, section: MemorySection, bullet: string): string {
  const lines = markdown.split(/\r?\n/u);
  const header = `## ${section}`;
  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex < 0) {
    // Section doesn't exist — append at end
    lines.push("", header, "", bullet);
    return lines.join("\n");
  }

  let sectionEnd = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (/^##\s+/u.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  let insertIndex = sectionEnd;
  while (insertIndex > headerIndex + 1 && (lines[insertIndex - 1]?.trim() ?? "") === "") {
    insertIndex -= 1;
  }

  lines.splice(insertIndex, 0, bullet);
  return lines.join("\n");
}

export const batchReview = inngest.createFunction(
  {
    id: "memory/batch-review",
    name: "Batch LLM Review of Memory Proposals",
    concurrency: { limit: 1 },
  },
  [
    { event: "memory/batch-review.requested" },
    { cron: "*/30 * * * *" },
  ],
  async ({ step }) => {
    // Load all pending proposals
    const proposals = await step.run("load-pending-proposals", async () => {
      const redis = getRedis();
      const ids = await redis.lrange(LLM_PENDING_KEY, 0, -1);
      if (ids.length === 0) return [];

      const results: PendingProposal[] = [];
      for (const id of ids) {
        const rawJson = await redis.get(`memory:proposal:${id}`);
        if (!rawJson) continue;
        try {
          const parsed = JSON.parse(rawJson) as Partial<PendingProposal>;
          if (parsed.change?.trim()) {
            results.push({
              id,
              section: parsed.section?.trim() ?? "Patterns",
              change: parsed.change.trim(),
              source: parsed.source,
              timestamp: parsed.timestamp,
            });
          }
        } catch {}
      }
      return results;
    });

    if (proposals.length === 0) {
      return { status: "noop", reason: "no proposals pending LLM review" };
    }

    // Read current MEMORY.md
    const currentMemory = await step.run("read-memory", async () => {
      const memoryPath = getMemoryPath();
      const file = Bun.file(memoryPath);
      if (!(await file.exists())) return "";
      return (await file.text()).trim();
    });

    // Send batch to Sonnet
    const aiResponse = await step.ai.infer("llm-review-proposals", {
      model: step.ai.models.anthropic({
        model: REVIEW_MODEL,
        defaultParameters: { max_tokens: 4096 },
      }),
      body: {
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(proposals, currentMemory) }],
      },
    });

    // Parse decisions
    const decisions = await step.run("parse-decisions", () => {
      const text = extractTextFromAiResponse(aiResponse);
      const parsed = parseDecisions(text);

      if (parsed.length === 0) {
        console.error("[batch-review] LLM returned 0 parseable decisions from", proposals.length, "proposals");
        // Don't process — leave proposals for next run
        return { decisions: [] as ReviewDecision[], unparsed: true };
      }

      console.log(`[batch-review] ${parsed.length} decisions: ${parsed.map(d => `${d.id}=${d.action}`).join(", ")}`);
      return { decisions: parsed, unparsed: false };
    });

    if (decisions.unparsed || decisions.decisions.length === 0) {
      return { status: "error", reason: "LLM response unparseable", proposalCount: proposals.length };
    }

    // Apply decisions
    const results = await step.run("apply-decisions", async () => {
      const redis = getRedis();
      const memoryPath = getMemoryPath();
      let memoryText = await Bun.file(memoryPath).text();
      let promoted = 0;
      let rejected = 0;
      let flagged = 0;

      for (const decision of decisions.decisions) {
        if (decision.action === "promote" && decision.entry) {
          // Find the proposal to get the date
          const proposal = proposals.find((p) => p.id === decision.id);
          const date = proposal?.timestamp?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
          const section = normalizeSection(decision.section);
          const bullet = `- (${date}) ${decision.entry}`;

          memoryText = appendBulletToSection(memoryText, section, bullet);
          promoted++;

          // Clean up Redis
          await redis.lrem(LLM_PENDING_KEY, 0, decision.id);
          await redis.del(`memory:proposal:${decision.id}`);
          await redis.del(`memory:review:proposal:${decision.id}`);
        } else if (decision.action === "reject") {
          rejected++;
          await redis.lrem(LLM_PENDING_KEY, 0, decision.id);
          await redis.del(`memory:proposal:${decision.id}`);
          await redis.del(`memory:review:proposal:${decision.id}`);
        } else {
          // needs-review — leave in queue, will get picked up by needs-review path
          flagged++;
        }
      }

      // Write updated MEMORY.md
      if (promoted > 0) {
        const tmpPath = `${memoryPath}.tmp`;
        await Bun.write(tmpPath, memoryText);
        await rename(tmpPath, memoryPath);
      }

      return { promoted, rejected, flagged, total: decisions.decisions.length };
    });

    console.log(`[batch-review] done: ${results.promoted} promoted, ${results.rejected} rejected, ${results.flagged} flagged`);

    return {
      status: "ok",
      ...results,
    };
  }
);

import { createHash } from "node:crypto";
import { NonRetriableError } from "inngest";
import { ensureKnowledge, type KnowledgeDoc } from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const SKIP_REASONS = [
  "routine-heartbeat",
  "duplicate-signal",
  "no-new-information",
] as const;

type SkipReason = (typeof SKIP_REASONS)[number];

type KnowledgeTurnWriteData = {
  source: string;
  agent: string;
  channel?: string;
  session?: string;
  turnId: string;
  turnNumber?: number;
  summary?: string;
  decision?: string;
  evidence?: string[];
  usefulnessTags?: string[];
  skipReason?: SkipReason;
  context?: {
    project?: string;
    loopId?: string;
    storyId?: string;
    runId?: string;
    toolNames?: string[];
    sourceMessageId?: string;
  };
  occurredAt?: string;
};

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeList(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (!normalized) continue;
    unique.add(normalized.slice(0, 140));
    if (unique.size >= max) break;
  }
  return Array.from(unique);
}

function normalizeSkipReason(value: unknown): SkipReason | undefined {
  if (typeof value !== "string") return undefined;
  return (SKIP_REASONS as readonly string[]).includes(value)
    ? (value as SkipReason)
    : undefined;
}

function toTurnId(payload: KnowledgeTurnWriteData): string {
  const raw = asTrimmed(payload.turnId);
  if (raw) return raw;
  const hash = createHash("sha1")
    .update([
      asTrimmed(payload.source),
      asTrimmed(payload.agent),
      asTrimmed(payload.session),
      String(payload.turnNumber ?? ""),
      asTrimmed(payload.summary),
      asTrimmed(payload.decision),
    ].join("|"))
    .digest("hex");
  return `turn-${hash.slice(0, 16)}`;
}

function buildContent(payload: {
  source: string;
  agent: string;
  channel?: string;
  session?: string;
  turnId: string;
  turnNumber?: number;
  summary: string;
  decision?: string;
  evidence: string[];
  occurredAt: string;
  context: KnowledgeTurnWriteData["context"];
}): string {
  const lines = [
    `source: ${payload.source}`,
    `agent: ${payload.agent}`,
    `channel: ${payload.channel ?? "internal"}`,
    `session: ${payload.session ?? "unknown"}`,
    `turn_id: ${payload.turnId}`,
    `turn_number: ${payload.turnNumber ?? "unknown"}`,
    `occurred_at: ${payload.occurredAt}`,
    "",
    "summary:",
    payload.summary,
  ];

  const decision = asTrimmed(payload.decision);
  if (decision) {
    lines.push("", "decision:", decision);
  }

  if (payload.evidence.length > 0) {
    lines.push("", "evidence:");
    for (const pointer of payload.evidence) {
      lines.push(`- ${pointer}`);
    }
  }

  if (payload.context && Object.keys(payload.context).length > 0) {
    lines.push("", "context:", JSON.stringify(payload.context));
  }

  return lines.join("\n");
}

function buildTags(payload: {
  source: string;
  agent: string;
  channel?: string;
  usefulnessTags: string[];
  context: KnowledgeTurnWriteData["context"];
}): string[] {
  const tags = new Set<string>(["turn-note"]);
  tags.add(`source:${payload.source.slice(0, 40)}`);
  tags.add(`agent:${payload.agent.slice(0, 40)}`);
  if (payload.channel) tags.add(`channel:${payload.channel.slice(0, 40)}`);
  for (const tag of payload.usefulnessTags) {
    tags.add(tag);
  }
  for (const toolName of payload.context?.toolNames ?? []) {
    tags.add(`tool:${toolName.slice(0, 40)}`);
  }
  return Array.from(tags).slice(0, 30);
}

export const knowledgeTurnWrite = inngest.createFunction(
  {
    id: "knowledge-turn-write",
    retries: 2,
  },
  { event: "knowledge/turn.write.requested" },
  async ({ event, step }) => {
    const payload = event.data as KnowledgeTurnWriteData;
    const startedAt = Date.now();
    const source = asTrimmed(payload.source) || "unknown";
    const agent = asTrimmed(payload.agent) || "unknown";
    const channel = asTrimmed(payload.channel) || undefined;
    const session = asTrimmed(payload.session) || undefined;
    const turnId = toTurnId(payload);
    const turnNumber = typeof payload.turnNumber === "number" && Number.isFinite(payload.turnNumber)
      ? Math.max(0, Math.floor(payload.turnNumber))
      : undefined;
    const summary = asTrimmed(payload.summary);
    const decision = asTrimmed(payload.decision) || undefined;
    const evidence = normalizeList(payload.evidence, 30);
    const usefulnessTags = normalizeList(payload.usefulnessTags, 20).map((tag) =>
      tag.toLowerCase().replace(/\s+/g, "-")
    );
    const skipReason = normalizeSkipReason(payload.skipReason);
    const context = payload.context ?? {};
    const occurredAt = asTrimmed(payload.occurredAt) || new Date().toISOString();

    await step.run("emit-turn-write-started", async () => {
      await emitOtelEvent({
        action: "knowledge.turn_write.started",
        component: "knowledge-turn-write",
        source,
        level: "info",
        success: true,
        metadata: {
          turn_id: turnId,
          turn_number: turnNumber,
          agent,
          channel: channel ?? "internal",
          has_skip_reason: Boolean(skipReason),
        },
      });
    });

    if (payload.skipReason && !skipReason) {
      const invalid = asTrimmed(payload.skipReason);
      await step.run("emit-turn-write-invalid-skip", async () => {
        await emitOtelEvent({
          action: "knowledge.turn_write.failed",
          component: "knowledge-turn-write",
          source,
          level: "error",
          success: false,
          error: "invalid_skip_reason",
          metadata: {
            turn_id: turnId,
            skip_reason: invalid,
          },
        });
      });
      throw new NonRetriableError(`Invalid skipReason: ${invalid}`);
    }

    if (skipReason) {
      await step.run("emit-turn-write-skipped", async () => {
        await emitOtelEvent({
          action: "knowledge.turn_write.skipped",
          component: "knowledge-turn-write",
          source,
          level: "info",
          success: true,
          duration_ms: Date.now() - startedAt,
          metadata: {
            turn_id: turnId,
            turn_number: turnNumber,
            agent,
            channel: channel ?? "internal",
            skip_reason: skipReason,
          },
        });
      });
      return {
        status: "skipped" as const,
        turnId,
        skipReason,
      };
    }

    if (!summary) {
      await step.run("emit-turn-write-missing-summary", async () => {
        await emitOtelEvent({
          action: "knowledge.turn_write.failed",
          component: "knowledge-turn-write",
          source,
          level: "error",
          success: false,
          error: "missing_summary_without_skip_reason",
          metadata: {
            turn_id: turnId,
            turn_number: turnNumber,
            agent,
            channel: channel ?? "internal",
          },
        });
      });
      throw new NonRetriableError(
        "knowledge/turn.write.requested requires summary unless skipReason is provided",
      );
    }

    const content = buildContent({
      source,
      agent,
      channel,
      session,
      turnId,
      turnNumber,
      summary,
      decision,
      evidence,
      occurredAt,
      context,
    });

    const doc: KnowledgeDoc = {
      id: `turn:${turnId}`,
      type: "turn_note",
      title: `Turn note: ${agent} ${channel ?? "internal"} #${turnNumber ?? "?"}`,
      content,
      source: `turn:${source}`,
      project: asTrimmed(context.project) || undefined,
      status: "captured",
      tags: buildTags({
        source,
        agent,
        channel,
        usefulnessTags,
        context,
      }),
    };

    try {
      const result = await step.run("upsert-turn-note", async () => ensureKnowledge(doc));
      if (result === "error") {
        throw new Error("ensureKnowledge returned error");
      }

      await step.run("emit-turn-write-completed", async () => {
        await emitOtelEvent({
          action: "knowledge.turn_write.completed",
          component: "knowledge-turn-write",
          source,
          level: "info",
          success: true,
          duration_ms: Date.now() - startedAt,
          metadata: {
            turn_id: turnId,
            turn_number: turnNumber,
            agent,
            channel: channel ?? "internal",
            write_result: result,
            tags: doc.tags ?? [],
          },
        });
      });

      return {
        status: "captured" as const,
        turnId,
        writeResult: result,
        documentId: doc.id,
      };
    } catch (error) {
      await step.run("emit-turn-write-failed", async () => {
        await emitOtelEvent({
          action: "knowledge.turn_write.failed",
          component: "knowledge-turn-write",
          source,
          level: "error",
          success: false,
          duration_ms: Date.now() - startedAt,
          error: String(error),
          metadata: {
            turn_id: turnId,
            turn_number: turnNumber,
            agent,
            channel: channel ?? "internal",
          },
        });
      });
      throw error;
    }
  },
);

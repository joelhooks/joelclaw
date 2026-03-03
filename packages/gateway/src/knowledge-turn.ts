import { createHash } from "node:crypto";
import { emitGatewayOtel } from "@joelclaw/telemetry";

const INNGEST_URL = process.env.INNGEST_URL ?? "http://localhost:8288";
const INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY ?? "";
const SUMMARY_MAX_CHARS = 700;

export const KNOWLEDGE_SKIP_REASONS = [
  "routine-heartbeat",
  "duplicate-signal",
  "no-new-information",
] as const;

export type KnowledgeSkipReason = (typeof KNOWLEDGE_SKIP_REASONS)[number];

type GatewayTurnKnowledgeInput = {
  source: string;
  sessionId: string;
  turnNumber: number;
  assistantText: string;
  toolCalls: string[];
  toolErrorCount: number;
  previousFingerprint?: string;
};

type GatewayTurnKnowledgePayload = {
  source: string;
  agent: string;
  channel?: string;
  session: string;
  turnId: string;
  turnNumber: number;
  summary?: string;
  decision?: string;
  evidence: string[];
  usefulnessTags: string[];
  skipReason?: KnowledgeSkipReason;
  context: {
    toolNames?: string[];
    sourceMessageId?: string;
  };
  occurredAt: string;
};

function asTrimmed(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function sourceToChannel(source: string): string | undefined {
  if (!source.includes(":")) return undefined;
  const [prefix] = source.split(":");
  return prefix?.trim() || undefined;
}

function summarizeAssistantText(text: string): string | undefined {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  if (compact.length <= SUMMARY_MAX_CHARS) return compact;
  return `${compact.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

function deriveDecision(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const firstSentence = summary.split(/(?<=[.!?])\s+/)[0]?.trim();
  if (!firstSentence) return undefined;
  return firstSentence.length <= 240
    ? firstSentence
    : `${firstSentence.slice(0, 239)}…`;
}

function buildFingerprint(input: {
  source: string;
  summary?: string;
  toolCalls: string[];
}): string {
  return createHash("sha1")
    .update([
      input.source,
      (input.summary ?? "").toLowerCase(),
      input.toolCalls.join(",").toLowerCase(),
    ].join("|"))
    .digest("hex");
}

function isRoutineHeartbeat(source: string, summary: string | undefined): boolean {
  const normalizedSource = source.toLowerCase();
  if (normalizedSource === "heartbeat") return true;
  if (!summary) return false;
  return summary.includes("HEARTBEAT_OK") && summary.length < 320;
}

function isNoNewInformation(summary: string | undefined, toolCalls: string[]): boolean {
  if (toolCalls.length > 0) return false;
  if (!summary) return true;
  return summary.length < 48;
}

export function buildGatewayTurnKnowledgeWrite(
  input: GatewayTurnKnowledgeInput,
): { payload: GatewayTurnKnowledgePayload; fingerprint: string } {
  const source = asTrimmed(input.source) || "gateway";
  const channel = sourceToChannel(source);
  const summary = summarizeAssistantText(input.assistantText);
  const fingerprint = buildFingerprint({
    source,
    summary,
    toolCalls: input.toolCalls,
  });

  let skipReason: KnowledgeSkipReason | undefined;
  if (isRoutineHeartbeat(source, summary)) {
    skipReason = "routine-heartbeat";
  } else if (input.previousFingerprint && input.previousFingerprint === fingerprint) {
    skipReason = "duplicate-signal";
  } else if (isNoNewInformation(summary, input.toolCalls)) {
    skipReason = "no-new-information";
  }

  const usefulnessTags = [
    "turn-note",
    "gateway",
    channel ? `channel:${channel}` : "channel:internal",
    input.toolCalls.length > 0 ? "tool-use" : "no-tool-use",
  ];
  const evidence = [
    `source:${source}`,
    `turn:${input.turnNumber}`,
    input.toolCalls.length > 0 ? `tools:${input.toolCalls.join("|")}` : "tools:none",
    input.toolErrorCount > 0 ? `tool_errors:${input.toolErrorCount}` : "tool_errors:0",
  ];

  const payload: GatewayTurnKnowledgePayload = {
    source: "gateway",
    agent: "gateway-daemon",
    channel,
    session: input.sessionId,
    turnId: `gateway:${input.sessionId}:${input.turnNumber}`,
    turnNumber: input.turnNumber,
    summary,
    decision: deriveDecision(summary),
    evidence,
    usefulnessTags,
    skipReason,
    context: {
      toolNames: input.toolCalls.length > 0 ? Array.from(new Set(input.toolCalls)) : undefined,
      sourceMessageId: source,
    },
    occurredAt: new Date().toISOString(),
  };

  return { payload, fingerprint };
}

export async function sendGatewayTurnKnowledgeWrite(
  payload: GatewayTurnKnowledgePayload,
): Promise<boolean> {
  void emitGatewayOtel({
    level: "info",
    component: "gateway.knowledge-turn",
    action: "knowledge.turn_write.eligible",
    success: true,
    metadata: {
      turnId: payload.turnId,
      turnNumber: payload.turnNumber,
      skipReason: payload.skipReason ?? null,
      channel: payload.channel ?? "internal",
    },
  });

  if (!INNGEST_EVENT_KEY) {
    void emitGatewayOtel({
      level: "error",
      component: "gateway.knowledge-turn",
      action: "knowledge.turn_write.failed",
      success: false,
      error: "missing_inngest_event_key",
      metadata: {
        turnId: payload.turnId,
      },
    });
    return false;
  }

  try {
    const response = await fetch(`${INNGEST_URL}/e/${INNGEST_EVENT_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "knowledge/turn.write.requested",
        id: `knowledge-turn-${payload.turnId}`,
        data: payload,
      }),
    });

    if (!response.ok) {
      void emitGatewayOtel({
        level: "error",
        component: "gateway.knowledge-turn",
        action: "knowledge.turn_write.failed",
        success: false,
        error: `http_${response.status}`,
        metadata: {
          turnId: payload.turnId,
          skipReason: payload.skipReason ?? null,
        },
      });
      return false;
    }

    void emitGatewayOtel({
      level: "debug",
      component: "gateway.knowledge-turn",
      action: "knowledge.turn_write.dispatched",
      success: true,
      metadata: {
        turnId: payload.turnId,
        skipReason: payload.skipReason ?? null,
      },
    });
    return true;
  } catch (error) {
    void emitGatewayOtel({
      level: "error",
      component: "gateway.knowledge-turn",
      action: "knowledge.turn_write.failed",
      success: false,
      error: String(error),
      metadata: {
        turnId: payload.turnId,
        skipReason: payload.skipReason ?? null,
      },
    });
    return false;
  }
}

export const __knowledgeTurnTestUtils = {
  summarizeAssistantText,
  deriveDecision,
  buildFingerprint,
};

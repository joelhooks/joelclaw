export type MessageType = "human" | "system";

const SYSTEM_HEADER_PATTERNS = [/🔔/u, /📋/u, /❌/u, /⚠️/u, /\bVIP\b/iu] as const;
const HEARTBEAT_PATTERN = /\bheartbeat\b/iu;
const BATCH_DIGEST_PATTERN = /\bbatch\s+digest\b/iu;
const GATEWAY_PROBE_PATTERN = /\bgateway\s+probe\b/iu;

export function classifyMessage(text: string): MessageType {
  const normalized = text.trim();

  if (!normalized) {
    return "system";
  }

  if (SYSTEM_HEADER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "system";
  }

  if (
    HEARTBEAT_PATTERN.test(normalized) ||
    BATCH_DIGEST_PATTERN.test(normalized) ||
    GATEWAY_PROBE_PATTERN.test(normalized)
  ) {
    return "system";
  }

  return "human";
}

export function isHumanMessage(text: string): boolean {
  return classifyMessage(text) === "human";
}

export function isSystemMessage(text: string): boolean {
  return classifyMessage(text) === "system";
}

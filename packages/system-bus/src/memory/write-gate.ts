export type WriteVerdict = "allow" | "hold" | "discard";

export const WRITE_GATE_VERSION = "v1";

export interface WriteGateResolution {
  observation: string;
  writeVerdict: WriteVerdict;
  writeConfidence: number;
  writeReason: string;
  writeGateVersion: string;
  writeGateFallback: boolean;
  hintedCategoryId?: string;
}

type ParsedAnnotation = {
  observation: string;
  verdict?: WriteVerdict;
  confidence?: number;
  reason?: string;
  category?: string;
  hasAnnotation: boolean;
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function normalizeVerdict(value: string | undefined): WriteVerdict | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "allow") return "allow";
  if (normalized === "hold") return "hold";
  if (normalized === "discard") return "discard";
  return undefined;
}

function asFiniteNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  if (Number.isFinite(parsed)) return parsed;
  return undefined;
}

function trimPriorityMarkers(text: string): string {
  return text
    .trim()
    .replace(/^[-*•]\s*/u, "")
    .replace(/^[🔴🟡🟢]\s*/u, "")
    .trim();
}

function parseKeyValues(meta: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /(\w+)=("[^"]*"|'[^']*'|\S+)/gu;
  for (const match of meta.matchAll(pattern)) {
    const key = (match[1] ?? "").trim().toLowerCase();
    const rawValue = (match[2] ?? "").trim();
    if (!key || !rawValue) continue;
    const value = rawValue.replace(/^['"]|['"]$/gu, "");
    result[key] = value;
  }
  return result;
}

function parseAnnotation(rawFact: string): ParsedAnnotation {
  const cleaned = trimPriorityMarkers(rawFact);
  const match = /^\[([^\]]+)\]\s*(.*)$/u.exec(cleaned);
  if (!match) {
    return {
      observation: cleaned,
      hasAnnotation: false,
    };
  }

  const meta = parseKeyValues(match[1] ?? "");
  const observation = (match[2] ?? "").trim();

  const verdict = normalizeVerdict(meta.gate ?? meta.verdict);
  const confidence = asFiniteNumber(meta.confidence ?? meta.conf);

  return {
    observation,
    verdict,
    confidence,
    reason: meta.reason,
    category: meta.category,
    hasAnnotation: true,
  };
}

function fallbackResolution(observation: string): WriteGateResolution {
  return {
    observation,
    writeVerdict: "allow",
    writeConfidence: 0.35,
    writeReason: "parse_fallback",
    writeGateVersion: WRITE_GATE_VERSION,
    writeGateFallback: true,
  };
}

export function resolveWriteGate(rawFact: string): WriteGateResolution {
  const parsed = parseAnnotation(rawFact);
  const observation = parsed.observation.trim();

  if (observation.length === 0) {
    return fallbackResolution(observation);
  }

  if (!parsed.hasAnnotation || !parsed.verdict) {
    return fallbackResolution(observation);
  }

  return {
    observation,
    writeVerdict: parsed.verdict,
    writeConfidence: clamp(parsed.confidence ?? 0.65, 0, 1),
    writeReason: (parsed.reason ?? "llm_classified").slice(0, 120),
    writeGateVersion: WRITE_GATE_VERSION,
    writeGateFallback: false,
    hintedCategoryId: parsed.category,
  };
}

export function allowsReflect(verdict: WriteVerdict): boolean {
  return verdict === "allow";
}

export function allowsDefaultRetrieval(
  verdict: WriteVerdict | undefined,
  options?: { includeHold?: boolean; includeDiscard?: boolean }
): boolean {
  if (!verdict || verdict === "allow") return true;
  if (verdict === "hold") return Boolean(options?.includeHold);
  if (verdict === "discard") return Boolean(options?.includeDiscard);
  return false;
}

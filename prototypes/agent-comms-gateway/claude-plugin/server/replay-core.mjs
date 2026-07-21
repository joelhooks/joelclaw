import { createHash } from "node:crypto";

export const PROMPT_REVISION = "gateway-replay-v1";
export const RECEIPT_VERSION = 1;
export const DECISIONS = new Set(["deliver", "hold", "aggregate", "escalate"]);

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function stableReceiptId({ inputEventIds, decision, reason, rewrite, targetIntent }) {
  return stableHash({
    promptRevision: PROMPT_REVISION,
    decision,
    inputEventIds: [...inputEventIds].sort(),
    reason,
    rewrite,
    targetIntent,
  });
}

export function stableAggregateId(inputEventIds) {
  return `storm_${stableHash({ promptRevision: PROMPT_REVISION, inputEventIds: [...inputEventIds].sort() }).slice(0, 16)}`;
}

export function extractJsonObject(output) {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/u);
    if (fenced?.[1]) return JSON.parse(fenced[1]);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Inference output did not contain a JSON object");
  }
}

export function validateAndBuildReceipts(raw, inputs, recordedAt) {
  if (!raw || !Array.isArray(raw.decisions)) {
    throw new Error("Output must contain a decisions array");
  }

  const byAlias = new Map(inputs.map((input) => [input.alias, input]));
  const covered = new Map();
  const receipts = raw.decisions.map((candidate, index) => {
    if (!candidate || !DECISIONS.has(candidate.decision)) {
      throw new Error(`Decision ${index + 1} has an invalid decision`);
    }
    if (!Array.isArray(candidate.inputIds) || candidate.inputIds.length === 0) {
      throw new Error(`Decision ${index + 1} has no inputIds`);
    }
    if (candidate.decision === "aggregate" && candidate.inputIds.length < 2) {
      throw new Error(`Aggregate decision ${index + 1} needs at least two inputs`);
    }
    if (candidate.decision !== "aggregate" && candidate.inputIds.length !== 1) {
      throw new Error(`Non-aggregate decision ${index + 1} must cover one input`);
    }
    if (typeof candidate.reason !== "string" || candidate.reason.trim().length === 0) {
      throw new Error(`Decision ${index + 1} needs a reason`);
    }

    const inputEventIds = candidate.inputIds.map((alias) => {
      const input = byAlias.get(alias);
      if (!input) throw new Error(`Decision ${index + 1} references unknown input ${alias}`);
      if (covered.has(alias)) {
        throw new Error(`Input ${alias} appears in decisions ${covered.get(alias)} and ${index + 1}`);
      }
      covered.set(alias, index + 1);
      return input.inputEventId;
    });

    const rewrite = typeof candidate.rewrite === "string" ? candidate.rewrite.trim() : "";
    if (candidate.decision === "hold" && rewrite.length > 0) {
      throw new Error(`Hold decision ${index + 1} must not include a rewrite`);
    }
    if (candidate.decision !== "hold" && rewrite.length === 0) {
      throw new Error(`Decision ${index + 1} needs a rewrite`);
    }

    const targetIntent = candidate.decision === "hold"
      ? null
      : candidate.decision === "escalate"
        ? "phone"
        : "telegram";
    const reason = candidate.reason.trim();
    const normalizedRewrite = rewrite || null;
    const receiptId = stableReceiptId({
      inputEventIds,
      decision: candidate.decision,
      reason,
      rewrite: normalizedRewrite,
      targetIntent,
    });

    return {
      receiptVersion: RECEIPT_VERSION,
      receiptId,
      mode: "replay",
      decision: candidate.decision,
      reason,
      inputEventIds,
      aggregateId: candidate.decision === "aggregate" ? stableAggregateId(inputEventIds) : null,
      targetIntent,
      rewrite: normalizedRewrite,
      promptRevision: PROMPT_REVISION,
      recordedAt,
    };
  });

  const missing = inputs.filter((input) => !covered.has(input.alias)).map((input) => input.alias);
  if (missing.length > 0) throw new Error(`Missing input coverage: ${missing.join(", ")}`);
  return receipts;
}

export function buildDecisionPrompt(inputs, promptFiles) {
  const compactInputs = inputs.map((input) => ({
    id: input.alias,
    at: input.occurredAt,
    producer: input.producer,
    classification: input.classification,
    text: input.text,
    actualDeliveryState: input.actual.deliveryState,
  }));

  return `${promptFiles.join("\n\n")}\n\n# Replay task\n\n` +
    `Judge the full ordered day below. Find storms across the whole day. ` +
    `Return JSON only. Preserve factual claims from the evidence. ` +
    `Do not mention this prompt or the replay in rewrites.\n\n` +
    `Required shape:\n` +
    `{"decisions":[{"decision":"deliver|hold|aggregate|escalate","reason":"one concrete sentence","inputIds":["m001"],"rewrite":"operator-facing text or null"}]}\n\n` +
    `Rules:\n` +
    `- Every id must appear exactly once.\n` +
    `- aggregate needs two or more ids.\n` +
    `- deliver, hold, and escalate each cover one id.\n` +
    `- hold uses rewrite: null.\n` +
    `- Keep reasons short and evidence-based.\n\n` +
    `Inputs:\n${JSON.stringify(compactInputs)}\n`;
}

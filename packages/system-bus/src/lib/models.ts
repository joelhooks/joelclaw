/**
 * Centralized model registry for joelclaw.
 * ADR-0078: Strict model enforcement to prevent cost blowouts.
 *
 * RULES:
 * 1. Never use dated snapshot IDs (e.g. claude-opus-4-20250514)
 * 2. Never use bare aliases (e.g. "claude-haiku") — always specify version
 * 3. All model references in Inngest functions MUST use these constants
 * 4. Update ALLOWED_MODELS when adding new models
 *
 * Pricing reference (Feb 2026):
 *   Opus 4.6:  $5 in / $15 out  (per MTok)
 *   Sonnet 4.6: $3 in / $15 out
 *   Haiku 4.5:  $1 in / $5 out
 *   ---
 *   Opus 4/4.1: $15 in / $75 out  ← NEVER USE, 5x more expensive
 */

/** Allowed model IDs — gateway-start.sh mirrors the Anthropic subset */
export const ALLOWED_MODELS = [
  // Anthropic
  "anthropic/claude-opus-4-6",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-haiku-4-5",
  // OpenAI (codex exec, agent loops, friction-fix)
  "gpt-5.3-codex",
  "o4-mini",
  "o3",
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

/** Semantic aliases for function authors */
export const MODEL = {
  /** Best reasoning. Use sparingly — $5/$15 per MTok. */
  OPUS: "anthropic/claude-opus-4-6" as const,
  /** General purpose. Good balance of cost/quality — $3/$15 per MTok. */
  SONNET: "anthropic/claude-sonnet-4-6" as const,
  /** Cheap and fast. Use for triage, formatting, simple extraction — $1/$5 per MTok. */
  HAIKU: "anthropic/claude-haiku-4-5" as const,
  /** Codex agent loops — OpenAI's coding model. */
  CODEX: "gpt-5.3-codex" as const,
  /** Fast OpenAI reasoning — friction fixes, quick tasks. */
  O4_MINI: "o4-mini" as const,
  /** OpenAI reasoning — heavier tasks. */
  O3: "o3" as const,
} satisfies Record<string, AllowedModel>;

/**
 * Validate a model string against the allowlist.
 * Throws if the model is not allowed — fail fast, don't burn money.
 */
export function assertAllowedModel(model: string): asserts model is AllowedModel {
  if (!ALLOWED_MODELS.includes(model as AllowedModel)) {
    throw new Error(
      `Model "${model}" is not in ALLOWED_MODELS. ` +
        `Allowed: ${ALLOWED_MODELS.join(", ")}. ` +
        `See ADR-0078 and packages/system-bus/src/lib/models.ts.`
    );
  }
}

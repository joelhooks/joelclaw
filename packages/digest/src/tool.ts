import { Effect } from "effect";
import type { DigestService } from "./service";
import type { DigestError, DigestInput, DigestResult } from "./types";

export const DIGEST_AGENT_TOOL = {
  name: "get_digest",
  label: "Get digest",
  description:
    "Assemble Joel's qualified signal digest when he asks what's up, what needs handling, or for the digest. Returns empty instead of sending filler.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      trigger: {
        type: "string",
        enum: ["on-demand", "scheduled"],
      },
    },
  },
} as const;

const NATURAL_LANGUAGE_DIGEST_PATTERNS = [
  /\bgive me (?:the|my) digest\b/iu,
  /\bwhat(?:'|’)s up\??\b/iu,
  /\banything (?:i|we) need to handle\??\b/iu,
  /\bshow me (?:the|my) digest\b/iu,
] as const;

/** Agent-intent hint only. Do not use this as a Telegram channel interceptor. */
export function matchesNaturalLanguageDigestRequest(text: string): boolean {
  return NATURAL_LANGUAGE_DIGEST_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

export function runDigestAgentTool(
  service: DigestService,
  input: DigestInput,
): Effect.Effect<DigestResult, DigestError> {
  return service.assemble(input);
}

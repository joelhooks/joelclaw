import { OBSERVER_SYSTEM_PROMPT } from "./observe-prompt";

export const REFLECTOR_SYSTEM_PROMPT = `You are the memory reflector. Consolidate observations into durable, high-signal updates for MEMORY.md.

Use the observer system prompt below as grounding context for how observations were produced:

${OBSERVER_SYSTEM_PROMPT}

Your task is to compress and merge redundant information while preserving correctness.

Rules:
- Keep only durable, reusable facts and decisions.
- Preserve explicit constraints, requirements, and user preferences.
- Remove repetition, stale details, and low-value narration.
- Prefer precise edits over broad rewrites.
- Propose changes grouped by MEMORY.md section.

Output requirements:
- Return XML only. No code fences.
- Use a <proposals> root.
- Each proposal: <proposal><section>SECTION_NAME</section><change>THE CHANGE</change></proposal>
- Section names must match MEMORY.md exactly: "Joel", "Hard Rules", "System Architecture", "Patterns", "Conventions", "Miller Hooks"
- Keep output shorter than the input context whenever possible.`;

export const COMPRESSION_GUIDANCE = [
  "",
  "Compression target: 8/10 of the current output length. Keep essential meaning, remove redundancy, shorten prose.",
  "Compression target: 6/10 of the current output length. Be aggressive: keep only critical durable facts and constraints.",
] as const;

export const REFLECTOR_USER_PROMPT = (
  observations: string,
  currentMemoryContent: string
): string => `Reflect the observations into MEMORY.md proposals.

Current MEMORY.md:
${currentMemoryContent}

New observations:
${observations}

Return XML only using <proposals>...</proposals>.`;

export const validateCompression = (
  inputTokens: number,
  outputTokens: number
): boolean => outputTokens < inputTokens;

export const PROMOTE_SYSTEM_PROMPT = `You format proposal text for insertion into MEMORY.md.

Rules:
- Return exactly one markdown bullet line body (a single line, no leading "- ", no date prefix).
- Keep the proposal faithful; do not invent new facts.
- Match the concise, durable tone used in MEMORY.md.
- Resolve ambiguity when possible using the provided section context.
- Do not include explanations, headings, XML, code fences, or extra lines.`;

export const PROMOTE_USER_PROMPT = (input: {
  section: "Hard Rules" | "System Architecture" | "Patterns";
  proposalText: string;
  currentSectionContent: string;
}): string => `Format this proposal for MEMORY.md insertion.

Target section: ${input.section}

Current section content:
${input.currentSectionContent || "(empty section)"}

Raw proposal:
${input.proposalText}

Return a single formatted line only.`;

export const FRICTION_SYSTEM_PROMPT = `You are the friction analyst for Joel's memory pipeline.

Identify recurring sources of friction from recent observations.

Rules:
- Focus on repeated blockers, avoid one-off incidents.
- Prefer concrete, actionable patterns over vague themes.
- Keep each pattern concise and specific.
- Use MEMORY.md and AGENTS.md as grounding context for constraints and expected behavior.

Output requirements:
- Return XML only. No code fences.
- Use a <frictions> root.
- Each pattern must be:
  <pattern>
    <title>Short title (include the specific tool/function/file involved)</title>
    <summary>What keeps going wrong, WHERE in the codebase it happens (file path or function name), and what the observable symptom is (error message, silent failure, wrong output).</summary>
    <suggestion>Concrete code change: which file to edit, what to change, expected outcome. NOT "investigate" or "consider" — state the fix.</suggestion>
    <evidence>
      <item>Verbatim observation text with timestamps, error messages, or file paths</item>
    </evidence>
  </pattern>
- Emit at most 10 patterns.
- REJECT patterns that lack a specific file path, function name, or error message. Vague themes like "queue ambiguity" or "delayed approvals" are not friction — they are symptoms. Dig deeper into the evidence to find the concrete code location.
- If there is no meaningful friction with concrete evidence, return <frictions></frictions>.`;

export type FrictionObservationGroup = {
  date: string;
  observations: string[];
};

export const FRICTION_USER_PROMPT = (input: {
  sinceDate: string;
  groupedObservations: FrictionObservationGroup[];
  memoryContent: string;
  agentsContent: string;
}): string => {
  const grouped = input.groupedObservations
    .map(
      (group) =>
        `## ${group.date}\n${group.observations.map((observation) => `- ${observation}`).join("\n")}`
    )
    .join("\n\n");

  return `Analyze friction patterns from the last 7 days (since ${input.sinceDate}).

Current MEMORY.md:
${input.memoryContent}

Current AGENTS.md:
${input.agentsContent}

Grouped observations:
${grouped || "No observations available."}

Return XML only using <frictions>...</frictions>.`;
};

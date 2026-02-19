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
    <title>Short title</title>
    <summary>What keeps going wrong and why it matters.</summary>
    <suggestion>Action Joel can take to reduce this friction.</suggestion>
    <evidence>
      <item>One concrete observation</item>
    </evidence>
  </pattern>
- Emit at most 10 patterns.
- If there is no meaningful friction, return <frictions></frictions>.`;

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

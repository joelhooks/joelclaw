export type RunbookPhase = "diagnose" | "fix" | "verify" | "rollback";

export type ResolvedRunbookPlan = {
  code: string;
  title: string;
  phase: RunbookPhase;
  commands: Array<{
    description: string;
    command: string;
    destructive: boolean;
    unresolved: boolean;
  }>;
};

export type RunbookEventContext = {
  id: string;
  component: string;
  action: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

function normalizeErrorCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

function toTitle(code: string): string {
  return code
    .split("_")
    .filter(Boolean)
    .map((segment) => segment[0] + segment.slice(1).toLowerCase())
    .join(" ");
}

export function buildRunbookRecoverCommand(plan: ResolvedRunbookPlan): string {
  return `joelclaw recover ${plan.code} --phase ${plan.phase}`;
}

export function resolveRunbookPlan(
  code: string,
  phase: RunbookPhase,
  context: Record<string, unknown> = {}
): ResolvedRunbookPlan | null {
  const normalizedCode = normalizeErrorCode(code);
  if (!normalizedCode) return null;

  const commands: ResolvedRunbookPlan["commands"] = [
    {
      description: "Run deterministic recovery command",
      command: `joelclaw recover ${normalizedCode} --phase ${phase}`,
      destructive: false,
      unresolved: false,
    },
  ];

  const runId = typeof context["run-id"] === "string"
    ? context["run-id"].trim()
    : "";
  if (runId.length > 0) {
    commands.push({
      description: "Inspect failed run details",
      command: `joelclaw run ${runId}`,
      destructive: false,
      unresolved: false,
    });
  }

  return {
    code: normalizedCode,
    title: toTitle(normalizedCode),
    phase,
    commands,
  };
}

function runbookContextForEvent(event: RunbookEventContext): Record<string, unknown> {
  const runId = typeof event.metadata?.runId === "string" ? event.metadata.runId : undefined;
  return {
    "run-id": runId,
    query: `${event.component}.${event.action}`,
    id: event.id,
  };
}

export function resolveRunbookPlanForEvent(
  event: RunbookEventContext,
  phase: RunbookPhase,
  preferredCode?: string
): ResolvedRunbookPlan | null {
  const candidates = new Set<string>();

  if (preferredCode && preferredCode.trim().length > 0) {
    candidates.add(normalizeErrorCode(preferredCode));
  }

  if (event.error && event.error.trim().length > 0) {
    candidates.add(normalizeErrorCode(event.error));
  }

  if (candidates.size === 0) {
    return null;
  }

  const context = runbookContextForEvent(event);
  for (const candidate of candidates) {
    const plan = resolveRunbookPlan(candidate, phase, context);
    if (plan) return plan;
  }

  return null;
}

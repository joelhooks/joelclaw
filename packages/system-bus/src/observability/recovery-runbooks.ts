import { normalizeErrorCode } from "../../../cli/src/error-codes";
import {
  getRunbook,
  type RunbookPhase,
  resolveRunbookPhase,
} from "../../../cli/src/runbooks";

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

export function buildRunbookRecoverCommand(plan: ResolvedRunbookPlan): string {
  return `joelclaw recover ${plan.code} --phase ${plan.phase}`;
}

export function resolveRunbookPlan(
  code: string,
  phase: RunbookPhase,
  context: Record<string, unknown> = {}
): ResolvedRunbookPlan | null {
  const normalizedCode = normalizeErrorCode(code);
  const runbook = getRunbook(normalizedCode);
  if (!runbook) return null;

  const commands = resolveRunbookPhase(runbook, phase, context).map((entry) => ({
    description: entry.description,
    command: entry.resolvedCommand,
    destructive: entry.destructive ?? false,
    unresolved: /<[^>]+>/.test(entry.resolvedCommand),
  }));

  return {
    code: runbook.code,
    title: runbook.title,
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

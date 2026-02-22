import {
  getRunbook,
  resolveRunbookPhase,
  type RunbookPhase,
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

export function resolveRunbookPlan(
  code: string,
  phase: RunbookPhase,
  context: Record<string, unknown> = {}
): ResolvedRunbookPlan | null {
  const runbook = getRunbook(code);
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

import { resolve } from "node:path";

export const CHANNEL_AUTONOMOUS_TOOL_BUDGET = 2;
export const BACKGROUND_AUTONOMOUS_TOOL_BUDGET = 4;
export const DEPLOY_VERIFICATION_DELAY_MS = 75_000;

const ROOT_CONFIG_FILES = new Set(["turbo.json", "package.json", "pnpm-lock.yaml"]);

export type GuardrailSourceKind = "channel" | "internal" | "unknown";

export type DeployVerificationPlan = {
  repoPath: string;
  changedFiles: string[];
};

export function extractBashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isGitPushCommand(command: string): boolean {
  return /(^|[;&]\s*|&&\s*)git(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+push\b/.test(command);
}

function stripWrappingQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return resolve(homeDir, value.slice(2));
  return resolve(value);
}

export function extractRepoPathFromCommand(command: string, homeDir: string): string | undefined {
  const gitCMatch = command.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)\s+push\b/);
  if (gitCMatch?.[1]) {
    return expandHome(stripWrappingQuotes(gitCMatch[1]), homeDir);
  }

  const cdMatch = command.match(/(?:^|&&\s*|;\s*)cd\s+("[^"]+"|'[^']+'|[^;&]+?)\s*(?:&&|;)/);
  if (cdMatch?.[1]) {
    return expandHome(stripWrappingQuotes(cdMatch[1].trim()), homeDir);
  }

  return undefined;
}

export function shouldVerifyDeploy(changedFiles: readonly string[]): boolean {
  return changedFiles.some((file) => file.startsWith("apps/web/") || ROOT_CONFIG_FILES.has(file));
}

export function buildDeployVerificationPlan(
  repoPath: string | undefined,
  changedFiles: readonly string[],
): DeployVerificationPlan | undefined {
  if (!repoPath) return undefined;
  if (!shouldVerifyDeploy(changedFiles)) return undefined;
  return {
    repoPath,
    changedFiles: [...changedFiles],
  };
}

export function guardrailToolBudgetForSource(sourceKind: GuardrailSourceKind): number {
  return sourceKind === "channel" ? CHANNEL_AUTONOMOUS_TOOL_BUDGET : BACKGROUND_AUTONOMOUS_TOOL_BUDGET;
}

export function shouldTriggerToolBudgetCheckpoint(toolCalls: number, sourceKind: GuardrailSourceKind): boolean {
  return toolCalls > guardrailToolBudgetForSource(sourceKind);
}

export function summarizeToolNames(toolNames: readonly string[], max = 4): string {
  if (toolNames.length === 0) return "none";
  const visible = toolNames.slice(0, max);
  const extra = toolNames.length - visible.length;
  return extra > 0 ? `${visible.join(" → ")} (+${extra})` : visible.join(" → ");
}

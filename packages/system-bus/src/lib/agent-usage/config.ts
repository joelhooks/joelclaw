import { homedir } from "node:os";
import { join } from "node:path";

export const AGENT_RUNTIME_NAMES = ["pi", "claude", "codex", "cursor"] as const;

export type AgentRuntimeName = (typeof AGENT_RUNTIME_NAMES)[number];

export type AgentUsageCaptureConfig = {
  agents: AgentRuntimeName[];
  maxFilesPerScan: number;
  maxEventsPerScan: number;
  statePath: string;
  lookbackHours: number;
};

function isRuntimeName(value: string): value is AgentRuntimeName {
  return (AGENT_RUNTIME_NAMES as readonly string[]).includes(value);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseAgents(value: string | undefined): AgentRuntimeName[] {
  if (value == null || value.trim().length === 0) return [...AGENT_RUNTIME_NAMES];
  const parsed = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(isRuntimeName);
  const unique = [...new Set(parsed)];
  return unique.length > 0 ? unique : [...AGENT_RUNTIME_NAMES];
}

export function resolveAgentUsageCaptureConfig(env: NodeJS.ProcessEnv = process.env): AgentUsageCaptureConfig {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return {
    agents: parseAgents(env.JOELCLAW_USAGE_CAPTURE_AGENTS),
    maxFilesPerScan: parsePositiveInt(env.JOELCLAW_USAGE_CAPTURE_MAX_FILES, 400),
    maxEventsPerScan: parsePositiveInt(env.JOELCLAW_USAGE_CAPTURE_MAX_EVENTS, 5000),
    statePath: env.JOELCLAW_USAGE_CAPTURE_STATE_PATH?.trim() || join(home, ".joelclaw", "agent-usage-state.json"),
    lookbackHours: parsePositiveInt(env.JOELCLAW_USAGE_CAPTURE_LOOKBACK_HOURS, 24),
  };
}

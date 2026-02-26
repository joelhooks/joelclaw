import type { InferenceTask } from "./schema";

export type BuiltinTool = "read" | "bash" | "edit" | "write";

export type AgentProfile = {
  name: string;
  description?: string;
  tags: string[];
  defaults: Partial<{
    model: string;
    task: InferenceTask;
    system: string;
    json: boolean;
    timeout: number;
    noTools: boolean;
  }>;
  builtinTools?: BuiltinTool[];
  extensions?: string[];
};

export const AGENT_PROFILES: Record<string, AgentProfile> = {
  classifier: {
    name: "classifier",
    description: "Fast classification and triage helper",
    tags: ["classification"],
    defaults: {
      task: "classification",
      model: "anthropic/claude-haiku-4-5",
      json: true,
      noTools: true,
      timeout: 45_000,
    },
  },
  reflector: {
    name: "reflector",
    description: "Observation reflection and proposal synthesis",
    tags: ["reflection"],
    defaults: {
      task: "summary",
      model: "anthropic/claude-haiku-4-5",
      noTools: true,
    },
  },
  triage: {
    name: "triage",
    description: "Task triage with cautious JSON output",
    tags: ["triage", "classification"],
    defaults: {
      task: "classification",
      model: "anthropic/claude-sonnet-4-6",
      json: true,
      noTools: true,
      timeout: 120_000,
    },
  },
};

export function resolveProfile(name: string): AgentProfile | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return undefined;
  return AGENT_PROFILES[normalized];
}

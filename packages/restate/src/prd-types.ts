/**
 * Re-export canonical types from @joelclaw/agent-execution.
 * 
 * Restate workflows consume the shared contract package to ensure
 * compatibility with system-bus and k8s Job launcher.
 */

export type {
  AgentIdentity,
  ExecutionArtifacts,
  ExecutionState,
  PrdExecutionPlan,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxProfile,
  StoryPlan as PrdStoryPlan,
  WavePlan as PrdWavePlan,
} from "@joelclaw/agent-execution";

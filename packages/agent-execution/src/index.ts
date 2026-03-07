/**
 * @joelclaw/agent-execution
 * 
 * Canonical contract package for sandboxed story execution.
 * Shared between Restate workflows and system-bus Inngest functions.
 */

// Export artifact generation utilities
export type {
  GeneratePatchOptions,
} from "./artifacts.js";
export {
  ArtifactGenerationError,
  generatePatchArtifact,
  readArtifactBundle,
  writeArtifactBundle,
} from "./artifacts.js";

export type {
  JobResourceLimits,
  JobSpecOptions,
  RuntimeImageContract,
} from "./job-spec.js";
// Export k8s Job spec builder and utilities
export {
  DEFAULT_ACTIVE_DEADLINE_SECONDS,
  DEFAULT_JOB_RESOURCES,
  DEFAULT_TTL_SECONDS,
  generateJobDeletion,
  generateJobName,
  generateJobSpec,
  isJobForRequest,
} from "./job-spec.js";

// Export repo materialization utilities
export type {
  MaterializeRepoOptions,
  MaterializeRepoResult,
} from "./repo.js";
export {
  getTouchedFiles,
  materializeRepo,
  RepoMaterializationError,
  verifyRepoState,
} from "./repo.js";

// Export all schema validators and constants
export {
  EXECUTION_STATES,
  isAgentIdentity,
  isExecutionArtifacts,
  isExecutionState,
  isPrdExecutionPlan,
  isSandboxExecutionRequest,
  isSandboxExecutionResult,
  isSandboxProfile,
  isStoryPlan,
  isWavePlan,
  SANDBOX_PROFILES,
} from "./schema.js";
// Export all types
export type {
  AgentIdentity,
  ExecutionArtifacts,
  ExecutionState,
  InboxResult,
  PrdExecutionPlan,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxProfile,
  StoryPlan,
  WavePlan,
} from "./types.js";

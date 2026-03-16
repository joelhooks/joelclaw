/**
 * @joelclaw/agent-execution
 *
 * Canonical contract package for sandboxed story execution.
 * Shared between Restate workflows and system-bus Inngest functions.
 */

export type { GeneratePatchOptions } from "./artifacts.js";
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
export {
  DEFAULT_ACTIVE_DEADLINE_SECONDS,
  DEFAULT_JOB_RESOURCES,
  DEFAULT_TTL_SECONDS,
  generateJobDeletion,
  generateJobName,
  generateJobSpec,
  isJobForRequest,
} from "./job-spec.js";

export type {
  LaunchSandboxJobOptions,
  SandboxJobLaunchResult,
  SandboxJobPhase,
  SandboxJobStatus,
} from "./k8s.js";
export {
  cancelSandboxJob,
  extractSandboxResultFromLogs,
  launchSandboxJob,
  RESULT_END_MARKER,
  RESULT_START_MARKER,
  readSandboxJobLogs,
  readSandboxJobPodName,
  readSandboxJobStatus,
} from "./k8s.js";

export type {
  CleanupLocalSandboxesOptions,
  CleanupLocalSandboxesResult,
  GenerateLocalSandboxIdentityInput,
  LocalSandboxDevcontainerStrategy,
  LocalSandboxIdentity,
  LocalSandboxMode,
  LocalSandboxPaths,
  LocalSandboxRegistry,
  LocalSandboxRegistryEntry,
  LocalSandboxRetentionDecision,
  LocalSandboxRetentionPolicy,
  LocalSandboxTeardownState,
  MaterializedLocalSandboxDevcontainer,
  MaterializedSandboxEnv,
  MaterializeLocalSandboxDevcontainerOptions,
  MaterializeLocalSandboxEnvOptions,
  PruneExpiredLocalSandboxesOptions,
  PruneExpiredLocalSandboxesResult,
  ReconcileLocalSandboxRegistryOptions,
  ReconcileLocalSandboxRegistryResult,
  ResolveLocalSandboxPathsOptions,
  ResolveLocalSandboxRetentionOptions,
} from "./local.js";
export {
  cleanupLocalSandboxes,
  defaultLocalSandboxRegistryPath,
  defaultLocalSandboxRoot,
  emptyLocalSandboxRegistry,
  ensureLocalSandboxLayout,
  generateLocalSandboxIdentity,
  isLocalSandboxDevcontainerStrategy,
  isLocalSandboxEntryExpired,
  isLocalSandboxIdentity,
  isLocalSandboxMode,
  isLocalSandboxRegistryEntry,
  LOCAL_SANDBOX_DEVCONTAINER_STRATEGIES,
  LOCAL_SANDBOX_MODES,
  LOCAL_SANDBOX_RETENTION_HOURS,
  materializeLocalSandboxDevcontainer,
  materializeLocalSandboxEnv,
  pruneExpiredLocalSandboxes,
  readLocalSandboxRegistry,
  reconcileLocalSandboxRegistry,
  removeLocalSandboxLayout,
  removeLocalSandboxRegistryEntry,
  resolveLocalSandboxPaths,
  resolveLocalSandboxRetention,
  upsertLocalSandboxRegistryEntry,
  writeLocalSandboxRegistry,
} from "./local.js";

export type {
  FirecrackerRequest,
  MicroVmConfig,
  MicroVmExecResult,
  MicroVmInstance,
  ValidatedMicroVmConfig,
} from "./microvm.js";
export {
  bootMicroVm,
  buildBootMicroVmRequests,
  buildRestoreMicroVmRequests,
  DEFAULT_MICROVM_API_TIMEOUT_MS,
  DEFAULT_MICROVM_BOOT_ARGS,
  DEFAULT_MICROVM_EXEC_TIMEOUT_MS,
  DEFAULT_MICROVM_MEM_SIZE_MIB,
  DEFAULT_MICROVM_ROOT,
  DEFAULT_MICROVM_VCPU_COUNT,
  defaultMicroVmRoot,
  destroyMicroVm,
  execInMicroVm,
  MICROVM_POLL_INTERVAL_MS,
  MICROVM_PROTOCOL_DIRNAME,
  MicroVmError,
  pauseMicroVm,
  resolveMicroVmSnapshotPaths,
  resolveMicroVmSocketPath,
  restoreMicroVm,
  snapshotMicroVm,
  validateMicroVmConfig,
} from "./microvm.js";

export type { MaterializeRepoOptions, MaterializeRepoResult } from "./repo.js";
export {
  getTouchedFiles,
  materializeRepo,
  RepoMaterializationError,
  verifyRepoState,
} from "./repo.js";

export {
  EXECUTION_MODES,
  EXECUTION_STATES,
  isAgentIdentity,
  isExecutionArtifacts,
  isExecutionMode,
  isExecutionState,
  isPrdExecutionPlan,
  isSandboxBackend,
  isSandboxExecutionRequest,
  isSandboxExecutionResult,
  isSandboxJobRef,
  isSandboxProfile,
  isStoryPlan,
  isWavePlan,
  SANDBOX_BACKENDS,
  SANDBOX_PROFILES,
} from "./schema.js";
export type {
  AgentIdentity,
  ExecutionArtifacts,
  ExecutionMode,
  ExecutionState,
  InboxResult,
  LocalSandboxRuntimeInfo,
  PrdExecutionPlan,
  SandboxBackend,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxJobRef,
  SandboxProfile,
  StoryPlan,
  WavePlan,
} from "./types.js";

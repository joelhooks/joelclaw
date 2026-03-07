/**
 * Runtime validation schemas for sandbox execution contracts.
 * 
 * Provides type guards and validation functions for the canonical types.
 */

import type {
  AgentIdentity,
  ExecutionArtifacts,
  ExecutionMode,
  ExecutionState,
  PrdExecutionPlan,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxProfile,
  StoryPlan,
  WavePlan,
} from "./types.js";

/**
 * Valid execution modes.
 */
export const EXECUTION_MODES: readonly ExecutionMode[] = [
  "host",
  "sandbox",
] as const;

/**
 * Valid sandbox profiles.
 */
export const SANDBOX_PROFILES: readonly SandboxProfile[] = [
  "workspace-write",
  "danger-full-access",
] as const;

/**
 * Valid execution states.
 */
export const EXECUTION_STATES: readonly ExecutionState[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

/**
 * Type guard for ExecutionMode.
 */
export function isExecutionMode(value: unknown): value is ExecutionMode {
  return (
    typeof value === "string" &&
    (EXECUTION_MODES as readonly string[]).includes(value)
  );
}

/**
 * Type guard for SandboxProfile.
 */
export function isSandboxProfile(value: unknown): value is SandboxProfile {
  return (
    typeof value === "string" &&
    (SANDBOX_PROFILES as readonly string[]).includes(value)
  );
}

/**
 * Type guard for ExecutionState.
 */
export function isExecutionState(value: unknown): value is ExecutionState {
  return (
    typeof value === "string" &&
    (EXECUTION_STATES as readonly string[]).includes(value)
  );
}

/**
 * Validate AgentIdentity.
 */
export function isAgentIdentity(value: unknown): value is AgentIdentity {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  
  if (typeof obj.name !== "string" || obj.name.trim().length === 0) {
    return false;
  }
  
  if (obj.variant !== undefined && typeof obj.variant !== "string") {
    return false;
  }
  
  if (obj.model !== undefined && typeof obj.model !== "string") {
    return false;
  }
  
  if (obj.program !== undefined && typeof obj.program !== "string") {
    return false;
  }
  
  return true;
}

/**
 * Validate SandboxExecutionRequest.
 */
export function isSandboxExecutionRequest(
  value: unknown
): value is SandboxExecutionRequest {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  // Required fields
  if (typeof obj.workflowId !== "string" || obj.workflowId.trim().length === 0) {
    return false;
  }
  if (typeof obj.requestId !== "string" || obj.requestId.trim().length === 0) {
    return false;
  }
  if (typeof obj.storyId !== "string" || obj.storyId.trim().length === 0) {
    return false;
  }
  if (typeof obj.task !== "string" || obj.task.trim().length === 0) {
    return false;
  }
  if (!isAgentIdentity(obj.agent)) {
    return false;
  }
  if (!isSandboxProfile(obj.sandbox)) {
    return false;
  }
  if (typeof obj.baseSha !== "string" || obj.baseSha.trim().length === 0) {
    return false;
  }

  // Optional fields
  if (obj.cwd !== undefined && typeof obj.cwd !== "string") {
    return false;
  }
  if (obj.timeoutSeconds !== undefined && typeof obj.timeoutSeconds !== "number") {
    return false;
  }
  if (obj.verificationCommands !== undefined) {
    if (!Array.isArray(obj.verificationCommands)) return false;
    if (!obj.verificationCommands.every((cmd) => typeof cmd === "string")) {
      return false;
    }
  }
  if (obj.sessionId !== undefined && typeof obj.sessionId !== "string") {
    return false;
  }

  return true;
}

/**
 * Validate ExecutionArtifacts.
 */
export function isExecutionArtifacts(value: unknown): value is ExecutionArtifacts {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  if (typeof obj.headSha !== "string" || obj.headSha.trim().length === 0) {
    return false;
  }
  
  if (!Array.isArray(obj.touchedFiles)) return false;
  if (!obj.touchedFiles.every((f) => typeof f === "string")) {
    return false;
  }

  if (obj.patch !== undefined && typeof obj.patch !== "string") {
    return false;
  }

  if (obj.verification !== undefined) {
    const v = obj.verification as Record<string, unknown>;
    if (!Array.isArray(v.commands) || !v.commands.every((c) => typeof c === "string")) {
      return false;
    }
    if (typeof v.success !== "boolean") {
      return false;
    }
    if (v.output !== undefined && typeof v.output !== "string") {
      return false;
    }
  }

  return true;
}

/**
 * Validate SandboxExecutionResult.
 */
export function isSandboxExecutionResult(
  value: unknown
): value is SandboxExecutionResult {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  if (typeof obj.requestId !== "string" || obj.requestId.trim().length === 0) {
    return false;
  }
  if (!isExecutionState(obj.state)) {
    return false;
  }
  if (typeof obj.startedAt !== "string") {
    return false;
  }

  if (obj.completedAt !== undefined && typeof obj.completedAt !== "string") {
    return false;
  }
  if (obj.durationMs !== undefined && typeof obj.durationMs !== "number") {
    return false;
  }
  if (obj.artifacts !== undefined && !isExecutionArtifacts(obj.artifacts)) {
    return false;
  }
  if (obj.error !== undefined && typeof obj.error !== "string") {
    return false;
  }
  if (obj.output !== undefined && typeof obj.output !== "string") {
    return false;
  }

  return true;
}

/**
 * Validate StoryPlan.
 */
export function isStoryPlan(value: unknown): value is StoryPlan {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  if (typeof obj.id !== "string" || obj.id.trim().length === 0) return false;
  if (typeof obj.title !== "string" || obj.title.trim().length === 0) return false;
  if (typeof obj.summary !== "string") return false;
  if (typeof obj.prompt !== "string" || obj.prompt.trim().length === 0) return false;

  if (obj.files !== undefined) {
    if (!Array.isArray(obj.files)) return false;
    if (!obj.files.every((f) => typeof f === "string")) return false;
  }
  if (obj.dependsOn !== undefined) {
    if (!Array.isArray(obj.dependsOn)) return false;
    if (!obj.dependsOn.every((d) => typeof d === "string")) return false;
  }
  if (obj.timeoutSeconds !== undefined && typeof obj.timeoutSeconds !== "number") {
    return false;
  }
  if (obj.sandbox !== undefined && !isSandboxProfile(obj.sandbox)) {
    return false;
  }

  return true;
}

/**
 * Validate WavePlan.
 */
export function isWavePlan(value: unknown): value is WavePlan {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  if (typeof obj.id !== "string" || obj.id.trim().length === 0) return false;
  if (!Array.isArray(obj.stories)) return false;
  if (!obj.stories.every(isStoryPlan)) return false;

  return true;
}

/**
 * Validate PrdExecutionPlan.
 */
export function isPrdExecutionPlan(value: unknown): value is PrdExecutionPlan {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  if (typeof obj.summary !== "string") return false;
  if (!Array.isArray(obj.waves)) return false;
  if (!obj.waves.every(isWavePlan)) return false;

  return true;
}

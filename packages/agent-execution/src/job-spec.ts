/**
 * Kubernetes Job specification builder for cold sandboxed story execution.
 * 
 * Generates deterministic Job manifests for isolated story runs with:
 * - Deterministic naming keyed by requestId
 * - Runtime image contract enforcement
 * - Resource limits and TTL cleanup
 * - Cancellation support at the Job level
 */

import type { SandboxExecutionRequest } from "./types.js";

/**
 * Runtime image contract for sandboxed execution.
 * 
 * All agent runner images MUST provide:
 * - Git (for checkout and diff generation)
 * - Bun runtime
 * - Required agent tooling (codex, pi, etc.)
 * - Workspace directory at /workspace
 * - Ability to read env vars for config
 */
export interface RuntimeImageContract {
  /** Container image reference (e.g., ghcr.io/owner/agent-runner:tag) */
  image: string;
  /** Image pull policy */
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
}

/**
 * Resource limits for Job execution.
 */
export interface JobResourceLimits {
  /** CPU request (e.g., "500m", "1") */
  cpuRequest?: string;
  /** CPU limit (e.g., "2", "4") */
  cpuLimit?: string;
  /** Memory request (e.g., "512Mi", "1Gi") */
  memoryRequest?: string;
  /** Memory limit (e.g., "2Gi", "4Gi") */
  memoryLimit?: string;
}

/**
 * Options for Job spec generation.
 */
export interface JobSpecOptions {
  /** Runtime image contract */
  runtime: RuntimeImageContract;
  /** k8s namespace */
  namespace?: string;
  /** Resource limits */
  resources?: JobResourceLimits;
  /** TTL seconds after completion (k8s will delete the Job) */
  ttlSecondsAfterFinished?: number;
  /** Backoff limit for retries (0 = no retries) */
  backoffLimit?: number;
  /** Active deadline seconds (timeout for the entire Job) */
  activeDeadlineSeconds?: number;
  /** Service account name */
  serviceAccountName?: string;
  /** Additional env vars to inject */
  env?: Record<string, string>;
  /** Image pull secret name */
  imagePullSecret?: string;
}

/**
 * Default resource limits for sandbox Jobs.
 */
export const DEFAULT_JOB_RESOURCES: JobResourceLimits = {
  cpuRequest: "500m",
  cpuLimit: "2",
  memoryRequest: "1Gi",
  memoryLimit: "4Gi",
};

/**
 * Default TTL for completed Jobs (5 minutes).
 * After this, k8s garbage collects the Job and Pod.
 */
export const DEFAULT_TTL_SECONDS = 300;

/**
 * Default active deadline (1 hour).
 * Jobs that run longer than this are terminated.
 */
export const DEFAULT_ACTIVE_DEADLINE_SECONDS = 3600;

/**
 * Generate a deterministic Job name from a requestId.
 * 
 * k8s Job names must be DNS-1123 compliant:
 * - lowercase alphanumeric + hyphens
 * - max 63 characters
 * - start/end with alphanumeric
 * 
 * @param requestId - Unique request identifier
 * @returns DNS-1123 compliant Job name
 */
export function generateJobName(requestId: string): string {
  // Sanitize: lowercase, replace non-alphanumeric with hyphens, dedupe hyphens
  const sanitized = requestId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  
  // Truncate to 63 chars (k8s limit)
  const truncated = sanitized.slice(0, 63);
  
  // Ensure it ends with alphanumeric (not hyphen)
  return truncated.replace(/-+$/, "");
}

/**
 * Build environment variables for the Job container.
 * 
 * @param request - Sandbox execution request
 * @param additionalEnv - Additional env vars from options
 * @returns Array of k8s EnvVar objects
 */
function buildEnvVars(
  request: SandboxExecutionRequest,
  additionalEnv?: Record<string, string>,
): Array<{ name: string; value: string }> {
  const env: Array<{ name: string; value: string }> = [
    // Request metadata
    { name: "WORKFLOW_ID", value: request.workflowId },
    { name: "REQUEST_ID", value: request.requestId },
    { name: "STORY_ID", value: request.storyId },
    { name: "SANDBOX_PROFILE", value: request.sandbox },
    { name: "BASE_SHA", value: request.baseSha },
    
    // Agent identity
    { name: "AGENT_NAME", value: request.agent.name },
    ...(request.agent.variant ? [{ name: "AGENT_VARIANT", value: request.agent.variant }] : []),
    ...(request.agent.model ? [{ name: "AGENT_MODEL", value: request.agent.model }] : []),
    ...(request.agent.program ? [{ name: "AGENT_PROGRAM", value: request.agent.program }] : []),
    
    // Execution config
    ...(request.cwd ? [{ name: "WORKING_DIR", value: request.cwd }] : []),
    ...(request.sessionId ? [{ name: "SESSION_ID", value: request.sessionId }] : []),
    
    // Timeout (convert to string)
    ...(request.timeoutSeconds
      ? [{ name: "TIMEOUT_SECONDS", value: String(request.timeoutSeconds) }]
      : []),
    
    // Task prompt (base64-encoded to avoid shell escaping issues)
    {
      name: "TASK_PROMPT_B64",
      value: Buffer.from(request.task, "utf-8").toString("base64"),
    },
    
    // Verification commands (JSON array, base64-encoded)
    ...(request.verificationCommands
      ? [{
          name: "VERIFICATION_COMMANDS_B64",
          value: Buffer.from(JSON.stringify(request.verificationCommands), "utf-8").toString("base64"),
        }]
      : []),
  ];
  
  // Add any additional env vars
  if (additionalEnv) {
    for (const [key, value] of Object.entries(additionalEnv)) {
      env.push({ name: key, value });
    }
  }
  
  return env;
}

/**
 * Generate a k8s Job manifest for cold sandboxed execution.
 * 
 * The Job will:
 * - Run in an isolated Pod
 * - Execute the agent runner image with the story task
 * - Write result artifacts to a shared volume or emit events
 * - Self-cleanup after TTL
 * 
 * @param request - Sandbox execution request
 * @param options - Job spec options
 * @returns k8s Job manifest (JSON-serializable object)
 */
export function generateJobSpec(
  request: SandboxExecutionRequest,
  options: JobSpecOptions,
): Record<string, unknown> {
  const jobName = generateJobName(request.requestId);
  const namespace = options.namespace ?? "joelclaw";
  const resources = options.resources ?? DEFAULT_JOB_RESOURCES;
  const ttl = options.ttlSecondsAfterFinished ?? DEFAULT_TTL_SECONDS;
  const backoffLimit = options.backoffLimit ?? 0; // No retries by default
  const activeDeadline = options.activeDeadlineSeconds ?? 
    (request.timeoutSeconds ? request.timeoutSeconds + 60 : DEFAULT_ACTIVE_DEADLINE_SECONDS);
  
  const envVars = buildEnvVars(request, options.env);
  
  const jobSpec: Record<string, unknown> = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace,
      labels: {
        "app.kubernetes.io/name": "agent-runner",
        "app.kubernetes.io/component": "sandbox-executor",
        "joelclaw.dev/workflow-id": request.workflowId,
        "joelclaw.dev/story-id": request.storyId,
        "joelclaw.dev/sandbox": request.sandbox,
      },
      annotations: {
        "joelclaw.dev/request-id": request.requestId,
        "joelclaw.dev/story-title": request.task.slice(0, 200),
        "joelclaw.dev/agent": request.agent.name,
        ...(request.agent.model ? { "joelclaw.dev/model": request.agent.model } : {}),
      },
    },
    spec: {
      ttlSecondsAfterFinished: ttl,
      backoffLimit,
      activeDeadlineSeconds: activeDeadline,
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/name": "agent-runner",
            "app.kubernetes.io/component": "sandbox-executor",
            "joelclaw.dev/workflow-id": request.workflowId,
            "joelclaw.dev/story-id": request.storyId,
          },
        },
        spec: {
          restartPolicy: "Never",
          ...(options.serviceAccountName ? { serviceAccountName: options.serviceAccountName } : {}),
          ...(options.imagePullSecret ? {
            imagePullSecrets: [{ name: options.imagePullSecret }],
          } : {}),
          containers: [
            {
              name: "agent-runner",
              image: options.runtime.image,
              imagePullPolicy: options.runtime.imagePullPolicy ?? "Always",
              env: envVars,
              resources: {
                requests: {
                  ...(resources.cpuRequest ? { cpu: resources.cpuRequest } : {}),
                  ...(resources.memoryRequest ? { memory: resources.memoryRequest } : {}),
                },
                limits: {
                  ...(resources.cpuLimit ? { cpu: resources.cpuLimit } : {}),
                  ...(resources.memoryLimit ? { memory: resources.memoryLimit } : {}),
                },
              },
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: false,
                capabilities: {
                  drop: ["ALL"],
                },
                seccompProfile: {
                  type: "RuntimeDefault",
                },
              },
            },
          ],
          tolerations: [
            {
              key: "node-role.kubernetes.io/control-plane",
              operator: "Exists",
              effect: "NoSchedule",
            },
          ],
        },
      },
    },
  };
  
  return jobSpec;
}

/**
 * Generate a Job deletion request for cleanup/cancellation.
 * 
 * @param requestId - Request ID of the Job to cancel
 * @param namespace - k8s namespace
 * @returns Deletion metadata
 */
export function generateJobDeletion(
  requestId: string,
  namespace = "joelclaw",
): { name: string; namespace: string; propagationPolicy: string } {
  return {
    name: generateJobName(requestId),
    namespace,
    propagationPolicy: "Background", // Delete Job and cascade to Pod
  };
}

/**
 * Check if a Job name is valid for the given requestId.
 * 
 * Used to verify Job identity during status checks.
 * 
 * @param jobName - k8s Job name
 * @param requestId - Expected request ID
 * @returns True if the Job name matches the request ID
 */
export function isJobForRequest(jobName: string, requestId: string): boolean {
  return jobName === generateJobName(requestId);
}

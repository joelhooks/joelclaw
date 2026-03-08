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
 * - Required agent tooling (codex, claude, etc.)
 * - Workspace directory at /workspace
 * - Ability to read env vars for config
 */
export interface RuntimeImageContract {
  /** Container image reference (e.g., ghcr.io/owner/agent-runner:tag) */
  image: string;
  /** Image pull policy */
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  /** Optional command override */
  command?: string[];
  /** Optional args override */
  args?: string[];
}

/**
 * Resource limits for Job execution.
 */
export interface JobResourceLimits {
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimit?: string;
}

/**
 * Options for Job spec generation.
 */
export interface JobSpecOptions {
  runtime: RuntimeImageContract;
  namespace?: string;
  resources?: JobResourceLimits;
  ttlSecondsAfterFinished?: number;
  backoffLimit?: number;
  activeDeadlineSeconds?: number;
  serviceAccountName?: string;
  env?: Record<string, string>;
  imagePullSecret?: string;
  /** Optional callback URL that the runner should POST SandboxExecutionResult to */
  resultCallbackUrl?: string;
  /** Optional token/header value for the callback route */
  resultCallbackToken?: string;
}

export const DEFAULT_JOB_RESOURCES: JobResourceLimits = {
  cpuRequest: "500m",
  cpuLimit: "2",
  memoryRequest: "1Gi",
  memoryLimit: "4Gi",
};

export const DEFAULT_TTL_SECONDS = 300;
export const DEFAULT_ACTIVE_DEADLINE_SECONDS = 3600;

export function generateJobName(requestId: string): string {
  const sanitized = requestId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  const truncated = sanitized.slice(0, 63);
  return truncated.replace(/-+$/, "");
}

function buildEnvVars(
  request: SandboxExecutionRequest,
  options: {
    additionalEnv?: Record<string, string>;
    callbackUrl?: string;
    callbackToken?: string;
    jobName: string;
    namespace: string;
  },
): Array<Record<string, unknown>> {
  const env: Array<Record<string, unknown>> = [
    { name: "WORKFLOW_ID", value: request.workflowId },
    { name: "REQUEST_ID", value: request.requestId },
    { name: "STORY_ID", value: request.storyId },
    { name: "SANDBOX_PROFILE", value: request.sandbox },
    { name: "BASE_SHA", value: request.baseSha },
    { name: "JOB_NAME", value: options.jobName },
    { name: "JOB_NAMESPACE", value: options.namespace },
    { name: "EXECUTION_BACKEND", value: request.backend ?? "k8s" },

    { name: "AGENT_NAME", value: request.agent.name },
    ...(request.agent.variant ? [{ name: "AGENT_VARIANT", value: request.agent.variant }] : []),
    ...(request.agent.model ? [{ name: "AGENT_MODEL", value: request.agent.model }] : []),
    ...(request.agent.program ? [{ name: "AGENT_PROGRAM", value: request.agent.program }] : []),

    ...(request.cwd ? [{ name: "HOST_REQUESTED_CWD", value: request.cwd }] : []),
    ...(request.repoUrl ? [{ name: "REPO_URL", value: request.repoUrl }] : []),
    ...(request.branch ? [{ name: "REPO_BRANCH", value: request.branch }] : []),
    ...(request.sessionId ? [{ name: "SESSION_ID", value: request.sessionId }] : []),
    ...(request.timeoutSeconds ? [{ name: "TIMEOUT_SECONDS", value: String(request.timeoutSeconds) }] : []),
    {
      name: "TASK_PROMPT_B64",
      value: Buffer.from(request.task, "utf8").toString("base64"),
    },
    ...(request.verificationCommands
      ? [{
          name: "VERIFICATION_COMMANDS_B64",
          value: Buffer.from(JSON.stringify(request.verificationCommands), "utf8").toString("base64"),
        }]
      : []),
    ...(options.callbackUrl ? [{ name: "RESULT_CALLBACK_URL", value: options.callbackUrl }] : []),
    ...(options.callbackToken ? [{ name: "RESULT_CALLBACK_TOKEN", value: options.callbackToken }] : []),
  ];

  if (options.additionalEnv) {
    for (const [key, value] of Object.entries(options.additionalEnv)) {
      env.push({ name: key, value });
    }
  }

  return env;
}

export function generateJobSpec(
  request: SandboxExecutionRequest,
  options: JobSpecOptions,
): Record<string, unknown> {
  const jobName = generateJobName(request.requestId);
  const namespace = options.namespace ?? "joelclaw";
  const resources = options.resources ?? DEFAULT_JOB_RESOURCES;
  const ttl = options.ttlSecondsAfterFinished ?? DEFAULT_TTL_SECONDS;
  const backoffLimit = options.backoffLimit ?? 0;
  const activeDeadlineSeconds =
    options.activeDeadlineSeconds ??
    (request.timeoutSeconds ? request.timeoutSeconds + 60 : DEFAULT_ACTIVE_DEADLINE_SECONDS);

  const envVars = buildEnvVars(request, {
    additionalEnv: options.env,
    callbackUrl: options.resultCallbackUrl,
    callbackToken: options.resultCallbackToken,
    jobName,
    namespace,
  });

  return {
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
        "joelclaw.dev/backend": request.backend ?? "k8s",
      },
      annotations: {
        "joelclaw.dev/request-id": request.requestId,
        "joelclaw.dev/story-title": request.task.slice(0, 200),
        "joelclaw.dev/agent": request.agent.name,
        ...(request.agent.model ? { "joelclaw.dev/model": request.agent.model } : {}),
        ...(request.repoUrl ? { "joelclaw.dev/repo-url": request.repoUrl } : {}),
      },
    },
    spec: {
      ttlSecondsAfterFinished: ttl,
      backoffLimit,
      activeDeadlineSeconds,
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
          ...(options.imagePullSecret ? { imagePullSecrets: [{ name: options.imagePullSecret }] } : {}),
          containers: [
            {
              name: "agent-runner",
              image: options.runtime.image,
              imagePullPolicy: options.runtime.imagePullPolicy ?? "Always",
              ...(options.runtime.command ? { command: options.runtime.command } : {}),
              ...(options.runtime.args ? { args: options.runtime.args } : {}),
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
}

export function generateJobDeletion(
  requestId: string,
  namespace = "joelclaw",
): { name: string; namespace: string; propagationPolicy: string } {
  return {
    name: generateJobName(requestId),
    namespace,
    propagationPolicy: "Background",
  };
}

export function isJobForRequest(jobName: string, requestId: string): boolean {
  return jobName === generateJobName(requestId);
}

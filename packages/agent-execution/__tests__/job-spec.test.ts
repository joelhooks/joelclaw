import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ACTIVE_DEADLINE_SECONDS,
  DEFAULT_JOB_RESOURCES,
  DEFAULT_TTL_SECONDS,
  generateJobDeletion,
  generateJobName,
  generateJobSpec,
  isJobForRequest,
  type JobSpecOptions,
  type SandboxExecutionRequest,
} from "../src/index.js";

describe("k8s Job spec builder", () => {
  const minimalRequest: SandboxExecutionRequest = {
    workflowId: "wf-test-123",
    requestId: "req-test-456",
    storyId: "story-1",
    task: "Implement feature X with tests and documentation",
    agent: { name: "codex", model: "gpt-5.4" },
    sandbox: "workspace-write",
    baseSha: "abc123def456",
  };

  const minimalOptions: JobSpecOptions = {
    runtime: {
      image: "ghcr.io/joelhooks/agent-runner:latest",
      imagePullPolicy: "Always",
    },
  };

  describe("generateJobName", () => {
    test("sanitizes request ID to DNS-1123", () => {
      expect(generateJobName("req-TEST-123")).toBe("req-test-123");
      expect(generateJobName("req_test_456")).toBe("req-test-456");
      expect(generateJobName("req.test.789")).toBe("req-test-789");
    });

    test("handles special characters", () => {
      expect(generateJobName("req@test#123")).toBe("req-test-123");
      expect(generateJobName("req::test::456")).toBe("req-test-456");
    });

    test("deduplicates hyphens", () => {
      expect(generateJobName("req---test---123")).toBe("req-test-123");
    });

    test("strips leading/trailing hyphens", () => {
      expect(generateJobName("-req-test-123-")).toBe("req-test-123");
      expect(generateJobName("--req-test--")).toBe("req-test");
    });

    test("truncates to 63 characters", () => {
      const longId = "a".repeat(100);
      const jobName = generateJobName(longId);
      expect(jobName.length).toBeLessThanOrEqual(63);
    });

    test("ensures truncated name ends with alphanumeric", () => {
      const edgeCase = "a".repeat(62) + "-b";
      const jobName = generateJobName(edgeCase);
      expect(jobName).not.toMatch(/-$/);
    });

    test("produces deterministic names", () => {
      const id = "req-test-123";
      const name1 = generateJobName(id);
      const name2 = generateJobName(id);
      expect(name1).toBe(name2);
    });
  });

  describe("generateJobSpec", () => {
    test("generates valid Job manifest with minimal config", () => {
      const spec = generateJobSpec(minimalRequest, minimalOptions);

      expect(spec.apiVersion).toBe("batch/v1");
      expect(spec.kind).toBe("Job");
      expect((spec.metadata as any).name).toBe("req-test-456");
      expect((spec.metadata as any).namespace).toBe("joelclaw");
    });

    test("sets TTL for cleanup", () => {
      const spec = generateJobSpec(minimalRequest, minimalOptions);
      expect((spec.spec as any).ttlSecondsAfterFinished).toBe(DEFAULT_TTL_SECONDS);
    });

    test("respects custom TTL", () => {
      const options = { ...minimalOptions, ttlSecondsAfterFinished: 600 };
      const spec = generateJobSpec(minimalRequest, options);
      expect((spec.spec as any).ttlSecondsAfterFinished).toBe(600);
    });

    test("sets backoff limit to 0 by default (no retries)", () => {
      const spec = generateJobSpec(minimalRequest, minimalOptions);
      expect((spec.spec as any).backoffLimit).toBe(0);
    });

    test("sets active deadline from request timeout", () => {
      const requestWithTimeout = { ...minimalRequest, timeoutSeconds: 900 };
      const spec = generateJobSpec(requestWithTimeout, minimalOptions);
      // Should be timeout + 60s grace
      expect((spec.spec as any).activeDeadlineSeconds).toBe(960);
    });

    test("uses default active deadline if no timeout specified", () => {
      const spec = generateJobSpec(minimalRequest, minimalOptions);
      expect((spec.spec as any).activeDeadlineSeconds).toBe(DEFAULT_ACTIVE_DEADLINE_SECONDS);
    });

    test("includes workflow and story labels", () => {
      const spec = generateJobSpec(minimalRequest, minimalOptions);
      const labels = (spec.metadata as any).labels;

      expect(labels["app.kubernetes.io/name"]).toBe("agent-runner");
      expect(labels["app.kubernetes.io/component"]).toBe("sandbox-executor");
      expect(labels["joelclaw.dev/workflow-id"]).toBe("wf-test-123");
      expect(labels["joelclaw.dev/story-id"]).toBe("story-1");
      expect(labels["joelclaw.dev/sandbox"]).toBe("workspace-write");
    });

    test("includes request metadata in annotations", () => {
      const spec = generateJobSpec(minimalRequest, minimalOptions);
      const annotations = (spec.metadata as any).annotations;

      expect(annotations["joelclaw.dev/request-id"]).toBe("req-test-456");
      expect(annotations["joelclaw.dev/agent"]).toBe("codex");
      expect(annotations["joelclaw.dev/model"]).toBe("gpt-5.4");
      expect(annotations["joelclaw.dev/story-title"]).toContain("Implement feature X");
    });

    test("injects required environment variables", () => {
      const spec = generateJobSpec(minimalRequest, minimalOptions);
      const container = (spec.spec as any).template.spec.containers[0];
      const env = container.env as Array<{ name: string; value: string }>;

      const envMap = Object.fromEntries(env.map((e) => [e.name, e.value]));

      expect(envMap.WORKFLOW_ID).toBe("wf-test-123");
      expect(envMap.REQUEST_ID).toBe("req-test-456");
      expect(envMap.STORY_ID).toBe("story-1");
      expect(envMap.SANDBOX_PROFILE).toBe("workspace-write");
      expect(envMap.BASE_SHA).toBe("abc123def456");
      expect(envMap.AGENT_NAME).toBe("codex");
      expect(envMap.AGENT_MODEL).toBe("gpt-5.4");
    });

    test("base64-encodes task prompt", () => {
      const spec = generateJobSpec(minimalRequest, minimalOptions);
      const container = (spec.spec as any).template.spec.containers[0];
      const env = container.env as Array<{ name: string; value: string }>;

      const taskEnv = env.find((e) => e.name === "TASK_PROMPT_B64");
      expect(taskEnv).toBeDefined();

      const decoded = Buffer.from(taskEnv!.value, "base64").toString("utf-8");
      expect(decoded).toBe(minimalRequest.task);
    });

    test("includes verification commands when provided", () => {
      const requestWithVerification = {
        ...minimalRequest,
        verificationCommands: ["pnpm test", "bunx tsc --noEmit"],
      };
      const spec = generateJobSpec(requestWithVerification, minimalOptions);
      const container = (spec.spec as any).template.spec.containers[0];
      const env = container.env as Array<{ name: string; value: string }>;

      const verifyEnv = env.find((e) => e.name === "VERIFICATION_COMMANDS_B64");
      expect(verifyEnv).toBeDefined();

      const decoded = JSON.parse(
        Buffer.from(verifyEnv!.value, "base64").toString("utf-8"),
      );
      expect(decoded).toEqual(["pnpm test", "bunx tsc --noEmit"]);
    });

    test("applies custom resource limits", () => {
      const options: JobSpecOptions = {
        ...minimalOptions,
        resources: {
          cpuRequest: "1",
          cpuLimit: "4",
          memoryRequest: "2Gi",
          memoryLimit: "8Gi",
        },
      };
      const spec = generateJobSpec(minimalRequest, options);
      const container = (spec.spec as any).template.spec.containers[0];

      expect(container.resources.requests.cpu).toBe("1");
      expect(container.resources.limits.cpu).toBe("4");
      expect(container.resources.requests.memory).toBe("2Gi");
      expect(container.resources.limits.memory).toBe("8Gi");
    });

    test("uses default resource limits if not specified", () => {
      const spec = generateJobSpec(minimalRequest, minimalOptions);
      const container = (spec.spec as any).template.spec.containers[0];

      expect(container.resources.requests.cpu).toBe(DEFAULT_JOB_RESOURCES.cpuRequest);
      expect(container.resources.limits.cpu).toBe(DEFAULT_JOB_RESOURCES.cpuLimit);
      expect(container.resources.requests.memory).toBe(DEFAULT_JOB_RESOURCES.memoryRequest);
      expect(container.resources.limits.memory).toBe(DEFAULT_JOB_RESOURCES.memoryLimit);
    });

    test("sets security context for non-root execution", () => {
      const spec = generateJobSpec(minimalRequest, minimalOptions);
      const container = (spec.spec as any).template.spec.containers[0];
      const securityContext = container.securityContext;

      expect(securityContext.runAsNonRoot).toBe(true);
      expect(securityContext.runAsUser).toBe(1000);
      expect(securityContext.runAsGroup).toBe(1000);
      expect(securityContext.allowPrivilegeEscalation).toBe(false);
      expect(securityContext.capabilities.drop).toEqual(["ALL"]);
      expect(securityContext.seccompProfile.type).toBe("RuntimeDefault");
    });

    test("includes control plane toleration", () => {
      const spec = generateJobSpec(minimalRequest, minimalOptions);
      const tolerations = (spec.spec as any).template.spec.tolerations;

      expect(tolerations).toHaveLength(1);
      expect(tolerations[0].key).toBe("node-role.kubernetes.io/control-plane");
      expect(tolerations[0].operator).toBe("Exists");
      expect(tolerations[0].effect).toBe("NoSchedule");
    });

    test("supports custom namespace", () => {
      const options = { ...minimalOptions, namespace: "custom-ns" };
      const spec = generateJobSpec(minimalRequest, options);
      expect((spec.metadata as any).namespace).toBe("custom-ns");
    });

    test("supports service account", () => {
      const options = { ...minimalOptions, serviceAccountName: "agent-sa" };
      const spec = generateJobSpec(minimalRequest, options);
      expect((spec.spec as any).template.spec.serviceAccountName).toBe("agent-sa");
    });

    test("supports image pull secret", () => {
      const options = { ...minimalOptions, imagePullSecret: "ghcr-pull" };
      const spec = generateJobSpec(minimalRequest, options);
      const pullSecrets = (spec.spec as any).template.spec.imagePullSecrets;

      expect(pullSecrets).toHaveLength(1);
      expect(pullSecrets[0].name).toBe("ghcr-pull");
    });

    test("supports additional env vars", () => {
      const options: JobSpecOptions = {
        ...minimalOptions,
        env: {
          CUSTOM_VAR: "custom-value",
          ANOTHER_VAR: "another-value",
        },
      };
      const spec = generateJobSpec(minimalRequest, options);
      const container = (spec.spec as any).template.spec.containers[0];
      const env = container.env as Array<{ name: string; value: string }>;

      const envMap = Object.fromEntries(env.map((e) => [e.name, e.value]));
      expect(envMap.CUSTOM_VAR).toBe("custom-value");
      expect(envMap.ANOTHER_VAR).toBe("another-value");
    });

    test("sets restart policy to Never", () => {
      const spec = generateJobSpec(minimalRequest, minimalOptions);
      expect((spec.spec as any).template.spec.restartPolicy).toBe("Never");
    });

    test("uses runtime image config", () => {
      const spec = generateJobSpec(minimalRequest, minimalOptions);
      const container = (spec.spec as any).template.spec.containers[0];

      expect(container.image).toBe("ghcr.io/joelhooks/agent-runner:latest");
      expect(container.imagePullPolicy).toBe("Always");
    });

    test("produces JSON-serializable output", () => {
      const spec = generateJobSpec(minimalRequest, minimalOptions);
      const serialized = JSON.stringify(spec);
      const deserialized = JSON.parse(serialized);

      expect(deserialized.kind).toBe("Job");
      expect(deserialized.metadata.name).toBe("req-test-456");
    });
  });

  describe("generateJobDeletion", () => {
    test("generates deletion metadata", () => {
      const deletion = generateJobDeletion("req-test-456");

      expect(deletion.name).toBe("req-test-456");
      expect(deletion.namespace).toBe("joelclaw");
      expect(deletion.propagationPolicy).toBe("Background");
    });

    test("supports custom namespace", () => {
      const deletion = generateJobDeletion("req-test-456", "custom-ns");
      expect(deletion.namespace).toBe("custom-ns");
    });

    test("uses same name generation as Job creation", () => {
      const requestId = "req-TEST-special@123";
      const jobName = generateJobName(requestId);
      const deletion = generateJobDeletion(requestId);

      expect(deletion.name).toBe(jobName);
    });
  });

  describe("isJobForRequest", () => {
    test("matches Job name to request ID", () => {
      const requestId = "req-test-123";
      const jobName = generateJobName(requestId);

      expect(isJobForRequest(jobName, requestId)).toBe(true);
    });

    test("rejects mismatched Job name", () => {
      const requestId = "req-test-123";
      const wrongName = generateJobName("req-other-456");

      expect(isJobForRequest(wrongName, requestId)).toBe(false);
    });

    test("handles sanitization consistently", () => {
      const requestId = "req-TEST-123";
      const jobName = generateJobName(requestId);

      // Should match even with different casing in original ID
      expect(isJobForRequest(jobName, "req-test-123")).toBe(true);
      expect(isJobForRequest(jobName, "REQ-TEST-123")).toBe(true);
    });
  });

  describe("contract constants", () => {
    test("exports default TTL", () => {
      expect(DEFAULT_TTL_SECONDS).toBeGreaterThan(0);
      expect(typeof DEFAULT_TTL_SECONDS).toBe("number");
    });

    test("exports default active deadline", () => {
      expect(DEFAULT_ACTIVE_DEADLINE_SECONDS).toBeGreaterThan(0);
      expect(typeof DEFAULT_ACTIVE_DEADLINE_SECONDS).toBe("number");
    });

    test("exports default resource limits", () => {
      expect(DEFAULT_JOB_RESOURCES.cpuRequest).toBeDefined();
      expect(DEFAULT_JOB_RESOURCES.cpuLimit).toBeDefined();
      expect(DEFAULT_JOB_RESOURCES.memoryRequest).toBeDefined();
      expect(DEFAULT_JOB_RESOURCES.memoryLimit).toBeDefined();
    });
  });
});

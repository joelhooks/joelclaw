import { describe, expect, test } from "bun:test";
import {
  type AgentIdentity,
  EXECUTION_STATES,
  type ExecutionArtifacts,
  isAgentIdentity,
  isExecutionArtifacts,
  isExecutionState,
  isPrdExecutionPlan,
  isSandboxBackend,
  isSandboxExecutionRequest,
  isSandboxExecutionResult,
  isSandboxJobRef,
  isSandboxProfile,
  isStoryPlan,
  isWavePlan,
  type PrdExecutionPlan,
  SANDBOX_BACKENDS,
  SANDBOX_PROFILES,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type StoryPlan,
  type WavePlan,
} from "../src/index.js";

describe("@joelclaw/agent-execution contracts", () => {
  describe("SandboxProfile", () => {
    test("validates known sandbox profiles", () => {
      expect(isSandboxProfile("workspace-write")).toBe(true);
      expect(isSandboxProfile("danger-full-access")).toBe(true);
    });

    test("rejects invalid sandbox profiles", () => {
      expect(isSandboxProfile("unknown")).toBe(false);
      expect(isSandboxProfile("")).toBe(false);
      expect(isSandboxProfile(null)).toBe(false);
      expect(isSandboxProfile(undefined)).toBe(false);
      expect(isSandboxProfile(123)).toBe(false);
    });

    test("exports expected profiles", () => {
      expect(SANDBOX_PROFILES).toEqual(["workspace-write", "danger-full-access"]);
    });
  });

  describe("SandboxBackend", () => {
    test("validates known sandbox backends", () => {
      expect(isSandboxBackend("local")).toBe(true);
      expect(isSandboxBackend("k8s")).toBe(true);
    });

    test("rejects invalid sandbox backends", () => {
      expect(isSandboxBackend("host")).toBe(false);
      expect(isSandboxBackend(null)).toBe(false);
    });

    test("exports expected backends", () => {
      expect(SANDBOX_BACKENDS).toEqual(["local", "k8s"]);
    });
  });

  describe("ExecutionState", () => {
    test("validates known execution states", () => {
      expect(isExecutionState("pending")).toBe(true);
      expect(isExecutionState("running")).toBe(true);
      expect(isExecutionState("completed")).toBe(true);
      expect(isExecutionState("failed")).toBe(true);
      expect(isExecutionState("cancelled")).toBe(true);
    });

    test("rejects invalid execution states", () => {
      expect(isExecutionState("unknown")).toBe(false);
      expect(isExecutionState("")).toBe(false);
      expect(isExecutionState(null)).toBe(false);
    });

    test("exports expected states", () => {
      expect(EXECUTION_STATES).toEqual([
        "pending",
        "running",
        "completed",
        "failed",
        "cancelled",
      ]);
    });
  });

  describe("AgentIdentity", () => {
    test("validates well-formed agent identity", () => {
      const valid: AgentIdentity = {
        name: "story-executor",
        variant: "sandbox",
        model: "claude-3-7-sonnet",
        program: "claude",
      };
      expect(isAgentIdentity(valid)).toBe(true);
    });

    test("validates minimal agent identity", () => {
      expect(isAgentIdentity({ name: "pi" })).toBe(true);
    });

    test("rejects invalid agent identity", () => {
      expect(isAgentIdentity({})).toBe(false);
      expect(isAgentIdentity({ name: "" })).toBe(false);
      expect(isAgentIdentity({ name: 123 })).toBe(false);
      expect(isAgentIdentity(null)).toBe(false);
    });
  });

  describe("SandboxJobRef", () => {
    test("validates a job ref", () => {
      expect(isSandboxJobRef({ name: "req-123", namespace: "joelclaw" })).toBe(true);
      expect(isSandboxJobRef({ name: "req-123", namespace: "joelclaw", podName: "req-123-abc" })).toBe(true);
    });

    test("rejects invalid job refs", () => {
      expect(isSandboxJobRef({ name: "", namespace: "joelclaw" })).toBe(false);
      expect(isSandboxJobRef({ name: "req-123" })).toBe(false);
    });
  });

  describe("SandboxExecutionRequest", () => {
    const validRequest: SandboxExecutionRequest = {
      workflowId: "wf-123",
      requestId: "req-456",
      storyId: "story-1",
      task: "implement feature X",
      agent: { name: "story-executor", program: "claude", model: "claude-3-7-sonnet" },
      sandbox: "workspace-write",
      baseSha: "abc123def456",
      backend: "k8s",
      repoUrl: "https://github.com/joelhooks/joelclaw.git",
      branch: "main",
    };

    test("validates well-formed request", () => {
      expect(isSandboxExecutionRequest(validRequest)).toBe(true);
    });

    test("validates request with optional fields", () => {
      const withOptionals: SandboxExecutionRequest = {
        ...validRequest,
        cwd: "/Users/joel/Code/joelhooks/joelclaw",
        timeoutSeconds: 600,
        verificationCommands: ["pnpm test", "bunx tsc --noEmit"],
        sessionId: "session-789",
      };
      expect(isSandboxExecutionRequest(withOptionals)).toBe(true);
    });

    test("rejects request with missing required fields", () => {
      const missing = { ...validRequest } as Record<string, unknown>;
      delete missing.workflowId;
      expect(isSandboxExecutionRequest(missing)).toBe(false);
    });

    test("rejects request with invalid backend", () => {
      expect(isSandboxExecutionRequest({ ...validRequest, backend: "bogus" })).toBe(false);
    });

    test("rejects request with invalid agent", () => {
      expect(isSandboxExecutionRequest({ ...validRequest, agent: { name: "" } })).toBe(false);
    });

    test("rejects request with invalid sandbox profile", () => {
      expect(isSandboxExecutionRequest({ ...validRequest, sandbox: "unknown" })).toBe(false);
    });
  });

  describe("ExecutionArtifacts", () => {
    const validArtifacts: ExecutionArtifacts = {
      headSha: "def789abc012",
      touchedFiles: ["src/index.ts", "src/types.ts"],
    };

    test("validates minimal artifacts", () => {
      expect(isExecutionArtifacts(validArtifacts)).toBe(true);
    });

    test("validates artifacts with verification", () => {
      const withVerification: ExecutionArtifacts = {
        ...validArtifacts,
        verification: {
          commands: ["pnpm test"],
          success: true,
          output: "All tests passed",
        },
      };
      expect(isExecutionArtifacts(withVerification)).toBe(true);
    });

    test("rejects artifacts with invalid verification", () => {
      expect(
        isExecutionArtifacts({
          ...validArtifacts,
          verification: {
            commands: "not an array",
            success: true,
          },
        }),
      ).toBe(false);
    });

    test("rejects artifacts with missing headSha", () => {
      const missing = { ...validArtifacts } as Record<string, unknown>;
      delete missing.headSha;
      expect(isExecutionArtifacts(missing)).toBe(false);
    });
  });

  describe("SandboxExecutionResult", () => {
    const validResult: SandboxExecutionResult = {
      requestId: "req-456",
      state: "completed",
      startedAt: "2026-03-07T00:00:00Z",
    };

    test("validates minimal result", () => {
      expect(isSandboxExecutionResult(validResult)).toBe(true);
    });

    test("validates completed result with backend and job ref", () => {
      const completed: SandboxExecutionResult = {
        ...validResult,
        backend: "k8s",
        job: {
          name: "req-456",
          namespace: "joelclaw",
          podName: "req-456-abc",
        },
        completedAt: "2026-03-07T00:10:00Z",
        durationMs: 600000,
        artifacts: {
          headSha: "def789",
          touchedFiles: ["src/index.ts"],
        },
      };
      expect(isSandboxExecutionResult(completed)).toBe(true);
    });

    test("validates failed result with error", () => {
      const failed: SandboxExecutionResult = {
        ...validResult,
        state: "failed",
        backend: "local",
        error: "Compilation failed",
        output: "Error: type mismatch",
      };
      expect(isSandboxExecutionResult(failed)).toBe(true);
    });

    test("rejects result with invalid state", () => {
      expect(isSandboxExecutionResult({ ...validResult, state: "unknown" })).toBe(false);
    });

    test("rejects result with invalid job ref", () => {
      expect(
        isSandboxExecutionResult({
          ...validResult,
          job: { name: "", namespace: "joelclaw" },
        }),
      ).toBe(false);
    });
  });

  describe("StoryPlan", () => {
    const validStory: StoryPlan = {
      id: "story-1",
      title: "Add feature X",
      summary: "Implement feature X with tests",
      prompt: "Create a new feature that...",
    };

    test("validates minimal story", () => {
      expect(isStoryPlan(validStory)).toBe(true);
    });

    test("validates story with optional fields", () => {
      const withOptionals: StoryPlan = {
        ...validStory,
        files: ["src/feature.ts"],
        dependsOn: ["story-0"],
        timeoutSeconds: 900,
        sandbox: "workspace-write",
      };
      expect(isStoryPlan(withOptionals)).toBe(true);
    });

    test("rejects story with missing required fields", () => {
      const missing = { ...validStory } as Record<string, unknown>;
      delete missing.prompt;
      expect(isStoryPlan(missing)).toBe(false);
    });
  });

  describe("WavePlan", () => {
    const validWave: WavePlan = {
      id: "wave-1",
      stories: [
        {
          id: "story-1",
          title: "Story 1",
          summary: "First story",
          prompt: "Do thing 1",
        },
        {
          id: "story-2",
          title: "Story 2",
          summary: "Second story",
          prompt: "Do thing 2",
        },
      ],
    };

    test("validates wave with stories", () => {
      expect(isWavePlan(validWave)).toBe(true);
    });

    test("rejects wave with invalid stories", () => {
      expect(
        isWavePlan({
          ...validWave,
          stories: [{ id: "bad", title: "", summary: "", prompt: "" }],
        }),
      ).toBe(false);
    });
  });

  describe("PrdExecutionPlan", () => {
    const validPlan: PrdExecutionPlan = {
      summary: "Implement feature set",
      waves: [
        {
          id: "wave-1",
          stories: [
            {
              id: "story-1",
              title: "Story 1",
              summary: "First story",
              prompt: "Do thing 1",
            },
          ],
        },
      ],
    };

    test("validates execution plan", () => {
      expect(isPrdExecutionPlan(validPlan)).toBe(true);
    });

    test("rejects plan with invalid waves", () => {
      expect(isPrdExecutionPlan({ ...validPlan, waves: [{ id: "bad" }] })).toBe(false);
    });
  });

  describe("Contract serialization", () => {
    test("request can round-trip through JSON", () => {
      const request: SandboxExecutionRequest = {
        workflowId: "wf-123",
        requestId: "req-456",
        storyId: "story-1",
        task: "test task",
        agent: { name: "story-executor", program: "claude" },
        sandbox: "workspace-write",
        baseSha: "abc123",
        backend: "k8s",
        repoUrl: "https://github.com/joelhooks/joelclaw.git",
        branch: "main",
      };

      const serialized = JSON.stringify(request);
      const deserialized = JSON.parse(serialized);
      expect(isSandboxExecutionRequest(deserialized)).toBe(true);
    });

    test("result can round-trip through JSON", () => {
      const result: SandboxExecutionResult = {
        requestId: "req-456",
        state: "completed",
        startedAt: "2026-03-07T00:00:00Z",
        backend: "k8s",
        job: { name: "req-456", namespace: "joelclaw" },
        artifacts: {
          headSha: "def789",
          touchedFiles: ["src/index.ts"],
        },
      };

      const serialized = JSON.stringify(result);
      const deserialized = JSON.parse(serialized);
      expect(isSandboxExecutionResult(deserialized)).toBe(true);
    });

    test("InboxResult supports local sandbox metadata", () => {
      const inbox = {
        requestId: "req-local",
        status: "running",
        task: "test task",
        tool: "pi",
        startedAt: "2026-03-09T00:00:00Z",
        updatedAt: "2026-03-09T00:00:00Z",
        executionMode: "sandbox",
        sandboxBackend: "local",
        localSandbox: {
          sandboxId: "jc-workflow-story-1234abcd-req-loca",
          slug: "jc-workflow-story-1234abcd",
          composeProjectName: "jc_workflow_1234abcd",
          mode: "minimal",
          path: "/Users/joel/.joelclaw/sandboxes/workflow/story/jc-workflow-story-1234abcd-req-loca",
          repoPath: "/Users/joel/.joelclaw/sandboxes/workflow/story/jc-workflow-story-1234abcd-req-loca/repo",
          envPath: "/Users/joel/.joelclaw/sandboxes/workflow/story/jc-workflow-story-1234abcd-req-loca/.sandbox.env",
          registryPath: "/Users/joel/.joelclaw/sandboxes/registry.json",
        },
      };

      const serialized = JSON.stringify(inbox);
      const deserialized = JSON.parse(serialized);
      expect(deserialized.localSandbox.composeProjectName).toBe("jc_workflow_1234abcd");
      expect(deserialized.localSandbox.mode).toBe("minimal");
    });
  });
});

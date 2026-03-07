import { describe, expect, it } from "bun:test";
import {
  EXECUTION_STATES,
  isExecutionState,
  isSandboxExecutionResult,
} from "../src/schema";
import type { SandboxExecutionResult } from "../src/types";

describe("Terminal state validation", () => {
  it("recognizes all execution states", () => {
    for (const state of EXECUTION_STATES) {
      expect(isExecutionState(state)).toBe(true);
    }
  });

  it("rejects invalid execution states", () => {
    expect(isExecutionState("invalid")).toBe(false);
    expect(isExecutionState("")).toBe(false);
    expect(isExecutionState(null)).toBe(false);
    expect(isExecutionState(undefined)).toBe(false);
  });

  it("validates completed result", () => {
    const result: SandboxExecutionResult = {
      requestId: "test-123",
      state: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 1000,
      artifacts: {
        headSha: "abc123",
        touchedFiles: ["file1.ts", "file2.ts"],
        logs: {
          stdout: "output",
          stderr: "",
        },
      },
    };

    expect(isSandboxExecutionResult(result)).toBe(true);
  });

  it("validates failed result", () => {
    const result: SandboxExecutionResult = {
      requestId: "test-456",
      state: "failed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 500,
      error: "Something went wrong",
      output: "partial output",
    };

    expect(isSandboxExecutionResult(result)).toBe(true);
  });

  it("validates cancelled result", () => {
    const result: SandboxExecutionResult = {
      requestId: "test-789",
      state: "cancelled",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 250,
      error: "Execution cancelled by user",
    };

    expect(isSandboxExecutionResult(result)).toBe(true);
  });

  it("validates running result", () => {
    const result: SandboxExecutionResult = {
      requestId: "test-running",
      state: "running",
      startedAt: new Date().toISOString(),
    };

    expect(isSandboxExecutionResult(result)).toBe(true);
  });

  it("validates pending result", () => {
    const result: SandboxExecutionResult = {
      requestId: "test-pending",
      state: "pending",
      startedAt: new Date().toISOString(),
    };

    expect(isSandboxExecutionResult(result)).toBe(true);
  });

  it("rejects result with invalid state", () => {
    const result = {
      requestId: "test-invalid",
      state: "invalid-state",
      startedAt: new Date().toISOString(),
    };

    expect(isSandboxExecutionResult(result)).toBe(false);
  });

  it("rejects result without requestId", () => {
    const result = {
      state: "completed",
      startedAt: new Date().toISOString(),
    };

    expect(isSandboxExecutionResult(result)).toBe(false);
  });

  it("rejects result without startedAt", () => {
    const result = {
      requestId: "test-no-start",
      state: "completed",
    };

    expect(isSandboxExecutionResult(result)).toBe(false);
  });

  it("validates result with logs in artifacts", () => {
    const result: SandboxExecutionResult = {
      requestId: "test-logs",
      state: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 1500,
      artifacts: {
        headSha: "def456",
        touchedFiles: ["main.ts"],
        logs: {
          executionLog: "/path/to/execution.log",
          verificationLog: "/path/to/verification.log",
          stdout: "Standard output content",
          stderr: "Standard error content",
        },
      },
    };

    expect(isSandboxExecutionResult(result)).toBe(true);
  });

  it("rejects result with invalid logs structure", () => {
    const result = {
      requestId: "test-bad-logs",
      state: "completed",
      startedAt: new Date().toISOString(),
      artifacts: {
        headSha: "xyz789",
        touchedFiles: [],
        logs: {
          stdout: 123, // Should be string
        },
      },
    };

    expect(isSandboxExecutionResult(result)).toBe(false);
  });
});

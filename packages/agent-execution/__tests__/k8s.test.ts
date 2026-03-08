import { describe, expect, test } from "bun:test";
import {
  extractSandboxResultFromLogs,
  generateJobName,
  RESULT_END_MARKER,
  RESULT_START_MARKER,
} from "../src/index.js";

describe("k8s sandbox helpers", () => {
  test("extracts a sandbox result from log markers", () => {
    const payload = {
      requestId: "req-test-123",
      state: "completed",
      startedAt: "2026-03-08T00:00:00.000Z",
      completedAt: "2026-03-08T00:01:00.000Z",
      durationMs: 60000,
      backend: "k8s",
      job: {
        name: generateJobName("req-test-123"),
        namespace: "joelclaw",
      },
    };

    const logs = [
      "some runner output",
      RESULT_START_MARKER,
      JSON.stringify(payload),
      RESULT_END_MARKER,
      "more trailing noise",
    ].join("\n");

    expect(extractSandboxResultFromLogs(logs)).toEqual(payload);
  });

  test("returns null when markers are absent", () => {
    expect(extractSandboxResultFromLogs("plain stdout only")).toBeNull();
  });

  test("returns null when marker payload is not valid JSON", () => {
    const logs = `${RESULT_START_MARKER}\nnot-json\n${RESULT_END_MARKER}`;
    expect(extractSandboxResultFromLogs(logs)).toBeNull();
  });
});

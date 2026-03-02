import { describe, expect, test } from "bun:test";
import { __taskTriageTestUtils } from "./task-triage";

const { parseTriageResult } = __taskTriageTestUtils;

describe("task triage output contract", () => {
  test("rejects non-json output", () => {
    const parsed = parseTriageResult("not json", new Set(["task-1"]));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe("null_output");
    }
  });

  test("rejects payload missing expected task IDs", () => {
    const raw = JSON.stringify({
      triage: [
        {
          id: "task-1",
          category: "agent-can-do-now",
          reason: "Can be automated now",
        },
      ],
    });

    const parsed = parseTriageResult(raw, new Set(["task-1", "task-2"]));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe("missing_ids");
    }
  });

  test("accepts complete valid classification payload", () => {
    const raw = JSON.stringify({
      triage: [
        {
          id: "task-1",
          category: "agent-can-do-now",
          reason: "Agent can execute this now",
          suggestedAction: "Run the command",
        },
        {
          id: "task-2",
          category: "needs-human-decision",
          reason: "Needs Joel to pick between two approaches",
        },
      ],
      insights: ["Task 1 should happen before task 2"],
    });

    const parsed = parseTriageResult(raw, new Set(["task-1", "task-2"]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.triage).toHaveLength(2);
      expect(parsed.insights).toEqual(["Task 1 should happen before task 2"]);
    }
  });
});

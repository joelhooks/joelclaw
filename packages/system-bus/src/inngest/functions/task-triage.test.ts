import { describe, expect, test } from "bun:test";
import type { Project, Task } from "../../tasks/port";
import { __taskTriageTestUtils } from "./task-triage";

const { parseTriageResult, selectHumanFacingTasks } = __taskTriageTestUtils;

const makeTask = (overrides: Partial<Task>): Task => ({
  id: "task-1",
  content: "Task",
  priority: 1,
  isRecurring: false,
  completed: false,
  labels: [],
  url: "",
  createdAt: new Date("2026-04-08T00:00:00.000Z"),
  ...overrides,
});

const projects: Project[] = [
  { id: "proj-human", name: "Joel's Tasks" },
  { id: "proj-decision", name: "Questions for Joel" },
  { id: "proj-machine", name: "Agent Work" },
];

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

describe("human-facing task selection", () => {
  test("keeps Joel-facing and decision projects, excludes machine backlog", () => {
    const selection = selectHumanFacingTasks(
      [
        makeTask({ id: "task-human", projectId: "proj-human", content: "Call the doctor" }),
        makeTask({ id: "task-decision", projectId: "proj-decision", content: "Pick launch pricing" }),
        makeTask({ id: "task-machine", projectId: "proj-machine", content: "Review memory proposal" }),
      ],
      projects,
    );

    expect(selection.visibleTasks.map((task) => task.id)).toEqual(["task-human", "task-decision"]);
    expect(selection.excludedTasks.map((task) => task.id)).toEqual(["task-machine"]);
  });

  test("accepts direct project names when ids are unavailable", () => {
    const selection = selectHumanFacingTasks(
      [
        makeTask({ id: "task-human", projectId: "Joel's Tasks", content: "Mail the form" }),
        makeTask({ id: "task-machine", projectId: "Agent Work", content: "Investigate queue noise" }),
      ],
      [],
    );

    expect(selection.visibleTasks.map((task) => task.id)).toEqual(["task-human"]);
    expect(selection.excludedTasks.map((task) => task.id)).toEqual(["task-machine"]);
  });
});

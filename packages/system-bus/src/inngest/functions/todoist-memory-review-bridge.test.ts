import { describe, expect, test } from "bun:test";
import { todoistMemoryReviewBridge } from "./todoist-memory-review-bridge";

async function executeBridge(eventData: Record<string, unknown>) {
  const sendEventCalls: unknown[][] = [];
  const step = {
    sendEvent: async (...args: unknown[]) => {
      sendEventCalls.push(args);
      return { ids: ["evt-test-1"] };
    },
  };

  const result = await (todoistMemoryReviewBridge as any).fn({
    event: { name: "todoist/task.completed", data: eventData },
    step,
  });

  return { result, sendEventCalls };
}

describe("MEM-BRIDGE-1 todoist memory review bridge", () => {
  test("emits memory/proposal.approved when memory-review task description contains proposal id", async () => {
    const { result, sendEventCalls } = await executeBridge({
      taskId: "12345",
      taskContent: "Review memory proposal",
      taskDescription: "Please review\nProposal: p-20260219-007",
      projectId: "inbox",
      labels: ["memory-review"],
    });

    const emittedApprovalEvent = sendEventCalls.some((call) => {
      const payload = call[1] as { name?: unknown; data?: { proposalId?: unknown } };
      return (
        payload?.name === "memory/proposal.approved" &&
        payload?.data?.proposalId === "p-20260219-007"
      );
    });

    expect({
      status: result?.status,
      proposalId: result?.proposalId,
      emittedApprovalEvent,
    }).toMatchObject({
      status: "approved",
      proposalId: "p-20260219-007",
      emittedApprovalEvent: true,
    });
  });

  test("noops when completed task does not have memory-review label", async () => {
    const { result, sendEventCalls } = await executeBridge({
      taskId: "12346",
      taskContent: "Unrelated task",
      taskDescription: "Proposal: p-20260219-008",
      projectId: "inbox",
      labels: ["ops"],
    });

    expect({
      status: result?.status,
      reason: result?.reason,
      sendEventCallCount: sendEventCalls.length,
    }).toMatchObject({
      status: "noop",
      reason: "missing-memory-review-label",
      sendEventCallCount: 0,
    });
  });
});

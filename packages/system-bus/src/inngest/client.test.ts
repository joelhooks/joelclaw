import { describe, expect, test } from "bun:test";
import { inngest, type Events } from "./client";

type SendEventArg = Parameters<typeof inngest.send>[0];

async function captureEvent(event: SendEventArg): Promise<SendEventArg> {
  return event;
}

describe("MEM-2 client event schema acceptance tests", () => {
  test("supports memory/proposal.approved with proposalId and approvedBy", async () => {
    const approvedData: Events["memory/proposal.approved"]["data"] = {
      proposalId: "p-20260217-001",
      approvedBy: "joel",
    };

    const result = await captureEvent({
      name: "memory/proposal.approved",
      data: approvedData,
    });

    expect(result).toMatchObject({
      name: "memory/proposal.approved",
      data: {
        proposalId: "p-20260217-001",
        approvedBy: "joel",
      },
    });
  });

  test("supports memory/proposal.rejected with proposalId, reason, and rejectedBy", async () => {
    const rejectedData: Events["memory/proposal.rejected"]["data"] = {
      proposalId: "p-20260217-002",
      reason: "Conflicts with an existing hard rule.",
      rejectedBy: "joel",
    };

    const result = await captureEvent({
      name: "memory/proposal.rejected",
      data: rejectedData,
    });

    expect(result).toMatchObject({
      name: "memory/proposal.rejected",
      data: {
        proposalId: "p-20260217-002",
        reason: "Conflicts with an existing hard rule.",
        rejectedBy: "joel",
      },
    });
  });
});

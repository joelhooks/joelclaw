import { inngest } from "../client";

const MEMORY_REVIEW_LABEL = "memory-review";
const PROPOSAL_PATTERN = /\bProposal:\s*(p-\d{8}-\d{3,})\b/u;

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hasMemoryReviewLabel(labels: unknown): boolean {
  if (!Array.isArray(labels)) return false;

  return labels.some(
    (label) =>
      typeof label === "string" && label.trim().toLowerCase() === MEMORY_REVIEW_LABEL
  );
}

function extractProposalId(description: string): string | null {
  const match = PROPOSAL_PATTERN.exec(description);
  return match?.[1] ?? null;
}

export const todoistMemoryReviewBridge = inngest.createFunction(
  {
    id: "todoist-memory-review-bridge",
    name: "Todoist Memory Review Bridge",
  },
  { event: "todoist/task.completed" },
  async ({ event, step }) => {
    const labels = (event.data as { labels?: unknown }).labels;
    if (!hasMemoryReviewLabel(labels)) {
      return { status: "noop", reason: "missing-memory-review-label" };
    }

    const description = readString(
      (event.data as { taskDescription?: unknown }).taskDescription
    ).trim();
    const proposalId = extractProposalId(description);

    if (!proposalId) {
      return { status: "noop", reason: "proposal-id-not-found", description };
    }

    await step.sendEvent("emit-proposal-approved", {
      name: "memory/proposal.approved",
      data: {
        proposalId,
        approvedBy: "joel",
      },
    });

    return {
      status: "approved",
      proposalId,
      taskId: (event.data as { taskId?: unknown }).taskId,
    };
  }
);


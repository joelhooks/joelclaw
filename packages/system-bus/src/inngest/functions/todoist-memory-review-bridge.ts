/**
 * Todoist → Memory Promotion Bridge (ADR-0021 Phase 3)
 *
 * Listens to todoist/task.completed for @memory-review tasks.
 * - Complete (no @rejected label) → memory/proposal.approved → MEMORY.md
 * - Complete WITH @rejected label → memory/proposal.rejected → archived
 * - Ignore → 7-day auto-expiry in promote.ts daily cron
 *
 * Also listens to todoist/task.deleted for explicit rejection.
 */

import { inngest } from "../client";

const MEMORY_REVIEW_LABEL = "memory-review";
const REJECTED_LABEL = "rejected";
const PROPOSAL_PATTERN = /\bProposal:\s*(p-\d{8}-\d{3,})\b/u;

function hasLabel(labels: unknown, target: string): boolean {
  if (!Array.isArray(labels)) return false;
  return labels.some(
    (l) => typeof l === "string" && l.trim().toLowerCase() === target,
  );
}

function extractProposalId(text: string): string | null {
  const match = PROPOSAL_PATTERN.exec(text);
  return match?.[1] ?? null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export const todoistMemoryReviewBridge = inngest.createFunction(
  {
    id: "todoist-memory-review-bridge",
    name: "Todoist Memory Review Bridge",
  },
  [{ event: "todoist/task.completed" }, { event: "todoist/task.deleted" }],
  async ({ event, step }) => {
    const data = event.data as Record<string, unknown>;
    const labels = data.labels;

    if (!hasLabel(labels, MEMORY_REVIEW_LABEL)) {
      return { status: "noop", reason: "not-memory-review" };
    }

    // Try description first, then task content for proposal ID
    const description = readString(data.taskDescription ?? data.description);
    const content = readString(data.taskContent ?? data.content);
    const proposalId = extractProposalId(description) ?? extractProposalId(content);

    if (!proposalId) {
      return { status: "noop", reason: "no-proposal-id", description: description.slice(0, 100) };
    }

    // Rejection: deleted task OR completed with @rejected label
    const isRejection = event.name === "todoist/task.deleted" || hasLabel(labels, REJECTED_LABEL);

    if (isRejection) {
      await step.sendEvent("emit-proposal-rejected", {
        name: "memory/proposal.rejected",
        data: {
          proposalId,
          reason: event.name === "todoist/task.deleted" ? "deleted" : "rejected-label",
        },
      });

      return { status: "rejected", proposalId, via: event.name };
    }

    // Approval: completed without @rejected
    await step.sendEvent("emit-proposal-approved", {
      name: "memory/proposal.approved",
      data: {
        proposalId,
        approvedBy: "joel",
      },
    });

    return { status: "approved", proposalId };
  },
);

import { approvalRequest, approvalResolve } from "./approval";
import {
  frontAssigneeChanged,
  frontMessageReceived,
  frontMessageSent,
} from "./front-notify";
import {
  githubPackagePublished,
  githubWorkflowRunCompleted,
} from "./github-notify";
import { todoistMemoryReviewBridge } from "./todoist-memory-review-bridge";
import {
  todoistCommentAdded,
  todoistTaskCompleted,
  todoistTaskCreated,
} from "./todoist-notify";
import { webhookSubscriptionDispatchGithubWorkflowRunCompleted } from "./webhook-subscription-dispatch";

function getFunctionId(fn: { opts?: { id?: string } }): string {
  return fn.opts?.id ?? "unknown";
}

// ADR-0089: Initial cluster-safe activation set.
export const clusterFunctionDefinitions = [
  approvalRequest,
  approvalResolve,
  todoistCommentAdded,
  todoistTaskCompleted,
  todoistTaskCreated,
  frontMessageReceived,
  frontMessageSent,
  frontAssigneeChanged,
  todoistMemoryReviewBridge,
  githubWorkflowRunCompleted,
  githubPackagePublished,
  webhookSubscriptionDispatchGithubWorkflowRunCompleted,
];

export const clusterFunctionIds = clusterFunctionDefinitions.map(getFunctionId);

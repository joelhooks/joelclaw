import { approvalRequest, approvalResolve } from "./approval";
import {
  todoistCommentAdded,
  todoistTaskCompleted,
  todoistTaskCreated,
} from "./todoist-notify";
import {
  frontMessageReceived,
  frontMessageSent,
  frontAssigneeChanged,
} from "./front-notify";
import { todoistMemoryReviewBridge } from "./todoist-memory-review-bridge";
import {
  githubWorkflowRunCompleted,
  githubPackagePublished,
} from "./github-notify";

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
];

export const clusterFunctionIds = clusterFunctionDefinitions.map(getFunctionId);

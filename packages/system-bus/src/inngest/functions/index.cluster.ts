import { approvalRequest, approvalResolve } from "./approval";
import {
  githubPackagePublished,
  githubWorkflowRunCompleted,
} from "./github-notify";
import { observeSessionFunction } from "./observe";
import { queueObserver, queueObserverRequested } from "./queue-observer";
import { swarmAgentExec } from "./swarm-agent-exec";
import { swarmOrchestrator } from "./swarm-orchestrator";
import {
  todoistCommentAdded,
  todoistTaskCompleted,
  todoistTaskCreated,
} from "./todoist-notify";
import { webhookSubscriptionDispatchGithubWorkflowRunCompleted } from "./webhook-subscription-dispatch";
import { webhookSubscriptionDispatchGeneric } from "./webhook-subscription-dispatch-generic";

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
  githubWorkflowRunCompleted,
  githubPackagePublished,
  webhookSubscriptionDispatchGithubWorkflowRunCompleted,
  webhookSubscriptionDispatchGeneric,
  observeSessionFunction,
  queueObserver,
  queueObserverRequested,
  swarmOrchestrator,
  swarmAgentExec,
];

export const clusterFunctionIds = clusterFunctionDefinitions.map(getFunctionId);

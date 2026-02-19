/**
 * Todoist webhook → gateway notification functions.
 *
 * When Todoist fires a webhook, these functions push a contextual
 * notification to the gateway pi session so the agent can act on it.
 *
 * ADR-0047: Todoist as Async Conversation Channel
 * ADR-0048: Webhook Gateway for External Service Integration
 */

import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

// ── Comment added ───────────────────────────────────────────────────

export const todoistCommentAdded = inngest.createFunction(
  { id: "todoist-comment-notify", name: "Todoist → Gateway: Comment Added" },
  { event: "todoist/comment.added" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const { taskId, commentId, commentContent, taskContent, projectId } = event.data;

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) {
        return { pushed: false, reason: "no gateway context" };
      }

      const pushResult = await gateway.notify("todoist.comment.added", {
        message: `💬 New Todoist comment on "${taskContent || `task ${taskId}`}": ${commentContent}`,
        taskId,
        commentId,
        commentContent,
        taskContent,
        projectId,
      });

      return pushResult;
    });

    return { status: result.pushed ? "notified" : "skipped", taskId, commentId, commentContent, result };
  }
);

// ── Task completed ──────────────────────────────────────────────────

export const todoistTaskCompleted = inngest.createFunction(
  { id: "todoist-task-completed-notify", name: "Todoist → Gateway: Task Completed" },
  { event: "todoist/task.completed" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const { taskId, taskContent, projectId } = event.data;

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) {
        return { pushed: false, reason: "no gateway context" };
      }

      const pushResult = await gateway.notify("todoist.task.completed", {
        message: `✅ Todoist task completed: "${taskContent || taskId}"`,
        taskId,
        taskContent,
        projectId,
      });

      return pushResult;
    });

    return { status: result.pushed ? "notified" : "skipped", taskId, taskContent, result };
  }
);

// ── Task created ────────────────────────────────────────────────────

export const todoistTaskCreated = inngest.createFunction(
  { id: "todoist-task-created-notify", name: "Todoist → Gateway: Task Created" },
  { event: "todoist/task.created" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const { taskId, taskContent, projectId, labels } = event.data;

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) {
        return { pushed: false, reason: "no gateway context" };
      }

      const pushResult = await gateway.notify("todoist.task.created", {
        message: `📝 New Todoist task: "${taskContent || taskId}"${labels?.length ? ` [${labels.join(", ")}]` : ""}`,
        taskId,
        taskContent,
        projectId,
        labels,
      });

      return pushResult;
    });

    return { status: result.pushed ? "notified" : "skipped", taskId, taskContent, result };
  }
);

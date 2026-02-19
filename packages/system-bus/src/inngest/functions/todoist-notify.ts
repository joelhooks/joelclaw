/**
 * Todoist webhook → gateway notification functions.
 *
 * When Todoist fires a webhook, these functions enrich the event
 * with full context (task title, project name) then push a notification
 * to the gateway pi session.
 *
 * ADR-0047: Todoist as Async Conversation Channel
 * ADR-0048: Webhook Gateway for External Service Integration
 */

import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

// ── Todoist API helpers ─────────────────────────────────────────────

const TODOIST_API = "https://api.todoist.com/api/v1";

function getApiToken(): string | undefined {
  return process.env.TODOIST_API_TOKEN;
}

async function fetchTask(taskId: string): Promise<{ content: string; projectId: string; labels: string[] } | null> {
  const token = getApiToken();
  if (!token || !taskId) return null;

  try {
    const res = await fetch(`${TODOIST_API}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const task = (await res.json()) as Record<string, unknown>;
    return {
      content: String(task.content ?? ""),
      projectId: String(task.project_id ?? ""),
      labels: Array.isArray(task.labels) ? task.labels : [],
    };
  } catch {
    return null;
  }
}

async function fetchProject(projectId: string): Promise<string | null> {
  const token = getApiToken();
  if (!token || !projectId) return null;

  try {
    const res = await fetch(`${TODOIST_API}/projects/${projectId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const project = (await res.json()) as Record<string, unknown>;
    return String(project.name ?? "");
  } catch {
    return null;
  }
}

// ── Comment added ───────────────────────────────────────────────────

export const todoistCommentAdded = inngest.createFunction(
  { id: "todoist-comment-notify", name: "Todoist → Gateway: Comment Added" },
  { event: "todoist/comment.added" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const { taskId, commentId, commentContent, taskContent: rawTaskContent, projectId: rawProjectId } = event.data;

    // Enrich: fetch task + project names (webhook payload doesn't include them reliably)
    const context = await step.run("enrich-context", async () => {
      const task = await fetchTask(taskId);
      const taskContent = task?.content || rawTaskContent || "";
      const projectId = task?.projectId || rawProjectId || "";
      const projectName = projectId ? await fetchProject(projectId) : null;
      return { taskContent, projectId, projectName, labels: task?.labels ?? [] };
    });

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) {
        return { pushed: false, reason: "no gateway context" };
      }

      const projectTag = context.projectName ? ` (${context.projectName})` : "";
      return await gateway.notify("todoist.comment.added", {
        message: `💬 New comment on "${context.taskContent || `task ${taskId}`}"${projectTag}: ${commentContent}`,
        taskId,
        commentId,
        commentContent,
        taskContent: context.taskContent,
        projectId: context.projectId,
        projectName: context.projectName,
        labels: context.labels,
      });
    });

    return {
      status: result.pushed ? "notified" : "skipped",
      taskId,
      commentId,
      commentContent,
      taskContent: context.taskContent,
      projectName: context.projectName,
      result,
    };
  }
);

// ── Task completed ──────────────────────────────────────────────────

export const todoistTaskCompleted = inngest.createFunction(
  { id: "todoist-task-completed-notify", name: "Todoist → Gateway: Task Completed" },
  { event: "todoist/task.completed" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const { taskId, taskContent: rawTaskContent, projectId: rawProjectId } = event.data;

    const context = await step.run("enrich-context", async () => {
      const projectId = rawProjectId || "";
      const projectName = projectId ? await fetchProject(projectId) : null;
      // Task content comes from event_data.content for item:completed — usually reliable
      return { taskContent: rawTaskContent || "", projectId, projectName };
    });

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) {
        return { pushed: false, reason: "no gateway context" };
      }

      const projectTag = context.projectName ? ` (${context.projectName})` : "";
      return await gateway.notify("todoist.task.completed", {
        message: `✅ Task completed: "${context.taskContent || taskId}"${projectTag}`,
        taskId,
        taskContent: context.taskContent,
        projectId: context.projectId,
        projectName: context.projectName,
      });
    });

    return {
      status: result.pushed ? "notified" : "skipped",
      taskId,
      taskContent: context.taskContent,
      projectName: context.projectName,
      result,
    };
  }
);

// ── Task created ────────────────────────────────────────────────────

export const todoistTaskCreated = inngest.createFunction(
  { id: "todoist-task-created-notify", name: "Todoist → Gateway: Task Created" },
  { event: "todoist/task.created" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const { taskId, taskContent: rawTaskContent, projectId: rawProjectId, labels: rawLabels } = event.data;

    const context = await step.run("enrich-context", async () => {
      const projectId = rawProjectId || "";
      const projectName = projectId ? await fetchProject(projectId) : null;
      const labels = Array.isArray(rawLabels) ? rawLabels : [];
      return { taskContent: rawTaskContent || "", projectId, projectName, labels };
    });

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) {
        return { pushed: false, reason: "no gateway context" };
      }

      const projectTag = context.projectName ? ` (${context.projectName})` : "";
      const labelTag = context.labels?.length ? ` [${context.labels.join(", ")}]` : "";
      return await gateway.notify("todoist.task.created", {
        message: `📝 New task: "${context.taskContent || taskId}"${projectTag}${labelTag}`,
        taskId,
        taskContent: context.taskContent,
        projectId: context.projectId,
        projectName: context.projectName,
        labels: context.labels,
      });
    });

    return {
      status: result.pushed ? "notified" : "skipped",
      taskId,
      taskContent: context.taskContent,
      projectName: context.projectName,
      result,
    };
  }
);

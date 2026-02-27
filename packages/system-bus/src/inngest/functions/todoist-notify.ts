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

import { NonRetriableError } from "inngest";
import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

// ── Todoist API helpers ─────────────────────────────────────────────

const TODOIST_API = "https://api.todoist.com/api/v1";

function getApiToken(): string | undefined {
  return process.env.TODOIST_API_TOKEN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractResults(payload: unknown): Array<Record<string, unknown>> {
  if (isRecord(payload)) {
    const results = payload.results;
    if (Array.isArray(results)) {
      return results.filter(isRecord);
    }
    return [payload];
  }
  return [];
}

async function throwIfHtmlResponse(response: Response, endpoint: string): Promise<void> {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/html")) {
    return;
  }

  const body = await response.text();
  console.error("[todoist-notify] Todoist API returned HTML instead of JSON", {
    endpoint,
    status: response.status,
    contentType,
    bodyPreview: body.slice(0, 500),
  });
  throw new NonRetriableError(`Todoist API returned HTML for ${endpoint} (${response.status})`);
}

async function parseJsonResponse(response: Response, endpoint: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    console.error("[todoist-notify] Failed to parse Todoist JSON response", {
      endpoint,
      status: response.status,
      contentType: response.headers.get("content-type") || "unknown",
      error: error instanceof Error ? error.message : String(error),
    });
    throw new NonRetriableError(`Todoist API JSON parsing failed for ${endpoint}`);
  }
}

async function fetchTask(taskId: string): Promise<{ content: string; projectId: string; labels: string[] } | null> {
  const token = getApiToken();
  if (!token || !taskId) return null;

  const endpoint = `/tasks?filter=${encodeURIComponent(`id:${taskId}`)}&limit=1`;
  try {
    const res = await fetch(`${TODOIST_API}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await throwIfHtmlResponse(res, endpoint);
    if (!res.ok) return null;
    const payload = await parseJsonResponse(res, endpoint);
    const task = extractResults(payload)[0];
    if (!task) return null;
    return {
      content: String(task.content ?? ""),
      projectId: String(task.project_id ?? ""),
      labels: Array.isArray(task.labels)
        ? task.labels.filter((label): label is string => typeof label === "string")
        : [],
    };
  } catch (error) {
    if (error instanceof NonRetriableError) throw error;
    return null;
  }
}

async function fetchProject(projectId: string): Promise<string | null> {
  const token = getApiToken();
  if (!token || !projectId) return null;

  const endpoint = `/projects/${projectId}`;
  try {
    const res = await fetch(`${TODOIST_API}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await throwIfHtmlResponse(res, endpoint);
    if (!res.ok) return null;
    const payload = await parseJsonResponse(res, endpoint);
    const project = extractResults(payload)[0];
    if (!project) return null;
    return String(project.name ?? "");
  } catch (error) {
    if (error instanceof NonRetriableError) throw error;
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

    // Comment = instruction. Context + instruction + IDs. Agent knows how to triage (SOUL.md § Agency).
    const agentPrompt = await step.run("build-prompt", () => {
      const projectTag = context.projectName ? ` (${context.projectName})` : "";
      const labelTag = context.labels?.length ? ` [${context.labels.join(", ")}]` : "";
      return [
        `## 📋 Todoist Instruction`,
        "",
        `**Task**: "${context.taskContent || `task ${taskId}`}"${projectTag}${labelTag}`,
        `**Instruction**: ${commentContent}`,
        `Task \`${taskId}\` · Comment \`${commentId}\`${context.projectId ? ` · Project \`${context.projectId}\`` : ""}`,
      ].filter(Boolean).join("\n");
    });

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) {
        return { pushed: false, reason: "no gateway context" };
      }

      return await gateway.notify("todoist.comment.added", {
        prompt: agentPrompt,
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

    const agentPrompt = await step.run("build-prompt", () => {
      const projectTag = context.projectName ? ` (${context.projectName})` : "";
      return [
        `## ✅ Task Completed`,
        "",
        `**Task**: "${context.taskContent || taskId}"${projectTag}`,
        "",
        `Is there follow-up work? A next step to create, a calendar event to remove, something to notify about?`,
        `If nothing obvious, acknowledge briefly.`,
      ].join("\n");
    });

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) {
        return { pushed: false, reason: "no gateway context" };
      }

      return await gateway.notify("todoist.task.completed", {
        prompt: agentPrompt,
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

    const agentPrompt = await step.run("build-prompt", () => {
      const projectTag = context.projectName ? ` (${context.projectName})` : "";
      const labelTag = context.labels?.length ? `\n**Labels**: ${context.labels.join(", ")}` : "";
      return [
        `## 📝 New Task`,
        "",
        `**Task**: "${context.taskContent || taskId}"${projectTag}${labelTag}`,
        "",
        `Can I help with this? Does it need scheduling, breakdown into subtasks, research, or context from the vault?`,
        `If it's just a note Joel created for himself, acknowledge briefly.`,
      ].join("\n");
    });

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) {
        return { pushed: false, reason: "no gateway context" };
      }

      return await gateway.notify("todoist.task.created", {
        prompt: agentPrompt,
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

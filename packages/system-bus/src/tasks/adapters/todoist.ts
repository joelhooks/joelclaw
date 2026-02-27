import { markTodoistTaskAgentClosed, unmarkTodoistTaskAgentClosed } from "../../lib/todoist-agent-closed";
import type {
  Change,
  CreateTaskInput,
  Label,
  Project,
  Task,
  TaskFilter,
  TaskPort,
  UpdateTaskInput,
} from "../port";

type TodoistEnvelope = {
  ok?: boolean;
  result?: unknown;
  error?: unknown;
};

type TodoistTaskLike = Record<string, unknown>;

function requireTodoistToken(): string {
  const token = process.env.TODOIST_API_TOKEN;
  if (!token) {
    throw new Error("TODOIST_API_TOKEN env var is required");
  }
  return token;
}

function formatDateForTodoist(input: Date): string {
  return input.toISOString();
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function normalizeTask(taskLike: TodoistTaskLike): Task {
  const dueObject = (taskLike.due ?? {}) as Record<string, unknown>;
  const deadlineObject = (taskLike.deadline ?? {}) as Record<string, unknown>;

  const dueDate = parseDate(
    dueObject.datetime ?? dueObject.date ?? taskLike.due_datetime ?? taskLike.due_date
  );
  const deadlineDate = parseDate(
    deadlineObject.date ?? taskLike.deadline_date
  );

  const labels = Array.isArray(taskLike.labels)
    ? taskLike.labels.filter((label): label is string => typeof label === "string")
    : [];

  const priorityNumber = Number(taskLike.priority ?? 1);
  const safePriority = (priorityNumber >= 1 && priorityNumber <= 4
    ? priorityNumber
    : 1) as 1 | 2 | 3 | 4;

  return {
    id: String(taskLike.id ?? ""),
    content: String(taskLike.content ?? ""),
    description: typeof taskLike.description === "string" ? taskLike.description : undefined,
    priority: safePriority,
    due: dueDate,
    dueString: typeof dueObject.string === "string"
      ? dueObject.string
      : (typeof taskLike.due_string === "string" ? taskLike.due_string : undefined),
    isRecurring: Boolean(dueObject.is_recurring ?? taskLike.is_recurring),
    deadline: deadlineDate,
    completed: Boolean(taskLike.completed ?? taskLike.is_completed),
    projectId: typeof taskLike.project_id === "string"
      ? taskLike.project_id
      : (typeof taskLike.projectId === "string" ? taskLike.projectId : undefined),
    sectionId: typeof taskLike.section_id === "string"
      ? taskLike.section_id
      : (typeof taskLike.sectionId === "string" ? taskLike.sectionId : undefined),
    parentId: typeof taskLike.parent_id === "string"
      ? taskLike.parent_id
      : (typeof taskLike.parentId === "string" ? taskLike.parentId : undefined),
    labels,
    url: typeof taskLike.url === "string" ? taskLike.url : "",
    createdAt: parseDate(taskLike.created_at) ?? new Date(0),
  };
}

function extractArray(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") {
    const data = result as Record<string, unknown>;
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.tasks)) return data.tasks;
    if (Array.isArray(data.results)) return data.results;
  }
  return [];
}

function buildListFilter(filter?: TaskFilter): string | undefined {
  if (!filter) return undefined;

  if (filter.filter) return filter.filter;

  const parts: string[] = [];
  if (filter.inbox) parts.push("#Inbox");
  if (filter.today) parts.push("today");
  if (filter.completed) parts.push("completed");
  if (filter.search) parts.push(`search: ${filter.search}`);

  return parts.length > 0 ? parts.join(" & ") : undefined;
}

export class TodoistTaskAdapter implements TaskPort {
  constructor(private readonly cliBin = "todoist-cli") {}

  private async runCli(args: string[]): Promise<unknown> {
    const token = requireTodoistToken();
    const proc = Bun.spawn([this.cliBin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TODOIST_API_TOKEN: token,
      },
    });

    const [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    const raw = stdoutText.trim();

    if (exitCode !== 0) {
      throw new Error(
        `todoist-cli ${args.join(" ")} failed (${exitCode}): ${stderrText.trim() || raw || "unknown error"}`
      );
    }

    if (!raw) {
      return null;
    }

    let envelope: TodoistEnvelope;
    try {
      envelope = JSON.parse(raw) as TodoistEnvelope;
    } catch {
      throw new Error(`todoist-cli returned invalid JSON: ${raw.slice(0, 400)}`);
    }

    if (envelope.ok !== true) {
      const errorText = typeof envelope.error === "string"
        ? envelope.error
        : JSON.stringify(envelope.error ?? "unknown error");
      throw new Error(`todoist-cli command failed: ${errorText}`);
    }

    return envelope.result;
  }

  async listTasks(filter?: TaskFilter): Promise<Task[]> {
    const args = ["list"];
    if (filter?.label) args.push("--label", filter.label);
    if (filter?.project) args.push("--project", filter.project);

    const mergedFilter = buildListFilter(filter);
    if (mergedFilter) args.push("--filter", mergedFilter);

    const result = await this.runCli(args);
    const tasks = extractArray(result);
    return tasks
      .filter((item): item is TodoistTaskLike => Boolean(item && typeof item === "object"))
      .map(normalizeTask);
  }

  async getTask(id: string): Promise<Task | null> {
    const result = await this.runCli(["show", id]);
    if (!result || typeof result !== "object") return null;
    return normalizeTask(result as TodoistTaskLike);
  }

  async createTask(task: CreateTaskInput): Promise<Task> {
    const args = ["add", task.content];
    if (task.description) args.push("--description", task.description);
    if (task.priority) args.push("--priority", String(task.priority));
    if (task.dueString) args.push("--due", task.dueString);
    else if (task.due) args.push("--due", formatDateForTodoist(task.due));
    if (task.deadline) args.push("--deadline", task.deadline.toISOString().slice(0, 10));
    if (task.projectId) args.push("--project", task.projectId);
    if (task.sectionId) args.push("--section", task.sectionId);
    if (task.parentId) args.push("--parent", task.parentId);
    if (task.labels && task.labels.length > 0) args.push("--labels", task.labels.join(","));

    const result = await this.runCli(args);
    if (!result || typeof result !== "object") {
      throw new Error("todoist-cli add returned an empty task payload");
    }
    return normalizeTask(result as TodoistTaskLike);
  }

  async updateTask(id: string, updates: UpdateTaskInput): Promise<Task> {
    const args = ["update", id];
    if (updates.content) args.push("--content", updates.content);
    if (updates.description) args.push("--description", updates.description);
    if (updates.priority) args.push("--priority", String(updates.priority));
    if (updates.dueString) args.push("--due", updates.dueString);
    else if (updates.due) args.push("--due", formatDateForTodoist(updates.due));
    if (updates.deadline) args.push("--deadline", updates.deadline.toISOString().slice(0, 10));
    if (updates.sectionId) args.push("--section", updates.sectionId);
    if (updates.parentId) args.push("--parent", updates.parentId);
    if (updates.labels && updates.labels.length > 0) args.push("--labels", updates.labels.join(","));

    await this.runCli(args);

    if (updates.projectId) {
      await this.moveToProject(id, updates.projectId);
    }

    const task = await this.getTask(id);
    if (!task) {
      throw new Error(`Failed to fetch updated task ${id}`);
    }
    return task;
  }

  async completeTask(id: string): Promise<void> {
    await markTodoistTaskAgentClosed(id);
    try {
      await this.runCli(["complete", id]);
    } catch (error) {
      await unmarkTodoistTaskAgentClosed(id).catch(() => {});
      throw error;
    }
  }

  async deleteTask(id: string): Promise<void> {
    await this.runCli(["delete", id]);
  }

  async listProjects(): Promise<Project[]> {
    const result = await this.runCli(["projects"]);
    const projects = extractArray(result);
    return projects
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((project) => ({
        id: String(project.id ?? ""),
        name: String(project.name ?? ""),
      }));
  }

  async listLabels(): Promise<Label[]> {
    const result = await this.runCli(["labels"]);
    const labels = extractArray(result);
    return labels
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((label) => ({
        id: String(label.id ?? ""),
        name: String(label.name ?? ""),
      }));
  }

  async moveToProject(taskId: string, projectId: string): Promise<void> {
    await this.runCli(["move", taskId, "--project", projectId]);
  }

  async sync(): Promise<Change[]> {
    // todoist-cli currently exposes list/show/update primitives, not a change feed.
    return [];
  }
}

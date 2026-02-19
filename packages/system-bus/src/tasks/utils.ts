/**
 * Task-awareness utilities for check functions.
 * ADR-0045: TaskPort. ADR-0062: Task-aware triage.
 *
 * Any check function can query current tasks before escalating to gateway,
 * preventing duplicate notifications for things that already have tasks.
 */

import { TodoistTaskAdapter } from "./adapters/todoist";
import type { Task } from "./port";

let cachedTasks: { tasks: Task[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache

/**
 * Get current open tasks with a short TTL cache.
 * Multiple check functions running in the same heartbeat cycle
 * can share the same task list without hammering Todoist.
 */
export async function getCurrentTasks(): Promise<Task[]> {
  const now = Date.now();
  if (cachedTasks && now - cachedTasks.fetchedAt < CACHE_TTL_MS) {
    return cachedTasks.tasks;
  }

  try {
    const adapter = new TodoistTaskAdapter();
    const tasks = await adapter.listTasks();
    cachedTasks = { tasks, fetchedAt: now };
    return tasks;
  } catch {
    return cachedTasks?.tasks ?? [];
  }
}

/**
 * Check if a task already exists matching a search string.
 * Case-insensitive substring match against content + description.
 */
export function hasTaskMatching(tasks: Task[], search: string): boolean {
  const lower = search.toLowerCase();
  return tasks.some(
    (t) =>
      t.content.toLowerCase().includes(lower) ||
      (t.description?.toLowerCase().includes(lower) ?? false),
  );
}

/**
 * Check if any task has a specific label.
 */
export function tasksWithLabel(tasks: Task[], label: string): Task[] {
  return tasks.filter((t) => t.labels.includes(label));
}

/**
 * Get tasks in a specific project by name or ID.
 */
export function tasksInProject(tasks: Task[], projectIdOrName: string): Task[] {
  const lower = projectIdOrName.toLowerCase();
  return tasks.filter(
    (t) =>
      t.projectId === projectIdOrName ||
      t.projectId?.toLowerCase() === lower,
  );
}

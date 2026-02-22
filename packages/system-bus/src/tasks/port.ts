/**
 * Task management port (hexagonal architecture).
 * ADR-0045: Task Management via Ports and Adapters
 */

export type TaskFilter = {
  inbox?: boolean;
  today?: boolean;
  project?: string;
  label?: string;
  /** Todoist filter syntax (Pro) */
  filter?: string;
  completed?: boolean;
  search?: string;
};

export type Task = {
  id: string;
  content: string;
  description?: string;
  priority: 1 | 2 | 3 | 4;
  due?: Date;
  dueString?: string;
  isRecurring: boolean;
  deadline?: Date;
  completed: boolean;
  projectId?: string;
  sectionId?: string;
  parentId?: string;
  labels: string[];
  url: string;
  createdAt: Date;
};

export type CreateTaskInput = {
  content: string;
  description?: string;
  priority?: 1 | 2 | 3 | 4;
  due?: Date;
  dueString?: string;
  deadline?: Date;
  projectId?: string;
  sectionId?: string;
  parentId?: string;
  labels?: string[];
};

export type UpdateTaskInput = {
  content?: string;
  description?: string;
  priority?: 1 | 2 | 3 | 4;
  due?: Date;
  dueString?: string;
  deadline?: Date;
  projectId?: string;
  sectionId?: string;
  parentId?: string;
  labels?: string[];
};

export type Project = {
  id: string;
  name: string;
};

export type Label = {
  id: string;
  name: string;
};

export type Change = {
  /** e.g. 'task.created', 'task.completed', 'task.moved' */
  type: string;
  entityId: string;
  timestamp: Date;
  details: Record<string, unknown>;
};

export interface TaskPort {
  // Core CRUD
  listTasks(filter?: TaskFilter): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(task: CreateTaskInput): Promise<Task>;
  updateTask(id: string, updates: UpdateTaskInput): Promise<Task>;
  completeTask(id: string): Promise<void>;
  deleteTask(id: string): Promise<void>;

  // Organization
  listProjects(): Promise<Project[]>;
  listLabels(): Promise<Label[]>;
  moveToProject(taskId: string, projectId: string): Promise<void>;

  // Sync
  sync(): Promise<Change[]>;
}

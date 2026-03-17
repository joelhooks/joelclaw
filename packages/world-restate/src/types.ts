/**
 * Core types for the Vercel Workflow DevKit World interface
 * Backed by Restate for event-sourced workflow execution
 */

export interface WorkflowRun {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
  finishedAt?: Date;
  output?: any;
  error?: string;
  metadata?: Record<string, any>;
  version?: string;
  deploymentId?: string;
  parentRunId?: string;
}

export interface Step {
  id: string;
  runId: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
  finishedAt?: Date;
  input?: any;
  output?: any;
  error?: string;
  retryCount: number;
  maxRetries?: number;
  metadata?: Record<string, any>;
  parentStepId?: string;
  type: 'step' | 'invoke' | 'sleep' | 'waitForEvent' | 'sendEvent';
}

export interface Hook {
  id: string;
  token: string;
  runId: string;
  stepId?: string;
  event: string;
  createdAt: Date;
  expiresAt?: Date;
  fulfilled: boolean;
  fulfilledAt?: Date;
  payload?: any;
  metadata?: Record<string, any>;
}

export interface Event {
  id: string;
  name: string;
  data: any;
  timestamp: Date;
  runId?: string;
  stepId?: string;
  hookId?: string;
  source: 'user' | 'system' | 'workflow' | 'external';
  metadata?: Record<string, any>;
  version: number;
  causationId?: string;
  correlationId?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    pageSize: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface EventResult {
  id: string;
  accepted: boolean;
  reason?: string;
  triggeredRuns?: string[];
}

export interface QueueOptions {
  delay?: number;
  priority?: number;
  maxAttempts?: number;
  retryPolicy?: 'exponential' | 'linear' | 'fixed';
  retryDelay?: number;
  timeout?: number;
  headers?: Record<string, string>;
  metadata?: Record<string, any>;
}

export interface QueueMessage {
  id: string;
  name: string;
  data: any;
  options?: QueueOptions;
  timestamp: Date;
  attempts: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  error?: string;
  nextAttemptAt?: Date;
}

export interface QueueHandler {
  (message: any, metadata: { id: string; attempts: number }): Promise<any>;
}

export interface StreamChunk {
  id: string;
  runId: string;
  streamId: string;
  data: any;
  timestamp: Date;
  sequence: number;
  type: 'data' | 'close' | 'error';
  metadata?: Record<string, any>;
}

/**
 * Storage interface for event-sourced workflow data
 */
export interface Storage {
  // Runs
  runs: {
    get(id: string): Promise<WorkflowRun | null>;
    list(options?: {
      status?: WorkflowRun['status'][];
      name?: string;
      deploymentId?: string;
      page?: number;
      pageSize?: number;
      sort?: 'createdAt' | 'updatedAt';
      order?: 'asc' | 'desc';
    }): Promise<PaginatedResponse<WorkflowRun>>;
  };

  // Steps
  steps: {
    get(id: string): Promise<Step | null>;
    list(runId: string, options?: {
      status?: Step['status'][];
      type?: Step['type'][];
      page?: number;
      pageSize?: number;
    }): Promise<PaginatedResponse<Step>>;
  };

  // Events (append-only, event-sourced)
  events: {
    create(event: Omit<Event, 'id' | 'timestamp' | 'version'>): Promise<EventResult>;
    list(options?: {
      runId?: string;
      stepId?: string;
      name?: string;
      source?: Event['source'][];
      since?: Date;
      until?: Date;
      page?: number;
      pageSize?: number;
    }): Promise<PaginatedResponse<Event>>;
  };

  // Hooks for external event waiting
  hooks: {
    get(id: string): Promise<Hook | null>;
    getByToken(token: string): Promise<Hook | null>;
    list(runId: string, options?: {
      fulfilled?: boolean;
      event?: string;
      page?: number;
      pageSize?: number;
    }): Promise<PaginatedResponse<Hook>>;
  };
}

/**
 * Queue interface for workflow and step execution
 */
export interface Queue {
  getDeploymentId(): string;
  queue(name: string, message: any, options?: QueueOptions): Promise<{ id: string }>;
  createQueueHandler(prefix: string, handler: QueueHandler): Promise<void>;
}

/**
 * Streamer interface for real-time data streaming
 */
export interface Streamer {
  writeToStream(runId: string, streamId: string, data: any): Promise<void>;
  closeStream(runId: string, streamId: string): Promise<void>;
  readFromStream(runId: string, streamId: string, options?: {
    since?: number;
    limit?: number;
  }): Promise<StreamChunk[]>;
  listStreamsByRunId(runId: string): Promise<string[]>;
}

/**
 * Main World interface that combines all three subsystems
 */
export interface World extends Storage, Queue, Streamer {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  health?(): Promise<{ status: 'healthy' | 'unhealthy'; details?: Record<string, any> }>;
}
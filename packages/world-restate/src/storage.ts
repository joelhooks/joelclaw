/**
 * Event-sourced storage implementation for workflow runs, steps, hooks, and events
 * All mutations flow through events.create() for true event sourcing
 */

import crypto from 'crypto';
import type {
  Storage,
  WorkflowRun,
  Step,
  Hook,
  Event,
  EventResult,
  PaginatedResponse,
} from './types.js';

export class RestateStorage implements Storage {
  private events = new Map<string, Event>();
  private runs = new Map<string, WorkflowRun>();
  private steps = new Map<string, Step>();
  private hooks = new Map<string, Hook>();
  private eventCounter = 0;

  constructor() {
    // Initialize with system start event
    this.applyEvent({
      id: crypto.randomUUID(),
      name: 'storage.initialized',
      data: { timestamp: new Date() },
      timestamp: new Date(),
      source: 'system',
      version: 1,
    });
  }

  // Runs interface
  runs = {
    get: async (id: string): Promise<WorkflowRun | null> => {
      return this.runs.get(id) || null;
    },

    list: async (options: {
      status?: WorkflowRun['status'][];
      name?: string;
      deploymentId?: string;
      page?: number;
      pageSize?: number;
      sort?: 'createdAt' | 'updatedAt';
      order?: 'asc' | 'desc';
    } = {}): Promise<PaginatedResponse<WorkflowRun>> => {
      const {
        status,
        name,
        deploymentId,
        page = 1,
        pageSize = 50,
        sort = 'createdAt',
        order = 'desc',
      } = options;

      let filtered = Array.from(this.runs.values());

      // Apply filters
      if (status?.length) {
        filtered = filtered.filter(run => status.includes(run.status));
      }
      if (name) {
        filtered = filtered.filter(run => run.name.includes(name));
      }
      if (deploymentId) {
        filtered = filtered.filter(run => run.deploymentId === deploymentId);
      }

      // Sort
      filtered.sort((a, b) => {
        const aVal = a[sort];
        const bVal = b[sort];
        const result = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        return order === 'desc' ? -result : result;
      });

      // Paginate
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const data = filtered.slice(start, end);

      return {
        data,
        pagination: {
          total: filtered.length,
          page,
          pageSize,
          hasNext: end < filtered.length,
          hasPrev: page > 1,
        },
      };
    },
  };

  // Steps interface
  steps = {
    get: async (id: string): Promise<Step | null> => {
      return this.steps.get(id) || null;
    },

    list: async (
      runId: string,
      options: {
        status?: Step['status'][];
        type?: Step['type'][];
        page?: number;
        pageSize?: number;
      } = {}
    ): Promise<PaginatedResponse<Step>> => {
      const { status, type, page = 1, pageSize = 50 } = options;

      let filtered = Array.from(this.steps.values()).filter(step => step.runId === runId);

      // Apply filters
      if (status?.length) {
        filtered = filtered.filter(step => status.includes(step.status));
      }
      if (type?.length) {
        filtered = filtered.filter(step => type.includes(step.type));
      }

      // Sort by creation time
      filtered.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      // Paginate
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const data = filtered.slice(start, end);

      return {
        data,
        pagination: {
          total: filtered.length,
          page,
          pageSize,
          hasNext: end < filtered.length,
          hasPrev: page > 1,
        },
      };
    },
  };

  // Events interface (append-only)
  events = {
    create: async (eventData: Omit<Event, 'id' | 'timestamp' | 'version'>): Promise<EventResult> => {
      const event: Event = {
        ...eventData,
        id: crypto.randomUUID(),
        timestamp: new Date(),
        version: ++this.eventCounter,
      };

      this.applyEvent(event);
      
      const triggeredRuns = this.getTriggeredRuns(event);

      return {
        id: event.id,
        accepted: true,
        triggeredRuns,
      };
    },

    list: async (options: {
      runId?: string;
      stepId?: string;
      name?: string;
      source?: Event['source'][];
      since?: Date;
      until?: Date;
      page?: number;
      pageSize?: number;
    } = {}): Promise<PaginatedResponse<Event>> => {
      const {
        runId,
        stepId,
        name,
        source,
        since,
        until,
        page = 1,
        pageSize = 50,
      } = options;

      let filtered = Array.from(this.events.values());

      // Apply filters
      if (runId) {
        filtered = filtered.filter(event => event.runId === runId);
      }
      if (stepId) {
        filtered = filtered.filter(event => event.stepId === stepId);
      }
      if (name) {
        filtered = filtered.filter(event => event.name.includes(name));
      }
      if (source?.length) {
        filtered = filtered.filter(event => source.includes(event.source));
      }
      if (since) {
        filtered = filtered.filter(event => event.timestamp >= since);
      }
      if (until) {
        filtered = filtered.filter(event => event.timestamp <= until);
      }

      // Sort by version (insertion order)
      filtered.sort((a, b) => b.version - a.version);

      // Paginate
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const data = filtered.slice(start, end);

      return {
        data,
        pagination: {
          total: filtered.length,
          page,
          pageSize,
          hasNext: end < filtered.length,
          hasPrev: page > 1,
        },
      };
    },
  };

  // Hooks interface
  hooks = {
    get: async (id: string): Promise<Hook | null> => {
      return this.hooks.get(id) || null;
    },

    getByToken: async (token: string): Promise<Hook | null> => {
      for (const hook of this.hooks.values()) {
        if (hook.token === token) {
          return hook;
        }
      }
      return null;
    },

    list: async (
      runId: string,
      options: {
        fulfilled?: boolean;
        event?: string;
        page?: number;
        pageSize?: number;
      } = {}
    ): Promise<PaginatedResponse<Hook>> => {
      const { fulfilled, event, page = 1, pageSize = 50 } = options;

      let filtered = Array.from(this.hooks.values()).filter(hook => hook.runId === runId);

      // Apply filters
      if (fulfilled !== undefined) {
        filtered = filtered.filter(hook => hook.fulfilled === fulfilled);
      }
      if (event) {
        filtered = filtered.filter(hook => hook.event === event);
      }

      // Sort by creation time
      filtered.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      // Paginate
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const data = filtered.slice(start, end);

      return {
        data,
        pagination: {
          total: filtered.length,
          page,
          pageSize,
          hasNext: end < filtered.length,
          hasPrev: page > 1,
        },
      };
    },
  };

  /**
   * Apply event to update materialized views (runs, steps, hooks)
   */
  private applyEvent(event: Event): void {
    this.events.set(event.id, event);

    // Apply event to materialized views based on event name
    switch (event.name) {
      case 'run.created':
        this.handleRunCreated(event);
        break;
      case 'run.started':
        this.handleRunStarted(event);
        break;
      case 'run.completed':
      case 'run.failed':
      case 'run.cancelled':
        this.handleRunFinished(event);
        break;
      case 'step.created':
        this.handleStepCreated(event);
        break;
      case 'step.started':
        this.handleStepStarted(event);
        break;
      case 'step.completed':
      case 'step.failed':
      case 'step.cancelled':
        this.handleStepFinished(event);
        break;
      case 'hook.created':
        this.handleHookCreated(event);
        break;
      case 'hook.fulfilled':
        this.handleHookFulfilled(event);
        break;
    }
  }

  private handleRunCreated(event: Event): void {
    const run: WorkflowRun = {
      id: event.runId!,
      name: event.data.name,
      status: 'pending',
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
      deploymentId: event.data.deploymentId,
      parentRunId: event.data.parentRunId,
      metadata: event.data.metadata,
      version: event.data.version,
    };
    this.runs.set(run.id, run);
  }

  private handleRunStarted(event: Event): void {
    const run = this.runs.get(event.runId!);
    if (run) {
      run.status = 'running';
      run.updatedAt = event.timestamp;
      this.runs.set(run.id, run);
    }
  }

  private handleRunFinished(event: Event): void {
    const run = this.runs.get(event.runId!);
    if (run) {
      run.status = event.name.split('.')[1] as WorkflowRun['status'];
      run.updatedAt = event.timestamp;
      run.finishedAt = event.timestamp;
      run.output = event.data.output;
      run.error = event.data.error;
      this.runs.set(run.id, run);
    }
  }

  private handleStepCreated(event: Event): void {
    const step: Step = {
      id: event.stepId!,
      runId: event.runId!,
      name: event.data.name,
      status: 'pending',
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
      input: event.data.input,
      retryCount: 0,
      maxRetries: event.data.maxRetries,
      metadata: event.data.metadata,
      parentStepId: event.data.parentStepId,
      type: event.data.type || 'step',
    };
    this.steps.set(step.id, step);
  }

  private handleStepStarted(event: Event): void {
    const step = this.steps.get(event.stepId!);
    if (step) {
      step.status = 'running';
      step.updatedAt = event.timestamp;
      this.steps.set(step.id, step);
    }
  }

  private handleStepFinished(event: Event): void {
    const step = this.steps.get(event.stepId!);
    if (step) {
      step.status = event.name.split('.')[1] as Step['status'];
      step.updatedAt = event.timestamp;
      step.finishedAt = event.timestamp;
      step.output = event.data.output;
      step.error = event.data.error;
      step.retryCount = event.data.retryCount || step.retryCount;
      this.steps.set(step.id, step);
    }
  }

  private handleHookCreated(event: Event): void {
    const hook: Hook = {
      id: event.hookId || crypto.randomUUID(),
      token: event.data.token,
      runId: event.runId!,
      stepId: event.stepId,
      event: event.data.event,
      createdAt: event.timestamp,
      fulfilled: false,
      metadata: event.data.metadata,
      expiresAt: event.data.expiresAt ? new Date(event.data.expiresAt) : undefined,
    };
    this.hooks.set(hook.id, hook);
  }

  private handleHookFulfilled(event: Event): void {
    const hook = this.hooks.get(event.hookId!);
    if (hook) {
      hook.fulfilled = true;
      hook.fulfilledAt = event.timestamp;
      hook.payload = event.data.payload;
      this.hooks.set(hook.id, hook);
    }
  }

  private getTriggeredRuns(event: Event): string[] {
    // Simple implementation - in practice this would match against 
    // workflow definitions and trigger patterns
    const triggered: string[] = [];
    
    if (event.name.startsWith('workflow.trigger.')) {
      // Create a new run for triggered workflows
      const runId = crypto.randomUUID();
      triggered.push(runId);
    }
    
    return triggered;
  }
}
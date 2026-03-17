/**
 * @joelclaw/world-restate - Vercel Workflow DevKit World interface backed by Restate
 * 
 * Provides event-sourced storage, Restate-backed queuing, and in-memory streaming
 * for durable workflow execution outside of Vercel's infrastructure.
 */

import { RestateStorage } from './storage.js';
import { RestateQueue } from './queue.js';
import { RestateStreamer } from './streamer.js';

import type {
  World,
  WorkflowRun,
  Step,
  Hook,
  Event,
  EventResult,
  PaginatedResponse,
  QueueOptions,
  QueueMessage,
  QueueHandler,
  StreamChunk,
  Storage,
  Queue,
  Streamer,
} from './types.js';

// Re-export all types
export type {
  World,
  WorkflowRun,
  Step,
  Hook,
  Event,
  EventResult,
  PaginatedResponse,
  QueueOptions,
  QueueMessage,
  QueueHandler,
  StreamChunk,
  Storage,
  Queue,
  Streamer,
};

// Re-export implementations
export { RestateStorage, RestateQueue, RestateStreamer };

interface RestateWorldConfig {
  // Storage configuration
  storage?: {
    // Storage is in-memory by default, no config needed
  };
  
  // Queue configuration
  queue?: {
    restateUrl?: string;
    deploymentId?: string;
    authToken?: string;
    defaultTimeout?: number;
    maxRetries?: number;
  };
  
  // Streamer configuration
  streamer?: {
    // Streamer is in-memory by default, no config needed
    maxStreamAge?: number; // Auto-cleanup age in milliseconds
  };
  
  // Global configuration
  autoStart?: boolean;
  healthCheckInterval?: number;
}

/**
 * Main World implementation that combines storage, queue, and streaming
 */
export class RestateWorld implements World {
  private storage: RestateStorage;
  private queue: RestateQueue;
  private streamer: RestateStreamer;
  private config: RestateWorldConfig;
  private started = false;
  private healthCheckTimer?: NodeJS.Timeout;

  constructor(config: RestateWorldConfig = {}) {
    this.config = {
      autoStart: true,
      healthCheckInterval: 60000, // 1 minute
      ...config,
    };

    // Initialize subsystems
    this.storage = new RestateStorage();
    this.queue = new RestateQueue(config.queue);
    this.streamer = new RestateStreamer();

    // Auto-start if configured
    if (this.config.autoStart) {
      this.start().catch(error => {
        console.error('Failed to auto-start RestateWorld:', error);
      });
    }
  }

  // World lifecycle methods
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    console.log('Starting RestateWorld...');
    
    // Initialize subsystems if they have start methods
    // Storage and streamer are ready immediately
    // Queue might need initialization in the future

    // Start periodic health checks
    if (this.config.healthCheckInterval) {
      this.healthCheckTimer = setInterval(
        () => this.performHealthCheck(),
        this.config.healthCheckInterval
      );
    }

    // Start stream cleanup if configured
    if (this.config.streamer?.maxStreamAge) {
      setInterval(
        () => this.streamer.cleanupOldStreams(this.config.streamer!.maxStreamAge!),
        this.config.streamer.maxStreamAge / 4 // Cleanup every quarter of the max age
      );
    }

    this.started = true;
    console.log('RestateWorld started successfully');
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    console.log('Stopping RestateWorld...');

    // Clear timers
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }

    // Future: Stop subsystems if they have stop methods

    this.started = false;
    console.log('RestateWorld stopped');
  }

  async health(): Promise<{ status: 'healthy' | 'unhealthy'; details: Record<string, any> }> {
    try {
      const queueHealth = await this.queue.healthCheck();
      const streamerHealth = this.streamer.healthCheck();

      const allHealthy = queueHealth.status === 'healthy' && streamerHealth.status === 'healthy';

      return {
        status: allHealthy ? 'healthy' : 'unhealthy',
        details: {
          started: this.started,
          storage: {
            status: 'healthy',
            // Storage is always healthy if it's in-memory
          },
          queue: queueHealth,
          streamer: streamerHealth,
        },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        details: {
          error: error instanceof Error ? error.message : String(error),
          started: this.started,
        },
      };
    }
  }

  // Delegate Storage interface
  runs = this.storage.runs;
  steps = this.storage.steps;
  events = this.storage.events;
  hooks = this.storage.hooks;

  // Delegate Queue interface
  getDeploymentId(): string {
    return this.queue.getDeploymentId();
  }

  async queue(name: string, message: any, options?: QueueOptions): Promise<{ id: string }> {
    return this.queue.queue(name, message, options);
  }

  async createQueueHandler(prefix: string, handler: QueueHandler): Promise<void> {
    return this.queue.createQueueHandler(prefix, handler);
  }

  // Delegate Streamer interface
  async writeToStream(runId: string, streamId: string, data: any): Promise<void> {
    return this.streamer.writeToStream(runId, streamId, data);
  }

  async closeStream(runId: string, streamId: string): Promise<void> {
    return this.streamer.closeStream(runId, streamId);
  }

  async readFromStream(
    runId: string,
    streamId: string,
    options?: { since?: number; limit?: number }
  ): Promise<StreamChunk[]> {
    return this.streamer.readFromStream(runId, streamId, options);
  }

  async listStreamsByRunId(runId: string): Promise<string[]> {
    return this.streamer.listStreamsByRunId(runId);
  }

  // Extended functionality
  
  /**
   * Get direct access to subsystems for advanced usage
   */
  getStorage(): RestateStorage {
    return this.storage;
  }

  getQueue(): RestateQueue {
    return this.queue;
  }

  getStreamer(): RestateStreamer {
    return this.streamer;
  }

  /**
   * Subscribe to stream updates (from streamer)
   */
  subscribeToStream(
    runId: string,
    streamId: string,
    callback: (chunk: StreamChunk) => void,
    filter?: (chunk: StreamChunk) => boolean
  ): () => void {
    return this.streamer.subscribe(runId, streamId, callback, filter);
  }

  /**
   * Process a queued message manually (from queue)
   */
  async processQueueMessage(messageId: string): Promise<any> {
    return this.queue.processMessage(messageId);
  }

  /**
   * Get queue message status (from queue)
   */
  getQueueMessageStatus(messageId: string): QueueMessage | null {
    return this.queue.getMessageStatus(messageId);
  }

  /**
   * List queue messages (from queue)
   */
  listQueueMessages(status?: QueueMessage['status']): QueueMessage[] {
    return this.queue.listMessages(status);
  }

  /**
   * Get stream info (from streamer)
   */
  getStreamInfo(runId: string, streamId: string) {
    return this.streamer.getStreamInfo(runId, streamId);
  }

  /**
   * Write error to stream (from streamer)
   */
  async writeStreamError(runId: string, streamId: string, error: Error | string): Promise<void> {
    return this.streamer.writeError(runId, streamId, error);
  }

  /**
   * Get all streams for monitoring (from streamer)
   */
  getAllStreams() {
    return this.streamer.getAllStreams();
  }

  /**
   * Manual health check
   */
  private async performHealthCheck(): Promise<void> {
    try {
      const health = await this.health();
      if (health.status === 'unhealthy') {
        console.warn('RestateWorld health check failed:', health.details);
      }
    } catch (error) {
      console.error('Health check error:', error);
    }
  }

  /**
   * Create a workflow run with event sourcing
   */
  async createRun(
    name: string,
    options: {
      id?: string;
      deploymentId?: string;
      parentRunId?: string;
      metadata?: Record<string, any>;
      version?: string;
    } = {}
  ): Promise<{ runId: string; eventId: string }> {
    const runId = options.id || crypto.randomUUID();
    
    const result = await this.events.create({
      name: 'run.created',
      runId,
      data: {
        name,
        deploymentId: options.deploymentId || this.getDeploymentId(),
        parentRunId: options.parentRunId,
        metadata: options.metadata,
        version: options.version,
      },
      source: 'user',
    });

    return {
      runId,
      eventId: result.id,
    };
  }

  /**
   * Create a step with event sourcing
   */
  async createStep(
    runId: string,
    stepName: string,
    options: {
      id?: string;
      input?: any;
      type?: Step['type'];
      parentStepId?: string;
      maxRetries?: number;
      metadata?: Record<string, any>;
    } = {}
  ): Promise<{ stepId: string; eventId: string }> {
    const stepId = options.id || crypto.randomUUID();

    const result = await this.events.create({
      name: 'step.created',
      runId,
      stepId,
      data: {
        name: stepName,
        input: options.input,
        type: options.type || 'step',
        parentStepId: options.parentStepId,
        maxRetries: options.maxRetries,
        metadata: options.metadata,
      },
      source: 'workflow',
    });

    return {
      stepId,
      eventId: result.id,
    };
  }
}

// Default export
export default RestateWorld;
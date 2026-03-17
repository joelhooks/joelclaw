/**
 * Queue implementation for Restate-backed workflow execution
 * Sends messages to Restate ingress endpoints for durable processing
 */

import crypto from 'crypto';
import fetch from 'node-fetch';
import type { Queue, QueueOptions, QueueHandler, QueueMessage } from './types.js';

interface RestateQueueConfig {
  restateUrl: string;
  deploymentId: string;
  authToken?: string;
  defaultTimeout?: number;
  maxRetries?: number;
}

export class RestateQueue implements Queue {
  private config: RestateQueueConfig;
  private handlers = new Map<string, QueueHandler>();
  private messages = new Map<string, QueueMessage>();

  constructor(config: Partial<RestateQueueConfig> = {}) {
    this.config = {
      restateUrl: config.restateUrl || process.env.RESTATE_URL || 'http://localhost:8080',
      deploymentId: config.deploymentId || process.env.DEPLOYMENT_ID || crypto.randomUUID(),
      authToken: config.authToken || process.env.RESTATE_AUTH_TOKEN,
      defaultTimeout: config.defaultTimeout || 30000,
      maxRetries: config.maxRetries || 3,
    };
  }

  getDeploymentId(): string {
    return this.config.deploymentId;
  }

  async queue(name: string, message: any, options: QueueOptions = {}): Promise<{ id: string }> {
    const messageId = crypto.randomUUID();
    const timestamp = new Date();

    // Create queue message record
    const queueMessage: QueueMessage = {
      id: messageId,
      name,
      data: message,
      options,
      timestamp,
      attempts: 0,
      status: 'pending',
      nextAttemptAt: options.delay ? new Date(Date.now() + options.delay) : timestamp,
    };

    this.messages.set(messageId, queueMessage);

    // Determine Restate service and handler
    const [serviceName, handlerName] = this.parseQueueName(name);
    
    // Prepare request to Restate ingress
    const restateUrl = this.buildRestateUrl(serviceName, handlerName);
    const payload = this.buildRestatePayload(message, options, messageId);

    try {
      await this.sendToRestate(restateUrl, payload, options);
      
      // Update message status
      queueMessage.status = 'processing';
      queueMessage.attempts = 1;
      this.messages.set(messageId, queueMessage);

      return { id: messageId };
    } catch (error) {
      // Update message with error
      queueMessage.status = 'failed';
      queueMessage.error = error instanceof Error ? error.message : String(error);
      this.messages.set(messageId, queueMessage);

      // Schedule retry if configured
      if (this.shouldRetry(queueMessage)) {
        await this.scheduleRetry(queueMessage);
      }

      throw error;
    }
  }

  async createQueueHandler(prefix: string, handler: QueueHandler): Promise<void> {
    this.handlers.set(prefix, handler);
    
    // In a real implementation, this would register the handler with Restate
    // For now, we store it locally for potential local processing
    console.log(`Registered queue handler for prefix: ${prefix}`);
  }

  /**
   * Process a queued message (called by local handler or webhook)
   */
  async processMessage(messageId: string): Promise<any> {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }

    const handler = this.findHandler(message.name);
    if (!handler) {
      throw new Error(`No handler found for queue: ${message.name}`);
    }

    try {
      message.status = 'processing';
      message.attempts += 1;
      this.messages.set(messageId, message);

      const result = await handler(message.data, {
        id: message.id,
        attempts: message.attempts,
      });

      message.status = 'completed';
      this.messages.set(messageId, message);

      return result;
    } catch (error) {
      message.status = 'failed';
      message.error = error instanceof Error ? error.message : String(error);
      this.messages.set(messageId, message);

      if (this.shouldRetry(message)) {
        await this.scheduleRetry(message);
      }

      throw error;
    }
  }

  /**
   * Get message status (useful for monitoring)
   */
  getMessageStatus(messageId: string): QueueMessage | null {
    return this.messages.get(messageId) || null;
  }

  /**
   * List messages by status
   */
  listMessages(status?: QueueMessage['status']): QueueMessage[] {
    const allMessages = Array.from(this.messages.values());
    if (status) {
      return allMessages.filter(msg => msg.status === status);
    }
    return allMessages;
  }

  private parseQueueName(name: string): [string, string] {
    // Parse queue names like "workflow/execute", "step/process", etc.
    const parts = name.split('/');
    if (parts.length !== 2) {
      throw new Error(`Invalid queue name format: ${name}. Expected "service/handler"`);
    }
    return [parts[0], parts[1]];
  }

  private buildRestateUrl(serviceName: string, handlerName: string): string {
    return `${this.config.restateUrl}/invoke/${serviceName}/${handlerName}`;
  }

  private buildRestatePayload(message: any, options: QueueOptions, messageId: string): any {
    return {
      data: message,
      metadata: {
        messageId,
        queueOptions: options,
        deploymentId: this.config.deploymentId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  private async sendToRestate(url: string, payload: any, options: QueueOptions): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.authToken) {
      headers.Authorization = `Bearer ${this.config.authToken}`;
    }

    // Add custom headers from options
    if (options.headers) {
      Object.assign(headers, options.headers);
    }

    const timeout = options.timeout || this.config.defaultTimeout!;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Restate request failed: ${response.status} ${response.statusText}`);
      }

      // For fire-and-forget, we don't need to wait for the response body
      // But we should at least check that it was accepted
      await response.text();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private findHandler(queueName: string): QueueHandler | null {
    // Find handler by prefix matching
    for (const [prefix, handler] of this.handlers) {
      if (queueName.startsWith(prefix)) {
        return handler;
      }
    }
    return null;
  }

  private shouldRetry(message: QueueMessage): boolean {
    const maxAttempts = message.options?.maxAttempts || this.config.maxRetries!;
    return message.attempts < maxAttempts && message.status === 'failed';
  }

  private async scheduleRetry(message: QueueMessage): Promise<void> {
    const retryPolicy = message.options?.retryPolicy || 'exponential';
    const baseDelay = message.options?.retryDelay || 1000;
    
    let delay: number;
    switch (retryPolicy) {
      case 'exponential':
        delay = baseDelay * Math.pow(2, message.attempts - 1);
        break;
      case 'linear':
        delay = baseDelay * message.attempts;
        break;
      case 'fixed':
      default:
        delay = baseDelay;
        break;
    }

    message.status = 'pending';
    message.nextAttemptAt = new Date(Date.now() + delay);
    this.messages.set(message.id, message);

    // In a real implementation, this would schedule the retry with a job scheduler
    // For now, we just update the message state
    console.log(`Scheduled retry for message ${message.id} in ${delay}ms`);
  }

  /**
   * Health check for the queue system
   */
  async healthCheck(): Promise<{ status: 'healthy' | 'unhealthy'; details: any }> {
    try {
      // Try to ping the Restate ingress
      const response = await fetch(`${this.config.restateUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        return {
          status: 'healthy',
          details: {
            restateUrl: this.config.restateUrl,
            deploymentId: this.config.deploymentId,
            pendingMessages: this.listMessages('pending').length,
            processingMessages: this.listMessages('processing').length,
            failedMessages: this.listMessages('failed').length,
          },
        };
      } else {
        return {
          status: 'unhealthy',
          details: {
            error: `Restate health check failed: ${response.status}`,
            restateUrl: this.config.restateUrl,
          },
        };
      }
    } catch (error) {
      return {
        status: 'unhealthy',
        details: {
          error: error instanceof Error ? error.message : String(error),
          restateUrl: this.config.restateUrl,
        },
      };
    }
  }
}
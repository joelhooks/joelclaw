/**
 * In-memory streaming implementation for real-time workflow data
 * Provides write/read/close operations for workflow stream data
 */

import crypto from 'crypto';
import type { Streamer, StreamChunk } from './types.js';

interface StreamState {
  runId: string;
  streamId: string;
  chunks: Map<number, StreamChunk>;
  nextSequence: number;
  closed: boolean;
  closedAt?: Date;
  subscribers: Set<StreamSubscriber>;
}

interface StreamSubscriber {
  runId: string;
  streamId: string;
  callback: (chunk: StreamChunk) => void;
  filter?: (chunk: StreamChunk) => boolean;
}

export class RestateStreamer implements Streamer {
  private streams = new Map<string, StreamState>();
  private subscribers = new Set<StreamSubscriber>();

  async writeToStream(runId: string, streamId: string, data: any): Promise<void> {
    const streamKey = this.getStreamKey(runId, streamId);
    let stream = this.streams.get(streamKey);

    if (!stream) {
      // Create new stream
      stream = {
        runId,
        streamId,
        chunks: new Map(),
        nextSequence: 0,
        closed: false,
        subscribers: new Set(),
      };
      this.streams.set(streamKey, stream);
    }

    if (stream.closed) {
      throw new Error(`Stream ${streamId} in run ${runId} is closed`);
    }

    // Create chunk
    const chunk: StreamChunk = {
      id: crypto.randomUUID(),
      runId,
      streamId,
      data,
      timestamp: new Date(),
      sequence: stream.nextSequence++,
      type: 'data',
    };

    // Store chunk
    stream.chunks.set(chunk.sequence, chunk);

    // Notify subscribers
    await this.notifySubscribers(chunk);
  }

  async closeStream(runId: string, streamId: string): Promise<void> {
    const streamKey = this.getStreamKey(runId, streamId);
    const stream = this.streams.get(streamKey);

    if (!stream) {
      throw new Error(`Stream ${streamId} not found in run ${runId}`);
    }

    if (stream.closed) {
      return; // Already closed
    }

    // Mark as closed
    stream.closed = true;
    stream.closedAt = new Date();

    // Create close chunk
    const closeChunk: StreamChunk = {
      id: crypto.randomUUID(),
      runId,
      streamId,
      data: null,
      timestamp: new Date(),
      sequence: stream.nextSequence++,
      type: 'close',
    };

    // Store close chunk
    stream.chunks.set(closeChunk.sequence, closeChunk);

    // Notify subscribers
    await this.notifySubscribers(closeChunk);

    // Clean up subscribers for this stream
    const streamSubscribers = Array.from(stream.subscribers);
    streamSubscribers.forEach(subscriber => {
      this.subscribers.delete(subscriber);
    });
    stream.subscribers.clear();
  }

  async readFromStream(
    runId: string,
    streamId: string,
    options: { since?: number; limit?: number } = {}
  ): Promise<StreamChunk[]> {
    const streamKey = this.getStreamKey(runId, streamId);
    const stream = this.streams.get(streamKey);

    if (!stream) {
      return []; // Stream doesn't exist yet
    }

    const { since = 0, limit = 100 } = options;
    const chunks: StreamChunk[] = [];

    // Get chunks starting from 'since' sequence number
    for (let seq = since; seq < stream.nextSequence && chunks.length < limit; seq++) {
      const chunk = stream.chunks.get(seq);
      if (chunk) {
        chunks.push(chunk);
      }
    }

    return chunks;
  }

  async listStreamsByRunId(runId: string): Promise<string[]> {
    const streamIds = new Set<string>();

    for (const [key, stream] of this.streams) {
      if (stream.runId === runId) {
        streamIds.add(stream.streamId);
      }
    }

    return Array.from(streamIds).sort();
  }

  /**
   * Subscribe to stream updates (real-time)
   */
  subscribe(
    runId: string,
    streamId: string,
    callback: (chunk: StreamChunk) => void,
    filter?: (chunk: StreamChunk) => boolean
  ): () => void {
    const subscriber: StreamSubscriber = {
      runId,
      streamId,
      callback,
      filter,
    };

    this.subscribers.add(subscriber);

    // Add to stream subscribers if stream exists
    const streamKey = this.getStreamKey(runId, streamId);
    const stream = this.streams.get(streamKey);
    if (stream) {
      stream.subscribers.add(subscriber);
    }

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(subscriber);
      if (stream) {
        stream.subscribers.delete(subscriber);
      }
    };
  }

  /**
   * Get stream metadata
   */
  getStreamInfo(runId: string, streamId: string): {
    exists: boolean;
    closed: boolean;
    chunkCount: number;
    closedAt?: Date;
    lastActivity?: Date;
  } {
    const streamKey = this.getStreamKey(runId, streamId);
    const stream = this.streams.get(streamKey);

    if (!stream) {
      return {
        exists: false,
        closed: false,
        chunkCount: 0,
      };
    }

    // Find last activity time
    let lastActivity: Date | undefined;
    for (const chunk of stream.chunks.values()) {
      if (!lastActivity || chunk.timestamp > lastActivity) {
        lastActivity = chunk.timestamp;
      }
    }

    return {
      exists: true,
      closed: stream.closed,
      chunkCount: stream.chunks.size,
      closedAt: stream.closedAt,
      lastActivity,
    };
  }

  /**
   * Write error to stream
   */
  async writeError(runId: string, streamId: string, error: Error | string): Promise<void> {
    const streamKey = this.getStreamKey(runId, streamId);
    let stream = this.streams.get(streamKey);

    if (!stream) {
      stream = {
        runId,
        streamId,
        chunks: new Map(),
        nextSequence: 0,
        closed: false,
        subscribers: new Set(),
      };
      this.streams.set(streamKey, stream);
    }

    if (stream.closed) {
      throw new Error(`Stream ${streamId} in run ${runId} is closed`);
    }

    // Create error chunk
    const errorChunk: StreamChunk = {
      id: crypto.randomUUID(),
      runId,
      streamId,
      data: {
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined,
      },
      timestamp: new Date(),
      sequence: stream.nextSequence++,
      type: 'error',
    };

    // Store chunk
    stream.chunks.set(errorChunk.sequence, errorChunk);

    // Notify subscribers
    await this.notifySubscribers(errorChunk);
  }

  /**
   * Cleanup old streams (garbage collection)
   */
  cleanupOldStreams(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - maxAgeMs);
    let cleaned = 0;

    for (const [key, stream] of this.streams) {
      if (stream.closed && stream.closedAt && stream.closedAt < cutoff) {
        this.streams.delete(key);
        cleaned++;

        // Clean up subscribers
        const streamSubscribers = Array.from(stream.subscribers);
        streamSubscribers.forEach(subscriber => {
          this.subscribers.delete(subscriber);
        });
      }
    }

    return cleaned;
  }

  /**
   * Get all streams (for debugging/monitoring)
   */
  getAllStreams(): Array<{
    runId: string;
    streamId: string;
    closed: boolean;
    chunkCount: number;
    lastActivity?: Date;
  }> {
    const result = [];

    for (const stream of this.streams.values()) {
      let lastActivity: Date | undefined;
      for (const chunk of stream.chunks.values()) {
        if (!lastActivity || chunk.timestamp > lastActivity) {
          lastActivity = chunk.timestamp;
        }
      }

      result.push({
        runId: stream.runId,
        streamId: stream.streamId,
        closed: stream.closed,
        chunkCount: stream.chunks.size,
        lastActivity,
      });
    }

    return result;
  }

  private getStreamKey(runId: string, streamId: string): string {
    return `${runId}:${streamId}`;
  }

  private async notifySubscribers(chunk: StreamChunk): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const subscriber of this.subscribers) {
      // Check if subscriber matches this stream
      if (
        subscriber.runId === chunk.runId &&
        subscriber.streamId === chunk.streamId
      ) {
        // Apply filter if provided
        if (subscriber.filter && !subscriber.filter(chunk)) {
          continue;
        }

        // Notify asynchronously to avoid blocking
        promises.push(
          Promise.resolve().then(() => {
            try {
              subscriber.callback(chunk);
            } catch (error) {
              console.error('Error in stream subscriber callback:', error);
            }
          })
        );
      }
    }

    // Wait for all notifications to complete
    await Promise.allSettled(promises);
  }

  /**
   * Health check for the streamer
   */
  healthCheck(): { status: 'healthy' | 'unhealthy'; details: any } {
    try {
      const activeStreams = Array.from(this.streams.values()).filter(s => !s.closed).length;
      const totalStreams = this.streams.size;
      const totalSubscribers = this.subscribers.size;
      
      let totalChunks = 0;
      for (const stream of this.streams.values()) {
        totalChunks += stream.chunks.size;
      }

      return {
        status: 'healthy',
        details: {
          activeStreams,
          totalStreams,
          totalSubscribers,
          totalChunks,
          memoryEstimate: totalChunks * 1000, // Rough estimate in bytes
        },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
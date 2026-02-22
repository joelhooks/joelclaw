import { ack, drainByPriority, getUnacked, indexMessagesByPriority, persist, type Priority } from "./message-store";
import { emitGatewayOtel } from "./observability";

export type QueueEntry = {
  source: string;
  prompt: string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
  streamId?: string;
  priority?: Priority;
};

type PromptSession = {
  prompt: (text: string) => unknown | Promise<unknown>;
  reload: () => Promise<void>;
  compact: (customInstructions?: string) => Promise<unknown>;
  newSession: () => Promise<void>;
};

type PromptCallback = () => void;
type IdleWaiter = () => Promise<void>;
type ErrorCallback = (consecutiveFailures: number) => void | Promise<void> | Promise<boolean>;

const queue: QueueEntry[] = [];
let sessionRef: PromptSession | undefined;
let drainPromise: Promise<void> | undefined;
let onPromptSent: PromptCallback | undefined;
let onPromptError: ErrorCallback | undefined;
let idleWaiter: IdleWaiter | undefined;
let consecutiveFailures = 0;

export let currentSource: string | undefined;

export function setSession(session: PromptSession): void {
  sessionRef = session;
}

export function reloadSession(): Promise<void> {
  if (!sessionRef) throw new Error("No session");
  return sessionRef.reload();
}

export function compactSession(instructions?: string): Promise<unknown> {
  if (!sessionRef) throw new Error("No session");
  return sessionRef.compact(instructions);
}

export function newSession(): Promise<void> {
  if (!sessionRef) throw new Error("No session");
  return sessionRef.newSession();
}

/** Register a callback fired each time a prompt is dispatched to the session. */
export function onPrompt(cb: PromptCallback): void {
  onPromptSent = cb;
}

/** Register a callback fired when a prompt fails. Receives the consecutive failure count. */
export function onError(cb: ErrorCallback): void {
  onPromptError = cb;
}

/**
 * Register a function that returns a Promise resolving when the session
 * is idle (turn finished). Called after each prompt() to prevent the drain
 * loop from firing the next message while the agent is still streaming.
 *
 * session.prompt() resolves when the message is *queued*, not when the
 * full turn completes. Without this gate, back-to-back messages race
 * and hit "Agent is already processing".
 */
export function setIdleWaiter(fn: IdleWaiter): void {
  idleWaiter = fn;
}

export async function enqueue(
  source: string,
  prompt: string,
  metadata?: Record<string, unknown>,
  options?: { streamId?: string },
): Promise<void> {
  let streamId = options?.streamId;
  let priority: Priority | undefined;

  if (!streamId) {
    try {
      const persisted = await persist({ source, prompt, metadata });
      if (!persisted) {
        void emitGatewayOtel({
          level: "debug",
          component: "command-queue",
          action: "queue.dedup_dropped",
          success: true,
          metadata: {
            source,
          },
        });
        return;
      }
      streamId = persisted.streamId;
      priority = persisted.priority;
    } catch (error) {
      console.error("[gateway:store] persist failed; enqueueing without durable stream id", {
        source,
        error,
      });
      void emitGatewayOtel({
        level: "warn",
        component: "command-queue",
        action: "queue.persist.failed",
        success: false,
        error: String(error),
        metadata: { source },
      });
    }
  }

  // Durable messages are drained from the Redis priority layer. Keep local queue
  // only for fallback messages when persistence is unavailable.
  if (!options?.streamId && streamId) {
    void emitGatewayOtel({
      level: "debug",
      component: "command-queue",
      action: "queue.enqueued",
      success: true,
      metadata: {
        source,
        depth: queue.length,
        hasStreamId: true,
        ...(priority !== undefined ? { priority } : {}),
      },
    });
    return;
  }

  queue.push({ source, prompt, metadata, streamId, priority });
  void emitGatewayOtel({
    level: "debug",
    component: "command-queue",
    action: "queue.enqueued",
    success: true,
    metadata: {
      source,
      depth: queue.length,
      hasStreamId: Boolean(streamId),
      ...(priority !== undefined ? { priority } : {}),
    },
  });
  if (queue.length >= 20) {
    void emitGatewayOtel({
      level: "warn",
      component: "command-queue",
      action: "queue.backpressure",
      success: false,
      metadata: {
        depth: queue.length,
      },
    });
  }
}

export function getCurrentSource(): string | undefined {
  return currentSource;
}

export function getQueueDepth(): number {
  return queue.length;
}

export function getConsecutiveFailures(): number {
  return consecutiveFailures;
}

export function resetFailureCount(): void {
  consecutiveFailures = 0;
}

export async function drain(): Promise<void> {
  if (drainPromise) return drainPromise;

  drainPromise = (async () => {
    const failedStreamIds = new Set<string>();

    while (true) {
      const localEntry = queue.shift();
      const entry = localEntry ?? (await (async (): Promise<QueueEntry | undefined> => {
        const next = await drainByPriority({ limit: 1, excludeIds: failedStreamIds });
        const message = next[0];
        if (!message) return undefined;
        return {
          source: message.source,
          prompt: message.prompt,
          metadata: message.metadata,
          streamId: message.id,
          priority: message.priority,
        };
      })());
      if (!entry) break;

      currentSource = entry.source;
      const startedAt = Date.now();

      try {
        if (!sessionRef) {
          console.error("command-queue: no prompt session set; dropping queued prompt", {
            source: entry.source,
          });
          void emitGatewayOtel({
            level: "error",
            component: "command-queue",
            action: "queue.session_missing",
            success: false,
            error: "no_prompt_session_set",
            metadata: { source: entry.source },
          });
          continue;
        }

        // Set up idle waiter BEFORE prompt() so turn_end can resolve it
        // regardless of when prompt() returns. If prompt() blocks until
        // turn_end, the idle promise is already resolved by the time we
        // await it. If prompt() returns early, we correctly wait.
        const idlePromise = idleWaiter?.();

        // Retry loop: pi SDK throws "Agent is already processing" if
        // isStreaming hasn't cleared yet after turn_end. Small delay
        // between retries gives the session time to settle.
        const MAX_PROMPT_RETRIES = 3;
        const RETRY_DELAY_MS = 2000;
        let promptSent = false;
        for (let attempt = 0; attempt < MAX_PROMPT_RETRIES; attempt++) {
          try {
            onPromptSent?.();
            await sessionRef.prompt(entry.prompt);
            promptSent = true;
            break;
          } catch (retryError: any) {
            const isStreamingRace = typeof retryError?.message === "string"
              && retryError.message.includes("already processing");
            if (!isStreamingRace || attempt >= MAX_PROMPT_RETRIES - 1) {
              throw retryError; // not a race, or exhausted retries
            }
            console.warn("command-queue: session still streaming, retrying", {
              attempt: attempt + 1,
              source: entry.source,
              delayMs: RETRY_DELAY_MS,
            });
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
          }
        }
        if (!promptSent) throw new Error("prompt retries exhausted");

        if (idlePromise) {
          await idlePromise;
        }

        if (entry.streamId) {
          await ack(entry.streamId);
        }

        consecutiveFailures = 0;
        void emitGatewayOtel({
          level: "debug",
          component: "command-queue",
          action: "queue.prompt.sent",
          success: true,
          duration_ms: Date.now() - startedAt,
          metadata: {
            source: entry.source,
            depthAfterSend: queue.length,
            ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
          },
        });
      } catch (error) {
        if (entry.streamId) failedStreamIds.add(entry.streamId);
        consecutiveFailures += 1;
        console.error("command-queue: prompt failed", {
          source: entry.source,
          consecutiveFailures,
          error,
        });
        // Notify fallback controller (may trigger model swap)
        try { await onPromptError?.(consecutiveFailures); } catch { /* swallow */ }
        void emitGatewayOtel({
          level: consecutiveFailures >= 3 ? "fatal" : "error",
          component: "command-queue",
          action: "queue.prompt.failed",
          success: false,
          duration_ms: Date.now() - startedAt,
          error: String(error),
          metadata: {
            source: entry.source,
            consecutiveFailures,
            depthAfterFailure: queue.length,
            ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
          },
        });
      } finally {
        currentSource = undefined;
      }
    }
  })().finally(() => {
    drainPromise = undefined;
  });

  return drainPromise;
}

/**
 * Replay unacked messages on startup — only recent ones.
 * Age filtering happens inside getUnacked() — stale messages are
 * acked at the store level so they never surface again.
 */
export async function replayUnacked(): Promise<void> {
  try {
    // getUnacked() handles age filtering and acks stale messages internally.
    // Reindex replayable messages into the priority set for ordered draining.
    const replayable = await getUnacked();
    if (replayable.length === 0) {
      console.log("[gateway:store] no messages to replay on startup");
      void emitGatewayOtel({
        level: "debug",
        component: "command-queue",
        action: "queue.replay.empty",
        success: true,
      });
      return;
    }

    const indexed = await indexMessagesByPriority(replayable);

    console.log("[gateway:store] replayed unacked messages into priority queue", {
      count: replayable.length,
      indexed,
    });
    void emitGatewayOtel({
      level: "info",
      component: "command-queue",
      action: "queue.replay.completed",
      success: true,
      metadata: {
        replayCount: replayable.length,
        indexedCount: indexed,
      },
    });
  } catch (error) {
    console.error("[gateway:store] replay failed", { error });
    void emitGatewayOtel({
      level: "error",
      component: "command-queue",
      action: "queue.replay.failed",
      success: false,
      error: String(error),
    });
    return;
  }

  await drain();
}

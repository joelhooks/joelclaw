import { ack, getUnacked, persist } from "./message-store";
import { emitGatewayOtel } from "./observability";

export type QueueEntry = {
  source: string;
  prompt: string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
  streamId?: string;
};

type PromptSession = {
  prompt: (text: string) => unknown | Promise<unknown>;
};

type PromptCallback = () => void;

const queue: QueueEntry[] = [];
let sessionRef: PromptSession | undefined;
let drainPromise: Promise<void> | undefined;
let onPromptSent: PromptCallback | undefined;
let consecutiveFailures = 0;

export let currentSource: string | undefined;

export function setSession(session: PromptSession): void {
  sessionRef = session;
}

/** Register a callback fired each time a prompt is dispatched to the session. */
export function onPrompt(cb: PromptCallback): void {
  onPromptSent = cb;
}

export async function enqueue(
  source: string,
  prompt: string,
  metadata?: Record<string, unknown>,
  options?: { streamId?: string },
): Promise<void> {
  let streamId = options?.streamId;

  if (!streamId) {
    try {
      streamId = await persist({ source, prompt, metadata });
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

  queue.push({ source, prompt, metadata, streamId });
  void emitGatewayOtel({
    level: "debug",
    component: "command-queue",
    action: "queue.enqueued",
    success: true,
    metadata: {
      source,
      depth: queue.length,
      hasStreamId: Boolean(streamId),
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
    while (queue.length > 0) {
      const entry = queue.shift();
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

        onPromptSent?.();
        await sessionRef.prompt(entry.prompt);

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
          },
        });
      } catch (error) {
        consecutiveFailures += 1;
        console.error("command-queue: prompt failed", {
          source: entry.source,
          consecutiveFailures,
          error,
        });
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
    // getUnacked() handles age filtering and acks stale messages internally
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

    for (const msg of replayable) {
      queue.push({
        source: msg.source,
        prompt: msg.prompt,
        metadata: msg.metadata,
        streamId: msg.id,
      });
    }

    console.log("[gateway:store] replayed unacked messages into queue", {
      count: replayable.length,
    });
    void emitGatewayOtel({
      level: "info",
      component: "command-queue",
      action: "queue.replay.completed",
      success: true,
      metadata: {
        replayCount: replayable.length,
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

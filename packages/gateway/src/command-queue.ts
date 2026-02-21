import { ack, getUnacked, persist } from "./message-store";

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
    }
  }

  queue.push({ source, prompt, metadata, streamId });
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

      try {
        if (!sessionRef) {
          console.error("command-queue: no prompt session set; dropping queued prompt", {
            source: entry.source,
          });
          continue;
        }

        onPromptSent?.();
        await sessionRef.prompt(entry.prompt);

        if (entry.streamId) {
          await ack(entry.streamId);
        }

        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        console.error("command-queue: prompt failed", {
          source: entry.source,
          consecutiveFailures,
          error,
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
 * Replay unacked messages on startup — but only RECENT ones.
 * Without a max age, a gateway restart replays the ENTIRE DAY of messages,
 * flooding Telegram with hundreds of duplicate responses.
 * Default: only replay messages from the last 2 minutes.
 */
const REPLAY_MAX_AGE_MS = 10 * 60 * 1000;

export async function replayUnacked(): Promise<void> {
  try {
    const pendingMessages = await getUnacked();
    if (pendingMessages.length === 0) return;

    const cutoff = Date.now() - REPLAY_MAX_AGE_MS;
    const recent = pendingMessages.filter((m) => m.timestamp >= cutoff);
    const stale = pendingMessages.filter((m) => m.timestamp < cutoff);

    // Ack stale messages so they never replay again
    for (const msg of stale) {
      await ack(msg.id);
    }

    if (stale.length > 0) {
      console.log("[gateway:store] acked stale messages (skipped replay)", {
        staleCount: stale.length,
        oldestStaleAge: `${Math.round((Date.now() - Math.min(...stale.map((m) => m.timestamp))) / 1000)}s`,
      });
    }

    if (recent.length === 0) {
      console.log("[gateway:store] no recent unacked messages to replay", {
        totalPending: pendingMessages.length,
        allStale: true,
      });
      return;
    }

    for (const pending of recent) {
      queue.push({
        source: pending.source,
        prompt: pending.prompt,
        metadata: pending.metadata,
        streamId: pending.id,
      });
    }

    console.log("[gateway:store] replayed recent unacked messages into queue", {
      replayedCount: recent.length,
      skippedStale: stale.length,
      maxAgeMs: REPLAY_MAX_AGE_MS,
    });
  } catch (error) {
    console.error("[gateway:store] replay failed", { error });
    return;
  }

  await drain();
}

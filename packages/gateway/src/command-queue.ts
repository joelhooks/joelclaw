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
      } catch (error) {
        console.error("command-queue: prompt failed", {
          source: entry.source,
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

export async function replayUnacked(): Promise<void> {
  try {
    const pendingMessages = await getUnacked();
    if (pendingMessages.length === 0) return;

    for (const pending of pendingMessages) {
      queue.push({
        source: pending.source,
        prompt: pending.prompt,
        metadata: pending.metadata,
        streamId: pending.id,
      });
    }

    console.log("[gateway:store] replayed unacked messages into queue", {
      count: pendingMessages.length,
    });
  } catch (error) {
    console.error("[gateway:store] replay failed", { error });
    return;
  }

  await drain();
}

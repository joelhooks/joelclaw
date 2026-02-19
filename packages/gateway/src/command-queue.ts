export type QueueEntry = {
  source: string;
  prompt: string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
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

export function enqueue(source: string, prompt: string, metadata?: Record<string, unknown>): void {
  queue.push({ source, prompt, metadata });
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

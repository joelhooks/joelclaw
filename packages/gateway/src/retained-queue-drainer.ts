export interface RetainedQueueClient {
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lrem(key: string, count: number, value: string): Promise<number>;
}

export type RetainedQueueFailureStage = "row" | "pass";

export interface RetainedQueueRetryFailure {
  readonly attempt: number;
  readonly error: unknown;
  readonly retryInMs: number;
  readonly stage: RetainedQueueFailureStage;
  readonly mayHaveRetainedRow: boolean;
}

export interface RetainedQueuePassReceipt {
  readonly recoveredAfterAttempts: number;
}

export interface RetainedQueueScheduler {
  schedule(task: () => void, delayMs: number): { cancel(): void };
}

export interface RetainedQueueDrainerOptions {
  readonly client: RetainedQueueClient;
  readonly lists: readonly string[];
  readonly processRow: (list: string, raw: string) => Promise<void>;
  readonly initialRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly scheduler?: RetainedQueueScheduler;
  readonly onFailure?: (failure: RetainedQueueRetryFailure) => void | Promise<void>;
  readonly onPass?: (receipt: RetainedQueuePassReceipt) => void | Promise<void>;
}

export type RetainedQueueDrainState =
  | { readonly phase: "idle" }
  | { readonly phase: "draining"; readonly rerunRequested: boolean }
  | {
      readonly phase: "backoff";
      readonly attempt: number;
      readonly retryInMs: number;
      readonly failureStage: RetainedQueueFailureStage;
    }
  | { readonly phase: "stopped" };

export interface RetainedQueueDrainer {
  start(): Promise<void>;
  request(): void;
  stop(): void;
  state(): RetainedQueueDrainState;
}

const defaultScheduler: RetainedQueueScheduler = {
  schedule(task, delayMs) {
    const timer = setTimeout(task, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

function retryDelay(attempt: number, initialMs: number, maxMs: number): number {
  return Math.min(initialMs * 2 ** Math.max(0, attempt - 1), maxMs);
}

/**
 * Drains Redis list rows oldest-first. A row is removed only after processRow
 * succeeds. Row-stage failure may retain the current row and always arms an
 * in-process retry, so recovery does not depend on a new Pub/Sub notification.
 */
export function createRetainedQueueDrainer(
  options: RetainedQueueDrainerOptions,
): RetainedQueueDrainer {
  const initialRetryDelayMs = Math.max(1, options.initialRetryDelayMs ?? 1_000);
  const maxRetryDelayMs = Math.max(
    initialRetryDelayMs,
    options.maxRetryDelayMs ?? 30_000,
  );
  const scheduler = options.scheduler ?? defaultScheduler;

  let state: RetainedQueueDrainState = { phase: "idle" };
  let retryHandle: { cancel(): void } | undefined;
  let retryAttempt = 0;
  let firstPassResolved = false;
  let resolveFirstPass!: () => void;
  const firstPass = new Promise<void>((resolve) => {
    resolveFirstPass = resolve;
  });

  const isStopped = (): boolean => state.phase === "stopped";

  const armRetry = async (
    error: unknown,
    stage: RetainedQueueFailureStage,
  ): Promise<void> => {
    retryAttempt += 1;
    const retryInMs = retryDelay(
      retryAttempt,
      initialRetryDelayMs,
      maxRetryDelayMs,
    );
    try {
      await options.onFailure?.({
        attempt: retryAttempt,
        error,
        retryInMs,
        stage,
        mayHaveRetainedRow: stage === "row",
      });
    } catch {
      // Retry scheduling is the durability boundary. Observer failure cannot cancel it.
    }
    if (isStopped()) return;
    state = {
      phase: "backoff",
      attempt: retryAttempt,
      retryInMs,
      failureStage: stage,
    };
    retryHandle = scheduler.schedule(() => {
      retryHandle = undefined;
      if (isStopped()) return;
      state = { phase: "idle" };
      void run();
    }, retryInMs);
  };

  const run = async (): Promise<void> => {
    if (state.phase === "stopped" || state.phase === "backoff") return;
    if (state.phase === "draining") {
      state = { phase: "draining", rerunRequested: true };
      return;
    }

    state = { phase: "draining", rerunRequested: false };
    try {
      for (const list of options.lists) {
        const rows = await options.client.lrange(list, 0, -1);
        for (const raw of rows.reverse()) {
          if (isStopped()) return;
          await options.processRow(list, raw);
          await options.client.lrem(list, 1, raw);
          if (isStopped()) return;
        }
      }
    } catch (error) {
      if (isStopped()) return;
      await armRetry(error, "row");
      return;
    }

    if (isStopped()) return;
    const recoveredAfterAttempts = retryAttempt;
    try {
      await options.onPass?.({ recoveredAfterAttempts });
    } catch (error) {
      if (isStopped()) return;
      await armRetry(error, "pass");
      return;
    }

    if (isStopped()) return;
    const rerunRequested = state.phase === "draining" && state.rerunRequested;
    retryAttempt = 0;
    state = { phase: "idle" };
    if (!firstPassResolved) {
      firstPassResolved = true;
      resolveFirstPass();
    }
    if (rerunRequested) void run();
  };

  return {
    start() {
      if (state.phase === "stopped") {
        return Promise.reject(new Error("retained queue drainer is stopped"));
      }
      void run();
      return firstPass;
    },
    request() {
      void run();
    },
    stop() {
      retryHandle?.cancel();
      retryHandle = undefined;
      state = { phase: "stopped" };
    },
    state() {
      return state;
    },
  };
}

export interface DependencyReadinessFailure {
  readonly attempt: number;
  readonly error: unknown;
  readonly retryInMs: number;
}

export interface DependencyReadinessOptions {
  readonly probe: () => Promise<void>;
  readonly wait?: (delayMs: number) => Promise<void>;
  readonly initialRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly onFailure?: (failure: DependencyReadinessFailure) => void | Promise<void>;
}

const defaultWait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });

/** Waits in-process so a dependency outage cannot make launchd restart owners. */
export async function waitForDependencyReadiness(
  options: DependencyReadinessOptions,
): Promise<{ attempts: number }> {
  const wait = options.wait ?? defaultWait;
  const initialRetryDelayMs = Math.max(1, options.initialRetryDelayMs ?? 1_000);
  const maxRetryDelayMs = Math.max(
    initialRetryDelayMs,
    options.maxRetryDelayMs ?? 30_000,
  );
  let attempts = 0;

  for (;;) {
    try {
      await options.probe();
      return { attempts };
    } catch (error) {
      attempts += 1;
      const retryInMs = Math.min(
        initialRetryDelayMs * 2 ** Math.max(0, attempts - 1),
        maxRetryDelayMs,
      );
      await options.onFailure?.({ attempt: attempts, error, retryInMs });
      await wait(retryInMs);
    }
  }
}

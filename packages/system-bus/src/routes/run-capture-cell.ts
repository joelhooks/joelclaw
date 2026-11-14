/**
 * Capture-cell shadow posting for the run-capture route.
 *
 * `off` (default): Inngest only. `both`: tee every accepted run, including
 * events durably queued for retry, in the background; bounded retries never
 * hold the route response open.
 * `cell`: await the durable cell save; never send to Inngest.
 */

export type CaptureCellMode = "off" | "both" | "cell";

// The measured p99.9 is 2,633ms. 4s leaves 1,367ms for transport/load;
// 13s fits three full attempts plus at most 750ms of jittered backoff.
export const DEFAULT_CAPTURE_CELL_TIMEOUT_MS = 4_000;
export const DEFAULT_CAPTURE_CELL_TOTAL_BUDGET_MS = 13_000;
const MAX_ATTEMPTS = 3;

export type CaptureCellFailure = {
  run_id: string;
  reason: string;
  duration_ms: number;
  attempt: number;
};

export type CaptureCellExhausted = {
  run_id: string;
  reason: string;
  duration_ms: number;
  attempts: number;
};

/** One bounded delivery (up to two retries). Never throws. The route detaches it. */
export type CaptureCellShadow = (
  data: { run_id: string },
  serializedBody?: string,
) => Promise<void>;

export type CaptureCellRouting = {
  mode: CaptureCellMode;
  shadow: CaptureCellShadow;
  /** Additional detached inline-JSONL tee to the disk-only intake. */
  intakeShadow?: CaptureCellShadow;
  /** Authoritative delivery: throws unless the cell acknowledged its commit. */
  commit?: (data: { run_id: string }) => Promise<void>;
};

export function parseCaptureCellMode(value: string | undefined): CaptureCellMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "both" || normalized === "cell") return normalized;
  if (normalized && normalized !== "off") {
    console.warn(`[run-capture] unknown CAPTURE_CELL_MODE="${value}", using off`);
  }
  return "off";
}

/** The mode the route acts on today. */
export function effectiveCaptureCellMode(mode: CaptureCellMode): CaptureCellMode {
  return mode;
}

/** Equal jitter: 125–250ms before retry 1, 250–500ms before retry 2. */
export function captureCellBackoffMs(retry: number, random: () => number = Math.random): number {
  const ceiling = 250 * 2 ** Math.max(0, Math.min(retry - 1, 1));
  return Math.floor(ceiling / 2 + (ceiling / 2) * random());
}

function reportExhausted(failure: CaptureCellExhausted): void {
  console.warn("[run-capture] capture cell shadow post exhausted", failure);
  // Lazy-load the existing telemetry adapter; this alarm never extends the
  // delivery budget or imports the telemetry store on unrelated route startup.
  void import("../observability/emit")
    .then(({ emitOtelEvent }) =>
      emitOtelEvent({
        level: "error",
        source: "system-bus",
        component: "run-capture",
        action: "capture.cell.shadow.post_exhausted",
        success: false,
        error: failure.reason,
        duration_ms: failure.duration_ms,
        metadata: { run_id: failure.run_id, attempts: failure.attempts },
      }),
    )
    .catch(() => undefined);
}

/** Observers must not interrupt retries or throw back into the route. */
function notify<T>(observer: (value: T) => void, value: T): void {
  try {
    observer(value);
  } catch {
    // Telemetry is not the delivery path.
  }
}

export function createCaptureCellShadow(options: {
  url: string | undefined;
  token: string | undefined;
  timeoutMs: number;
  totalBudgetMs?: number;
  onFailure: (failure: CaptureCellFailure) => void;
  onExhausted?: (failure: CaptureCellExhausted) => void;
  fetch?: typeof fetch;
  random?: () => number;
  /** Fresh stream for every attempt; default preserves the pinned JSON bytes. */
  makeBody?: (data: { run_id: string }) => RequestInit["body"] | Promise<RequestInit["body"]>;
}): CaptureCellShadow {
  const doFetch = options.fetch ?? fetch;
  const onExhausted = options.onExhausted ?? reportExhausted;
  return async (data, serializedBody) => {
    const started = performance.now();
    const deadline = started + (options.totalBudgetMs ?? DEFAULT_CAPTURE_CELL_TOTAL_BUDGET_MS);
    const runId = data.run_id;
    let attempts = 0;
    let reason = "capture cell total budget exhausted";
    const fail = (at: number) =>
      notify(options.onFailure, {
        run_id: runId,
        reason,
        duration_ms: Math.round(performance.now() - at),
        attempt: attempts,
      });

    // State flow: posting -> delivered | failed -> stopped | backoff -> posting.
    // The deadline is shared by every attempt and every backoff, never reset.
    try {
      if (!options.url || !options.token) {
        reason =
          "capture cell not configured: set CAPTURE_CELL_URL (or CAPTURE_CELL_PORT) and CAPTURE_CELL_TOKEN";
        fail(started);
      } else {
        // Serialize once: every attempt carries the identical run_id and bytes.
        // The cell's fold dedupes on payload.run_id, not an HTTP header.
        const body = serializedBody ?? JSON.stringify(data);
        while (attempts < MAX_ATTEMPTS) {
          const remaining = deadline - performance.now();
          if (remaining <= 0) break;
          attempts += 1;
          const attemptStarted = performance.now();
          const timeoutMs = Math.min(options.timeoutMs, remaining);
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let retryable = true;
          try {
            // The race also bounds fetch implementations that ignore abort.
            const timedOut = new Promise<"timeout">((resolve) => {
              timer = setTimeout(() => {
                resolve("timeout");
                controller.abort();
              }, timeoutMs);
            });
            const outcome = await Promise.race([
              Promise.resolve()
                .then(() => (options.makeBody ? options.makeBody(data) : body))
                .then((requestBody) => {
                  if (controller.signal.aborted) {
                    if (requestBody instanceof ReadableStream)
                      void requestBody.cancel().catch(() => undefined);
                    throw new Error("capture cell body preparation timed out");
                  }
                  return doFetch(options.url!, {
                    method: "POST",
                    headers: {
                      authorization: `Bearer ${options.token}`,
                      "content-type": "application/json",
                      "x-capture-cell-mode": "both",
                    },
                    body: requestBody,
                    signal: controller.signal,
                  });
                })
                .then((response) => {
                  // Release even a late response from an abort-ignoring fetch.
                  void response.body?.cancel().catch(() => undefined);
                  return response;
                }),
              timedOut,
            ]);
            if (outcome === "timeout") {
              reason = `capture cell did not answer within ${Math.ceil(timeoutMs)}ms`;
            } else {
              if (outcome.status === 202) return;
              reason = `capture cell answered HTTP ${outcome.status}`;
              retryable = outcome.status >= 500 && outcome.status <= 599;
            }
          } catch (error) {
            reason = `capture cell request failed: ${String(error)}`;
          } finally {
            clearTimeout(timer);
          }
          fail(attemptStarted);
          if (!retryable || attempts === MAX_ATTEMPTS) break;
          const waitMs = captureCellBackoffMs(attempts, options.random);
          // Do not shorten jitter into a hot retry at the deadline.
          if (performance.now() + waitMs >= deadline) break;
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }
      }
    } catch (error) {
      reason = `capture cell request failed: ${String(error)}`;
      fail(started);
    }
    notify(onExhausted, {
      run_id: runId,
      reason,
      duration_ms: Math.round(performance.now() - started),
      attempts,
    });
  };
}

/** A lost acknowledgement fails closed; the caller retries the same run id. */
export function createCaptureCellCommit(options: {
  url: string | undefined;
  token: string | undefined;
  timeoutMs: number;
  fetch?: typeof fetch;
}): (data: { run_id: string }) => Promise<void> {
  const doFetch = options.fetch ?? fetch;
  return async (data) => {
    if (!options.url || !options.token) throw new Error("capture cell not configured");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        doFetch(options.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
            "x-capture-cell-mode": "cell",
          },
          body: JSON.stringify(data),
          signal: controller.signal,
        }).then((response) => {
          void response.body?.cancel().catch(() => undefined);
          return response;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("capture cell commit acknowledgement timed out"));
            controller.abort();
          }, options.timeoutMs);
        }),
      ]);
      if (response.status !== 202) throw new Error(`capture cell answered HTTP ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function captureCellUrl(env: Record<string, string | undefined>): string | undefined {
  const explicit = env.CAPTURE_CELL_URL?.trim();
  if (explicit) return `${explicit.replace(/\/+$/u, "")}/capture`;
  const port = env.CAPTURE_CELL_PORT?.trim();
  return port && /^\d+$/u.test(port) ? `http://127.0.0.1:${port}/capture` : undefined;
}

export function captureCellFromEnv(
  env: Record<string, string | undefined> = process.env,
  onFailure: (failure: CaptureCellFailure) => void = (failure) =>
    console.warn("[run-capture] capture cell shadow post failed", failure),
  onExhausted: (failure: CaptureCellExhausted) => void = reportExhausted,
): CaptureCellRouting {
  return {
    mode: parseCaptureCellMode(env.CAPTURE_CELL_MODE),
    intakeShadow: env.CAPTURE_INTAKE_URL?.trim()
      ? createCaptureCellShadow({
          url: `${env.CAPTURE_INTAKE_URL.trim().replace(/\/+$/u, "")}/api/runs`,
          token: env.CAPTURE_INTAKE_TOKEN?.trim(),
          timeoutMs: positiveInteger(
            env.CAPTURE_INTAKE_TIMEOUT_MS,
            DEFAULT_CAPTURE_CELL_TIMEOUT_MS,
          ),
          totalBudgetMs: positiveInteger(
            env.CAPTURE_INTAKE_TOTAL_BUDGET_MS,
            DEFAULT_CAPTURE_CELL_TOTAL_BUDGET_MS,
          ),
          onFailure,
          onExhausted,
          makeBody: async (data) => {
            const { inlineBody } = await import("@joelclaw/capture-cell/intake");
            const { jsonl_path, ...metadata } = data as { run_id: string; jsonl_path: string };
            return inlineBody(metadata, jsonl_path);
          },
        })
      : undefined,
    commit: createCaptureCellCommit({
      url: captureCellUrl(env),
      token: env.CAPTURE_CELL_TOKEN?.trim() || undefined,
      timeoutMs: positiveInteger(env.CAPTURE_CELL_TIMEOUT_MS, DEFAULT_CAPTURE_CELL_TIMEOUT_MS),
    }),
    shadow: createCaptureCellShadow({
      url: captureCellUrl(env),
      token: env.CAPTURE_CELL_TOKEN?.trim() || undefined,
      timeoutMs: positiveInteger(env.CAPTURE_CELL_TIMEOUT_MS, DEFAULT_CAPTURE_CELL_TIMEOUT_MS),
      totalBudgetMs: positiveInteger(
        env.CAPTURE_CELL_TOTAL_BUDGET_MS,
        DEFAULT_CAPTURE_CELL_TOTAL_BUDGET_MS,
      ),
      onFailure,
      onExhausted,
    }),
  };
}

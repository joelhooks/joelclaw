export type ErrorSummary = {
  windowStartedAt: number;
  windowEndedAt: number;
  emitted: number;
  suppressed: number;
  suppressedSignatures: string[];
};

export type ErrorEmissionDecision = {
  emit: boolean;
  summary?: ErrorSummary;
};

type ErrorBudgetOptions = {
  windowMs: number;
  maxDistinctPerWindow: number;
  now?: () => number;
};

/**
 * Emits each distinct failure only once per window, with a bounded number of
 * distinct failures. Repeated failures collapse into one summary row.
 */
export class ErrorEmissionBudget {
  readonly #windowMs: number;
  readonly #maxDistinctPerWindow: number;
  readonly #now: () => number;
  #windowStartedAt: number;
  #emittedSignatures = new Set<string>();
  #suppressed = 0;
  #suppressedSignatures = new Set<string>();

  constructor(options: ErrorBudgetOptions) {
    this.#windowMs = options.windowMs;
    this.#maxDistinctPerWindow = options.maxDistinctPerWindow;
    this.#now = options.now ?? Date.now;
    this.#windowStartedAt = this.#now();
  }

  record(signature: string): ErrorEmissionDecision {
    const now = this.#now();
    const summary = now - this.#windowStartedAt >= this.#windowMs
      ? this.#rotate(now)
      : undefined;

    if (
      !this.#emittedSignatures.has(signature)
      && this.#emittedSignatures.size < this.#maxDistinctPerWindow
    ) {
      this.#emittedSignatures.add(signature);
      return { emit: true, ...(summary ? { summary } : {}) };
    }

    this.#suppressed += 1;
    if (this.#suppressedSignatures.size < this.#maxDistinctPerWindow) {
      this.#suppressedSignatures.add(signature);
    }
    return { emit: false, ...(summary ? { summary } : {}) };
  }

  flush(): ErrorSummary | undefined {
    return this.#rotate(this.#now());
  }

  #rotate(windowEndedAt: number): ErrorSummary | undefined {
    const summary = this.#suppressed > 0
      ? {
          windowStartedAt: this.#windowStartedAt,
          windowEndedAt,
          emitted: this.#emittedSignatures.size,
          suppressed: this.#suppressed,
          suppressedSignatures: [...this.#suppressedSignatures],
        }
      : undefined;

    this.#windowStartedAt = windowEndedAt;
    this.#emittedSignatures.clear();
    this.#suppressed = 0;
    this.#suppressedSignatures.clear();
    return summary;
  }
}

export type ErrorDescription = {
  message: string;
  name: string;
  code?: string;
  causes: string[];
  signature: string;
};

export function describeError(error: unknown): ErrorDescription {
  if (!(error instanceof Error)) {
    const message = String(error).slice(0, 500);
    return { message, name: "Error", causes: [], signature: message };
  }

  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const causes = error instanceof AggregateError
    ? error.errors.slice(0, 5).map((cause) => String(cause).slice(0, 500))
    : error.cause
      ? [String(error.cause).slice(0, 500)]
      : [];
  const message = (error.message || error.name).slice(0, 500);
  const signature = [error.name, code, message, ...causes].filter(Boolean).join(":").slice(0, 1_000);

  return {
    message,
    name: error.name,
    ...(code ? { code } : {}),
    causes,
    signature,
  };
}

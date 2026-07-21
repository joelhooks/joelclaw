import { Data, Effect } from "effect";

export type IncidentLatchKind = "first" | "repeat-silenced" | "final-notice";

export interface IncidentLatchCheckOptions {
  readonly quietWindowMs: number;
  readonly attemptCap: number;
}

export interface IncidentLatchDecision {
  readonly key: string;
  readonly speak: boolean;
  readonly kind: IncidentLatchKind;
  readonly attempt: number;
  readonly firstSeenAt: number;
  readonly checkedAt: number;
  readonly quietWindowMs: number;
  readonly attemptCap: number;
  readonly latchAvailable: boolean;
  readonly detail: string | null;
}

export interface IncidentLatchResolveOptions {
  readonly allClear?: boolean;
}

export interface IncidentLatchResolution {
  readonly key: string;
  readonly resolved: boolean;
  readonly speakAllClear: boolean;
  readonly resolvedAt: number;
  readonly latchAvailable: boolean;
  readonly detail: string | null;
}

export interface IncidentLatchTransition {
  readonly kind: IncidentLatchKind;
  readonly attempt: number;
  readonly firstSeenAt: number;
}

export class IncidentLatchStorageError extends Data.TaggedError("IncidentLatchStorageError")<{
  readonly operation: "check" | "resolve";
  readonly key: string;
  readonly cause: unknown;
}> {}

export class IncidentLatchConfigError extends Data.TaggedError("IncidentLatchConfigError")<{
  readonly field: "key" | "quietWindowMs" | "attemptCap";
  readonly value: unknown;
  readonly message: string;
}> {}

export interface IncidentLatchStore {
  readonly check: (
    key: string,
    input: { readonly now: number; readonly quietWindowMs: number; readonly attemptCap: number },
  ) => Effect.Effect<IncidentLatchTransition, IncidentLatchStorageError>;
  readonly resolve: (key: string) => Effect.Effect<boolean, IncidentLatchStorageError>;
}

export interface RedisIncidentLatchClient {
  readonly eval: (
    script: string,
    numberOfKeys: number,
    ...args: ReadonlyArray<string | number>
  ) => Promise<unknown>;
  readonly del: (key: string) => Promise<number>;
}

export interface IncidentLatch {
  readonly check: (
    key: string,
    options: IncidentLatchCheckOptions,
  ) => Effect.Effect<IncidentLatchDecision, IncidentLatchConfigError>;
  readonly resolve: (
    key: string,
    options?: IncidentLatchResolveOptions,
  ) => Effect.Effect<IncidentLatchResolution, IncidentLatchConfigError>;
}

const CHECK_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local quiet_window_ms = tonumber(ARGV[2])
local attempt_cap = tonumber(ARGV[3])

if redis.call("EXISTS", key) == 0 then
  redis.call("HSET", key, "attempt", 1, "first_seen_at", now, "final_notice_sent", 0)
  redis.call("PEXPIRE", key, quiet_window_ms)
  return { "first", 1, now }
end

local first_seen_at = tonumber(redis.call("HGET", key, "first_seen_at")) or now
local prior_attempt = tonumber(redis.call("HGET", key, "attempt")) or 0
local final_notice_sent = tonumber(redis.call("HGET", key, "final_notice_sent")) or 0
local attempt = math.min(prior_attempt + 1, attempt_cap)
local kind = "repeat-silenced"

if attempt >= attempt_cap and final_notice_sent == 0 then
  kind = "final-notice"
  final_notice_sent = 1
end

redis.call("HSET", key, "attempt", attempt, "first_seen_at", first_seen_at, "final_notice_sent", final_notice_sent)
redis.call("PEXPIRE", key, quiet_window_ms)
return { kind, attempt, first_seen_at }
`;

function storageDetail(error: IncidentLatchStorageError): string {
  const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
  return `${error.operation} failed: ${cause}`.slice(0, 500);
}

function validateKey(key: string): Effect.Effect<string, IncidentLatchConfigError> {
  const normalized = key.trim();
  if (normalized.length > 0) return Effect.succeed(normalized);
  return Effect.fail(new IncidentLatchConfigError({
    field: "key",
    value: key,
    message: "key must not be empty",
  }));
}

function validateOptions(
  options: IncidentLatchCheckOptions,
): Effect.Effect<IncidentLatchCheckOptions, IncidentLatchConfigError> {
  if (!Number.isSafeInteger(options.quietWindowMs) || options.quietWindowMs <= 0) {
    return Effect.fail(new IncidentLatchConfigError({
      field: "quietWindowMs",
      value: options.quietWindowMs,
      message: "quietWindowMs must be a positive safe integer",
    }));
  }
  if (!Number.isSafeInteger(options.attemptCap) || options.attemptCap < 2) {
    return Effect.fail(new IncidentLatchConfigError({
      field: "attemptCap",
      value: options.attemptCap,
      message: "attemptCap must be a safe integer of at least 2",
    }));
  }
  return Effect.succeed(options);
}

function parseRedisTransition(value: unknown): IncidentLatchTransition {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error("Redis returned an invalid latch transition");
  }
  const [kind, rawAttempt, rawFirstSeenAt] = value;
  const attempt = Number(rawAttempt);
  const firstSeenAt = Number(rawFirstSeenAt);
  if (
    (kind !== "first" && kind !== "repeat-silenced" && kind !== "final-notice") ||
    !Number.isSafeInteger(attempt) ||
    !Number.isSafeInteger(firstSeenAt)
  ) {
    throw new Error("Redis returned malformed latch fields");
  }
  return { kind, attempt, firstSeenAt };
}

export function makeRedisIncidentLatchStore(
  redis: RedisIncidentLatchClient,
  options: { readonly prefix?: string } = {},
): IncidentLatchStore {
  const prefix = options.prefix ?? "incident-latch";
  const redisKey = (key: string) => `${prefix}:${key}`;

  return {
    check: (key, input) => Effect.tryPromise({
      try: async () => parseRedisTransition(await redis.eval(
        CHECK_SCRIPT,
        1,
        redisKey(key),
        input.now,
        input.quietWindowMs,
        input.attemptCap,
      )),
      catch: (cause) => new IncidentLatchStorageError({ operation: "check", key, cause }),
    }),
    resolve: (key) => Effect.tryPromise({
      try: async () => (await redis.del(redisKey(key))) > 0,
      catch: (cause) => new IncidentLatchStorageError({ operation: "resolve", key, cause }),
    }),
  };
}

export function makeIncidentLatch(
  store: IncidentLatchStore,
  options: { readonly now?: () => number } = {},
): IncidentLatch {
  const now = options.now ?? Date.now;

  return {
    check: (rawKey, rawOptions) => Effect.gen(function* () {
      const key = yield* validateKey(rawKey);
      const checkOptions = yield* validateOptions(rawOptions);
      const checkedAt = now();
      const transition = yield* store.check(key, {
        now: checkedAt,
        quietWindowMs: checkOptions.quietWindowMs,
        attemptCap: checkOptions.attemptCap,
      }).pipe(
        Effect.map((result) => ({ _tag: "available" as const, result })),
        Effect.catchAll((error) => Effect.succeed({ _tag: "unavailable" as const, error })),
      );

      if (transition._tag === "unavailable") {
        return {
          key,
          speak: true,
          kind: "first",
          attempt: 1,
          firstSeenAt: checkedAt,
          checkedAt,
          quietWindowMs: checkOptions.quietWindowMs,
          attemptCap: checkOptions.attemptCap,
          latchAvailable: false,
          detail: storageDetail(transition.error),
        } satisfies IncidentLatchDecision;
      }

      return {
        key,
        speak: transition.result.kind !== "repeat-silenced",
        kind: transition.result.kind,
        attempt: transition.result.attempt,
        firstSeenAt: transition.result.firstSeenAt,
        checkedAt,
        quietWindowMs: checkOptions.quietWindowMs,
        attemptCap: checkOptions.attemptCap,
        latchAvailable: true,
        detail: null,
      } satisfies IncidentLatchDecision;
    }),

    resolve: (rawKey, resolveOptions = {}) => Effect.gen(function* () {
      const key = yield* validateKey(rawKey);
      const resolvedAt = now();
      const outcome = yield* store.resolve(key).pipe(
        Effect.map((resolved) => ({ resolved, error: null as IncidentLatchStorageError | null })),
        Effect.catchAll((error) => Effect.succeed({ resolved: false, error })),
      );
      return {
        key,
        resolved: outcome.resolved,
        speakAllClear: outcome.resolved && resolveOptions.allClear === true,
        resolvedAt,
        latchAvailable: outcome.error === null,
        detail: outcome.error ? storageDetail(outcome.error) : null,
      } satisfies IncidentLatchResolution;
    }),
  };
}

export interface PromiseIncidentLatch {
  readonly check: (
    key: string,
    options: IncidentLatchCheckOptions,
  ) => Promise<IncidentLatchDecision>;
  readonly resolve: (
    key: string,
    options?: IncidentLatchResolveOptions,
  ) => Promise<IncidentLatchResolution>;
}

export function makePromiseIncidentLatch(
  store: IncidentLatchStore,
  options: { readonly now?: () => number } = {},
): PromiseIncidentLatch {
  const latch = makeIncidentLatch(store, options);
  return {
    check: (key, checkOptions) => Effect.runPromise(latch.check(key, checkOptions)),
    resolve: (key, resolveOptions) => Effect.runPromise(latch.resolve(key, resolveOptions)),
  };
}

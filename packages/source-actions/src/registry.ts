import { randomUUID } from "node:crypto";
import { Context, Data, Effect, Either, Layer } from "effect";
import { getNextSnapshot, setup } from "xstate";
import type { MutationReceipt, SourceRef } from "./types";

export const ACTION_CALLBACK_PREFIX = "act:";
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
export const ACTION_REGISTRY_KEY = "joelclaw:source-actions:registry:v1";
export const ACTION_CLAIM_KEY_PREFIX = "joelclaw:source-actions:claim:v1:";
export const DEFAULT_ACTION_CLAIM_LEASE_MS = 60_000;

const RELEASE_CLAIM_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const RENEW_CLAIM_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

const SETTLE_CLAIM_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call("HSET", KEYS[2], ARGV[2], ARGV[3])
redis.call("DEL", KEYS[1])
return 1
`;

export type ActionOperation = "resolve" | "acknowledge" | "snooze" | "open-url";
export type ActionState =
  | "pending"
  | "applied"
  | "already-applied"
  | "failed"
  | "expired";

export type ActionRecord = {
  actionId: string;
  sourceRef: SourceRef;
  allowedOperations: readonly ActionOperation[];
  state: ActionState;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  receipt?: MutationReceipt;
  failure?: string;
};

export type ActionClaim = {
  record: ActionRecord;
  claimToken: string;
  leaseMs: number;
  claimExpiresAt: string;
};

export type RegisterActionInput = {
  sourceRef: SourceRef;
  allowedOperations: readonly ActionOperation[];
  expiresAt?: string;
};

export type ActionStateEvent =
  | { type: "RECEIPT_APPLIED" }
  | { type: "RECEIPT_ALREADY_APPLIED" }
  | { type: "FAIL" }
  | { type: "RETRY" }
  | { type: "EXPIRE" };

export type ActionRegistryOptions = {
  now?: () => Date;
  key?: string;
  claimLeaseMs?: number;
};

export class RegistryError extends Data.TaggedError("RegistryError")<{
  operation: "register" | "get" | "authorize" | "transition" | "renew";
  message: string;
  actionId?: string;
  cause?: unknown;
}> {}

/** Minimal structural subset implemented by ioredis. */
export interface RedisActionRegistryClient {
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    expiryMode: "PX",
    leaseMs: number,
    setMode: "NX",
  ): Promise<"OK" | null>;
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface ActionRegistryService {
  register(input: RegisterActionInput): Effect.Effect<ActionRecord, RegistryError>;
  get(actionId: string): Effect.Effect<ActionRecord, RegistryError>;
  authorize(
    actionId: string,
    operation: ActionOperation,
  ): Effect.Effect<ActionClaim, RegistryError>;
  renewClaim(claim: ActionClaim): Effect.Effect<ActionClaim, RegistryError>;
  applyReceipt(
    claim: ActionClaim,
    receipt: MutationReceipt,
  ): Effect.Effect<ActionRecord, RegistryError>;
  markFailed(claim: ActionClaim, failure: string): Effect.Effect<ActionRecord, RegistryError>;
  retry(actionId: string): Effect.Effect<ActionRecord, RegistryError>;
  expire(actionId: string): Effect.Effect<ActionRecord, RegistryError>;
}

export class ActionRegistry extends Context.Tag("joelclaw/ActionRegistry")<
  ActionRegistry,
  ActionRegistryService
>() {}

export const actionStateMachine = setup({
  types: {
    context: {} as Record<string, never>,
    events: {} as ActionStateEvent,
  },
}).createMachine({
  id: "sourceAction",
  context: {},
  initial: "pending",
  states: {
    pending: {
      on: {
        RECEIPT_APPLIED: "applied",
        RECEIPT_ALREADY_APPLIED: "already-applied",
        FAIL: "failed",
        EXPIRE: "expired",
      },
    },
    failed: {
      on: {
        RETRY: "pending",
        EXPIRE: "expired",
      },
    },
    applied: { type: "final" },
    "already-applied": { type: "final" },
    expired: { type: "final" },
  },
});

export function transitionActionState(state: ActionState, event: ActionStateEvent): ActionState {
  const snapshot = actionStateMachine.resolveState({ value: state, context: {} });
  return getNextSnapshot(actionStateMachine, snapshot, event).value as ActionState;
}

export function createActionId(uuid: string = randomUUID()): string {
  const actionId = `${ACTION_CALLBACK_PREFIX}${uuid}`;
  if (Buffer.byteLength(actionId, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new RegistryError({
      operation: "register",
      actionId,
      message: "Action callback data exceeds Telegram's 64-byte limit",
    });
  }
  return actionId;
}

export function toActionRenderState(record: ActionRecord): {
  pending: boolean;
  terminal: boolean;
  label: "Pending…" | "Done" | "Already done" | "Failed" | "Expired";
} {
  switch (record.state) {
    case "pending":
      return { pending: true, terminal: false, label: "Pending…" };
    case "applied":
      return { pending: false, terminal: true, label: "Done" };
    case "already-applied":
      return { pending: false, terminal: true, label: "Already done" };
    case "failed":
      return { pending: false, terminal: false, label: "Failed" };
    case "expired":
      return { pending: false, terminal: true, label: "Expired" };
  }
}

const ACTION_STATES = new Set<ActionState>([
  "pending",
  "applied",
  "already-applied",
  "failed",
  "expired",
]);

function parseRecord(raw: string, actionId: string): ActionRecord {
  try {
    const value = JSON.parse(raw) as Partial<ActionRecord>;
    if (
      value.actionId !== actionId ||
      !value.sourceRef ||
      !Array.isArray(value.allowedOperations) ||
      typeof value.state !== "string" ||
      !ACTION_STATES.has(value.state as ActionState) ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      throw new Error("invalid action record shape");
    }
    return value as ActionRecord;
  } catch (cause) {
    throw new RegistryError({
      operation: "get",
      actionId,
      message: `Action registry record is invalid: ${actionId}`,
      cause,
    });
  }
}

export function makeRedisActionRegistry(
  redis: RedisActionRegistryClient,
  options: ActionRegistryOptions = {},
): ActionRegistryService {
  const now = options.now ?? (() => new Date());
  const key = options.key ?? ACTION_REGISTRY_KEY;
  const claimLeaseMs = options.claimLeaseMs ?? DEFAULT_ACTION_CLAIM_LEASE_MS;
  if (!Number.isSafeInteger(claimLeaseMs) || claimLeaseMs <= 0) {
    throw new RegistryError({
      operation: "register",
      message: "Action claim lease must be a positive integer",
    });
  }

  const claimKey = (actionId: string) => `${ACTION_CLAIM_KEY_PREFIX}${actionId}`;
  const claimExpiry = () => new Date(now().getTime() + claimLeaseMs).toISOString();

  const persist = (record: ActionRecord, operation: RegistryError["operation"]) =>
    Effect.tryPromise({
      try: () => redis.hset(key, record.actionId, JSON.stringify(record)),
      catch: (cause) =>
        new RegistryError({
          operation,
          actionId: record.actionId,
          message: `Failed to persist action ${record.actionId}`,
          cause,
        }),
    }).pipe(Effect.as(record));

  const load = (actionId: string) =>
    Effect.tryPromise({
      try: () => redis.hget(key, actionId),
      catch: (cause) =>
        new RegistryError({
          operation: "get",
          actionId,
          message: `Failed to read action ${actionId}`,
          cause,
        }),
    }).pipe(
      Effect.flatMap((raw) =>
        raw === null
          ? Effect.fail(
              new RegistryError({
                operation: "get",
                actionId,
                message: `Action not found: ${actionId}`,
              }),
            )
          : Effect.try({
              try: () => parseRecord(raw, actionId),
              catch: (cause) =>
                cause instanceof RegistryError
                  ? cause
                  : new RegistryError({
                      operation: "get",
                      actionId,
                      message: `Failed to decode action ${actionId}`,
                      cause,
                    }),
            }),
      ),
    );

  const acquireClaim = (actionId: string) => {
    const claimToken = randomUUID();
    return Effect.tryPromise({
      try: () => redis.set(claimKey(actionId), claimToken, "PX", claimLeaseMs, "NX"),
      catch: (cause) =>
        new RegistryError({
          operation: "authorize",
          actionId,
          message: `Failed to claim action ${actionId}`,
          cause,
        }),
    }).pipe(
      Effect.flatMap((result) =>
        result === "OK"
          ? Effect.succeed(claimToken)
          : Effect.fail(
              new RegistryError({
                operation: "authorize",
                actionId,
                message: `Action is already in flight: ${actionId}`,
              }),
            ),
      ),
    );
  };

  const releaseClaim = (actionId: string, claimToken: string) =>
    Effect.tryPromise({
      try: () => redis.eval(RELEASE_CLAIM_SCRIPT, 1, claimKey(actionId), claimToken),
      catch: (cause) =>
        new RegistryError({
          operation: "transition",
          actionId,
          message: `Failed to release action claim ${actionId}`,
          cause,
        }),
    }).pipe(Effect.asVoid);

  const buildTransition = (
    actionId: string,
    event: ActionStateEvent,
    patch: Partial<ActionRecord> = {},
  ) =>
    Effect.gen(function* () {
      const current = yield* load(actionId);
      const nextState = transitionActionState(current.state, event);
      if (nextState === current.state) {
        return yield* Effect.fail(
          new RegistryError({
            operation: "transition",
            actionId,
            message: `Invalid action transition: ${current.state} + ${event.type}`,
          }),
        );
      }
      return {
        ...current,
        ...patch,
        state: nextState,
        updatedAt: now().toISOString(),
      } satisfies ActionRecord;
    });

  const settleClaim = (
    claim: ActionClaim,
    event: ActionStateEvent,
    patch: Partial<ActionRecord> = {},
  ) =>
    Effect.gen(function* () {
      const next = yield* buildTransition(claim.record.actionId, event, patch);
      const settled = yield* Effect.tryPromise({
        try: () =>
          redis.eval(
            SETTLE_CLAIM_SCRIPT,
            2,
            claimKey(claim.record.actionId),
            key,
            claim.claimToken,
            claim.record.actionId,
            JSON.stringify(next),
          ),
        catch: (cause) =>
          new RegistryError({
            operation: "transition",
            actionId: claim.record.actionId,
            message: `Failed to settle action ${claim.record.actionId}`,
            cause,
          }),
      });
      if (settled !== 1) {
        return yield* Effect.fail(
          new RegistryError({
            operation: "transition",
            actionId: claim.record.actionId,
            message: "Action claim expired or is owned by another callback",
          }),
        );
      }
      return next;
    });

  const transitionWithTemporaryClaim = (
    actionId: string,
    event: ActionStateEvent,
    patch: Partial<ActionRecord> = {},
  ) =>
    Effect.gen(function* () {
      const claimToken = yield* acquireClaim(actionId);
      const current = yield* Effect.either(load(actionId));
      if (Either.isLeft(current)) {
        yield* releaseClaim(actionId, claimToken);
        return yield* Effect.fail(current.left);
      }
      const result = yield* Effect.either(
        settleClaim(
          {
            record: current.right,
            claimToken,
            leaseMs: claimLeaseMs,
            claimExpiresAt: claimExpiry(),
          },
          event,
          patch,
        ),
      );
      if (Either.isLeft(result)) {
        yield* releaseClaim(actionId, claimToken);
        return yield* Effect.fail(result.left);
      }
      return result.right;
    });

  const get = Effect.fn("ActionRegistry.get")(function* (actionId: string) {
    return yield* load(actionId);
  });

  const register = Effect.fn("ActionRegistry.register")(function* (input: RegisterActionInput) {
    const actionId = yield* Effect.try({
      try: () => createActionId(),
      catch: (cause) =>
        cause instanceof RegistryError
          ? cause
          : new RegistryError({ operation: "register", message: "Failed to create action ID", cause }),
    });
    const timestamp = now().toISOString();
    const record: ActionRecord = {
      actionId,
      sourceRef: input.sourceRef,
      allowedOperations: [...new Set(input.allowedOperations)],
      state: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    return yield* persist(record, "register");
  });

  const authorize = Effect.fn("ActionRegistry.authorize")(function* (
    actionId: string,
    operation: ActionOperation,
  ) {
    const claimToken = yield* acquireClaim(actionId);
    const loaded = yield* Effect.either(load(actionId));
    if (Either.isLeft(loaded)) {
      yield* releaseClaim(actionId, claimToken);
      return yield* Effect.fail(loaded.left);
    }

    const record = loaded.right;
    const claim: ActionClaim = {
      record,
      claimToken,
      leaseMs: claimLeaseMs,
      claimExpiresAt: claimExpiry(),
    };
    if (record.state !== "pending") {
      yield* releaseClaim(actionId, claimToken);
      return yield* Effect.fail(
        new RegistryError({
          operation: "authorize",
          actionId,
          message: `Action is not pending: ${record.state}`,
        }),
      );
    }
    if (!record.allowedOperations.includes(operation)) {
      yield* releaseClaim(actionId, claimToken);
      return yield* Effect.fail(
        new RegistryError({
          operation: "authorize",
          actionId,
          message: `Operation is not allowed: ${operation}`,
        }),
      );
    }
    if (record.expiresAt && Date.parse(record.expiresAt) <= now().getTime()) {
      const expired = yield* Effect.either(settleClaim(claim, { type: "EXPIRE" }));
      if (Either.isLeft(expired)) return yield* Effect.fail(expired.left);
      return yield* Effect.fail(
        new RegistryError({ operation: "authorize", actionId, message: "Action is expired" }),
      );
    }

    return claim;
  });

  const renewClaim = Effect.fn("ActionRegistry.renewClaim")(function* (claim: ActionClaim) {
    const renewed = yield* Effect.tryPromise({
      try: () =>
        redis.eval(
          RENEW_CLAIM_SCRIPT,
          1,
          claimKey(claim.record.actionId),
          claim.claimToken,
          claimLeaseMs,
        ),
      catch: (cause) =>
        new RegistryError({
          operation: "renew",
          actionId: claim.record.actionId,
          message: `Failed to renew action claim ${claim.record.actionId}`,
          cause,
        }),
    });
    if (renewed !== 1) {
      return yield* Effect.fail(
        new RegistryError({
          operation: "renew",
          actionId: claim.record.actionId,
          message: "Action claim expired or is owned by another callback",
        }),
      );
    }
    return { ...claim, claimExpiresAt: claimExpiry() };
  });

  const applyReceipt = Effect.fn("ActionRegistry.applyReceipt")(function* (
    claim: ActionClaim,
    receipt: MutationReceipt,
  ) {
    return yield* settleClaim(
      claim,
      {
        type:
          receipt.outcome === "applied"
            ? "RECEIPT_APPLIED"
            : "RECEIPT_ALREADY_APPLIED",
      },
      { receipt, failure: undefined },
    );
  });

  const markFailed = Effect.fn("ActionRegistry.markFailed")(function* (
    claim: ActionClaim,
    failure: string,
  ) {
    return yield* settleClaim(claim, { type: "FAIL" }, { failure });
  });

  const retry = Effect.fn("ActionRegistry.retry")(function* (actionId: string) {
    return yield* transitionWithTemporaryClaim(actionId, { type: "RETRY" }, { failure: undefined });
  });

  const expire = Effect.fn("ActionRegistry.expire")(function* (actionId: string) {
    return yield* transitionWithTemporaryClaim(actionId, { type: "EXPIRE" });
  });

  return { register, get, authorize, renewClaim, applyReceipt, markFailed, retry, expire };
}

export const actionRegistryLayer = (
  redis: RedisActionRegistryClient,
  options?: ActionRegistryOptions,
) => Layer.succeed(ActionRegistry, makeRedisActionRegistry(redis, options));

import { Data, Effect } from "effect";
import { type ActorRefFrom, createActor } from "xstate";

import { detectRepeatedTokenCollapse } from "./degeneration";
import {
  type AgentObservation,
  type DriverState,
  driverMachine,
  type RetireReason,
} from "./machine";

export const DEFAULT_HEARTBEAT_KEY = "gateway:agent:heartbeat";
export const DEFAULT_HEARTBEAT_REFRESH_MS = 15_000;
export const DEFAULT_HEARTBEAT_TTL_MS = 60_000;
// Measured live 2026-07-21: real gateway turns run 1-3 minutes. A 120s
// deadline scored healthy turns as failures and flapped the heartbeat.
export const DEFAULT_POKE_DEADLINE_MS = 300_000;
export const DEFAULT_SUCCESSOR_DEADLINE_MS = 120_000;
/** Wall-clock session age before a clean idle retire. Prefer honest age over fragile token parsing. */
export const DEFAULT_MAX_SESSION_AGE_MS = 4 * 60 * 60 * 1000;
/** A wedged aggregate defers retire this long, then loses. */
export const DEFAULT_AGGREGATE_GRACE_MS = 60 * 60 * 1000;
export const DRIVER_POKE_TEXT = "Unhandled gateway stream work exists. Read the authoritative stream and decide it.";

export type AggregateDeadline = {
  aggregateId: string;
  memberEventIds: string[];
  holdUntil: number;
  follows?: string;
};

export type SessionHandoffInput = {
  reason: RetireReason;
  sessionAgeMs: number;
  note: string;
};

export type DriverReceipt = {
  at: number;
  action:
    | "observed"
    | "poke.started"
    | "poke.answered"
    | "poke.failed"
    | "heartbeat.refreshed"
    | "heartbeat.withheld"
    | "aggregate.deadline.fired"
    | "session.retire.requested"
    | "session.retire.stopped"
    | "successor.spawn.requested"
    | "successor.spawn.failed";
  state: DriverState;
  detail?: Record<string, unknown>;
};

export type DriverPorts = {
  inspectAgent: () => Promise<
    Omit<
      AgentObservation,
      "hasUnhandledWork" | "degenerated" | "sessionAgeMs" | "openAggregates" | "observedAt"
    >
    & { sessionStartedAt?: number }
  >;
  countUnhandled: () => Promise<number>;
  /** Recent terminal/assistant text used only for degeneration detection. */
  readRecentOutput: () => Promise<string>;
  promptAgent: (text: string, timeoutMs: number) => Promise<void>;
  listDueDeadlines: (now: number) => Promise<AggregateDeadline[]>;
  /** Open (opened, not yet close-delivered) aggregates. Read after listDueDeadlines. */
  countOpenAggregates: () => Promise<number>;
  appendDeadline: (deadline: AggregateDeadline) => Promise<void>;
  refreshHeartbeat: (key: string, ttlMs: number, value: string) => Promise<void>;
  /** Append advisory gateway.handoff before a planned retire. */
  writeHandoff: (input: SessionHandoffInput) => Promise<void>;
  /** Stop the live agent process in-place; keep the pane for relaunch. */
  stopSession: () => Promise<void>;
  requestSuccessor: () => Promise<void>;
  recordReceipt: (receipt: DriverReceipt) => Promise<void>;
  now: () => number;
};

export type DriverOptions = {
  heartbeatKey?: string;
  heartbeatTtlMs?: number;
  pokeDeadlineMs?: number;
  successorDeadlineMs?: number;
  /** Wall-clock age limit. Default 4h. Set 0 to disable age retire. */
  maxSessionAgeMs?: number;
  /** Extra time an open aggregate may hold off an age retire. Default 1h. */
  aggregateGraceMs?: number;
  pokeText?: string;
};

export class DriverPassError extends Data.TaggedError("DriverPassError")<{
  operation: string;
  cause: unknown;
}> {}

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DriverPassError({ operation, cause }),
  });

const stateOf = (actor: ActorRefFrom<typeof driverMachine>): DriverState =>
  actor.getSnapshot().value as DriverState;

const handoffNote = (reason: RetireReason, sessionAgeMs: number): string => {
  if (reason === "degeneration") {
    return "Driver forced retire: repeated-token collapse detected in recent session output. Replay is authoritative.";
  }
  const hours = Math.round((sessionAgeMs / 3_600_000) * 10) / 10;
  return `Driver clean retire after ${hours}h wall-clock session age. Replay is authoritative.`;
};

export class AgentCommsDriver {
  readonly #actor = createActor(driverMachine);
  readonly #heartbeatKey: string;
  readonly #heartbeatTtlMs: number;
  readonly #pokeDeadlineMs: number;
  readonly #successorDeadlineMs: number;
  readonly #maxSessionAgeMs: number;
  readonly #aggregateGraceMs: number;
  readonly #pokeText: string;
  #started = false;
  /** Wall-clock start of the currently observed live session. */
  #sessionStartedAt?: number;

  constructor(
    readonly ports: DriverPorts,
    options: DriverOptions = {},
  ) {
    this.#heartbeatKey = options.heartbeatKey ?? DEFAULT_HEARTBEAT_KEY;
    this.#heartbeatTtlMs = options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
    this.#pokeDeadlineMs = options.pokeDeadlineMs ?? DEFAULT_POKE_DEADLINE_MS;
    this.#successorDeadlineMs = options.successorDeadlineMs ?? DEFAULT_SUCCESSOR_DEADLINE_MS;
    this.#maxSessionAgeMs = options.maxSessionAgeMs ?? DEFAULT_MAX_SESSION_AGE_MS;
    this.#aggregateGraceMs = options.aggregateGraceMs ?? DEFAULT_AGGREGATE_GRACE_MS;
    this.#pokeText = options.pokeText ?? DRIVER_POKE_TEXT;
  }

  get state(): DriverState {
    return stateOf(this.#actor);
  }

  get retireReason(): RetireReason | undefined {
    return this.#actor.getSnapshot().context.retireReason;
  }

  start(): void {
    if (this.#started) return;
    this.#actor.start();
    this.#started = true;
  }

  stop(): void {
    if (!this.#started) return;
    this.#actor.send({ type: "STOP" });
    this.#actor.stop();
    this.#started = false;
  }

  runPass(): Effect.Effect<DriverState, DriverPassError> {
    return Effect.gen(this, function* () {
      this.start();
      const now = this.ports.now();
      const [agent, unhandled, deadlines, recentOutput] = yield* Effect.all(
        [
          attempt("inspectAgent", this.ports.inspectAgent),
          attempt("countUnhandled", this.ports.countUnhandled),
          attempt("listDueDeadlines", () => this.ports.listDueDeadlines(now)),
          attempt("readRecentOutput", this.ports.readRecentOutput),
        ],
        { concurrency: "unbounded" },
      );

      for (const deadline of deadlines) {
        yield* attempt("appendDeadline", () => this.ports.appendDeadline(deadline));
        yield* this.#receipt("aggregate.deadline.fired", {
          aggregateId: deadline.aggregateId,
          holdUntil: deadline.holdUntil,
        });
      }

      if (agent.sessionExists) {
        // Prefer the session's real start when the adapter can see it; first
        // sighting is only a fallback. Otherwise a driver restart hands a
        // days-old session a fresh lease — exactly when it most needs retiring.
        this.#sessionStartedAt = agent.sessionStartedAt ?? this.#sessionStartedAt ?? now;
      } else {
        this.#sessionStartedAt = undefined;
      }
      const sessionAgeMs = this.#sessionStartedAt === undefined
        ? 0
        : Math.max(0, now - this.#sessionStartedAt);

      const collapse = detectRepeatedTokenCollapse(recentOutput);
      const degenerated = collapse.degenerated;

      // Read after the deadline pass so the index reflects this pass's stream.
      const openAggregates = yield* attempt("countOpenAggregates", this.ports.countOpenAggregates);

      this.#actor.send({
        type: "OBSERVED",
        ...agent,
        hasUnhandledWork: unhandled > 0,
        degenerated,
        sessionAgeMs,
        openAggregates,
        observedAt: now,
        pokeDeadlineMs: this.#pokeDeadlineMs,
        successorDeadlineMs: this.#successorDeadlineMs,
        maxSessionAgeMs: this.#maxSessionAgeMs,
        aggregateGraceMs: this.#aggregateGraceMs,
      });
      yield* this.#receipt("observed", {
        paneExists: agent.paneExists,
        sessionExists: agent.sessionExists,
        idle: agent.idle,
        unhandled,
        sessionAgeMs,
        openAggregates,
        degenerated,
        ...(collapse.reason ? { degenerationReason: collapse.reason } : {}),
        ...(collapse.token ? { degenerationToken: collapse.token } : {}),
      });

      if (this.state === "spawning") {
        const reason = this.retireReason;
        if (reason) {
          const note = handoffNote(reason, sessionAgeMs);
          yield* this.#receipt("session.retire.requested", {
            reason,
            sessionAgeMs,
          });
          yield* attempt("writeHandoff", () =>
            this.ports.writeHandoff({ reason, sessionAgeMs, note }),
          );
          yield* attempt("stopSession", this.ports.stopSession);
          this.#sessionStartedAt = undefined;
          yield* this.#receipt("session.retire.stopped", { reason });
        }

        const spawned = yield* Effect.either(attempt("requestSuccessor", this.ports.requestSuccessor));
        if (spawned._tag === "Right") {
          this.#actor.send({ type: "SPAWN_ACCEPTED", requestedAt: this.ports.now() });
          yield* this.#receipt("successor.spawn.requested", reason ? { reason } : undefined);
        } else {
          this.#actor.send({ type: "SPAWN_FAILED", reason: String(spawned.left.cause) });
          yield* this.#receipt("successor.spawn.failed", { error: String(spawned.left.cause) });
        }
      }

      if (this.state === "poking") {
        yield* this.#receipt("poke.started", { unhandled });
        const prompted = yield* Effect.either(
          attempt("promptAgent", () => this.ports.promptAgent(this.#pokeText, this.#pokeDeadlineMs)),
        );
        if (prompted._tag === "Right") {
          const answeredAt = this.ports.now();
          this.#actor.send({ type: "POKE_ANSWERED", answeredAt });
          yield* this.#receipt("poke.answered", { answeredAt });
        } else {
          this.#actor.send({ type: "POKE_FAILED", reason: String(prompted.left.cause) });
          yield* this.#receipt("poke.failed", { error: String(prompted.left.cause) });
        }
      }

      if (this.state === "ready") {
        const value = JSON.stringify({ checkedAt: this.ports.now(), state: this.state });
        yield* attempt("refreshHeartbeat", () =>
          this.ports.refreshHeartbeat(this.#heartbeatKey, this.#heartbeatTtlMs, value),
        );
        yield* this.#receipt("heartbeat.refreshed", {
          key: this.#heartbeatKey,
          ttlMs: this.#heartbeatTtlMs,
        });
      } else {
        yield* this.#receipt("heartbeat.withheld", { reason: this.state });
      }

      return this.state;
    });
  }

  #receipt(
    action: DriverReceipt["action"],
    detail?: Record<string, unknown>,
  ): Effect.Effect<void, DriverPassError> {
    return attempt("recordReceipt", () =>
      this.ports.recordReceipt({
        at: this.ports.now(),
        action,
        state: this.state,
        ...(detail ? { detail } : {}),
      }),
    );
  }
}

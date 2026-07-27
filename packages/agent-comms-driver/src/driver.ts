import { Data, Effect } from "effect";
import { type ActorRefFrom, createActor } from "xstate";

import { detectRepeatedTokenCollapse } from "./degeneration";
import {
  type AgentObservation,
  type DriverState,
  driverMachine,
  type HeartbeatVerdict,
  heartbeatVerdict,
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
/**
 * How long a session may stay mid-turn while the driver still vouches for it.
 * Matches the poke deadline: past it the session has failed to answer anything,
 * and the transport deserves to know.
 */
export const DEFAULT_UNRESPONSIVE_GRACE_MS = DEFAULT_POKE_DEADLINE_MS;
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
  /** How long a mid-turn session keeps the heartbeat. Default = poke deadline. */
  unresponsiveGraceMs?: number;
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
  readonly #unresponsiveGraceMs: number;
  readonly #pokeText: string;
  #started = false;
  /** Wall-clock start of the currently observed live session. */
  #sessionStartedAt?: number;
  /**
   * Last moment the session proved it still answers: observed settled, or a
   * poke came back. Undefined until the first live sighting.
   */
  #lastResponsiveAt?: number;
  /** Latest degeneration read, so the heartbeat pass need not re-scan output. */
  #degenerated = false;
  /** Last verdict reason recorded, so the heartbeat loop logs changes only. */
  #lastHeartbeatReason?: string;

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
    this.#unresponsiveGraceMs = options.unresponsiveGraceMs ?? this.#pokeDeadlineMs;
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
      this.#degenerated = degenerated;
      this.#markResponsiveness(agent, now);
      // Tracks whether the session this pass observed is still the live one.
      let sessionLive = agent.sessionExists;

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
          // The observation at the top of this pass is now stale: that session
          // is gone. Never heartbeat on evidence collected before the kill.
          this.#lastResponsiveAt = undefined;
          sessionLive = false;
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
          // An answered poke is the strongest responsiveness evidence there is.
          this.#lastResponsiveAt = answeredAt;
          this.#actor.send({ type: "POKE_ANSWERED", answeredAt });
          yield* this.#receipt("poke.answered", { answeredAt });
        } else {
          this.#actor.send({ type: "POKE_FAILED", reason: String(prompted.left.cause) });
          yield* this.#receipt("poke.failed", { error: String(prompted.left.cause) });
        }
      }

      yield* this.#applyHeartbeat(
        { paneExists: agent.paneExists, sessionExists: sessionLive },
        this.ports.now(),
        true,
      );

      return this.state;
    });
  }

  /**
   * Heartbeat on its own cadence, independent of the work pass.
   *
   * This exists because `runPass` blocks on `promptAgent` for up to the poke
   * deadline (300s) while the key lives 60s. The pass that owned the key could
   * not refresh it precisely when the session was busiest, so a healthy gateway
   * went dark mid-turn and the transport delivered raw. Measured 2026-07-27:
   * 12.6% of the day blind.
   *
   * It takes a fresh observation rather than reusing the pass's — stale evidence
   * is what the kill drill exists to catch — but never sends machine events, so
   * it cannot race the work pass for the state machine.
   */
  heartbeatPass(): Effect.Effect<HeartbeatVerdict, DriverPassError> {
    return Effect.gen(this, function* () {
      this.start();
      const agent = yield* attempt("inspectAgent", this.ports.inspectAgent);
      const now = this.ports.now();
      this.#markResponsiveness(agent, now);
      return yield* this.#applyHeartbeat(agent, now, false);
    });
  }

  /** Fold one observation into the responsiveness clock. */
  #markResponsiveness(
    agent: { paneExists: boolean; sessionExists: boolean; idle: boolean },
    now: number,
  ): void {
    if (!agent.sessionExists) {
      this.#lastResponsiveAt = undefined;
      return;
    }
    // First sighting of a busy session starts its clock now rather than
    // scoring it unresponsive — otherwise a driver restart mid-turn withholds
    // instantly, which is the raw-delivery window restarts used to guarantee.
    if (agent.idle) this.#lastResponsiveAt = now;
    else this.#lastResponsiveAt ??= now;
  }

  #applyHeartbeat(
    agent: { paneExists: boolean; sessionExists: boolean },
    now: number,
    alwaysRecord: boolean,
  ): Effect.Effect<HeartbeatVerdict, DriverPassError> {
    return Effect.gen(this, function* () {
      const verdict = heartbeatVerdict({
        state: this.state,
        paneExists: agent.paneExists,
        sessionExists: agent.sessionExists,
        degenerated: this.#degenerated,
        unresponsiveForMs: this.#lastResponsiveAt === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(0, now - this.#lastResponsiveAt),
        unresponsiveGraceMs: this.#unresponsiveGraceMs,
      });
      const changed = this.#lastHeartbeatReason !== verdict.reason;
      this.#lastHeartbeatReason = verdict.reason;

      if (verdict.alive) {
        const value = JSON.stringify({ checkedAt: now, state: this.state });
        yield* attempt("refreshHeartbeat", () =>
          this.ports.refreshHeartbeat(this.#heartbeatKey, this.#heartbeatTtlMs, value),
        );
        if (alwaysRecord || changed) {
          yield* this.#receipt("heartbeat.refreshed", {
            key: this.#heartbeatKey,
            ttlMs: this.#heartbeatTtlMs,
          });
        }
      } else if (alwaysRecord || changed) {
        yield* this.#receipt("heartbeat.withheld", {
          reason: verdict.reason,
          state: this.state,
        });
      }
      return verdict;
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

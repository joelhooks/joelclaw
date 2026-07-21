import { Data, Effect } from "effect";
import { type ActorRefFrom, createActor } from "xstate";

import { type AgentObservation, type DriverState, driverMachine } from "./machine";

export const DEFAULT_HEARTBEAT_KEY = "gateway:agent:heartbeat";
export const DEFAULT_HEARTBEAT_REFRESH_MS = 15_000;
export const DEFAULT_HEARTBEAT_TTL_MS = 60_000;
// Measured live 2026-07-21: real gateway turns run 1-3 minutes. A 120s
// deadline scored healthy turns as failures and flapped the heartbeat.
export const DEFAULT_POKE_DEADLINE_MS = 300_000;
export const DEFAULT_SUCCESSOR_DEADLINE_MS = 120_000;
export const DRIVER_POKE_TEXT = "Unhandled gateway stream work exists. Read the authoritative stream and decide it.";

export type AggregateDeadline = {
  aggregateId: string;
  memberEventIds: string[];
  holdUntil: number;
  follows?: string;
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
    | "successor.spawn.requested"
    | "successor.spawn.failed";
  state: DriverState;
  detail?: Record<string, unknown>;
};

export type DriverPorts = {
  inspectAgent: () => Promise<Omit<AgentObservation, "hasUnhandledWork" | "observedAt">>;
  countUnhandled: () => Promise<number>;
  promptAgent: (text: string, timeoutMs: number) => Promise<void>;
  listDueDeadlines: (now: number) => Promise<AggregateDeadline[]>;
  appendDeadline: (deadline: AggregateDeadline) => Promise<void>;
  refreshHeartbeat: (key: string, ttlMs: number, value: string) => Promise<void>;
  requestSuccessor: () => Promise<void>;
  recordReceipt: (receipt: DriverReceipt) => Promise<void>;
  now: () => number;
};

export type DriverOptions = {
  heartbeatKey?: string;
  heartbeatTtlMs?: number;
  pokeDeadlineMs?: number;
  successorDeadlineMs?: number;
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

export class AgentCommsDriver {
  readonly #actor = createActor(driverMachine);
  readonly #heartbeatKey: string;
  readonly #heartbeatTtlMs: number;
  readonly #pokeDeadlineMs: number;
  readonly #successorDeadlineMs: number;
  readonly #pokeText: string;
  #started = false;

  constructor(
    readonly ports: DriverPorts,
    options: DriverOptions = {},
  ) {
    this.#heartbeatKey = options.heartbeatKey ?? DEFAULT_HEARTBEAT_KEY;
    this.#heartbeatTtlMs = options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
    this.#pokeDeadlineMs = options.pokeDeadlineMs ?? DEFAULT_POKE_DEADLINE_MS;
    this.#successorDeadlineMs = options.successorDeadlineMs ?? DEFAULT_SUCCESSOR_DEADLINE_MS;
    this.#pokeText = options.pokeText ?? DRIVER_POKE_TEXT;
  }

  get state(): DriverState {
    return stateOf(this.#actor);
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
      const [agent, unhandled, deadlines] = yield* Effect.all(
        [
          attempt("inspectAgent", this.ports.inspectAgent),
          attempt("countUnhandled", this.ports.countUnhandled),
          attempt("listDueDeadlines", () => this.ports.listDueDeadlines(now)),
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

      this.#actor.send({
        type: "OBSERVED",
        ...agent,
        hasUnhandledWork: unhandled > 0,
        observedAt: now,
        pokeDeadlineMs: this.#pokeDeadlineMs,
        successorDeadlineMs: this.#successorDeadlineMs,
      });
      yield* this.#receipt("observed", {
        paneExists: agent.paneExists,
        sessionExists: agent.sessionExists,
        idle: agent.idle,
        unhandled,
      });

      if (this.state === "spawning") {
        const spawned = yield* Effect.either(attempt("requestSuccessor", this.ports.requestSuccessor));
        if (spawned._tag === "Right") {
          this.#actor.send({ type: "SPAWN_ACCEPTED", requestedAt: this.ports.now() });
          yield* this.#receipt("successor.spawn.requested");
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

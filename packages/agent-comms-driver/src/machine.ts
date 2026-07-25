import { assign, setup } from "xstate";

export type AgentObservation = {
  paneExists: boolean;
  sessionExists: boolean;
  idle: boolean;
  hasUnhandledWork: boolean;
  degenerated: boolean;
  sessionAgeMs: number;
  observedAt: number;
};

export type RetireReason = "age" | "degeneration";

export type DriverContext = {
  pokeStartedAt?: number;
  lastPokeAnsweredAt?: number;
  spawnRequestedAt?: number;
  lastFailure?: string;
  retireReason?: RetireReason;
};

export type DriverEvent =
  | ({ type: "OBSERVED" } & AgentObservation & {
      pokeDeadlineMs: number;
      successorDeadlineMs: number;
      maxSessionAgeMs: number;
    })
  | { type: "POKE_ANSWERED"; answeredAt: number }
  | { type: "POKE_FAILED"; reason: string }
  | { type: "SPAWN_ACCEPTED"; requestedAt: number }
  | { type: "SPAWN_FAILED"; reason: string }
  | { type: "STOP" };

const healthyIdleSession = ({ event }: { event: DriverEvent }): boolean =>
  event.type === "OBSERVED" && event.paneExists && event.sessionExists && event.idle;

const paneOrSessionMissing = ({ event }: { event: DriverEvent }): boolean =>
  event.type === "OBSERVED" && (!event.paneExists || !event.sessionExists);

const sessionNotSettled = ({ event }: { event: DriverEvent }): boolean =>
  event.type === "OBSERVED" && event.paneExists && event.sessionExists && !event.idle;

const shouldPoke = ({ event }: { event: DriverEvent }): boolean =>
  event.type === "OBSERVED"
  && event.paneExists
  && event.sessionExists
  && event.idle
  && event.hasUnhandledWork
  && !event.degenerated;

/** Clean age retire: healthy, idle, no outstanding work, past wall-clock limit. */
const shouldRetire = ({ event }: { event: DriverEvent }): boolean =>
  event.type === "OBSERVED"
  && event.paneExists
  && event.sessionExists
  && event.idle
  && !event.hasUnhandledWork
  && !event.degenerated
  && event.sessionAgeMs >= event.maxSessionAgeMs
  && event.maxSessionAgeMs > 0;

/** Degeneration is poison — force successor even with queue/work outstanding. */
const shouldForceRetire = ({ event }: { event: DriverEvent }): boolean =>
  event.type === "OBSERVED"
  && event.paneExists
  && event.sessionExists
  && event.degenerated;

const pokePastDeadline = ({ context, event }: { context: DriverContext; event: DriverEvent }): boolean =>
  event.type === "OBSERVED"
  && context.pokeStartedAt !== undefined
  && event.observedAt - context.pokeStartedAt >= event.pokeDeadlineMs;

const successorPastDeadline = ({
  context,
  event,
}: {
  context: DriverContext;
  event: DriverEvent;
}): boolean =>
  event.type === "OBSERVED"
  && (!event.paneExists || !event.sessionExists)
  && context.spawnRequestedAt !== undefined
  && event.observedAt - context.spawnRequestedAt >= event.successorDeadlineMs;

export const driverMachine = setup({
  types: {
    context: {} as DriverContext,
    events: {} as DriverEvent,
  },
  guards: {
    healthyIdleSession,
    paneOrSessionMissing,
    sessionNotSettled,
    shouldPoke,
    shouldRetire,
    shouldForceRetire,
    pokePastDeadline,
    successorPastDeadline,
  },
  actions: {
    beginPoke: assign({
      pokeStartedAt: ({ event }) => event.type === "OBSERVED" ? event.observedAt : undefined,
      lastFailure: undefined,
      retireReason: undefined,
    }),
    finishPoke: assign({
      pokeStartedAt: undefined,
      lastPokeAnsweredAt: ({ event }) =>
        event.type === "POKE_ANSWERED" ? event.answeredAt : undefined,
      lastFailure: undefined,
    }),
    recordFailure: assign({
      lastFailure: ({ event }) =>
        event.type === "POKE_FAILED" || event.type === "SPAWN_FAILED"
          ? event.reason
          : "driver unhealthy",
    }),
    clearFailure: assign({
      pokeStartedAt: undefined,
      spawnRequestedAt: undefined,
      lastFailure: undefined,
      retireReason: undefined,
    }),
    recordSpawnRequest: assign({
      spawnRequestedAt: ({ event }) =>
        event.type === "SPAWN_ACCEPTED" ? event.requestedAt : undefined,
      pokeStartedAt: undefined,
    }),
    markAgeRetire: assign({
      retireReason: "age" as const,
      pokeStartedAt: undefined,
      lastFailure: undefined,
    }),
    markDegenerationRetire: assign({
      retireReason: "degeneration" as const,
      pokeStartedAt: undefined,
      lastFailure: "session output degenerated",
    }),
  },
}).createMachine({
  id: "agentCommsDriver",
  initial: "booting",
  context: {},
  on: {
    STOP: ".stopped",
  },
  states: {
    booting: {
      on: {
        OBSERVED: [
          { target: "spawning", guard: "shouldForceRetire", actions: "markDegenerationRetire" },
          { target: "spawning", guard: "paneOrSessionMissing" },
          { target: "poking", guard: "shouldPoke", actions: "beginPoke" },
          { target: "spawning", guard: "shouldRetire", actions: "markAgeRetire" },
          { target: "ready", guard: "healthyIdleSession" },
        ],
      },
    },
    ready: {
      on: {
        OBSERVED: [
          { target: "spawning", guard: "shouldForceRetire", actions: "markDegenerationRetire" },
          { target: "spawning", guard: "paneOrSessionMissing" },
          { target: "poking", guard: "shouldPoke", actions: "beginPoke" },
          { target: "spawning", guard: "shouldRetire", actions: "markAgeRetire" },
          { target: "booting", guard: "sessionNotSettled" },
        ],
      },
    },
    poking: {
      on: {
        POKE_ANSWERED: { target: "ready", actions: "finishPoke" },
        POKE_FAILED: { target: "unhealthy", actions: "recordFailure" },
        OBSERVED: [
          { target: "spawning", guard: "shouldForceRetire", actions: "markDegenerationRetire" },
          { target: "spawning", guard: "paneOrSessionMissing" },
          { target: "unhealthy", guard: "pokePastDeadline", actions: "recordFailure" },
        ],
      },
    },
    unhealthy: {
      on: {
        OBSERVED: [
          { target: "spawning", guard: "shouldForceRetire", actions: "markDegenerationRetire" },
          { target: "spawning", guard: "paneOrSessionMissing" },
          { target: "poking", guard: "shouldPoke", actions: "beginPoke" },
          // A healthy idle session has no poke outstanding — that is recovery
          // evidence. Without this, one failed poke latches unhealthy forever
          // when the queue is empty (absorbing-state bug, caught by the live
          // kill drill 2026-07-21). A truly wedged session fails its next
          // real poke and re-enters unhealthy with fresh evidence.
          // Age retire is also allowed from recovered unhealthy when idle/empty.
          { target: "spawning", guard: "shouldRetire", actions: "markAgeRetire" },
          { target: "ready", guard: "healthyIdleSession" },
        ],
      },
    },
    spawning: {
      on: {
        SPAWN_ACCEPTED: { target: "awaitingSuccessor", actions: "recordSpawnRequest" },
        SPAWN_FAILED: { target: "unhealthy", actions: "recordFailure" },
      },
    },
    awaitingSuccessor: {
      on: {
        OBSERVED: [
          { target: "spawning", guard: "successorPastDeadline" },
          { target: "spawning", guard: "shouldForceRetire", actions: "markDegenerationRetire" },
          { target: "poking", guard: "shouldPoke", actions: "beginPoke" },
          { target: "ready", guard: "healthyIdleSession", actions: "clearFailure" },
        ],
      },
    },
    stopped: { type: "final" },
  },
});

export type DriverState =
  | "booting"
  | "ready"
  | "poking"
  | "unhealthy"
  | "spawning"
  | "awaitingSuccessor"
  | "stopped";

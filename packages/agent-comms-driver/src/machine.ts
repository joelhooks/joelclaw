import { assign, setup } from "xstate";

export type AgentObservation = {
  paneExists: boolean;
  sessionExists: boolean;
  idle: boolean;
  hasUnhandledWork: boolean;
  observedAt: number;
};

export type DriverContext = {
  pokeStartedAt?: number;
  lastPokeAnsweredAt?: number;
  spawnRequestedAt?: number;
  lastFailure?: string;
};

export type DriverEvent =
  | ({ type: "OBSERVED" } & AgentObservation & {
      pokeDeadlineMs: number;
      successorDeadlineMs: number;
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
  && event.hasUnhandledWork;

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
    pokePastDeadline,
    successorPastDeadline,
  },
  actions: {
    beginPoke: assign({
      pokeStartedAt: ({ event }) => event.type === "OBSERVED" ? event.observedAt : undefined,
      lastFailure: undefined,
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
    }),
    recordSpawnRequest: assign({
      spawnRequestedAt: ({ event }) =>
        event.type === "SPAWN_ACCEPTED" ? event.requestedAt : undefined,
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
          { target: "spawning", guard: "paneOrSessionMissing" },
          { target: "poking", guard: "shouldPoke", actions: "beginPoke" },
          { target: "ready", guard: "healthyIdleSession" },
        ],
      },
    },
    ready: {
      on: {
        OBSERVED: [
          { target: "spawning", guard: "paneOrSessionMissing" },
          { target: "poking", guard: "shouldPoke", actions: "beginPoke" },
          { target: "booting", guard: "sessionNotSettled" },
        ],
      },
    },
    poking: {
      on: {
        POKE_ANSWERED: { target: "ready", actions: "finishPoke" },
        POKE_FAILED: { target: "unhealthy", actions: "recordFailure" },
        OBSERVED: [
          { target: "spawning", guard: "paneOrSessionMissing" },
          { target: "unhealthy", guard: "pokePastDeadline", actions: "recordFailure" },
        ],
      },
    },
    unhealthy: {
      on: {
        OBSERVED: [
          { target: "spawning", guard: "paneOrSessionMissing" },
          { target: "poking", guard: "shouldPoke", actions: "beginPoke" },
          // A healthy idle session has no poke outstanding — that is recovery
          // evidence. Without this, one failed poke latches unhealthy forever
          // when the queue is empty (absorbing-state bug, caught by the live
          // kill drill 2026-07-21). A truly wedged session fails its next
          // real poke and re-enters unhealthy with fresh evidence.
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

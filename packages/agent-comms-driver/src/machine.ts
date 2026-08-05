import { assign, setup } from "xstate";

export type AgentObservation = {
  paneExists: boolean;
  sessionExists: boolean;
  idle: boolean;
  hasUnhandledWork: boolean;
  degenerated: boolean;
  sessionAgeMs: number;
  /**
   * Aggregates the agent has opened and not yet closed. An open batch lives in
   * the session's head, so retiring on top of one strands it forever: the
   * successor cannot close-deliver a batch it never opened.
   */
  openAggregates: number;
  observedAt: number;
};

export type RetireReason = "age" | "degeneration" | "stalled";

export type DriverContext = {
  pokeStartedAt?: number;
  lastPokeAnsweredAt?: number;
  spawnRequestedAt?: number;
  lastFailure?: string;
  retireReason?: RetireReason;
  stalledEventId?: string;
};

export type DriverEvent =
  | ({ type: "OBSERVED" } & AgentObservation & {
      pokeDeadlineMs: number;
      successorDeadlineMs: number;
      maxSessionAgeMs: number;
      aggregateGraceMs: number;
    })
  | { type: "POKE_ANSWERED"; answeredAt: number }
  | { type: "POKE_STALLED"; eventId: string }
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

/**
 * Clean age retire: healthy, idle, no outstanding work, past wall-clock limit,
 * and holding no open aggregate.
 *
 * The aggregate condition is not politeness. A fixed 4h retire shipped on
 * 2026-07-25 and aggregation stopped dead at 21:00 that day — 43 hours and 11
 * retires later it had never resumed, because every successor inherited a
 * batch it could not close. Deliveries to Joel went 15/day to 76/day.
 *
 * An open aggregate defers the retire only up to `aggregateGraceMs`; past that
 * a wedged batch would keep a rotting session alive forever, which is worse.
 */
const shouldRetire = ({ event }: { event: DriverEvent }): boolean =>
  event.type === "OBSERVED"
  && event.paneExists
  && event.sessionExists
  && event.idle
  && !event.hasUnhandledWork
  && !event.degenerated
  && event.maxSessionAgeMs > 0
  && event.sessionAgeMs >= event.maxSessionAgeMs
  && (event.openAggregates === 0
    || event.sessionAgeMs >= event.maxSessionAgeMs + event.aggregateGraceMs);

/** Degeneration is poison — force successor even with queue/work outstanding. */
const shouldForceRetire = ({ event }: { event: DriverEvent }): boolean =>
  event.type === "OBSERVED"
  && event.paneExists
  && event.sessionExists
  && event.degenerated;

const shouldRetireStalled = ({ context, event }: { context: DriverContext; event: DriverEvent }): boolean =>
  event.type === "OBSERVED"
  && event.paneExists
  && event.sessionExists
  && context.stalledEventId !== undefined;

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
    shouldRetireStalled,
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
      stalledEventId: undefined,
    }),
    recordStall: assign({
      pokeStartedAt: undefined,
      lastFailure: ({ event }) =>
        event.type === "POKE_STALLED" ? `stream cursor stalled at ${event.eventId}` : "stream cursor stalled",
      stalledEventId: ({ event }) => event.type === "POKE_STALLED" ? event.eventId : undefined,
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
      stalledEventId: undefined,
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
    markStalledRetire: assign({
      retireReason: "stalled" as const,
      pokeStartedAt: undefined,
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
        POKE_STALLED: { target: "unhealthy", actions: "recordStall" },
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
          { target: "spawning", guard: "shouldRetireStalled", actions: "markStalledRetire" },
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

export type HeartbeatDenial =
  | "no-session"
  | "degenerated"
  | "driver-unhealthy"
  | "retiring"
  | "unresponsive";

export type HeartbeatVerdict =
  | { readonly alive: true; readonly reason: "session-live" }
  | { readonly alive: false; readonly reason: HeartbeatDenial };

/**
 * Does the heartbeat key belong up right now?
 *
 * The key answers exactly one question for the transport: will a live agent
 * session pick this message up? It is NOT "is the session idle this instant".
 *
 * Those two were conflated until 2026-07-27: the driver wrote the key only in
 * `ready`, so every ordinary busy turn read as an outage and the transport
 * dumped raw text at Joel. Measured on the live receipt log that morning, 51 of
 * 200 pokes outlived the 60s TTL and the gateway was invisible 12.6% of the day.
 *
 * `unresponsiveForMs` is what keeps this honest. A session that stops answering
 * altogether must still lose the key or the kill drill has nothing to catch, so
 * the driver only vouches for a mid-turn session for a bounded window.
 */
export function heartbeatVerdict(input: {
  readonly state: DriverState;
  readonly paneExists: boolean;
  readonly sessionExists: boolean;
  readonly degenerated: boolean;
  readonly unresponsiveForMs: number;
  readonly unresponsiveGraceMs: number;
}): HeartbeatVerdict {
  if (!(input.paneExists && input.sessionExists)) return { alive: false, reason: "no-session" };
  if (input.degenerated) return { alive: false, reason: "degenerated" };
  // The session is being stopped or replaced — there is a real gap here.
  if (input.state === "spawning" || input.state === "stopped") {
    return { alive: false, reason: "retiring" };
  }
  // A failed or timed-out poke is evidence against the session, not for it.
  if (input.state === "unhealthy") return { alive: false, reason: "driver-unhealthy" };
  if (input.unresponsiveForMs > input.unresponsiveGraceMs) {
    return { alive: false, reason: "unresponsive" };
  }
  return { alive: true, reason: "session-live" };
}

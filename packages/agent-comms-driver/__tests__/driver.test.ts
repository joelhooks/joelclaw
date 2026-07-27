import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createActor } from "xstate";

import {
  AgentCommsDriver,
  type AggregateDeadline,
  type DriverPorts,
  type DriverReceipt,
  driverMachine,
  type SessionHandoffInput,
} from "../src";

type Fake = {
  now: number;
  agent: { paneExists: boolean; sessionExists: boolean; idle: boolean };
  unhandled: number;
  recentOutput: string;
  due: AggregateDeadline[];
  openAggregates: number;
  prompts: string[];
  deadlines: AggregateDeadline[];
  receipts: DriverReceipt[];
  handoffs: SessionHandoffInput[];
  stops: number;
  spawns: number;
  heartbeat?: { key: string; expiresAt: number; value: string };
  promptError?: Error;
};

function harness(): { fake: Fake; ports: DriverPorts } {
  const fake: Fake = {
    now: 1_000,
    agent: { paneExists: true, sessionExists: true, idle: true },
    unhandled: 0,
    recentOutput: "",
    due: [],
    openAggregates: 0,
    prompts: [],
    deadlines: [],
    receipts: [],
    handoffs: [],
    stops: 0,
    spawns: 0,
  };
  return {
    fake,
    ports: {
      now: () => fake.now,
      inspectAgent: async () => fake.agent,
      countUnhandled: async () => fake.unhandled,
      readRecentOutput: async () => fake.recentOutput,
      promptAgent: async (text) => {
        fake.prompts.push(text);
        if (fake.promptError) throw fake.promptError;
      },
      listDueDeadlines: async () => fake.due,
      countOpenAggregates: async () => fake.openAggregates,
      appendDeadline: async (deadline) => {
        fake.deadlines.push(deadline);
        fake.due = [];
      },
      refreshHeartbeat: async (key, ttlMs, value) => {
        fake.heartbeat = { key, value, expiresAt: fake.now + ttlMs };
      },
      writeHandoff: async (input) => {
        fake.handoffs.push(input);
      },
      stopSession: async () => {
        fake.stops += 1;
        fake.agent = { paneExists: true, sessionExists: false, idle: false };
        fake.recentOutput = "";
      },
      requestSuccessor: async () => {
        fake.spawns += 1;
      },
      recordReceipt: async (receipt) => {
        fake.receipts.push(receipt);
      },
    },
  };
}

const run = (driver: AgentCommsDriver) => Effect.runPromise(driver.runPass());
const heartbeatExists = (fake: Fake) =>
  fake.heartbeat !== undefined && fake.heartbeat.expiresAt > fake.now;

const observed = (overrides: Partial<{
  paneExists: boolean;
  sessionExists: boolean;
  idle: boolean;
  hasUnhandledWork: boolean;
  degenerated: boolean;
  sessionAgeMs: number;
  openAggregates: number;
  observedAt: number;
  pokeDeadlineMs: number;
  successorDeadlineMs: number;
  maxSessionAgeMs: number;
  aggregateGraceMs: number;
}> = {}) => ({
  type: "OBSERVED" as const,
  paneExists: true,
  sessionExists: true,
  idle: true,
  hasUnhandledWork: false,
  degenerated: false,
  sessionAgeMs: 0,
  openAggregates: 0,
  observedAt: 1_000,
  pokeDeadlineMs: 5_000,
  successorDeadlineMs: 120_000,
  maxSessionAgeMs: 4 * 60 * 60 * 1000,
  aggregateGraceMs: 60 * 60 * 1000,
  ...overrides,
});

describe("AgentCommsDriver", () => {
  test("pokes once for unhandled work and refreshes the test heartbeat only after the answer", async () => {
    const { fake, ports } = harness();
    fake.unhandled = 1;
    const driver = new AgentCommsDriver(ports, {
      heartbeatKey: "test:gateway:heartbeat",
      heartbeatTtlMs: 60_000,
    });

    expect(await run(driver)).toBe("ready");
    expect(fake.prompts).toHaveLength(1);
    expect(fake.heartbeat?.key).toBe("test:gateway:heartbeat");
    expect(fake.receipts.map((receipt) => receipt.action)).toContain("poke.answered");
    expect(fake.receipts.findIndex((receipt) => receipt.action === "poke.answered")).toBeLessThan(
      fake.receipts.findIndex((receipt) => receipt.action === "heartbeat.refreshed"),
    );
  });

  test("withholds heartbeat after a failed poke and lets its TTL trip fallback", async () => {
    const { fake, ports } = harness();
    const driver = new AgentCommsDriver(ports, {
      heartbeatKey: "test:gateway:heartbeat",
      heartbeatTtlMs: 60_000,
      pokeDeadlineMs: 5_000,
    });

    await run(driver);
    expect(heartbeatExists(fake)).toBe(true);

    fake.now += 15_000;
    fake.unhandled = 1;
    fake.promptError = new Error("scratch session wedged past deadline");
    expect(await run(driver)).toBe("unhealthy");
    expect(fake.receipts.at(-1)).toMatchObject({
      action: "heartbeat.withheld",
      detail: { reason: "driver-unhealthy" },
    });

    fake.now += 15_000;
    fake.agent.idle = false;
    fake.promptError = undefined;
    expect(await run(driver)).toBe("unhealthy");

    fake.now += 45_001;
    expect(heartbeatExists(fake)).toBe(false);
  });

  // A working session is the normal case, not an outage. Withholding here is
  // what made the transport deliver raw text mid-turn (fixed 2026-07-27).
  test("keeps refreshing when a ready session becomes working", async () => {
    const { fake, ports } = harness();
    const driver = new AgentCommsDriver(ports, { heartbeatKey: "test:gateway:heartbeat" });

    expect(await run(driver)).toBe("ready");
    const firstExpiry = fake.heartbeat?.expiresAt;
    fake.now += 15_000;
    fake.agent.idle = false;

    expect(await run(driver)).toBe("booting");
    expect(fake.heartbeat?.expiresAt).toBeGreaterThan(firstExpiry ?? 0);
    expect(heartbeatExists(fake)).toBe(true);
    expect(fake.receipts.at(-1)).toMatchObject({ action: "heartbeat.refreshed" });
  });

  test("vouches for a session already mid-turn at first sighting", async () => {
    const { fake, ports } = harness();
    fake.agent.idle = false;
    const driver = new AgentCommsDriver(ports, { heartbeatKey: "test:gateway:heartbeat" });

    // A driver restart lands here. Scoring it unresponsive on sight is what made
    // every restart guarantee a raw-delivery window.
    expect(await run(driver)).toBe("booting");
    expect(heartbeatExists(fake)).toBe(true);
  });

  test("drops the heartbeat once a session stays mid-turn past the grace", async () => {
    const { fake, ports } = harness();
    const driver = new AgentCommsDriver(ports, {
      heartbeatKey: "test:gateway:heartbeat",
      unresponsiveGraceMs: 300_000,
    });

    expect(await run(driver)).toBe("ready");
    fake.agent.idle = false;

    fake.now += 299_000;
    expect(await run(driver)).toBe("booting");
    expect(heartbeatExists(fake)).toBe(true);

    fake.now += 2_000;
    expect(await run(driver)).toBe("booting");
    expect(fake.receipts.at(-1)).toMatchObject({
      action: "heartbeat.withheld",
      detail: { reason: "unresponsive" },
    });
    fake.now += 60_001;
    expect(heartbeatExists(fake)).toBe(false);
  });

  // The whole point of the separate pass: a poke blocks runPass for up to the
  // poke deadline, which is five times the heartbeat TTL.
  test("heartbeatPass keeps the key alive while a poke blocks the work pass", async () => {
    const { fake, ports } = harness();
    const driver = new AgentCommsDriver(ports, {
      heartbeatKey: "test:gateway:heartbeat",
      heartbeatTtlMs: 60_000,
      pokeDeadlineMs: 300_000,
    });

    expect(await run(driver)).toBe("ready");
    fake.unhandled = 1;

    // Work pass is now notionally blocked inside promptAgent; only the
    // heartbeat fiber runs. Step past the TTL entirely.
    fake.agent.idle = false;
    for (let elapsed = 0; elapsed < 240_000; elapsed += 15_000) {
      fake.now += 15_000;
      const verdict = await Effect.runPromise(driver.heartbeatPass());
      expect(verdict.alive).toBe(true);
      expect(heartbeatExists(fake)).toBe(true);
    }
  });

  test("heartbeatPass withholds the moment the session disappears", async () => {
    const { fake, ports } = harness();
    const driver = new AgentCommsDriver(ports, { heartbeatKey: "test:gateway:heartbeat" });

    expect(await run(driver)).toBe("ready");
    expect(heartbeatExists(fake)).toBe(true);

    // The kill drill: session gone, key must not be renewed on stale evidence.
    fake.agent = { paneExists: true, sessionExists: false, idle: false };
    fake.now += 15_000;
    const verdict = await Effect.runPromise(driver.heartbeatPass());
    expect(verdict).toEqual({ alive: false, reason: "no-session" });

    fake.now += 60_001;
    expect(heartbeatExists(fake)).toBe(false);
  });

  test("fires every due aggregate deadline without deciding its meaning", async () => {
    const { fake, ports } = harness();
    fake.due = [{
      aggregateId: "aggregate-17",
      memberEventIds: ["event-a", "event-b"],
      holdUntil: fake.now,
    }];
    const driver = new AgentCommsDriver(ports, { heartbeatKey: "test:gateway:heartbeat" });

    await run(driver);

    expect(fake.deadlines).toEqual([{
      aggregateId: "aggregate-17",
      memberEventIds: ["event-a", "event-b"],
      holdUntil: 1_000,
    }]);
    expect(fake.receipts).toContainEqual(expect.objectContaining({
      action: "aggregate.deadline.fired",
      detail: { aggregateId: "aggregate-17", holdUntil: 1_000 },
    }));
  });

  test("requests one wake-registry SPAWN when the pane or session disappears", async () => {
    const { fake, ports } = harness();
    fake.agent = { paneExists: false, sessionExists: false, idle: false };
    const driver = new AgentCommsDriver(ports, { heartbeatKey: "test:gateway:heartbeat" });

    expect(await run(driver)).toBe("awaitingSuccessor");
    expect(await run(driver)).toBe("awaitingSuccessor");
    expect(fake.spawns).toBe(1);
    expect(fake.stops).toBe(0);
    expect(fake.handoffs).toHaveLength(0);
    expect(fake.heartbeat).toBeUndefined();

    fake.now += 120_000;
    expect(await run(driver)).toBe("awaitingSuccessor");
    expect(fake.spawns).toBe(2);

    fake.agent = { paneExists: true, sessionExists: true, idle: true };
    expect(await run(driver)).toBe("ready");
    expect(fake.heartbeat?.key).toBe("test:gateway:heartbeat");
  });

  test("retires a healthy idle empty session past the age limit and boots a successor", async () => {
    const { fake, ports } = harness();
    const maxSessionAgeMs = 4 * 60 * 60 * 1000;
    const driver = new AgentCommsDriver(ports, {
      heartbeatKey: "test:gateway:heartbeat",
      maxSessionAgeMs,
    });

    expect(await run(driver)).toBe("ready");
    expect(fake.spawns).toBe(0);

    fake.now += maxSessionAgeMs;
    expect(await run(driver)).toBe("awaitingSuccessor");
    expect(fake.stops).toBe(1);
    expect(fake.spawns).toBe(1);
    expect(fake.handoffs).toEqual([
      expect.objectContaining({
        reason: "age",
        sessionAgeMs: maxSessionAgeMs,
      }),
    ]);
    expect(fake.receipts.map((receipt) => receipt.action)).toEqual(expect.arrayContaining([
      "session.retire.requested",
      "session.retire.stopped",
      "successor.spawn.requested",
    ]));
    expect(fake.receipts.at(-1)).toMatchObject({
      action: "heartbeat.withheld",
      detail: { reason: "no-session" },
    });

    fake.agent = { paneExists: true, sessionExists: true, idle: true };
    fake.now += 1_000;
    expect(await run(driver)).toBe("ready");
    expect(fake.heartbeat?.key).toBe("test:gateway:heartbeat");
  });

  test("does not age-retire while unhandled work remains", async () => {
    const { fake, ports } = harness();
    const maxSessionAgeMs = 60_000;
    const driver = new AgentCommsDriver(ports, {
      heartbeatKey: "test:gateway:heartbeat",
      maxSessionAgeMs,
    });

    expect(await run(driver)).toBe("ready");
    fake.now += maxSessionAgeMs;
    fake.unhandled = 2;
    expect(await run(driver)).toBe("ready");
    expect(fake.prompts).toHaveLength(1);
    expect(fake.stops).toBe(0);
    expect(fake.spawns).toBe(0);
  });

  test("does not age-retire mid-poke", async () => {
    const { fake, ports } = harness();
    const maxSessionAgeMs = 60_000;
    let resolvePrompt: (() => void) | undefined;
    const portsBlocking: DriverPorts = {
      ...ports,
      promptAgent: async (text) => {
        fake.prompts.push(text);
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
      },
    };
    // Age retire is gated on idle empty ready — while poking, only OBSERVED
    // can force-spawn for missing pane or degeneration. Simulate via machine.
    const actor = createActor(driverMachine).start();
    actor.send(observed({
      hasUnhandledWork: true,
      observedAt: 1_000,
      maxSessionAgeMs,
    }));
    expect(actor.getSnapshot().value).toBe("poking");
    actor.send(observed({
      idle: false,
      hasUnhandledWork: true,
      sessionAgeMs: maxSessionAgeMs + 1,
      observedAt: 1_500,
      maxSessionAgeMs,
    }));
    expect(actor.getSnapshot().value).toBe("poking");
    expect(actor.getSnapshot().context.retireReason).toBeUndefined();
    void portsBlocking;
    void resolvePrompt;
  });

  test("force-retires on repeated-token collapse and recovers via successor", async () => {
    const { fake, ports } = harness();
    const driver = new AgentCommsDriver(ports, {
      heartbeatKey: "test:gateway:heartbeat",
      maxSessionAgeMs: 4 * 60 * 60 * 1000,
    });

    expect(await run(driver)).toBe("ready");
    fake.recentOutput = "court court court court court court court";
    fake.unhandled = 3;
    expect(await run(driver)).toBe("awaitingSuccessor");
    expect(fake.stops).toBe(1);
    expect(fake.spawns).toBe(1);
    expect(fake.handoffs[0]?.reason).toBe("degeneration");
    expect(fake.prompts).toHaveLength(0);

    fake.agent = { paneExists: true, sessionExists: true, idle: true };
    fake.recentOutput = "normal gateway prose about aggregates";
    fake.unhandled = 0;
    fake.now += 1_000;
    expect(await run(driver)).toBe("ready");
    expect(fake.heartbeat?.key).toBe("test:gateway:heartbeat");
  });
});

describe("driver lifecycle machine", () => {
  test("an outstanding poke past deadline becomes unhealthy", () => {
    const actor = createActor(driverMachine).start();
    actor.send(observed({
      hasUnhandledWork: true,
      observedAt: 1_000,
      pokeDeadlineMs: 5_000,
    }));
    expect(actor.getSnapshot().value).toBe("poking");

    actor.send(observed({
      idle: false,
      hasUnhandledWork: true,
      observedAt: 6_000,
      pokeDeadlineMs: 5_000,
    }));
    expect(actor.getSnapshot().value).toBe("unhealthy");
  });

  test("age retire requires idle empty session past the limit", () => {
    const maxSessionAgeMs = 60_000;
    const actor = createActor(driverMachine).start();
    actor.send(observed({ sessionAgeMs: 0, observedAt: 1_000, maxSessionAgeMs }));
    expect(actor.getSnapshot().value).toBe("ready");

    actor.send(observed({
      hasUnhandledWork: true,
      sessionAgeMs: maxSessionAgeMs + 1,
      observedAt: 2_000,
      maxSessionAgeMs,
    }));
    expect(actor.getSnapshot().value).toBe("poking");

    actor.send({ type: "POKE_ANSWERED", answeredAt: 2_100 });
    expect(actor.getSnapshot().value).toBe("ready");

    actor.send(observed({
      sessionAgeMs: maxSessionAgeMs + 1,
      observedAt: 3_000,
      maxSessionAgeMs,
    }));
    expect(actor.getSnapshot().value).toBe("spawning");
    expect(actor.getSnapshot().context.retireReason).toBe("age");
  });

  test("an open aggregate defers the age retire", () => {
    // Shipped 2026-07-25: a fixed 4h retire stranded every open batch, and
    // aggregation stopped for 43 hours across 11 retires. Deliveries to Joel
    // went 15/day to 76/day because nothing folded the health-check noise.
    const maxSessionAgeMs = 60_000;
    const actor = createActor(driverMachine).start();

    actor.send(observed({
      sessionAgeMs: maxSessionAgeMs + 1,
      openAggregates: 1,
      observedAt: 2_000,
      maxSessionAgeMs,
    }));
    expect(actor.getSnapshot().value).toBe("ready");

    // Closing the batch releases the retire on the very next pass.
    actor.send(observed({
      sessionAgeMs: maxSessionAgeMs + 2,
      openAggregates: 0,
      observedAt: 3_000,
      maxSessionAgeMs,
    }));
    expect(actor.getSnapshot().value).toBe("spawning");
    expect(actor.getSnapshot().context.retireReason).toBe("age");
  });

  test("a wedged aggregate loses once the grace window closes", () => {
    // Deferring forever would trade one bug for a session that never rotates.
    const maxSessionAgeMs = 60_000;
    const aggregateGraceMs = 30_000;
    const actor = createActor(driverMachine).start();

    actor.send(observed({
      sessionAgeMs: maxSessionAgeMs + aggregateGraceMs - 1,
      openAggregates: 2,
      observedAt: 2_000,
      maxSessionAgeMs,
      aggregateGraceMs,
    }));
    expect(actor.getSnapshot().value).toBe("ready");

    actor.send(observed({
      sessionAgeMs: maxSessionAgeMs + aggregateGraceMs,
      openAggregates: 2,
      observedAt: 3_000,
      maxSessionAgeMs,
      aggregateGraceMs,
    }));
    expect(actor.getSnapshot().value).toBe("spawning");
    expect(actor.getSnapshot().context.retireReason).toBe("age");
  });

  test("degeneration still force-retires on top of an open aggregate", () => {
    const actor = createActor(driverMachine).start();
    actor.send(observed({ degenerated: true, openAggregates: 3, observedAt: 1_000 }));
    expect(actor.getSnapshot().value).toBe("spawning");
    expect(actor.getSnapshot().context.retireReason).toBe("degeneration");
  });

  test("degeneration force-retires even mid-poke", () => {
    const actor = createActor(driverMachine).start();
    actor.send(observed({ hasUnhandledWork: true, observedAt: 1_000 }));
    expect(actor.getSnapshot().value).toBe("poking");

    actor.send(observed({
      idle: false,
      hasUnhandledWork: true,
      degenerated: true,
      observedAt: 1_500,
    }));
    expect(actor.getSnapshot().value).toBe("spawning");
    expect(actor.getSnapshot().context.retireReason).toBe("degeneration");
  });
});

test("real session start beats first sighting so a driver restart cannot reset the clock", async () => {
  // A days-old session must retire on the next pass after a driver restart,
  // not get a fresh 4h lease.
  const startedAt = 1_000_000;
  const now = startedAt + 5 * 60 * 60 * 1000;
  const { fake, ports } = harness();
  fake.now = now;
  fake.unhandled = 0;
  const driver = new AgentCommsDriver(
    {
      ...ports,
      inspectAgent: async () => ({
        paneExists: true,
        sessionExists: true,
        idle: true,
        sessionStartedAt: startedAt,
      }),
    },
    { maxSessionAgeMs: 4 * 60 * 60 * 1000 },
  );

  await Effect.runPromise(driver.runPass());
  const observed = fake.receipts.find((receipt) => receipt.action === "observed");
  expect(observed?.detail?.sessionAgeMs).toBe(5 * 60 * 60 * 1000);
  expect(fake.receipts.some((receipt) => receipt.action === "session.retire.requested")).toBe(true);
});

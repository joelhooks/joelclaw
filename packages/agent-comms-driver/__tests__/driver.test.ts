import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createActor } from "xstate";

import {
  AgentCommsDriver,
  type AggregateDeadline,
  type DriverPorts,
  type DriverReceipt,
  driverMachine,
} from "../src";

type Fake = {
  now: number;
  agent: { paneExists: boolean; sessionExists: boolean; idle: boolean };
  unhandled: number;
  due: AggregateDeadline[];
  prompts: string[];
  deadlines: AggregateDeadline[];
  receipts: DriverReceipt[];
  spawns: number;
  heartbeat?: { key: string; expiresAt: number; value: string };
  promptError?: Error;
};

function harness(): { fake: Fake; ports: DriverPorts } {
  const fake: Fake = {
    now: 1_000,
    agent: { paneExists: true, sessionExists: true, idle: true },
    unhandled: 0,
    due: [],
    prompts: [],
    deadlines: [],
    receipts: [],
    spawns: 0,
  };
  return {
    fake,
    ports: {
      now: () => fake.now,
      inspectAgent: async () => fake.agent,
      countUnhandled: async () => fake.unhandled,
      promptAgent: async (text) => {
        fake.prompts.push(text);
        if (fake.promptError) throw fake.promptError;
      },
      listDueDeadlines: async () => fake.due,
      appendDeadline: async (deadline) => {
        fake.deadlines.push(deadline);
        fake.due = [];
      },
      refreshHeartbeat: async (key, ttlMs, value) => {
        fake.heartbeat = { key, value, expiresAt: fake.now + ttlMs };
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
      detail: { reason: "unhealthy" },
    });

    fake.now += 15_000;
    fake.agent.idle = false;
    fake.promptError = undefined;
    expect(await run(driver)).toBe("unhealthy");

    fake.now += 45_001;
    expect(heartbeatExists(fake)).toBe(false);
  });

  test("stops refreshing when a ready session becomes working", async () => {
    const { fake, ports } = harness();
    const driver = new AgentCommsDriver(ports, { heartbeatKey: "test:gateway:heartbeat" });

    expect(await run(driver)).toBe("ready");
    const firstExpiry = fake.heartbeat?.expiresAt;
    fake.now += 15_000;
    fake.agent.idle = false;

    expect(await run(driver)).toBe("booting");
    expect(fake.heartbeat?.expiresAt).toBe(firstExpiry);
    expect(fake.receipts.at(-1)).toMatchObject({
      action: "heartbeat.withheld",
      detail: { reason: "booting" },
    });
  });

  test("withholds heartbeat while the session is not settled", async () => {
    const { fake, ports } = harness();
    fake.agent.idle = false;
    const driver = new AgentCommsDriver(ports, { heartbeatKey: "test:gateway:heartbeat" });

    expect(await run(driver)).toBe("booting");
    expect(fake.heartbeat).toBeUndefined();
    expect(fake.receipts.at(-1)).toMatchObject({
      action: "heartbeat.withheld",
      detail: { reason: "booting" },
    });
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
    expect(fake.heartbeat).toBeUndefined();

    fake.now += 120_000;
    expect(await run(driver)).toBe("awaitingSuccessor");
    expect(fake.spawns).toBe(2);

    fake.agent = { paneExists: true, sessionExists: true, idle: true };
    expect(await run(driver)).toBe("ready");
    expect(fake.heartbeat?.key).toBe("test:gateway:heartbeat");
  });
});

describe("driver lifecycle machine", () => {
  test("an outstanding poke past deadline becomes unhealthy", () => {
    const actor = createActor(driverMachine).start();
    actor.send({
      type: "OBSERVED",
      paneExists: true,
      sessionExists: true,
      idle: true,
      hasUnhandledWork: true,
      observedAt: 1_000,
      pokeDeadlineMs: 5_000,
      successorDeadlineMs: 120_000,
    });
    expect(actor.getSnapshot().value).toBe("poking");

    actor.send({
      type: "OBSERVED",
      paneExists: true,
      sessionExists: true,
      idle: false,
      hasUnhandledWork: true,
      observedAt: 6_000,
      pokeDeadlineMs: 5_000,
      successorDeadlineMs: 120_000,
    });
    expect(actor.getSnapshot().value).toBe("unhealthy");
  });
});

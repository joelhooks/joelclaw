import { describe, expect, test } from "bun:test";
import { InngestTestEngine } from "@inngest/test";
import type { MessageEventDocument } from "@joelclaw/message-event-log";
import {
  claimDeliveryVolumePage,
  clearDeliveryVolumeLatch,
  countDeliveryVolume,
  createDeliveryVolumeMeterFunction,
  DELIVERY_VOLUME_LATCH_KEY,
  type DeliveryVolumeMeterDependencies,
  type DeliveryVolumeOutcome,
  type DeliveryVolumeRedis,
  PAGE_THRESHOLD,
  TARGET_DELIVERIES_PER_DAY,
} from "./delivery-volume-meter";

const NOW = Date.parse("2026-07-29T16:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function messageEvent(
  sequence: number,
  kind: MessageEventDocument["kind"],
  producer: string,
  occurredAt = NOW - 60_000,
): MessageEventDocument {
  return {
    _id: `event-${sequence}`,
    _creationTime: occurredAt,
    schemaVersion: 1,
    sequence,
    semanticKey: `fixture:${sequence}`,
    kind,
    source: "gateway-transport",
    origin: {
      producer,
      machineId: "test-machine",
    },
    payload: {},
    occurredAt,
    recordedAt: occurredAt,
  };
}

function report(count: number) {
  return {
    windowStartedAt: NOW - DAY_MS,
    windowEndedAt: NOW,
    count,
    topSources: count > 0 ? [{ source: "fixture", count }] : [],
  };
}

function cronEvent() {
  return { name: "cron", data: { cron: "TZ=America/Los_Angeles 0 8 * * *" } } as any;
}

function memoryRedis(): DeliveryVolumeRedis {
  const values = new Map<string, string>();
  return {
    set: async (key, value) => {
      if (values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    del: async (key) => values.delete(key) ? 1 : 0,
  };
}

describe("delivery volume count", () => {
  test("counts both delivery kinds in the last 24 hours and ranks three producers", () => {
    const result = countDeliveryVolume([
      messageEvent(1, "delivery.requested", "worker-d"),
      messageEvent(2, "delivery.requested", "worker-b"),
      messageEvent(3, "fallback.delivered", "worker-b"),
      messageEvent(4, "delivery.requested", "worker-a"),
      messageEvent(5, "fallback.delivered", "worker-a"),
      messageEvent(6, "delivery.requested", "worker-a"),
      messageEvent(7, "delivery.requested", "worker-c"),
      messageEvent(8, "delivery.confirmed", "ignored"),
      messageEvent(9, "delivery.requested", "too-old", NOW - DAY_MS - 1),
      messageEvent(10, "fallback.delivered", "future", NOW + 1),
    ], NOW);

    expect(result).toEqual({
      windowStartedAt: NOW - DAY_MS,
      windowEndedAt: NOW,
      count: 7,
      topSources: [
        { source: "worker-a", count: 3 },
        { source: "worker-b", count: 2 },
        { source: "worker-c", count: 1 },
      ],
    });
  });
});

describe("delivery volume Redis latch", () => {
  test("claims once until a full-day recovery clears the latch", async () => {
    const redis = memoryRedis();
    const breach = report(PAGE_THRESHOLD);

    expect(await claimDeliveryVolumePage(redis, breach)).toBe(true);
    expect(await claimDeliveryVolumePage(redis, breach)).toBe(false);
    expect(await clearDeliveryVolumeLatch(redis)).toBe(true);
    expect(await claimDeliveryVolumePage(redis, breach)).toBe(true);
    expect(DELIVERY_VOLUME_LATCH_KEY).toBe("joelclaw:delivery-volume-meter:paged");
  });
});

describe("delivery volume meter function", () => {
  test("sends exactly one page while the breach remains latched", async () => {
    let latched = false;
    let sendCalls = 0;
    const outcomes: DeliveryVolumeOutcome[] = [];
    const dependencies: DeliveryVolumeMeterDependencies = {
      measure: async () => report(PAGE_THRESHOLD),
      claimPage: async () => {
        if (latched) return false;
        latched = true;
        return true;
      },
      resetLatch: async () => {
        const existed = latched;
        latched = false;
        return existed;
      },
      releaseLatch: async () => {
        latched = false;
      },
      sendPage: async () => {
        sendCalls += 1;
      },
      emitReport: async (_report, outcome) => {
        outcomes.push(outcome);
      },
      emitFailure: async () => undefined,
    };
    const fn = createDeliveryVolumeMeterFunction(dependencies);

    const first = await new InngestTestEngine({
      function: fn as any,
      events: [cronEvent()],
    }).execute();
    const second = await new InngestTestEngine({
      function: fn as any,
      events: [cronEvent()],
    }).execute();

    expect(first.result).toMatchObject({ outcome: "paged", count: PAGE_THRESHOLD });
    expect(second.result).toMatchObject({ outcome: "latched", count: PAGE_THRESHOLD });
    expect(sendCalls).toBe(1);
    expect(outcomes).toEqual(["paged", "latched"]);
  });

  test("stays quiet below the page threshold", async () => {
    let claimCalls = 0;
    let sendCalls = 0;
    const dependencies: DeliveryVolumeMeterDependencies = {
      measure: async () => report(PAGE_THRESHOLD - 1),
      claimPage: async () => {
        claimCalls += 1;
        return true;
      },
      resetLatch: async () => false,
      releaseLatch: async () => undefined,
      sendPage: async () => {
        sendCalls += 1;
      },
      emitReport: async () => undefined,
      emitFailure: async () => undefined,
    };

    const execution = await new InngestTestEngine({
      function: createDeliveryVolumeMeterFunction(dependencies) as any,
      events: [cronEvent()],
    }).execute();

    expect(execution.result).toMatchObject({
      count: PAGE_THRESHOLD - 1,
      target: TARGET_DELIVERIES_PER_DAY,
      pageThreshold: PAGE_THRESHOLD,
      outcome: "quiet",
    });
    expect(claimCalls).toBe(0);
    expect(sendCalls).toBe(0);
  });

  test("clears the latch only after a 24-hour window is back at target", async () => {
    let resetCalls = 0;
    const dependencies: DeliveryVolumeMeterDependencies = {
      measure: async () => report(TARGET_DELIVERIES_PER_DAY),
      claimPage: async () => false,
      resetLatch: async () => {
        resetCalls += 1;
        return true;
      },
      releaseLatch: async () => undefined,
      sendPage: async () => undefined,
      emitReport: async () => undefined,
      emitFailure: async () => undefined,
    };

    const execution = await new InngestTestEngine({
      function: createDeliveryVolumeMeterFunction(dependencies) as any,
      events: [cronEvent()],
    }).execute();

    expect(execution.result).toMatchObject({ outcome: "latch-reset" });
    expect(resetCalls).toBe(1);
  });
});

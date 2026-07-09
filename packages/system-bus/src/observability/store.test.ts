import { describe, expect, test } from "bun:test";
import { createOtelEvent } from "./otel-event";
import { storeOtelEvent } from "./store";

const originalEnabled = process.env.OTEL_EVENTS_ENABLED;
const originalWindow = process.env.OTEL_EVENTS_CONVEX_WINDOW_HOURS;
const originalSentryDsn = process.env.SENTRY_DSN;
const originalStore = process.env.OTEL_STORE;
const originalProjection = process.env.OTEL_TYPESENSE_PROJECTION;

function restoreEnv(): void {
  if (originalEnabled === undefined) delete process.env.OTEL_EVENTS_ENABLED;
  else process.env.OTEL_EVENTS_ENABLED = originalEnabled;

  if (originalWindow === undefined) delete process.env.OTEL_EVENTS_CONVEX_WINDOW_HOURS;
  else process.env.OTEL_EVENTS_CONVEX_WINDOW_HOURS = originalWindow;

  if (originalSentryDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = originalSentryDsn;

  if (originalStore === undefined) delete process.env.OTEL_STORE;
  else process.env.OTEL_STORE = originalStore;

  if (originalProjection === undefined) delete process.env.OTEL_TYPESENSE_PROJECTION;
  else process.env.OTEL_TYPESENSE_PROJECTION = originalProjection;
}

describe("otel store adapter", () => {
  test("respects OTEL_EVENTS_ENABLED=false", async () => {
    process.env.OTEL_EVENTS_ENABLED = "false";

    const result = await storeOtelEvent(
      createOtelEvent({
        level: "info",
        source: "worker",
        component: "serve",
        action: "worker.started",
        success: true,
      }),
      {
        ensureCollection: async () => {},
        upsert: async () => {},
        pushContentResource: async () => {},
        listContentResourcesByType: async () => [],
        removeContentResource: async () => {},
        postSentry: async () => ({ written: false, skipped: true }),
      }
    );

    expect(result.dropped).toBe(true);
    expect(result.dropReason).toBe("otel_events_disabled");
    restoreEnv();
  });

  test("writes to Typesense and mirrors high severity to Convex", async () => {
    process.env.OTEL_EVENTS_ENABLED = "true";
    process.env.OTEL_STORE = "typesense";
    process.env.OTEL_EVENTS_CONVEX_WINDOW_HOURS = "0.5";
    delete process.env.SENTRY_DSN;

    const calls = {
      ensure: 0,
      upsert: 0,
      convexUpsert: 0,
      convexRemove: 0,
    };

    const now = Date.now();
    const result = await storeOtelEvent(
      createOtelEvent({
        level: "error",
        source: "gateway",
        component: "redis-channel",
        action: "events.drain.failed",
        success: false,
        error: "boom",
        metadata: { test: true },
      }),
      {
        ensureCollection: async () => {
          calls.ensure += 1;
        },
        upsert: async () => {
          calls.upsert += 1;
        },
        pushContentResource: async () => {
          calls.convexUpsert += 1;
        },
        listContentResourcesByType: async () => [
          {
            resourceId: "otel:old",
            fields: { timestamp: now - 1000 * 60 * 45 },
          },
          {
            resourceId: "otel:new",
            fields: { timestamp: now - 1000 * 60 },
          },
        ],
        removeContentResource: async () => {
          calls.convexRemove += 1;
        },
        postSentry: async () => ({ written: false, skipped: true }),
      }
    );

    expect(result.stored).toBe(true);
    expect(calls.ensure).toBe(1);
    expect(calls.upsert).toBe(1);
    expect(calls.convexUpsert).toBe(1);
    expect(calls.convexRemove).toBeGreaterThanOrEqual(1);
    restoreEnv();
  });

  test("skips Convex mirror for high-severity events outside convex window", async () => {
    process.env.OTEL_EVENTS_ENABLED = "true";
    process.env.OTEL_STORE = "typesense";
    process.env.OTEL_EVENTS_CONVEX_WINDOW_HOURS = "0.5";
    delete process.env.SENTRY_DSN;

    let convexUpsertCalls = 0;
    const result = await storeOtelEvent(
      createOtelEvent({
        level: "error",
        source: "worker",
        component: "observe",
        action: "observe.store.failed",
        success: false,
        error: "timeout",
        timestamp: Date.now() - 1000 * 60 * 31,
      }),
      {
        ensureCollection: async () => {},
        upsert: async () => {},
        pushContentResource: async () => {
          convexUpsertCalls += 1;
        },
        listContentResourcesByType: async () => [],
        removeContentResource: async () => {},
        postSentry: async () => ({ written: false, skipped: true }),
      }
    );

    expect(result.stored).toBe(true);
    expect(result.convex.written).toBe(false);
    expect(result.convex.skipped).toBe(true);
    expect(convexUpsertCalls).toBe(0);
    restoreEnv();
  });

  test("drops debug floods by backpressure guard", async () => {
    process.env.OTEL_EVENTS_ENABLED = "true";
    process.env.OTEL_STORE = "typesense";
    delete process.env.SENTRY_DSN;

    const suffix = `${Date.now()}`;
    let dropped = 0;
    for (let i = 0; i < 25; i += 1) {
      const result = await storeOtelEvent(
        createOtelEvent({
          level: "debug",
          source: "gateway",
          component: `queue-${suffix}`,
          action: "queue.enqueued",
          success: true,
        }),
        {
          ensureCollection: async () => {},
          upsert: async () => {},
          pushContentResource: async () => {},
          listContentResourcesByType: async () => [],
          removeContentResource: async () => {},
          postSentry: async () => ({ written: false, skipped: true }),
        }
      );
      if (result.dropped) dropped += 1;
    }

    expect(dropped).toBeGreaterThan(0);
    restoreEnv();
  });

  test("queues to durable outbox when ClickHouse primary write fails", async () => {
    process.env.OTEL_EVENTS_ENABLED = "true";
    process.env.OTEL_STORE = "clickhouse";
    delete process.env.SENTRY_DSN;

    let queued = 0;
    const result = await storeOtelEvent(
      createOtelEvent({
        level: "info",
        source: "worker",
        component: "observe",
        action: "observe.store.queued",
        success: true,
      }),
      {
        ensureCollection: async () => {},
        upsert: async () => {
          throw new Error("typesense should be skipped");
        },
        pushContentResource: async () => {},
        listContentResourcesByType: async () => [],
        removeContentResource: async () => {},
        postSentry: async () => ({ written: false, skipped: true }),
        writeClickHouse: async () => ({ written: false, error: "clickhouse_down" }),
        enqueueOutbox: async () => {
          queued += 1;
          return { queued: true, path: "/tmp/otel/event.json" };
        },
      }
    );

    expect(result.stored).toBe(true);
    expect(result.clickhouse.written).toBe(false);
    expect(result.clickhouse.queued).toBe(true);
    expect(result.typesense.skipped).toBe(true);
    expect(queued).toBe(1);
    restoreEnv();
  });

  test("forwards events without touching Typesense or ClickHouse in forward mode", async () => {
    process.env.OTEL_EVENTS_ENABLED = "true";
    process.env.OTEL_STORE = "forward";
    delete process.env.SENTRY_DSN;

    let forwarded = 0;
    const result = await storeOtelEvent(
      createOtelEvent({
        level: "info",
        source: "worker",
        component: "serve",
        action: "worker.started",
        success: true,
      }),
      {
        ensureCollection: async () => {
          throw new Error("typesense should be skipped");
        },
        upsert: async () => {
          throw new Error("typesense should be skipped");
        },
        pushContentResource: async () => {},
        listContentResourcesByType: async () => [],
        removeContentResource: async () => {},
        postSentry: async () => ({ written: false, skipped: true }),
        writeClickHouse: async () => {
          throw new Error("clickhouse should be skipped");
        },
        forwardEvent: async () => {
          forwarded += 1;
          return { attempted: true, accepted: true, endpoint: "http://flagg:3111/observability/emit", status: 200 };
        },
      }
    );

    expect(result.stored).toBe(true);
    expect(result.forward?.accepted).toBe(true);
    expect(result.typesense.skipped).toBe(true);
    expect(result.clickhouse.written).toBe(false);
    expect(forwarded).toBe(1);
    restoreEnv();
  });
});

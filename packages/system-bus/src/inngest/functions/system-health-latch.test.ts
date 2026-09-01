import { describe, expect, test } from "bun:test";
import {
  addHealthObservationToDailyAggregate,
  createEmptyDailyAggregate,
  createEmptyHealthLatchState,
  reconcileSystemHealth,
  toHealthAnomaly,
} from "./system-health-latch";

const BASE = "2026-07-29T16:00:00.000Z";
const LATER = "2026-07-29T16:15:00.000Z";
const NEXT_DAY = "2026-07-30T16:00:00.000Z";
const green = (name: string) => ({ name, ok: true });
const red = (name: string, detail: string) => ({ name, ok: false, detail });

describe("system health anomaly identities", () => {
  test("uses stable IDs for the noisy audit components", () => {
    expect(toHealthAnomaly(red("Front Projection", "age=70m threshold=60m")))
      .toMatchObject({
        anomalyId: "front-projection-stale",
        evidenceShape: "freshness-threshold-exceeded",
      });
    expect(toHealthAnomaly(red("Webhooks", "providers: none")))
      .toMatchObject({
        anomalyId: "webhooks-providers-empty",
        evidenceShape: "providers-empty",
      });
    expect(toHealthAnomaly(red("Docs API", "status=502; payload=not-ok")))
      .toMatchObject({
        componentKey: "docs-api",
        severity: "critical",
      });
  });
});

describe("system health transition table", () => {
  test("green to green stays silent", () => {
    const result = reconcileSystemHealth({
      previous: createEmptyHealthLatchState(BASE),
      services: [green("Worker")],
      observedAt: BASE,
    });
    expect(result.decisions).toEqual([]);
  });

  test("green to red opens and delivers", () => {
    const result = reconcileSystemHealth({
      previous: null,
      services: [red("Worker", "unreachable on all endpoints")],
      observedAt: BASE,
    });
    expect(result.decisions).toEqual([
      expect.objectContaining({
        anomalyId: "worker-unreachable",
        deliver: true,
        transition: "opened",
      }),
    ]);
  });

  test("identical red repeats join the aggregate", () => {
    const opened = reconcileSystemHealth({
      previous: null,
      services: [red("Webhooks", "providers: none")],
      observedAt: BASE,
    });
    const repeated = reconcileSystemHealth({
      previous: opened.nextState,
      services: [red("Webhooks", "0 registered providers")],
      observedAt: LATER,
    });
    expect(repeated.decisions).toEqual([
      expect.objectContaining({
        deliver: false,
        deliveryReason: "aggregate-repeat",
        repeatCount: 1,
        transition: "repeated",
      }),
    ]);
  });

  test("material worsening delivers one changed transition", () => {
    const opened = reconcileSystemHealth({
      previous: null,
      services: [red("Webhooks", "providers: none")],
      observedAt: BASE,
    });
    const changed = reconcileSystemHealth({
      previous: opened.nextState,
      services: [red("Webhooks", "endpoint unreachable after timeout")],
      observedAt: LATER,
    });
    expect(changed.decisions).toEqual([
      expect.objectContaining({
        anomalyId: "webhooks-unreachable",
        deliver: true,
        previousAnomalyId: "webhooks-providers-empty",
        transition: "changed",
      }),
    ]);
  });

  test("red improvement is recorded without an immediate DM", () => {
    const opened = reconcileSystemHealth({
      previous: null,
      services: [red("Webhooks", "endpoint unreachable after timeout")],
      observedAt: BASE,
    });
    const improved = reconcileSystemHealth({
      previous: opened.nextState,
      services: [red("Webhooks", "providers: none")],
      observedAt: LATER,
    });
    expect(improved.decisions).toEqual([
      expect.objectContaining({
        deliver: false,
        deliveryReason: "non-material-improvement",
        transition: "improved",
      }),
    ]);
  });

  test("red to green resolves and delivers once", () => {
    const opened = reconcileSystemHealth({
      previous: null,
      services: [red("Worker", "unreachable")],
      observedAt: BASE,
    });
    const resolved = reconcileSystemHealth({
      previous: opened.nextState,
      services: [green("Worker")],
      observedAt: LATER,
    });
    expect(resolved.decisions).toEqual([
      expect.objectContaining({
        anomalyId: "worker-unreachable",
        deliver: true,
        transition: "resolved",
      }),
    ]);
  });

  test("same-day successor flaps use the existing open slot", () => {
    const opened = reconcileSystemHealth({
      previous: null,
      services: [red("Webhooks", "providers: none")],
      observedAt: BASE,
    });
    const resolved = reconcileSystemHealth({
      previous: opened.nextState,
      services: [green("Webhooks")],
      observedAt: LATER,
    });
    const reopened = reconcileSystemHealth({
      previous: resolved.nextState,
      services: [red("Webhooks", "providers: none")],
      observedAt: "2026-07-29T16:30:00.000Z",
    });
    expect(reopened.decisions).toEqual([
      expect.objectContaining({
        deliver: false,
        deliveryReason: "daily-transition-slot-used",
        transition: "opened",
      }),
    ]);
  });

  test("the next PT day gets a fresh open slot", () => {
    const opened = reconcileSystemHealth({
      previous: null,
      services: [red("Webhooks", "providers: none")],
      observedAt: BASE,
    });
    const resolved = reconcileSystemHealth({
      previous: opened.nextState,
      services: [green("Webhooks")],
      observedAt: LATER,
    });
    const reopened = reconcileSystemHealth({
      previous: resolved.nextState,
      services: [red("Webhooks", "providers: none")],
      observedAt: NEXT_DAY,
    });
    expect(reopened.decisions).toEqual([
      expect.objectContaining({
        deliver: true,
        deliveryReason: "transition",
        transition: "opened",
      }),
    ]);
  });

  test("simultaneous component transitions share one producer slot and one DM", () => {
    const result = reconcileSystemHealth({
      previous: null,
      services: [
        red("Worker", "unreachable"),
        red("Typesense", "health payload not ok"),
      ],
      observedAt: BASE,
    });
    expect(result.decisions.filter((item) => item.deliver)).toHaveLength(2);
  });

  test("later components join the digest after the producer open slot is used", () => {
    const worker = reconcileSystemHealth({
      previous: null,
      services: [red("Worker", "unreachable")],
      observedAt: BASE,
    });
    const typesense = reconcileSystemHealth({
      previous: worker.nextState,
      services: [
        red("Worker", "unreachable"),
        red("Typesense", "health payload not ok"),
      ],
      observedAt: LATER,
    });
    expect(typesense.decisions).toContainEqual(
      expect.objectContaining({
        anomalyId: "typesense-unhealthy",
        deliver: false,
        deliveryReason: "daily-transition-slot-used",
        transition: "opened",
      }),
    );
  });
});

describe("system health daily aggregate", () => {
  test("records silent repeats and counts one combined DM per run", () => {
    const opened = reconcileSystemHealth({
      previous: null,
      services: [
        red("Worker", "unreachable"),
        red("Typesense", "health payload not ok"),
      ],
      observedAt: BASE,
    });
    const first = addHealthObservationToDailyAggregate(
      createEmptyDailyAggregate(opened.ptDate),
      opened,
    );
    const repeated = reconcileSystemHealth({
      previous: opened.nextState,
      services: [
        red("Worker", "unreachable"),
        red("Typesense", "health payload not ok"),
      ],
      observedAt: LATER,
    });
    const second = addHealthObservationToDailyAggregate(first, repeated);

    expect(second).toMatchObject({
      observationCount: 2,
      degradedCount: 2,
      immediateDmCount: 1,
      transitions: {
        opened: 2,
        changed: 0,
        improved: 0,
        repeated: 2,
        resolved: 0,
      },
      repeatsByAnomaly: {
        "typesense-unhealthy": 1,
        "worker-unreachable": 1,
      },
    });
  });
});

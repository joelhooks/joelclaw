import { describe, expect, test } from "bun:test";
import {
  type IncidentLatchStore,
  makeIncidentLatch,
} from "@joelclaw/incident-latch";
import { Effect } from "effect";
import {
  cronCadenceMs,
  cronScheduleCadenceMs,
  type FunctionHealthDependencies,
  type LastSuccessfulRun,
  runFunctionHealthCheck,
} from "./function-health";
import type {
  ExpectedFunctionSpec,
  RegisteredFunctionSpec,
} from "./trigger-audit";

const NOW = Date.parse("2026-07-24T18:20:00.000Z");
const SLUG = "system-bus-host-ai-hero-confirmation-reconciler";

function expectedMap(): Map<string, ExpectedFunctionSpec> {
  return new Map([
    [
      SLUG,
      {
        name: "AI Hero confirmation reconciler",
        triggers: ["CRON:17 * * * *"],
      },
    ],
  ]);
}

function registeredMap(): Map<string, RegisteredFunctionSpec> {
  return new Map([
    [
      SLUG,
      {
        id: "runtime-function-id",
        slug: SLUG,
        name: "AI Hero confirmation reconciler",
        triggers: [{ type: "CRON", value: "17 * * * *" }],
      },
    ],
  ]);
}

function dependencies(
  overrides: Partial<FunctionHealthDependencies> = {},
): FunctionHealthDependencies {
  return {
    expected: async () => expectedMap(),
    registered: async () => registeredMap(),
    register: async () => undefined,
    readLastSuccessfulRun: async () => ({
      id: "healthy-run",
      startedAt: "2026-07-24T17:17:00.000Z",
    }),
    notifyDeadCron: async () => undefined,
    resolveDeadCron: async () => undefined,
    sleep: async () => undefined,
    now: () => NOW,
    monitorStartedAt: NOW - 24 * 60 * 60_000,
    registrationAttemptCap: 3,
    registrationBackoffMs: 1,
    ...overrides,
  };
}

function memoryLatchStore(): IncidentLatchStore {
  const state = new Map<
    string,
    { attempt: number; firstSeenAt: number; finalNoticeSent: boolean }
  >();
  return {
    check: (key, input) => Effect.sync(() => {
      const current = state.get(key);
      if (!current) {
        state.set(key, {
          attempt: 1,
          firstSeenAt: input.now,
          finalNoticeSent: false,
        });
        return { kind: "first" as const, attempt: 1, firstSeenAt: input.now };
      }
      const attempt = Math.min(current.attempt + 1, input.attemptCap);
      const finalNotice = attempt >= input.attemptCap && !current.finalNoticeSent;
      state.set(key, {
        ...current,
        attempt,
        finalNoticeSent: current.finalNoticeSent || finalNotice,
      });
      return {
        kind: finalNotice ? "final-notice" as const : "repeat-silenced" as const,
        attempt,
        firstSeenAt: current.firstSeenAt,
      };
    }),
    resolve: (key) => Effect.sync(() => state.delete(key)),
  };
}

describe("function registration and cron run health", () => {
  test("re-registers a missing function and proves it appeared", async () => {
    let registered = new Map<string, RegisteredFunctionSpec>();
    let registrationPuts = 0;

    const result = await runFunctionHealthCheck(dependencies({
      registered: async () => registered,
      register: async () => {
        registrationPuts += 1;
        registered = registeredMap();
      },
    }));

    expect(registrationPuts).toBe(1);
    expect(result.registration).toMatchObject({
      missingBefore: [SLUG],
      missingAfter: [],
      attempts: 1,
      repaired: true,
    });
  });

  test("retries a failed registration PUT with exponential backoff", async () => {
    let registered = new Map<string, RegisteredFunctionSpec>();
    let registrationPuts = 0;
    const sleeps: number[] = [];

    const result = await runFunctionHealthCheck(dependencies({
      registered: async () => registered,
      register: async () => {
        registrationPuts += 1;
        if (registrationPuts === 1) throw new Error("test endpoint unavailable");
        registered = registeredMap();
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      registrationBackoffMs: 25,
    }));

    expect(registrationPuts).toBe(2);
    expect(sleeps).toEqual([25]);
    expect(result.registration).toMatchObject({
      missingAfter: [],
      attempts: 2,
      repaired: true,
      errors: ["Error: test endpoint unavailable"],
    });
  });

  test("uses the cron offset to derive the real hourly cadence", () => {
    expect(cronCadenceMs("17 * * * *", NOW)).toBe(60 * 60_000);
    expect(cronCadenceMs("TZ=America/Los_Angeles 17 * * * *", NOW)).toBe(
      60 * 60_000,
    );
    expect(cronCadenceMs("0 17,22 * * *", NOW)).toBe(19 * 60 * 60_000);
    expect(
      cronScheduleCadenceMs([
        "0 17 * * 1-5",
        "0 2 * * 2-6",
        "0 22 * * 1-5",
        "30 13 * * 1-5",
      ], NOW),
    ).toBe(59.5 * 60 * 60_000);
  });

  test("a paused cron produces one alert and silences the repeat", async () => {
    const latch = makeIncidentLatch(memoryLatchStore(), { now: () => NOW });
    let notifications = 0;
    const readLastSuccessfulRun = async (): Promise<LastSuccessfulRun | null> => ({
      id: "stale-run",
      startedAt: "2026-07-24T15:17:00.000Z",
    });
    const notifyDeadCron = async () => {
      const decision = await Effect.runPromise(latch.check(SLUG, {
        quietWindowMs: 24 * 60 * 60_000,
        attemptCap: 3,
      }));
      if (decision.speak) notifications += 1;
      return decision.speak;
    };

    const first = await runFunctionHealthCheck(dependencies({
      readLastSuccessfulRun,
      notifyDeadCron,
    }));
    const second = await runFunctionHealthCheck(dependencies({
      readLastSuccessfulRun,
      notifyDeadCron,
    }));

    expect(first.cron.stale).toHaveLength(1);
    expect(first.cron.stale[0]).toMatchObject({
      slug: SLUG,
      cron: "17 * * * *",
      lastSuccessfulRun: { startedAt: "2026-07-24T15:17:00.000Z" },
      stale: true,
    });
    expect(second.cron.stale).toHaveLength(1);
    expect(notifications).toBe(1);
  });

  test("does not alert a never-run cron before two cadences elapse", async () => {
    let notifications = 0;
    const result = await runFunctionHealthCheck(dependencies({
      readLastSuccessfulRun: async () => null,
      monitorStartedAt: NOW - 90 * 60_000,
      notifyDeadCron: async () => {
        notifications += 1;
      },
    }));

    expect(result.cron.stale).toEqual([]);
    expect(notifications).toBe(0);
  });

  test("resolves the incident latch after a successful run", async () => {
    const resolved: string[] = [];
    const result = await runFunctionHealthCheck(dependencies({
      resolveDeadCron: async (slug) => {
        resolved.push(slug);
      },
    }));

    expect(result.cron.stale).toEqual([]);
    expect(resolved).toEqual([SLUG]);
  });
});

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type IncidentLatchStore,
  makeIncidentLatch,
  makeRedisIncidentLatchStore,
} from "../src";

function memoryStore(): IncidentLatchStore {
  const states = new Map<string, { attempt: number; firstSeenAt: number; finalNoticeSent: boolean; expiresAt: number }>();
  return {
    check: (key, input) => Effect.sync(() => {
      const prior = states.get(key);
      if (!prior || prior.expiresAt <= input.now) {
        states.set(key, {
          attempt: 1,
          firstSeenAt: input.now,
          finalNoticeSent: false,
          expiresAt: input.now + input.quietWindowMs,
        });
        return { kind: "first" as const, attempt: 1, firstSeenAt: input.now };
      }
      const attempt = Math.min(prior.attempt + 1, input.attemptCap);
      const finalNotice = attempt >= input.attemptCap && !prior.finalNoticeSent;
      states.set(key, {
        ...prior,
        attempt,
        finalNoticeSent: prior.finalNoticeSent || finalNotice,
        expiresAt: input.now + input.quietWindowMs,
      });
      return {
        kind: finalNotice ? "final-notice" as const : "repeat-silenced" as const,
        attempt,
        firstSeenAt: prior.firstSeenAt,
      };
    }),
    resolve: (key) => Effect.sync(() => states.delete(key)),
  };
}

describe("incident latch", () => {
  test("speaks first, silences repeats, sends one final notice, and caps attempts", async () => {
    let now = 1_000;
    const latch = makeIncidentLatch(memoryStore(), { now: () => now });
    const options = { quietWindowMs: 60_000, attemptCap: 3 };

    expect(await Effect.runPromise(latch.check("search", options))).toMatchObject({
      speak: true,
      kind: "first",
      attempt: 1,
      firstSeenAt: 1_000,
      latchAvailable: true,
    });
    now = 2_000;
    expect(await Effect.runPromise(latch.check("search", options))).toMatchObject({
      speak: false,
      kind: "repeat-silenced",
      attempt: 2,
    });
    now = 3_000;
    expect(await Effect.runPromise(latch.check("search", options))).toMatchObject({
      speak: true,
      kind: "final-notice",
      attempt: 3,
    });
    now = 4_000;
    expect(await Effect.runPromise(latch.check("search", options))).toMatchObject({
      speak: false,
      kind: "repeat-silenced",
      attempt: 3,
    });
  });

  test("quiet-window expiry starts a new incident", async () => {
    let now = 100;
    const latch = makeIncidentLatch(memoryStore(), { now: () => now });
    const options = { quietWindowMs: 1_000, attemptCap: 4 };
    await Effect.runPromise(latch.check("worker", options));
    now = 1_101;
    expect(await Effect.runPromise(latch.check("worker", options))).toMatchObject({
      speak: true,
      kind: "first",
      attempt: 1,
      firstSeenAt: 1_101,
    });
  });

  test("resolve resets state and makes all-clear opt-in", async () => {
    let now = 100;
    const latch = makeIncidentLatch(memoryStore(), { now: () => now });
    const options = { quietWindowMs: 1_000, attemptCap: 4 };
    await Effect.runPromise(latch.check("worker", options));
    now = 200;
    expect(await Effect.runPromise(latch.resolve("worker"))).toMatchObject({
      resolved: true,
      speakAllClear: false,
    });
    expect(await Effect.runPromise(latch.check("worker", options))).toMatchObject({
      speak: true,
      kind: "first",
      attempt: 1,
      firstSeenAt: 200,
    });
    expect(await Effect.runPromise(latch.resolve("worker", { allClear: true }))).toMatchObject({
      resolved: true,
      speakAllClear: true,
    });
  });

  test("fails open when storage is unavailable", async () => {
    const unavailable = makeRedisIncidentLatchStore({
      eval: async () => {
        throw new Error("Redis unavailable");
      },
      del: async () => {
        throw new Error("Redis unavailable");
      },
    });
    const latch = makeIncidentLatch(unavailable, { now: () => 500 });

    expect(await Effect.runPromise(latch.check("critical", {
      quietWindowMs: 1_000,
      attemptCap: 3,
    }))).toMatchObject({
      speak: true,
      kind: "first",
      latchAvailable: false,
      detail: expect.stringContaining("Redis unavailable"),
    });
    expect(await Effect.runPromise(latch.resolve("critical"))).toMatchObject({
      resolved: false,
      latchAvailable: false,
      detail: expect.stringContaining("Redis unavailable"),
    });
  });
});

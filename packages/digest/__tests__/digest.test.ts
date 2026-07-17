import { describe, expect, test } from "bun:test";
import {
  FIXTURE_SOURCE_REFS,
  makeRedisActionRegistry,
  type RedisActionRegistryClient,
} from "@joelclaw/source-actions";
import { Effect, Either } from "effect";
import {
  buildFixtureDigestPrototype,
  createFixtureDigestInput,
  type DigestActionControl,
  type DigestInput,
  type DigestLinkVerifier,
  makeDigestService,
  makeFetchDigestLinkVerifier,
  matchesNaturalLanguageDigestRequest,
} from "../src";

class MockRedis implements RedisActionRegistryClient {
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly strings = new Map<string, { value: string; expiresAt: number }>();
  private nowMs = 0;

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const existed = hash.has(field);
    hash.set(field, value);
    this.hashes.set(key, hash);
    return existed ? 0 : 1;
  }

  private stringValue(key: string): string | null {
    const entry = this.strings.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.nowMs) {
      this.strings.delete(key);
      return null;
    }
    return entry.value;
  }

  async get(key: string): Promise<string | null> {
    return this.stringValue(key);
  }

  async set(
    key: string,
    value: string,
    _expiryMode: "PX",
    leaseMs: number,
    _setMode: "NX",
  ): Promise<"OK" | null> {
    if (this.stringValue(key) !== null) return null;
    this.strings.set(key, { value, expiresAt: this.nowMs + leaseMs });
    return "OK";
  }

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<number> {
    const keys = args.slice(0, numberOfKeys).map(String);
    const values = args.slice(numberOfKeys).map(String);
    const claimKey = keys[0];
    const token = values[0];
    if (!claimKey || !token || (await this.get(claimKey)) !== token) return 0;

    if (script.includes("PEXPIRE")) {
      const leaseMs = Number(values[1]);
      this.strings.set(claimKey, { value: token, expiresAt: this.nowMs + leaseMs });
      return 1;
    }
    if (script.includes("HSET")) {
      const registryKey = keys[1];
      const actionId = values[1];
      const record = values[2];
      if (!registryKey || !actionId || !record) return 0;
      await this.hset(registryKey, actionId, record);
    }
    this.strings.delete(claimKey);
    return 1;
  }
}

const fixedNow = new Date("2026-07-15T15:00:00.000Z");

function fixtureRegistry() {
  return makeRedisActionRegistry(new MockRedis(), { now: () => fixedNow });
}

function memoryInput(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    requestedAt: fixedNow.toISOString(),
    trigger: "on-demand",
    candidates: [
      {
        kind: "memory",
        quality: "high",
        summary: "One useful memory",
        source: "A real source",
        happenedAt: "2026-07-14",
        whyNow: "It matters today",
        connection: "It connects to current work",
      },
    ],
    ...overrides,
  };
}

describe("digest assembly", () => {
  test("returns empty and registers no controls when nothing qualifies", async () => {
    let verifyCalls = 0;
    const service = makeDigestService({
      actionRegistry: fixtureRegistry(),
      adapters: {},
      verifyLink: () => {
        verifyCalls += 1;
        return Effect.succeed(true);
      },
      now: () => fixedNow,
    });

    const result = await Effect.runPromise(
      service.assemble({
        requestedAt: fixedNow.toISOString(),
        trigger: "scheduled",
        candidates: [
          {
            kind: "memory",
            quality: "normal",
            summary: "Filler",
            source: "fixture",
            happenedAt: "yesterday",
            whyNow: "",
            connection: "",
          },
          {
            kind: "action",
            owner: "agent",
            title: "Agent-owned work",
            sourceRef: FIXTURE_SOURCE_REFS.safeDone,
          },
        ],
      }),
    );

    expect(result.kind).toBe("empty");
    expect(verifyCalls).toBe(0);
  });

  test("selects at most one complete high-quality memory", async () => {
    const service = makeDigestService({
      actionRegistry: fixtureRegistry(),
      adapters: {},
      verifyLink: () => Effect.succeed(true),
      now: () => fixedNow,
    });
    const result = await Effect.runPromise(
      service.assemble(
        memoryInput({
          candidates: [
            {
              kind: "memory",
              quality: "high",
              relevance: 1,
              summary: "Lower relevance",
              source: "Source A",
              happenedAt: "2026-07-13",
              whyNow: "Still useful",
              connection: "Current project",
            },
            {
              kind: "memory",
              quality: "high",
              relevance: 9,
              summary: "Highest relevance",
              source: "Source B",
              happenedAt: "2026-07-14",
              whyNow: "Useful now",
              connection: "Current project",
            },
          ],
        }),
      ),
    );

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("expected ready digest");
    expect(result.selectedMemory?.summary).toBe("Highest relevance");
    expect(result.payload.text).toContain("Useful now");
    expect(result.payload.text).not.toContain("Lower relevance");
  });

  test("the fetch verifier accepts only 200 and fails visibly on network errors", async () => {
    let cancelled = 0;
    const verifier = makeFetchDigestLinkVerifier(async () => ({
      status: 200,
      body: { cancel: async () => { cancelled += 1; } },
    }));
    expect(await Effect.runPromise(verifier("https://brain.joelclaw.com/projects/example"))).toBe(
      true,
    );
    expect(cancelled).toBe(1);

    for (const status of [302, 404, 500]) {
      const rejected = makeFetchDigestLinkVerifier(async () => ({ status, body: null }));
      expect(
        await Effect.runPromise(rejected("https://brain.joelclaw.com/projects/example")),
      ).toBe(false);
    }

    const networkFailure = makeFetchDigestLinkVerifier(async () => {
      throw new Error("network down");
    });
    const result = await Effect.runPromise(
      Effect.either(networkFailure("https://brain.joelclaw.com/projects/example")),
    );
    expect(Either.isLeft(result)).toBe(true);
  });

  test("includes Brain links only after an exact 200 verifier receipt", async () => {
    const seen: string[] = [];
    const verifyLink: DigestLinkVerifier = (url) => {
      seen.push(url);
      return Effect.succeed(false);
    };
    const service = makeDigestService({
      actionRegistry: fixtureRegistry(),
      adapters: {},
      verifyLink,
      now: () => fixedNow,
    });
    const input = memoryInput();
    const memory = input.candidates[0];
    if (!memory || memory.kind !== "memory") throw new Error("missing fixture memory");
    const result = await Effect.runPromise(
      service.assemble({
        ...input,
        candidates: [
          {
            ...memory,
            sourceUrl: "https://brain.joelclaw.com/projects/telegram-signal-system",
          },
        ],
      }),
    );

    expect(result.kind).toBe("empty");
    expect(seen).toEqual(["https://brain.joelclaw.com/projects/telegram-signal-system"]);
  });
});

describe("fixture prototype controls", () => {
  test("builds the exact fixture digest with every capability shape", async () => {
    const prototype = await Effect.runPromise(
      buildFixtureDigestPrototype(fixtureRegistry(), { now: () => fixedNow }),
    );
    expect(prototype.result.kind).toBe("ready");
    if (prototype.result.kind !== "ready") throw new Error("expected fixture digest");

    expect(prototype.result.payload.text).toContain("🧠 <b>Memory</b>");
    expect(prototype.result.payload.text).toContain("🟢 <b>Recovery</b>");
    expect(prototype.result.payload.text).toContain("✅ <b>Yours</b>");
    expect(prototype.result.payload.text).toContain("⏰ <b>Reminder</b>");
    expect(prototype.result.payload.policy).toEqual({
      sourceEventType: "signal/digest.assembled",
      priority: "normal",
    });

    const buttons = prototype.result.payload.buttons.flat();
    expect(buttons.map((button) => button.text)).toEqual([
      "Open memory source",
      "✅ Done",
      "Dismiss",
      "Snooze 4h",
    ]);
    for (const button of buttons.filter((button) => button.action)) {
      expect(button.action?.startsWith("act:")).toBe(true);
      expect(Buffer.byteLength(button.action ?? "", "utf8")).toBeLessThanOrEqual(64);
    }
    expect(buttons.find((button) => button.text === "Open memory source")?.url).toBe(
      "https://example.com/source-actions/url-only",
    );
  });

  test("settles controls only after fixture mutation receipts", async () => {
    const prototype = await Effect.runPromise(
      buildFixtureDigestPrototype(fixtureRegistry(), { now: () => fixedNow }),
    );
    if (prototype.result.kind !== "ready") throw new Error("expected fixture digest");
    const actions = prototype.result.controls
      .flat()
      .filter((control): control is DigestActionControl => control.kind === "action");

    const before = await Effect.runPromise(
      prototype.service.refreshControls(prototype.result.controls),
    );
    expect(before.flat().filter((button) => button.action)).toHaveLength(3);

    const outcomes = [];
    for (const action of actions) {
      outcomes.push(
        await Effect.runPromise(
          prototype.service.handleAction({
            actionId: action.actionId,
            telegramMessageId: 4242,
          }),
        ),
      );
    }
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "applied",
      "applied",
      "applied",
    ]);

    const done = actions.find((action) => action.operation === "resolve");
    const dismiss = actions.find((action) => action.operation === "acknowledge");
    const snooze = actions.find((action) => action.operation === "snooze");
    if (!done || !dismiss || !snooze) throw new Error("missing fixture action controls");
    expect(prototype.adapter.mutationCount(FIXTURE_SOURCE_REFS.safeDone.id)).toBe(1);
    expect(prototype.adapter.wasAcknowledged(dismiss.actionId)).toBe(true);
    expect(prototype.adapter.snoozedUntil(snooze.actionId)).toBe(
      "2026-07-15T19:00:00.000Z",
    );

    const after = await Effect.runPromise(
      prototype.service.refreshControls(prototype.result.controls),
    );
    expect(after.flat().filter((button) => button.action)).toHaveLength(0);
    expect(after.flat().filter((button) => button.url)).toHaveLength(1);
  });

  test("keeps expired controls visible because expiry is not a mutation receipt", async () => {
    let currentNow = new Date("2026-07-15T15:00:00.000Z");
    const registry = makeRedisActionRegistry(new MockRedis(), { now: () => currentNow });
    const prototype = await Effect.runPromise(
      buildFixtureDigestPrototype(registry, {
        now: () => currentNow,
        actionTtlMs: 1_000,
      }),
    );
    if (prototype.result.kind !== "ready") throw new Error("expected fixture digest");
    const done = prototype.result.controls
      .flat()
      .find(
        (control): control is DigestActionControl =>
          control.kind === "action" && control.operation === "resolve",
      );
    if (!done) throw new Error("missing Done control");

    currentNow = new Date("2026-07-15T15:00:02.000Z");
    const outcome = await Effect.runPromise(
      prototype.service.handleAction({ actionId: done.actionId, telegramMessageId: 4242 }),
    );
    expect(outcome.status).toBe("expired");
    expect(outcome.record.receipt).toBeUndefined();

    const buttons = await Effect.runPromise(
      prototype.service.refreshControls(prototype.result.controls),
    );
    expect(buttons.flat()).toContainEqual({
      text: "Expired: ✅ Done",
      action: done.actionId,
    });
  });

  test("returns the stored receipt when a terminal action is tapped again", async () => {
    const prototype = await Effect.runPromise(
      buildFixtureDigestPrototype(fixtureRegistry(), { now: () => fixedNow }),
    );
    if (prototype.result.kind !== "ready") throw new Error("expected fixture digest");
    const done = prototype.result.controls
      .flat()
      .find(
        (control): control is DigestActionControl =>
          control.kind === "action" && control.operation === "resolve",
      );
    if (!done) throw new Error("missing Done control");

    const first = await Effect.runPromise(
      prototype.service.handleAction({ actionId: done.actionId, telegramMessageId: 4242 }),
    );
    const second = await Effect.runPromise(
      prototype.service.handleAction({ actionId: done.actionId, telegramMessageId: 4242 }),
    );
    expect(first.status).toBe("applied");
    expect(second.status).toBe("applied");
    expect(second.record.receipt).toEqual(first.record.receipt);
    expect(prototype.adapter.mutationCount(FIXTURE_SOURCE_REFS.safeDone.id)).toBe(1);
  });

  test("the fixture input remains source-backed and deadline-free", () => {
    const input = createFixtureDigestInput();
    const reminder = input.candidates.find((candidate) => candidate.kind === "reminder");
    expect(reminder).toMatchObject({
      sourceEvidence: expect.any(String),
      presentRelevance: expect.any(String),
    });
    expect(reminder && "dueAt" in reminder ? reminder.dueAt : undefined).toBeUndefined();
  });
});

describe("agent intent hint", () => {
  test("recognizes natural language without becoming a channel interceptor", () => {
    expect(matchesNaturalLanguageDigestRequest("give me the digest")).toBe(true);
    expect(matchesNaturalLanguageDigestRequest("what’s up?" )).toBe(true);
    expect(matchesNaturalLanguageDigestRequest("anything I need to handle?" )).toBe(true);
    expect(matchesNaturalLanguageDigestRequest("restart the worker" )).toBe(false);
  });
});

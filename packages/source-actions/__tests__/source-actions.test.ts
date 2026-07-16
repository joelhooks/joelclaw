import { describe, expect, test } from "bun:test";
import type {
  EmailAddress,
  EmailConversation,
  EmailDraft,
  EmailInbox,
  EmailMessage,
  EmailPort,
} from "@joelclaw/email";
import { Effect, Either, Option } from "effect";
import {
  type ActionContext,
  createActionId,
  FIXTURE_SOURCE_REFS,
  makeBrainReminderSourceAdapter,
  makeFixtureSourceAdapter,
  makeFrontSourceAdapter,
  makeRedisActionRegistry,
  type SignalReminderScheduledEvent,
  type SourceAdapter,
  type SourceRef,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  toActionRenderState,
  transitionActionState,
} from "../src";

const context: ActionContext = {
  actionId: "act:00000000-0000-4000-8000-000000000001",
  actor: "joel",
  telegramMessageId: 42,
  requestedAt: "2026-07-15T12:00:00.000Z",
};

type ContractHarness = {
  adapter: SourceAdapter;
  resolvableRef: SourceRef;
  sourceMutationCount: () => number;
};

function sourceAdapterContract(name: string, makeHarness: () => ContractHarness): void {
  describe(`${name} SourceAdapter contract`, () => {
    test("resolve is read-before-write and idempotent", async () => {
      const harness = makeHarness();
      const item = await Effect.runPromise(harness.adapter.inspect(harness.resolvableRef));

      const first = await Effect.runPromise(harness.adapter.resolve(item, context));
      const second = await Effect.runPromise(harness.adapter.resolve(item, context));

      expect(first.outcome).toBe("applied");
      expect(second.outcome).toBe("already-applied");
      expect(harness.sourceMutationCount()).toBe(1);
    });

    test("acknowledge never mutates the source", async () => {
      const harness = makeHarness();
      const item = await Effect.runPromise(harness.adapter.inspect(harness.resolvableRef));
      const before = harness.sourceMutationCount();

      const receipt = await Effect.runPromise(harness.adapter.acknowledge(item, context));

      expect(receipt.outcome).toBe("applied");
      expect(harness.sourceMutationCount()).toBe(before);
    });

    test("capabilities are computed from the inspected item", async () => {
      const harness = makeHarness();
      const item = await Effect.runPromise(harness.adapter.inspect(harness.resolvableRef));
      const capabilities = harness.adapter.capabilities(item);

      expect(capabilities.resolve).toEqual({
        supported: true,
        idempotency: "read-before-write",
        button: "Done",
      });
    });
  });
}

sourceAdapterContract("fixture", () => {
  const adapter = makeFixtureSourceAdapter();
  return {
    adapter,
    resolvableRef: FIXTURE_SOURCE_REFS.safeDone,
    sourceMutationCount: () => adapter.mutationCount(FIXTURE_SOURCE_REFS.safeDone.id),
  };
});

function makeMockFrontHarness(
  archiveBehavior: "success" | "throw" | "no-readback" = "success",
): ContractHarness & {
  email: EmailPort;
  getConversationCount: () => number;
} {
  let archiveCount = 0;
  let getConversationCount = 0;
  let status: EmailConversation["status"] = "open";
  const address: EmailAddress = { email: "joel@example.com", name: "Joel" };
  const conversation = (): EmailConversation => ({
    id: "cnv_front_1",
    subject: "[archive] Resolved customer thread",
    status,
    lastMessageAt: new Date("2026-07-15T10:00:00.000Z"),
    messageCount: 1,
    isUnread: false,
    from: address,
    to: [address],
    tags: [],
  });

  const email: EmailPort = {
    provider: "front",
    listInboxes: async (): Promise<EmailInbox[]> => [],
    listConversations: async (): Promise<EmailConversation[]> => [conversation()],
    getConversation: async (): Promise<{
      conversation: EmailConversation;
      messages: EmailMessage[];
    }> => {
      getConversationCount += 1;
      return { conversation: conversation(), messages: [] };
    },
    archive: async () => {
      archiveCount += 1;
      if (archiveBehavior === "throw") throw new Error("Front archive failed");
      if (archiveBehavior === "success") status = "archived";
    },
    tag: async () => undefined,
    untag: async () => undefined,
    assign: async () => undefined,
    markRead: async () => undefined,
    createDraft: async (): Promise<EmailDraft> => {
      throw new Error("not used");
    },
    listDrafts: async (): Promise<EmailDraft[]> => [],
    deleteDraft: async () => undefined,
  };

  const adapter = makeFrontSourceAdapter(email, {
    isArchiveResolution: (item) => item.subject.startsWith("[archive]"),
    openUrl: (item) => `https://app.frontapp.com/open/${item.id}`,
  });

  return {
    adapter,
    email,
    resolvableRef: { kind: "front", id: "cnv_front_1" },
    sourceMutationCount: () => archiveCount,
    getConversationCount: () => getConversationCount,
  };
}

sourceAdapterContract("Front", makeMockFrontHarness);

describe("fixture capability shapes", () => {
  test("exercises Done, Acknowledge, snooze, and URL-only items", async () => {
    const adapter = makeFixtureSourceAdapter();
    const done = await Effect.runPromise(adapter.inspect(FIXTURE_SOURCE_REFS.safeDone));
    const acknowledge = await Effect.runPromise(adapter.inspect(FIXTURE_SOURCE_REFS.acknowledgeOnly));
    const snoozable = await Effect.runPromise(adapter.inspect(FIXTURE_SOURCE_REFS.snoozable));
    const urlOnly = await Effect.runPromise(adapter.inspect(FIXTURE_SOURCE_REFS.urlOnly));

    expect(adapter.capabilities(done).resolve.button).toBe("Done");
    expect(adapter.capabilities(acknowledge).resolve.supported).toBe(false);
    expect(adapter.capabilities(acknowledge).acknowledge).toBe(true);
    expect(adapter.capabilities(snoozable).snooze).toEqual({
      supported: true,
      mode: "local-reminder",
    });
    expect(adapter.capabilities(urlOnly).acknowledge).toBe(false);
    expect(adapter.capabilities(urlOnly).openUrl).toBe(true);
    expect(
      Option.getOrUndefined(await Effect.runPromise(adapter.openUrl(urlOnly))),
    ).toBe("https://example.com/source-actions/url-only");
  });

  test("snooze and acknowledge are idempotent interaction-only updates", async () => {
    const adapter = makeFixtureSourceAdapter();
    const item = await Effect.runPromise(adapter.inspect(FIXTURE_SOURCE_REFS.snoozable));
    const until = new Date("2026-07-16T12:00:00.000Z");

    const firstSnooze = await Effect.runPromise(adapter.snooze(item, until, context));
    const secondSnooze = await Effect.runPromise(adapter.snooze(item, until, context));
    const firstAcknowledge = await Effect.runPromise(adapter.acknowledge(item, context));
    const secondAcknowledge = await Effect.runPromise(adapter.acknowledge(item, context));

    expect(firstSnooze.outcome).toBe("applied");
    expect(secondSnooze.outcome).toBe("already-applied");
    expect(adapter.snoozedUntil(context.actionId)).toBe(until.toISOString());
    expect(firstAcknowledge.outcome).toBe("applied");
    expect(secondAcknowledge.outcome).toBe("already-applied");
    expect(adapter.wasAcknowledged(context.actionId)).toBe(true);
  });
});

describe("Brain memory reminder adapter", () => {
  test("emits one well-formed reminder for the requested duration", async () => {
    const emitted: SignalReminderScheduledEvent[] = [];
    const adapter = makeBrainReminderSourceAdapter({
      slug: "telegram-signal-system",
      title: "Telegram signal system working brief",
      openUrl: "https://brain.joelclaw.com/joelclaw/projects/telegram-signal-system",
      emitReminder: async (event) => {
        emitted.push(event);
      },
    });
    const item = await Effect.runPromise(adapter.inspect(adapter.sourceRef));
    const requestedAt = new Date(context.requestedAt);
    const until = new Date(requestedAt.getTime() + 4 * 60 * 60 * 1_000);

    expect(adapter.capabilities(item)).toMatchObject({
      resolve: { supported: false, button: "Acknowledge" },
      acknowledge: true,
      snooze: { supported: true, mode: "local-reminder" },
    });

    const first = await Effect.runPromise(adapter.snooze(item, until, context));
    const second = await Effect.runPromise(adapter.snooze(item, until, context));

    expect(first.outcome).toBe("applied");
    expect(second.outcome).toBe("already-applied");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      name: "signal/reminder.scheduled",
      data: {
        actionId: context.actionId,
        remindAt: "2026-07-15T16:00:00.000Z",
        delivery: {
          text: "Yo — Telegram signal system working brief is back on your radar.",
          channel: "telegram",
        },
      },
    });
    expect(Date.parse(emitted[0]?.data.remindAt ?? "") - requestedAt.getTime()).toBe(
      4 * 60 * 60 * 1_000,
    );
    expect(adapter.sourceRef).toEqual({
      kind: "brain",
      id: "telegram-signal-system",
      revision: "https://brain.joelclaw.com/joelclaw/projects/telegram-signal-system",
    });
  });

  test("keeps Done acknowledge-only and never fakes a Brain mutation", async () => {
    const adapter = makeBrainReminderSourceAdapter({
      slug: "telegram-signal-system",
      title: "Telegram signal system working brief",
      openUrl: "https://brain.joelclaw.com/joelclaw/projects/telegram-signal-system",
      emitReminder: async () => undefined,
    });
    const item = await Effect.runPromise(adapter.inspect(adapter.sourceRef));

    const first = await Effect.runPromise(adapter.acknowledge(item, context));
    const second = await Effect.runPromise(adapter.acknowledge(item, context));
    const resolveResult = await Effect.runPromise(
      Effect.either(adapter.resolve(item, context)),
    );

    expect(first).toMatchObject({ outcome: "applied", detail: "Memory interaction acknowledged" });
    expect(second.outcome).toBe("already-applied");
    expect(adapter.wasAcknowledged(context.actionId)).toBe(true);
    expect(Either.isLeft(resolveResult)).toBe(true);
    if (Either.isLeft(resolveResult)) {
      expect(resolveResult.left).toMatchObject({ _tag: "SourceError", operation: "resolve" });
    }
  });

  test("does not return an applied receipt when reminder emission fails", async () => {
    const adapter = makeBrainReminderSourceAdapter({
      slug: "telegram-signal-system",
      title: "Telegram signal system working brief",
      openUrl: "https://brain.joelclaw.com/joelclaw/projects/telegram-signal-system",
      emitReminder: async () => {
        throw new Error("Inngest unavailable");
      },
    });
    const item = await Effect.runPromise(adapter.inspect(adapter.sourceRef));
    const result = await Effect.runPromise(
      Effect.either(adapter.snooze(item, new Date("2026-07-15T16:00:00.000Z"), context)),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "SourceError",
        operation: "snooze",
        message: "Failed to schedule the memory reminder",
      });
    }
    expect(adapter.scheduledReminder(context.actionId)).toBeUndefined();
  });
});

describe("Front semantic capability gate", () => {
  test("returns Acknowledge when Done would not mean archive", async () => {
    const harness = makeMockFrontHarness();
    const adapter = makeFrontSourceAdapter(harness.email, {
      isArchiveResolution: () => false,
    });
    const item = await Effect.runPromise(adapter.inspect(harness.resolvableRef));

    expect(adapter.capabilities(item).resolve).toEqual({
      supported: false,
      idempotency: "none",
      button: "Acknowledge",
    });
    const result = await Effect.runPromise(Effect.either(adapter.resolve(item, context)));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({ _tag: "SourceError", operation: "resolve" });
    }
    expect(harness.sourceMutationCount()).toBe(0);
  });

  test("returns typed failures for archive errors and failed readback", async () => {
    for (const behavior of ["throw", "no-readback"] as const) {
      const harness = makeMockFrontHarness(behavior);
      const item = await Effect.runPromise(harness.adapter.inspect(harness.resolvableRef));
      const result = await Effect.runPromise(
        Effect.either(harness.adapter.resolve(item, context)),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toMatchObject({ _tag: "SourceError", operation: "resolve" });
      }
      expect(harness.sourceMutationCount()).toBe(1);
    }
  });
});

class MockRedis {
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly strings = new Map<string, { value: string; expiresAt: number }>();
  private nowMs = 0;

  advance(ms: number): void {
    this.nowMs += ms;
  }

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

describe("durable action registry", () => {
  test("uses opaque callback IDs within Telegram's 64-byte bound", () => {
    const actionId = createActionId("00000000-0000-4000-8000-000000000001");

    expect(actionId).toBe("act:00000000-0000-4000-8000-000000000001");
    expect(Buffer.byteLength(actionId, "utf8")).toBeLessThanOrEqual(
      TELEGRAM_CALLBACK_DATA_MAX_BYTES,
    );
    expect(() => createActionId("x".repeat(TELEGRAM_CALLBACK_DATA_MAX_BYTES))).toThrow(
      "64-byte limit",
    );
  });

  test("persists pending until a mutation receipt makes it terminal", async () => {
    const registry = makeRedisActionRegistry(new MockRedis(), {
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });
    const registered = await Effect.runPromise(
      registry.register({
        sourceRef: FIXTURE_SOURCE_REFS.safeDone,
        allowedOperations: ["resolve", "open-url"],
      }),
    );

    expect(registered.state).toBe("pending");
    expect(toActionRenderState(registered)).toEqual({
      pending: true,
      terminal: false,
      label: "Pending…",
    });
    const claim = await Effect.runPromise(
      registry.authorize(registered.actionId, "resolve"),
    );
    const applied = await Effect.runPromise(
      registry.applyReceipt(claim, {
        outcome: "applied",
        sourceId: registered.sourceRef.id,
        detail: "readback confirmed",
      }),
    );

    expect(applied.state).toBe("applied");
    expect(toActionRenderState(applied)).toEqual({
      pending: false,
      terminal: true,
      label: "Done",
    });
    expect((await Effect.runPromise(registry.get(registered.actionId))).receipt?.detail).toBe(
      "readback confirmed",
    );
  });

  test("exposes failure, retry, already-applied, and expiry transitions", async () => {
    expect(transitionActionState("pending", { type: "FAIL" })).toBe("failed");
    expect(transitionActionState("failed", { type: "RETRY" })).toBe("pending");
    expect(transitionActionState("pending", { type: "RECEIPT_ALREADY_APPLIED" })).toBe(
      "already-applied",
    );
    expect(transitionActionState("pending", { type: "EXPIRE" })).toBe("expired");

    const registry = makeRedisActionRegistry(new MockRedis(), {
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });
    const registered = await Effect.runPromise(
      registry.register({
        sourceRef: FIXTURE_SOURCE_REFS.acknowledgeOnly,
        allowedOperations: ["acknowledge"],
        expiresAt: "2026-07-15T11:59:59.000Z",
      }),
    );
    const authorization = await Effect.runPromise(
      Effect.either(registry.authorize(registered.actionId, "acknowledge")),
    );
    expect(Either.isLeft(authorization)).toBe(true);
    expect((await Effect.runPromise(registry.get(registered.actionId))).state).toBe("expired");
  });

  test("atomically admits only one callback and preserves terminal receipts past expiry", async () => {
    let currentTime = new Date("2026-07-15T12:00:00.000Z");
    const registry = makeRedisActionRegistry(new MockRedis(), { now: () => currentTime });
    const registered = await Effect.runPromise(
      registry.register({
        sourceRef: FIXTURE_SOURCE_REFS.safeDone,
        allowedOperations: ["resolve"],
        expiresAt: "2026-07-15T12:05:00.000Z",
      }),
    );

    const attempts = await Promise.all([
      Effect.runPromise(Effect.either(registry.authorize(registered.actionId, "resolve"))),
      Effect.runPromise(Effect.either(registry.authorize(registered.actionId, "resolve"))),
    ]);
    const winners = attempts.filter(Either.isRight);
    const rejected = attempts.filter(Either.isLeft);
    expect(winners).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winner = winners[0];
    if (!winner || Either.isLeft(winner)) throw new Error("expected one claim winner");
    await Effect.runPromise(
      registry.applyReceipt(winner.right, {
        outcome: "applied",
        sourceId: registered.sourceRef.id,
        detail: "one callback mutated the source",
      }),
    );

    currentTime = new Date("2026-07-15T12:10:00.000Z");
    const terminal = await Effect.runPromise(registry.get(registered.actionId));
    expect(terminal.state).toBe("applied");
    expect(terminal.receipt?.detail).toBe("one callback mutated the source");
  });

  test("recovers an abandoned lease without letting the stale claimant settle", async () => {
    const redis = new MockRedis();
    const registry = makeRedisActionRegistry(redis, { claimLeaseMs: 1_000 });
    const registered = await Effect.runPromise(
      registry.register({
        sourceRef: FIXTURE_SOURCE_REFS.safeDone,
        allowedOperations: ["resolve"],
      }),
    );
    const abandoned = await Effect.runPromise(
      registry.authorize(registered.actionId, "resolve"),
    );

    redis.advance(1_001);
    const recovered = await Effect.runPromise(
      registry.authorize(registered.actionId, "resolve"),
    );
    const staleSettlement = await Effect.runPromise(
      Effect.either(
        registry.applyReceipt(abandoned, {
          outcome: "applied",
          sourceId: registered.sourceRef.id,
          detail: "stale worker",
        }),
      ),
    );
    expect(Either.isLeft(staleSettlement)).toBe(true);

    const settled = await Effect.runPromise(
      registry.applyReceipt(recovered, {
        outcome: "already-applied",
        sourceId: registered.sourceRef.id,
        detail: "re-inspection found the source resolved",
      }),
    );
    expect(settled.state).toBe("already-applied");
  });

  test("renews a live lease atomically", async () => {
    const redis = new MockRedis();
    const registry = makeRedisActionRegistry(redis, { claimLeaseMs: 1_000 });
    const registered = await Effect.runPromise(
      registry.register({
        sourceRef: FIXTURE_SOURCE_REFS.safeDone,
        allowedOperations: ["resolve"],
      }),
    );
    const claim = await Effect.runPromise(
      registry.authorize(registered.actionId, "resolve"),
    );

    redis.advance(900);
    const renewed = await Effect.runPromise(registry.renewClaim(claim));
    redis.advance(900);
    const duplicate = await Effect.runPromise(
      Effect.either(registry.authorize(registered.actionId, "resolve")),
    );
    expect(Either.isLeft(duplicate)).toBe(true);

    const settled = await Effect.runPromise(
      registry.applyReceipt(renewed, {
        outcome: "applied",
        sourceId: registered.sourceRef.id,
        detail: "renewed worker settled",
      }),
    );
    expect(settled.state).toBe("applied");
  });

  test("rejects operations not registered for the action", async () => {
    const registry = makeRedisActionRegistry(new MockRedis());
    const registered = await Effect.runPromise(
      registry.register({
        sourceRef: FIXTURE_SOURCE_REFS.acknowledgeOnly,
        allowedOperations: ["acknowledge"],
      }),
    );

    const result = await Effect.runPromise(
      Effect.either(registry.authorize(registered.actionId, "resolve")),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({ _tag: "RegistryError", operation: "authorize" });
    }
  });
});

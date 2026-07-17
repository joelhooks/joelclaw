import { describe, expect, test } from "bun:test";
import {
  DigestError,
  type DigestInput,
  type DigestService,
} from "@joelclaw/digest";
import {
  ACTION_REGISTRY_KEY,
  type ActionRecord,
  type MutationReceipt,
  type SignalReminderScheduledEvent,
} from "@joelclaw/source-actions";
import { Effect } from "effect";
import {
  composeFixtureDigestPrototype,
  executeDigestAgentTool,
  type GatewayDigestPrototype,
  handleDigestActionCallback,
  makeGatewayReminderEmitter,
  makeLiveRedisActionRegistryClient,
} from "./digest-gateway";

const sourceRef = { kind: "fixture" as const, id: "safe-done" };
const actionRecord: ActionRecord = {
  actionId: "act:test",
  sourceRef,
  allowedOperations: ["resolve"],
  state: "applied",
  createdAt: "2026-07-15T15:00:00.000Z",
  updatedAt: "2026-07-15T15:00:01.000Z",
};
const receipt: MutationReceipt = {
  outcome: "applied",
  sourceId: sourceRef.id,
  detail: "fixture resolved",
};

function prototypeWithService(service: DigestService): GatewayDigestPrototype {
  return {
    adapter: {} as GatewayDigestPrototype["adapter"],
    reminderAdapter: {
      sourceRef: {
        kind: "brain",
        id: "telegram-signal-system",
        revision: "https://brain.joelclaw.com/joelclaw/projects/telegram-signal-system",
      },
    } as GatewayDigestPrototype["reminderAdapter"],
    controlsByActionId: new Map(),
    service,
    result: {
      kind: "ready",
      payload: {
        text: "Fixture digest",
        format: "html",
        buttons: [[
          { text: "✅ Done", action: "act:test" },
          { text: "Open memory source", url: "https://example.com/source" },
        ]],
        policy: {
          sourceEventType: "signal/digest.assembled",
          priority: "normal",
        },
      },
      controls: [[
        {
          kind: "action",
          text: "✅ Done",
          actionId: "act:test",
          operation: "resolve",
          sourceRef,
        },
        {
          kind: "url",
          text: "Open memory source",
          url: "https://example.com/source",
        },
      ]],
      includedCandidateCount: 1,
      rejected: [],
    },
  };
}

function unusedService(overrides: Partial<DigestService>): DigestService {
  return {
    assemble: () => Effect.die("unused assemble"),
    handleAction: () => Effect.die("unused action"),
    refreshControls: () => Effect.die("unused refresh"),
    ...overrides,
  };
}

describe("digest Redis action registry", () => {
  test("follows the current gateway Redis client after recovery", async () => {
    const first = {
      hget: async () => "first",
      hset: async () => 1,
      get: async () => null,
      set: async () => "OK" as const,
      eval: async () => 1,
    };
    const second = {
      ...first,
      hget: async () => "second",
    };
    let current = first;
    const live = makeLiveRedisActionRegistryClient(() => current);

    expect(await live.hget("registry", "action")).toBe("first");
    current = second;
    expect(await live.hget("registry", "action")).toBe("second");
  });
});

class MockRedis {
  private readonly hashes = new Map<string, Map<string, string>>();

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    hash.set(field, value);
    this.hashes.set(key, hash);
    return 1;
  }

  async get(): Promise<string | null> {
    return null;
  }

  async set(): Promise<"OK"> {
    return "OK";
  }

  async eval(): Promise<number> {
    return 1;
  }
}

describe("digest reminder composition", () => {
  test("posts the exact reminder event through the gateway Inngest endpoint", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const emit = makeGatewayReminderEmitter({
      loadConfig: () => ({
        eventKey: "redacted",
        inngestUrl: "http://inngest.test",
        eventApi: "http://inngest.test/e/redacted",
      }),
      fetchFn: (async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
    });
    const event: SignalReminderScheduledEvent = {
      name: "signal/reminder.scheduled",
      data: {
        actionId: "act:00000000-0000-4000-8000-000000000001",
        remindAt: "2026-07-16T15:00:00.000Z",
        delivery: { text: "Yo — reminder.", channel: "telegram" },
      },
    };

    await emit(event);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://inngest.test/e/redacted");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  });

  test("composes Snooze with a Brain source record and keeps memory open as a URL", async () => {
    const redis = new MockRedis();
    const emitted: SignalReminderScheduledEvent[] = [];
    const now = new Date("2026-07-16T12:00:00.000Z");
    const prototype = await composeFixtureDigestPrototype(redis, {
      now: () => now,
      verifyLink: () => Effect.succeed(true),
      emitReminder: async (event) => {
        emitted.push(event);
      },
    });
    if (prototype.result.kind !== "ready") throw new Error("expected ready digest");

    const item = await Effect.runPromise(
      prototype.reminderAdapter.inspect(prototype.reminderAdapter.sourceRef),
    );
    expect(prototype.reminderAdapter.capabilities(item).snooze).toEqual({
      supported: true,
      mode: "local-reminder",
    });

    const snooze = prototype.result.controls.flat().find(
      (control) => control.kind === "action" && control.operation === "snooze",
    );
    if (!snooze || snooze.kind !== "action") throw new Error("missing Snooze control");
    expect(snooze.sourceRef).toEqual({
      kind: "brain",
      id: "telegram-signal-system",
      revision: "https://brain.joelclaw.com/joelclaw/projects/telegram-signal-system",
    });
    const record = JSON.parse(
      (await redis.hget(ACTION_REGISTRY_KEY, snooze.actionId)) ?? "null",
    ) as ActionRecord;
    expect(record.sourceRef).toEqual(snooze.sourceRef);

    const openMemory = prototype.result.payload.buttons.flat().find(
      (button) => button.text === "Open memory source",
    );
    expect(openMemory).toEqual({
      text: "Open memory source",
      url: "https://brain.joelclaw.com/joelclaw/projects/telegram-signal-system",
    });
    expect(openMemory?.action).toBeUndefined();
    expect(emitted).toHaveLength(0);

    const callback = await handleDigestActionCallback(
      prototype,
      { actionId: snooze.actionId, telegramMessageId: 42 },
      {
        answerWorking: async () => undefined,
        editKeyboard: async () => undefined,
        reportFailure: async (message) => {
          throw new Error(message);
        },
      },
    );
    expect(callback.status).toBe("applied");
    expect(emitted).toEqual([{
      name: "signal/reminder.scheduled",
      data: {
        actionId: snooze.actionId,
        remindAt: "2026-07-16T16:00:00.000Z",
        delivery: {
          text: "Yo — Telegram Signal System is back on your radar.",
          channel: "telegram",
        },
      },
    }]);

    const sent = await executeDigestAgentTool(prototype, { trigger: "scheduled" });
    if (sent.kind !== "ready") throw new Error("expected sent digest");
    const sentSnooze = sent.controls.flat().find(
      (control) => control.kind === "action" && control.operation === "snooze",
    );
    if (!sentSnooze || sentSnooze.kind !== "action") {
      throw new Error("missing sent Snooze control");
    }
    expect(sentSnooze.actionId).not.toBe(snooze.actionId);
    expect(prototype.controlsByActionId.get(sentSnooze.actionId)).toBe(sent.controls);

    const edited: unknown[] = [];
    await handleDigestActionCallback(
      prototype,
      { actionId: sentSnooze.actionId, telegramMessageId: 43 },
      {
        answerWorking: async () => undefined,
        editKeyboard: async (buttons) => {
          edited.push(buttons);
        },
        reportFailure: async (message) => {
          throw new Error(message);
        },
      },
    );
    const editedActions = (edited[0] as Array<Array<{ action?: string }>>)
      .flat()
      .flatMap((button) => button.action ? [button.action] : []);
    expect(editedActions).toContain(sentSnooze.actionId);
    expect(editedActions).not.toContain(snooze.actionId);
  });
});

describe("digest agent tool", () => {
  test("loads fixture candidates and calls the service without sending", async () => {
    let assembled: DigestInput | undefined;
    const prototype = prototypeWithService(unusedService({
      assemble: (input) => {
        assembled = input;
        return Effect.succeed({
          kind: "empty",
          reason: "no-qualified-content",
          rejected: [],
        });
      },
    }));

    const result = await executeDigestAgentTool(prototype, { trigger: "scheduled" });

    expect(result.kind).toBe("empty");
    expect(assembled?.trigger).toBe("scheduled");
    expect(assembled?.candidates.length).toBeGreaterThan(0);
    expect(
      assembled?.candidates.find((candidate) => candidate.kind === "reminder")?.sourceRef,
    ).toEqual(prototype.reminderAdapter.sourceRef);
    expect(
      assembled?.candidates.find((candidate) => candidate.kind === "memory"),
    ).toMatchObject({
      sourceRef: prototype.reminderAdapter.sourceRef,
      sourceUrl: "https://brain.joelclaw.com/joelclaw/projects/telegram-signal-system",
    });
  });
});

describe("digest action callbacks", () => {
  test("removes controls only after a mutation receipt", async () => {
    const edits: unknown[] = [];
    const prototype = prototypeWithService(unusedService({
      handleAction: () => Effect.succeed({
        status: "applied",
        record: { ...actionRecord, receipt },
        receipt,
      }),
      refreshControls: () => Effect.succeed([
        [{ text: "Open memory source", url: "https://example.com/source" }],
      ]),
    }));

    const result = await handleDigestActionCallback(
      prototype,
      { actionId: "act:test", telegramMessageId: 42 },
      {
        answerWorking: async () => {},
        editKeyboard: async (buttons) => {
          edits.push(buttons);
        },
        reportFailure: async () => {
          throw new Error("unexpected failure report");
        },
      },
    );

    expect(result).toEqual({ status: "applied", keyboardEdited: true });
    expect(edits).toEqual([
      [[{ text: "Open memory source", url: "https://example.com/source" }]],
    ]);
  });

  test("refreshes failed actions into retry controls", async () => {
    const edits: unknown[] = [];
    const failedRecord: ActionRecord = {
      ...actionRecord,
      state: "failed",
      receipt: undefined,
      failure: "fixture failure",
    };
    const prototype = prototypeWithService(unusedService({
      handleAction: () => Effect.succeed({
        status: "failed",
        record: failedRecord,
        failure: "fixture failure",
      }),
      refreshControls: () => Effect.succeed([
        [{ text: "↻ Retry ✅ Done", action: "act:test" }],
      ]),
    }));

    const result = await handleDigestActionCallback(
      prototype,
      { actionId: "act:test", telegramMessageId: 42 },
      {
        answerWorking: async () => {},
        editKeyboard: async (buttons) => {
          edits.push(buttons);
        },
        reportFailure: async () => {
          throw new Error("unexpected failure report");
        },
      },
    );

    expect(result).toEqual({ status: "failed", keyboardEdited: true });
    expect(edits).toEqual([[[{ text: "↻ Retry ✅ Done", action: "act:test" }]]]);
  });

  test("preserves the keyboard when registry or claim handling fails", async () => {
    let editCount = 0;
    const failures: string[] = [];
    const prototype = prototypeWithService(unusedService({
      handleAction: () => Effect.fail(new DigestError({
        operation: "handle-action",
        message: "Action could not be claimed",
        actionId: "act:test",
      })),
    }));

    const result = await handleDigestActionCallback(
      prototype,
      { actionId: "act:test", telegramMessageId: 42 },
      {
        answerWorking: async () => {},
        editKeyboard: async () => {
          editCount += 1;
        },
        reportFailure: async (message) => {
          failures.push(message);
        },
      },
    );

    expect(result).toMatchObject({
      status: "failed-to-handle",
      keyboardEdited: false,
      error: "Action could not be claimed",
    });
    expect(editCount).toBe(0);
    expect(failures).toEqual(["Action could not be claimed"]);
  });
});

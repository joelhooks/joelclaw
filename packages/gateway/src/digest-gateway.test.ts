import { describe, expect, test } from "bun:test";
import {
  DigestError,
  type DigestInput,
  type DigestService,
  type FixtureDigestPrototype,
} from "@joelclaw/digest";
import type {
  ActionRecord,
  MutationReceipt,
} from "@joelclaw/source-actions";
import { Effect } from "effect";
import {
  executeDigestAgentTool,
  handleDigestActionCallback,
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

function prototypeWithService(service: DigestService): FixtureDigestPrototype {
  return {
    adapter: {} as FixtureDigestPrototype["adapter"],
    service,
    result: {
      kind: "ready",
      payload: {
        text: "Fixture digest",
        format: "plain",
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

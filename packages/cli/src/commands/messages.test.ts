import { describe, expect, test } from "bun:test";
import { createJournalEvent } from "@joelclaw/message-journal";
import { Effect } from "effect";
import {
  executeMessagesAudit,
  executeMessagesTrace,
  formatJournalEvent,
  formatMessageEvent,
  messagesCmd,
  normalizeMessagesLimit,
  parseMessagesSince,
} from "./messages";

function fixtureEvent() {
  return createJournalEvent(
    {
      messageKey: "telegram:42:99",
      flowId: "flow-private-123",
      direction: "interaction",
      eventType: "interaction.completed",
      contentKind: "text",
      producer: "telegram-adapter",
      originSystemId: "gateway",
      sourceEventId: "event-123",
      sourceRef: "telegram:update:456",
      route: "gateway/telegram",
      classification: "action",
      reason: "Joel asked for it",
      investigationState: "completed",
      investigationResult: "source confirmed",
      telegramChatId: 42,
      telegramMessageId: 99,
      telegramUpdateId: 456,
      callbackQueryId: "callback-1",
      interactionAction: "dismiss",
      interactionPayload: "dismiss:signal-1",
      interactionOutcome: "dismissed",
      text: "private exact text",
      transportText: "<b>private exact text</b>",
      deliveryState: "confirmed",
      metadata: { importance: "high", safe: true },
    },
    () => new Date("2026-07-15T12:00:00.000Z"),
  );
}

const unusedTrace = () =>
  Effect.succeed({ kind: "not_found" as const, lookup: "unused" });

function subcommandNames() {
  if (messagesCmd.descriptor._tag !== "Subcommands") return [];
  return messagesCmd.descriptor.children.map((child) => {
    const command = child.command as {
      command?: { name?: string };
      name?: string;
      parent?: { command?: { name?: string } };
    };
    return command.command?.name ?? command.name ?? command.parent?.command?.name;
  });
}

describe("messages CLI", () => {
  test("registers audit and trace subcommands", () => {
    expect(subcommandNames()).toEqual(["audit", "trace"]);
  });

  test("parses supported durations and rejects malformed lookbacks before querying", async () => {
    expect(parseMessagesSince("24h")).toBe(86_400_000);
    expect(parseMessagesSince("7d")).toBe(604_800_000);
    expect(() => parseMessagesSince("24 hours")).toThrow();

    let queried = false;
    const envelope = await Effect.runPromise(
      executeMessagesAudit(
        { since: "24 hours" },
        {
          auditMessages: () => {
            queried = true;
            return Effect.succeed([]);
          },
          traceMessage: unusedTrace,
        },
      ),
    );

    expect(queried).toBe(false);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("INVALID_DURATION");
  });

  test("executes invalid duration handling through the real CLI parser", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "packages/cli/src/cli.ts",
        "messages",
        "audit",
        "--since",
        "24 hours",
      ],
      cwd: process.cwd(),
      env: process.env,
    });
    const envelope = JSON.parse(result.stdout.toString());

    expect(result.exitCode).toBe(0);
    expect(envelope).toMatchObject({
      ok: false,
      command: "joelclaw messages audit",
      error: { code: "INVALID_DURATION" },
    });
  });

  test("normalizes the limit before querying and reporting it", async () => {
    expect(normalizeMessagesLimit(-5)).toBe(1);
    expect(normalizeMessagesLimit(5_000)).toBe(1_000);

    let receivedLimit: number | undefined;
    const envelope = await Effect.runPromise(
      executeMessagesAudit(
        { since: "24h", limit: 5_000 },
        {
          auditMessages: (input) => {
            receivedLimit = input.limit;
            return Effect.succeed([]);
          },
          traceMessage: unusedTrace,
        },
      ),
    );

    expect(receivedLimit).toBe(1_000);
    expect(envelope.result).toMatchObject({ filters: { limit: 1_000 } });
  });

  test("renders the complete private audit explanation, including exact bodies", async () => {
    const row = fixtureEvent();
    const envelope = await Effect.runPromise(
      executeMessagesAudit(
        { since: "24h", channel: "telegram", category: "action", direction: "interaction" },
        {
          auditMessages: () => Effect.succeed([row]),
          traceMessage: unusedTrace,
        },
      ),
    );

    expect(envelope.ok).toBe(true);
    expect(envelope.result).toEqual({
      filters: {
        since: "24h",
        channel: "telegram",
        category: "action",
        direction: "interaction",
        limit: 100,
      },
      count: 1,
      events: [formatJournalEvent(row)],
    });

    const output = JSON.stringify(envelope.result);
    expect(output).toContain("private exact text");
    expect(output).toContain("telegram-adapter");
    expect(output).toContain('"category":"action"');
    expect(output).toContain('"importance":"high"');
    expect(output).toContain("Joel asked for it");
    expect(output).toContain("source confirmed");
    expect(output).toContain('"state":"confirmed"');
    expect(output).toContain('"outcome":"dismissed"');
  });

  test("renders the Convex flow view as the default trace shape", async () => {
    const event = {
      _id: "message-event-1",
      _creationTime: 1,
      schemaVersion: 1,
      sequence: 1,
      semanticKey: "proof:event-1",
      kind: "message.requested" as const,
      source: "proof",
      payload: { text: "canonical body" },
      occurredAt: 1,
      recordedAt: 2,
      flowId: "flow-proof-1",
    };
    const envelope = await Effect.runPromise(
      executeMessagesTrace("flow-proof-1", {
        auditMessages: () => Effect.succeed([]),
        traceMessage: () =>
          Effect.succeed({
            kind: "trace" as const,
            source: "convex" as const,
            flowId: "flow-proof-1",
            projection: {
              flowId: "flow-proof-1",
              eventCount: 1,
              firstOccurredAt: 1,
              lastOccurredAt: 1,
              latestEventId: "message-event-1",
              latestKind: "message.requested" as const,
              updatedAt: 2,
            },
            events: [event],
            consumerReceipts: [],
            truncated: false,
          }),
      }),
    );

    expect(envelope.ok).toBe(true);
    expect(envelope.result).toMatchObject({
      kind: "trace",
      source: "convex",
      flowId: "flow-proof-1",
      eventCount: 1,
      events: [formatMessageEvent(event)],
    });
  });

  test("returns candidates and ID-only follow-ups for ambiguous Telegram message IDs", async () => {
    const candidateWithBody = {
      flowId: "flow-a",
      telegramChatId: 42,
      telegramMessageId: 99,
      occurredAt: "2026-07-15 12:00:00.000",
      text: "private exact text",
    };
    const envelope = await Effect.runPromise(
      executeMessagesTrace("99", {
        auditMessages: () => Effect.succeed([]),
        traceMessage: () =>
          Effect.succeed({
            kind: "ambiguous" as const,
            lookup: "99",
            candidates: [
              candidateWithBody,
              {
                flowId: "flow-b",
                telegramChatId: 43,
                telegramMessageId: 99,
                occurredAt: "2026-07-15 11:00:00.000",
              },
            ],
          }),
      }),
    );

    expect(envelope.ok).toBe(true);
    expect(envelope.result).toMatchObject({ kind: "ambiguous", lookup: "99" });
    expect(envelope.next_actions.map((action) => action.params?.["flow-id"]?.value)).toEqual([
      "flow-a",
      "flow-b",
    ]);
    expect(JSON.stringify(envelope)).not.toContain("private exact text");
  });

  test("never leaks message bodies from query failures", async () => {
    const envelope = await Effect.runPromise(
      executeMessagesAudit(
        { since: "24h" },
        {
          auditMessages: () =>
            Effect.fail({
              _tag: "MessageJournalQueryError",
              operation: "audit",
              code: "CLICKHOUSE_QUERY_FAILED",
              cause: new Error("private exact text"),
            }),
          traceMessage: unusedTrace,
        },
      ),
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("CLICKHOUSE_QUERY_FAILED");
    expect(JSON.stringify(envelope)).not.toContain("private exact text");

    const traceEnvelope = await Effect.runPromise(
      executeMessagesTrace("flow-private-123", {
        auditMessages: () => Effect.succeed([]),
        traceMessage: () =>
          Effect.fail({
            _tag: "MessageJournalQueryError",
            operation: "trace",
            code: "CLICKHOUSE_QUERY_FAILED",
            cause: new Error("private exact text"),
          }),
      }),
    );

    expect(traceEnvelope.ok).toBe(false);
    expect(traceEnvelope.error?.code).toBe("CLICKHOUSE_QUERY_FAILED");
    expect(JSON.stringify(traceEnvelope)).not.toContain("private exact text");
  });
});

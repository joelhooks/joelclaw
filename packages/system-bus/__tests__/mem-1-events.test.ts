import { describe, expect, test } from "bun:test";
import type { Events } from "../src/inngest/client.ts";

type EventData<TName extends keyof Events> = Events[TName] extends { data: infer TData }
  ? TData
  : never;

function expectLiteralOne(value: 1): 1 {
  return value;
}

describe("MEM-1: Add memory event types to client.ts", () => {
  test("AC-1: Events includes memory/session.compaction.pending with specified data fields", () => {
    const data: EventData<"memory/session.compaction.pending"> = {
      sessionId: "session-123",
      dedupeKey: "dedupe-123",
      trigger: "compaction",
      messages: "user: hi\nassistant: hello",
      messageCount: 2,
      tokensBefore: 1280,
      filesRead: ["src/a.ts", "src/b.ts"],
      filesModified: ["src/c.ts"],
      capturedAt: "2026-02-15T00:00:00.000Z",
      schemaVersion: 1,
    };

    expect(data.trigger).toBe("compaction");
    expect(data.messageCount).toBe(2);
    expect(expectLiteralOne(data.schemaVersion)).toBe(1);
  });

  test("AC-2: Events includes memory/session.ended with specified data fields and optional sessionName", () => {
    const withoutSessionName: EventData<"memory/session.ended"> = {
      sessionId: "session-456",
      dedupeKey: "dedupe-456",
      trigger: "shutdown",
      messages: "user: bye\nassistant: bye",
      messageCount: 2,
      userMessageCount: 1,
      duration: 95,
      filesRead: ["src/a.ts"],
      filesModified: ["src/a.ts"],
      capturedAt: "2026-02-15T00:00:00.000Z",
      schemaVersion: 1,
    };

    const withSessionName: EventData<"memory/session.ended"> = {
      ...withoutSessionName,
      sessionName: "Debug session",
    };

    expect(withoutSessionName.trigger).toBe("shutdown");
    expect(withSessionName.sessionName).toBe("Debug session");
    expect(expectLiteralOne(withoutSessionName.schemaVersion)).toBe(1);
    expect(expectLiteralOne(withSessionName.schemaVersion)).toBe(1);
  });

  test("AC-3: Events includes memory/observations.accumulated with specified data fields", () => {
    const data: EventData<"memory/observations.accumulated"> = {
      date: "2026-02-15",
      totalTokens: 4021,
      observationCount: 17,
      capturedAt: "2026-02-15T00:00:00.000Z",
    };

    expect(data.totalTokens).toBe(4021);
    expect(data.observationCount).toBe(17);
  });

  test("AC-4: Events includes memory/observations.reflected with specified data fields", () => {
    const data: EventData<"memory/observations.reflected"> = {
      date: "2026-02-15",
      inputTokens: 900,
      outputTokens: 300,
      compressionRatio: 3,
      proposalCount: 4,
      capturedAt: "2026-02-15T00:00:00.000Z",
    };

    expect(data.compressionRatio).toBe(3);
    expect(data.proposalCount).toBe(4);
  });

  test("AC-5: session event schemaVersion fields are literal type 1 (not number)", () => {
    const compactionSchemaVersion: EventData<"memory/session.compaction.pending">["schemaVersion"] = 1;
    const endedSchemaVersion: EventData<"memory/session.ended">["schemaVersion"] = 1;

    expect(expectLiteralOne(compactionSchemaVersion)).toBe(1);
    expect(expectLiteralOne(endedSchemaVersion)).toBe(1);
  });
});

describe("MEM-1: TypeScript compile gate", () => {
  test(
    "AC-6: bunx tsc --noEmit succeeds",
    async () => {
      const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: new URL("..", import.meta.url).pathname,
      });

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    },
    30_000
  );
});

import { describe, expect, test } from "bun:test";
import { buildQueuedGatewayMessage } from "./channel-delivery-audit";

describe("gateway/send.message audit envelope", () => {
  test("preserves producer lineage without retaining a second message body", () => {
    const queued = buildQueuedGatewayMessage({
      channel: "telegram",
      text: "private notification",
      audit: {
        flowId: "flow-123",
        producer: "queue-observer",
        originSystemId: "panda",
        requestedAtMs: 1_000,
      },
    }, {
      eventId: "event-456",
      eventTimestampMs: 900,
    }, 1_250);

    expect(queued.audit).toMatchObject({
      schemaVersion: 1,
      flowId: "flow-123",
      producer: "queue-observer",
      originSystemId: "panda",
      eventId: "event-456",
      requestedAtMs: 1_000,
      queuedAtMs: 1_250,
      contentChars: 20,
      contentBytes: 20,
    });
    expect(queued.ts).toBe("1970-01-01T00:00:01.250Z");
    expect(JSON.stringify(queued.audit)).not.toContain("private notification");
  });

  test("creates stable fallback audit metadata for legacy producers", () => {
    const queued = buildQueuedGatewayMessage({
      channel: "telegram",
      text: "legacy",
    }, {
      eventId: "event-legacy",
      eventTimestampMs: 2_000,
    }, 2_500);

    expect(queued.audit.flowId).toBe("inngest:event-legacy");
    expect(queued.audit.producer).toBe("gateway/send.message");
    expect(queued.audit.eventId).toBe("event-legacy");
    expect(queued.audit.requestedAtMs).toBe(2_000);
    expect(queued.audit.queuedAtMs).toBe(2_500);
  });
});

import { describe, expect, test } from "bun:test";

const { __channelMessageClassifyTestUtils } = await import("./channel-message-classify");
const {
  parseJsonObject,
  parseClassification,
  fallbackClassificationFromMessage,
  buildClassifiedChannelMessageDocument,
} = __channelMessageClassifyTestUtils;

describe("channel-message-classify JSON parsing", () => {
  test("parses markdown-fenced JSON payloads", () => {
    const parsed = parseJsonObject('```json\n{"classification":"context","topics":["ops"],"urgency":"normal","actionable":false,"conceptIds":["joelclaw:concept:observe"],"primaryConceptId":"joelclaw:concept:observe"}\n```');

    expect(parsed).not.toBeNull();
    expect(parsed?.classification).toBe("context");
  });

  test("parses JSON objects embedded in prose", () => {
    const parsed = parseJsonObject('Here you go:\n{"classification":"signal","topics":["deploy"],"urgency":"high","actionable":true,"conceptIds":["joelclaw:concept:build"],"primaryConceptId":"joelclaw:concept:build"}\nDone.');

    expect(parsed).not.toBeNull();
    expect(parsed?.classification).toBe("signal");
  });

  test("normalizes fenced classification payload into canonical concepts", () => {
    const classification = parseClassification(
      null,
      '```json\n{"classification":"context","topics":["Gateway Health","Gateway Health"],"urgency":"normal","actionable":false,"summary":"Gateway status update","primaryConceptId":"joelclaw:concept:observe","conceptIds":["joelclaw:concept:observe","joelclaw:concept:comms"]}\n```'
    );

    expect(classification.classification).toBe("context");
    expect(classification.topics).toEqual(["gateway-health"]);
    expect(classification.primaryConceptId).toBe("joelclaw:concept:observe");
    expect(classification.conceptIds).toEqual([
      "joelclaw:concept:observe",
      "joelclaw:concept:comms",
    ]);
  });

  test("falls back to heuristic classification when model output is malformed", () => {
    const classification = fallbackClassificationFromMessage({
      id: "msg-1",
      channelType: "telegram",
      channelId: "gateway",
      channelName: "Gateway",
      threadId: "thread-1",
      userId: "user-1",
      userName: "Joel",
      text: "Urgent gateway error: webhook delivery failing and OTEL timeout spike",
      timestamp: 1775492690000,
    });

    expect(classification.classification).toBe("signal");
    expect(classification.urgency).toBe("high");
    expect(classification.actionable).toBe(true);
    expect(classification.conceptSource).toBe("fallback");
    expect(classification.conceptIds).toContain("joelclaw:concept:observe");
  });

  test("builds a full Typesense upsert document so required fields stay present", () => {
    const document = buildClassifiedChannelMessageDocument(
      {
        id: "msg-1",
        channelType: "telegram",
        channelId: "gateway",
        channelName: "Gateway",
        threadId: "thread-1",
        userId: "user-1",
        userName: "Joel",
        text: "Gateway auth failed again",
        timestamp: 1775492690000,
        sourceUrl: "https://example.com/message/1",
      },
      {
        classification: "signal",
        topics: ["gateway-auth"],
        urgency: "high",
        actionable: true,
        summary: "Gateway auth failure needs attention.",
        primaryConceptId: "joelclaw:concept:observe",
        conceptIds: ["joelclaw:concept:observe", "joelclaw:concept:comms"],
        taxonomyVersion: "workload-v1",
        conceptSource: "fallback",
      },
      "thread-1"
    );

    expect(document).toMatchObject({
      id: "msg-1",
      channel_type: "telegram",
      channel_id: "gateway",
      channel_name: "Gateway",
      thread_id: "thread-1",
      user_id: "user-1",
      user_name: "Joel",
      text: "Gateway auth failed again",
      timestamp: 1775492690000,
      classification: "signal",
      urgency: "high",
      actionable: true,
      primary_concept_id: "joelclaw:concept:observe",
      concept_ids: ["joelclaw:concept:observe", "joelclaw:concept:comms"],
      taxonomy_version: "workload-v1",
      concept_source: "fallback",
      summary: "Gateway auth failure needs attention.",
      source_url: "https://example.com/message/1",
    });
  });
});

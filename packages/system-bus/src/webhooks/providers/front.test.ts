import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { frontProvider } from "./front";

const priorRulesSecret = process.env.FRONT_RULES_WEBHOOK_SECRET;
const priorApplicationSecret = process.env.FRONT_APPLICATION_SECRET;

afterEach(() => {
  if (priorRulesSecret === undefined) delete process.env.FRONT_RULES_WEBHOOK_SECRET;
  else process.env.FRONT_RULES_WEBHOOK_SECRET = priorRulesSecret;

  if (priorApplicationSecret === undefined) delete process.env.FRONT_APPLICATION_SECRET;
  else process.env.FRONT_APPLICATION_SECRET = priorApplicationSecret;
});

describe("Front webhook signatures", () => {
  test("verifies rules webhooks with the API secret and SHA1", () => {
    process.env.FRONT_RULES_WEBHOOK_SECRET = "rules-secret";
    const rawBody = JSON.stringify({ type: "inbound", id: "evt_123" });
    const signature = createHmac("sha1", "rules-secret").update(rawBody).digest("base64");

    expect(frontProvider.verifySignature(rawBody, { "x-front-signature": signature })).toBe(true);
  });

  test("verifies application webhooks with timestamp, application secret, and SHA256", () => {
    process.env.FRONT_APPLICATION_SECRET = "application-secret";
    const rawBody = JSON.stringify({ type: "sync", authorization: { id: "cmp_123" } });
    const timestamp = "1783700793";
    const signature = createHmac("sha256", "application-secret")
      .update(`${timestamp}:${rawBody}`)
      .digest("base64");

    expect(frontProvider.verifySignature(rawBody, {
      "x-front-signature": signature,
      "x-front-request-timestamp": timestamp,
    })).toBe(true);
  });
});

describe("Front webhook normalization", () => {
  test("normalizes application inbound_received payloads", () => {
    const [event] = frontProvider.normalizePayload({
      type: "inbound_received",
      ts: 1_783_970_793,
      payload: {
        id: "evt_app_123",
        conversation: { id: "cnv_app_123", subject: "Application webhook" },
        target: {
          data: {
            id: "msg_app_123",
            recipients: [
              { role: "from", handle: "sender@example.com", name: "Sender" },
              { role: "to", handle: "support@example.com" },
            ],
            text: "hello from application webhook",
            blurb: "hello",
            attachments: [],
          },
        },
      },
    }, {});

    expect(event).toMatchObject({
      name: "message.received",
      data: {
        conversationId: "cnv_app_123",
        messageId: "msg_app_123",
        from: "sender@example.com",
        fromName: "Sender",
        to: ["support@example.com"],
        subject: "Application webhook",
        bodyPlain: "hello from application webhook",
        isInbound: true,
      },
    });
    expect(event?.idempotencyKey).toBe("front-inbound_received-evt_app_123-1783970793");
  });

  test("derives non-empty text from each supported message shape", () => {
    const cases = [
      { message: { text: "  plain text  " }, expected: "plain text" },
      { message: { blurb: "  preview text  " }, expected: "preview text" },
      {
        message: { body: "<p>Hello <strong>from HTML</strong>&amp; friends</p>" },
        expected: "Hello from HTML & friends",
      },
      {
        message: { attachments: [{ id: "fil_123" }] },
        expected: "[Attachment-only message: 1 attachment]",
      },
    ];

    for (const [index, fixture] of cases.entries()) {
      const [event] = frontProvider.normalizePayload({
        type: "inbound_received",
        ts: 1_783_970_800 + index,
        payload: {
          id: `evt_text_${index}`,
          conversation: { id: `cnv_text_${index}` },
          target: { data: { id: `msg_text_${index}`, ...fixture.message } },
        },
      }, {});

      expect(event).toMatchObject({
        name: "message.received",
        data: { bodyPlain: fixture.expected },
      });
    }
  });

  test("quarantines message events without usable text", () => {
    const [event] = frontProvider.normalizePayload({
      type: "inbound_received",
      ts: 1_783_970_804,
      payload: {
        id: "evt_blank_123",
        conversation: { id: "cnv_blank_123" },
        target: { data: { id: "msg_blank_123", unexpected: true } },
      },
    }, {});

    expect(event).toMatchObject({
      name: "message.quarantined",
      data: {
        conversationId: "cnv_blank_123",
        messageId: "msg_blank_123",
        eventType: "inbound_received",
        reason: "missing-message-text",
        payloadKeys: ["id", "unexpected"],
      },
    });
  });

  test("keeps normalizing rules inbound payloads", () => {
    const [event] = frontProvider.normalizePayload({
      type: "inbound",
      id: "evt_rules_123",
      emitted_at: 1_783_970_794,
      conversation: { id: "cnv_rules_123", subject: "Rules webhook" },
      target: {
        data: {
          id: "msg_rules_123",
          recipients: [{ role: "from", handle: "rules@example.com" }],
          text: "hello from rules webhook",
        },
      },
    }, {});

    expect(event).toMatchObject({
      name: "message.received",
      data: {
        conversationId: "cnv_rules_123",
        messageId: "msg_rules_123",
        from: "rules@example.com",
        bodyPlain: "hello from rules webhook",
        isInbound: true,
      },
    });
  });

  test("normalizes application lifecycle payload target data", () => {
    const basePayload = {
      id: "evt_app_lifecycle",
      conversation: { id: "cnv_app_lifecycle" },
    };
    const [assignee] = frontProvider.normalizePayload({
      type: "assignee_changed",
      ts: 1_783_970_795,
      payload: {
        ...basePayload,
        target: { data: { email: "owner@example.com", first_name: "Owner" } },
      },
    }, {});
    const [comment] = frontProvider.normalizePayload({
      type: "new_comment_added",
      ts: 1_783_970_796,
      payload: {
        ...basePayload,
        target: { data: { body: "Internal note", author: { email: "author@example.com" } } },
      },
    }, {});
    const [tag] = frontProvider.normalizePayload({
      type: "tag_added",
      ts: 1_783_970_797,
      payload: {
        ...basePayload,
        target: { data: { id: "tag_123", name: "priority" } },
      },
    }, {});

    expect(assignee).toMatchObject({
      name: "assignee.changed",
      data: { conversationId: "cnv_app_lifecycle", assigneeEmail: "owner@example.com" },
    });
    expect(comment).toMatchObject({
      name: "comment.added",
      data: { conversationId: "cnv_app_lifecycle", commentBody: "Internal note" },
    });
    expect(tag).toMatchObject({
      name: "tag.added",
      data: { conversationId: "cnv_app_lifecycle", tagId: "tag_123", tagName: "priority" },
    });
  });
});

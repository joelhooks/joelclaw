import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { __webhookServerTestUtils, webhookApp } from "./server";
import type { NormalizedEvent, WebhookProvider } from "./types";

const { buildWebhookEventName, shouldQueueWebhookEvent } = __webhookServerTestUtils;

const githubProvider: WebhookProvider = {
  id: "github",
  eventPrefix: "github",
  verifySignature: () => true,
  normalizePayload: () => [],
};

const workflowCompleted: NormalizedEvent = {
  name: "workflow_run.completed",
  data: { runId: 123 },
  idempotencyKey: "delivery-123",
};

const packagePublished: NormalizedEvent = {
  name: "package.published",
  data: { packageName: "pkg" },
  idempotencyKey: "delivery-456",
};

const priorQueuePilots = process.env.QUEUE_PILOTS;
const priorXConsumerSecret = process.env.X_CONSUMER_SECRET;

afterEach(() => {
  if (priorQueuePilots === undefined) {
    delete process.env.QUEUE_PILOTS;
    return;
  }

  process.env.QUEUE_PILOTS = priorQueuePilots;

  if (priorXConsumerSecret === undefined) {
    delete process.env.X_CONSUMER_SECRET;
  } else {
    process.env.X_CONSUMER_SECRET = priorXConsumerSecret;
  }
});

describe("webhook server queue pilot helpers", () => {
  test("buildWebhookEventName prefixes the normalized event name", () => {
    expect(buildWebhookEventName(githubProvider, workflowCompleted)).toBe(
      "github/workflow_run.completed",
    );
  });

  test("queues github workflow_run.completed when the github pilot is enabled", () => {
    process.env.QUEUE_PILOTS = "github";

    expect(shouldQueueWebhookEvent("github", workflowCompleted)).toBe(true);
  });

  test("does not queue github package.published when the github pilot is enabled", () => {
    process.env.QUEUE_PILOTS = "github";

    expect(shouldQueueWebhookEvent("github", packagePublished)).toBe(false);
  });

  test("does not queue workflow_run.completed when the github pilot is disabled", () => {
    delete process.env.QUEUE_PILOTS;

    expect(shouldQueueWebhookEvent("github", workflowCompleted)).toBe(false);
  });

  test("does not queue non-github providers even when the github pilot is enabled", () => {
    process.env.QUEUE_PILOTS = "github";

    expect(shouldQueueWebhookEvent("vercel", workflowCompleted)).toBe(false);
  });
});

describe("webhook server provider challenges", () => {
  test("handles X CRC validation over GET /:provider", async () => {
    process.env.X_CONSUMER_SECRET = "test-secret";
    const response = await webhookApp.request("/x?crc_token=foo");
    const body = await response.json();
    const expected = `sha256=${createHmac("sha256", "test-secret").update("foo").digest("base64")}`;

    expect(response.status).toBe(200);
    expect(body).toEqual({ response_token: expected });
  });

  test("rejects GET challenges for providers that do not support them", async () => {
    const response = await webhookApp.request("/github?crc_token=foo");
    expect(response.status).toBe(405);
  });
});

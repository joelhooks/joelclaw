import { afterEach, describe, expect, test } from "bun:test";
import { __webhookServerTestUtils } from "./server";
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

afterEach(() => {
  if (priorQueuePilots === undefined) {
    delete process.env.QUEUE_PILOTS;
    return;
  }

  process.env.QUEUE_PILOTS = priorQueuePilots;
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

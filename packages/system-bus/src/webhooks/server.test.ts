import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { __webhookServerTestUtils, webhookApp } from "./server";
import type { NormalizedEvent, WebhookProvider } from "./types";

const {
  buildWebhookEventName,
  shouldQueueWebhookEvent,
  buildWebhookDispatchFailureEvent,
  persistWebhookDispatchFailure,
} = __webhookServerTestUtils;

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
const priorFrontApplicationSecret = process.env.FRONT_APPLICATION_SECRET;

const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

afterEach(() => {
  restoreEnv("QUEUE_PILOTS", priorQueuePilots);
  restoreEnv("X_CONSUMER_SECRET", priorXConsumerSecret);
  restoreEnv("FRONT_APPLICATION_SECRET", priorFrontApplicationSecret);
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

  test("builds a durable failure receipt for rejected Inngest sends", () => {
    const receipt = buildWebhookDispatchFailureEvent(
      "github",
      githubProvider,
      [workflowCompleted],
      new Error("Inngest unavailable"),
    );

    expect(receipt).toMatchObject({
      level: "error",
      component: "webhook",
      action: "webhook.forward.failed",
      success: false,
      error: "Inngest unavailable",
      metadata: {
        provider: "github",
        totalEvents: 1,
        eventNames: ["github/workflow_run.completed"],
      },
    });
  });

  test("surfaces when the dispatch failure receipt could not be stored", async () => {
    const result = await persistWebhookDispatchFailure(
      "github",
      githubProvider,
      [workflowCompleted],
      new Error("Inngest unavailable"),
      async () => ({
        stored: false,
        eventId: "failed-receipt",
        error: "ClickHouse and outbox unavailable",
        clickhouse: { written: false, queued: false, error: "unreachable" },
        typesense: { written: false, skipped: true },
        convex: { written: false, pruned: 0, skipped: true },
        sentry: { written: false, skipped: true },
      }),
    );

    expect(result).toMatchObject({
      stored: false,
      eventId: "failed-receipt",
      error: "ClickHouse and outbox unavailable",
    });
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

  test("handles signed Front application webhook validation", async () => {
    process.env.FRONT_APPLICATION_SECRET = "front-application-test-secret";
    const timestamp = "1783700793";
    const challenge = "front-validation-challenge";
    const rawBody = JSON.stringify({ type: "sync", authorization: { id: "cmp_test" } });
    const signature = createHmac("sha256", process.env.FRONT_APPLICATION_SECRET)
      .update(`${timestamp}:${rawBody}`)
      .digest("base64");

    const response = await webhookApp.request("/front", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-front-challenge": challenge,
        "x-front-request-timestamp": timestamp,
        "x-front-signature": signature,
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(challenge);
  });

  test("rejects GET challenges for providers that do not support them", async () => {
    const response = await webhookApp.request("/github?crc_token=foo");
    expect(response.status).toBe(405);
  });
});

import { describe, expect, test } from "bun:test";
import {
  matchesWebhookSubscriptionPayload,
  parseWebhookSubscription,
  type WebhookSubscription,
} from "./webhook-subscriptions";

describe("webhook-subscriptions", () => {
  test("matches github workflow filters case-insensitively", () => {
    const subscription: WebhookSubscription = {
      id: "whs_test",
      provider: "github",
      event: "workflow_run.completed",
      filters: {
        repo: "joelhooks/joelclaw",
        workflow: "CI",
        branch: "main",
        conclusion: "success",
      },
      sessionId: "pid-123",
      createdAt: "2026-03-01T00:00:00.000Z",
      active: true,
    };

    const matched = matchesWebhookSubscriptionPayload(subscription, {
      repository: "JoelHooks/JoelClaw",
      workflowName: "ci",
      branch: "MAIN",
      conclusion: "SUCCESS",
    });

    expect(matched).toBe(true);
  });

  test("rejects non-matching github workflow filters", () => {
    const subscription: WebhookSubscription = {
      id: "whs_test",
      provider: "github",
      event: "workflow_run.completed",
      filters: {
        repo: "joelhooks/joelclaw",
        conclusion: "success",
      },
      sessionId: "pid-123",
      createdAt: "2026-03-01T00:00:00.000Z",
      active: true,
    };

    const matched = matchesWebhookSubscriptionPayload(subscription, {
      repository: "joelhooks/joelclaw",
      conclusion: "failure",
    });

    expect(matched).toBe(false);
  });

  test("parseWebhookSubscription normalizes malformed payloads", () => {
    const parsed = parseWebhookSubscription(JSON.stringify({
      id: "whs_abc",
      provider: "github",
      event: "workflow_run.completed",
      createdAt: "2026-03-01T00:00:00.000Z",
      filters: {
        repo: "joelhooks/joelclaw",
        workflow: "",
      },
      active: false,
    }));

    expect(parsed).toEqual({
      id: "whs_abc",
      provider: "github",
      event: "workflow_run.completed",
      filters: {
        repo: "joelhooks/joelclaw",
      },
      createdAt: "2026-03-01T00:00:00.000Z",
      active: false,
    });
  });
});

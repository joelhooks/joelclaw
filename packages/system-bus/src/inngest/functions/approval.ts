/**
 * Agent approval workflow functions.
 * Credits local-approvals by shaiss (ADR-0067).
 */

import Redis from "ioredis";
import { inngest } from "../client";
import { approveRequest, denyRequest, submitRequest } from "../../approvals/core";
import { pushGatewayEvent } from "./agent-loop/utils";

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const isTest = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
    retryStrategy: isTest ? () => null : undefined,
  });
  redisClient.on("error", () => {});
  return redisClient;
}

export const approvalRequest = inngest.createFunction(
  { id: "agent/approval-request", retries: 1 },
  { event: "agent/approval.requested" },
  async ({ event, step }) => {
    const { agent, category, operation, reasoning } = event.data;

    const submitted = await step.run("submit-request", async () =>
      submitRequest(getRedis(), { agent, category, operation, reasoning })
    );

    if (submitted.autoApproved) {
      await step.sendEvent("emit-auto-resolved", {
        name: "agent/approval.resolved",
        data: {
          requestId: submitted.requestId,
          status: "approved" as const,
          reviewer: "system:auto-approve",
        },
      });
    } else {
      await step.run("notify-gateway-pending", async () => {
        await pushGatewayEvent({
          type: "approval.requested",
          source: "inngest/agent/approval.requested",
          payload: {
            requestId: submitted.requestId,
            agent,
            category,
            operation,
            reasoning,
            prompt: [
              "## Approval Requested",
              "",
              `- Request: \`${submitted.requestId}\``,
              `- Agent: \`${agent}\``,
              `- Category: \`${category}\``,
              `- Operation: ${operation}`,
              "",
              `Reasoning: ${reasoning}`,
              "",
              `Approve: \`joelclaw approvals approve ${submitted.requestId}\``,
              `Deny: \`joelclaw approvals deny ${submitted.requestId}\``,
            ].join("\n"),
          },
        });
      });
    }

    return { requestId: submitted.requestId, autoApproved: submitted.autoApproved };
  }
);

export const approvalResolve = inngest.createFunction(
  { id: "agent/approval-resolve", retries: 1 },
  { event: "agent/approval.resolved" },
  async ({ event, step }) => {
    await step.run("resolve-request", async () => {
      if (event.data.status === "approved") {
        await approveRequest(getRedis(), event.data.requestId, {
          reviewer: event.data.reviewer,
          ...(event.data.learn ? { learn: true } : {}),
        });
        return;
      }

      await denyRequest(getRedis(), event.data.requestId, {
        reviewer: event.data.reviewer,
      });
    });

    await step.run("notify-gateway-resolved", async () => {
      await pushGatewayEvent({
        type: "approval.resolved",
        source: "inngest/agent/approval.resolved",
        payload: {
          requestId: event.data.requestId,
          status: event.data.status,
          reviewer: event.data.reviewer,
          learn: event.data.learn ?? false,
          prompt: [
            `## Approval ${event.data.status === "approved" ? "Approved" : "Denied"}`,
            "",
            `- Request: \`${event.data.requestId}\``,
            `- Status: \`${event.data.status}\``,
            `- Reviewer: \`${event.data.reviewer}\``,
          ].join("\n"),
        },
      });
    });

    return { requestId: event.data.requestId, status: event.data.status };
  }
);

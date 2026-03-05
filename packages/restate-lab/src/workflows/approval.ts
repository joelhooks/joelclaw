/**
 * Level 3: Human-in-the-loop approval workflow.
 *
 * Flow:
 *   1. Workflow receives a request
 *   2. Sends notification to primary channel (Telegram/Console) with approve/reject buttons
 *   3. Blocks on ctx.promise("decision") — durable, survives restarts
 *   4. Human taps button → callback resolves the promise
 *   5. Workflow continues with the decision
 *
 * The key insight: ctx.promise() is durable. Kill the worker while waiting
 * for human input, restart it hours later, resolve the promise — it completes.
 *
 * Restate workflow handlers are the external API:
 *   POST /approvalWorkflow/{id}/run     — start the workflow
 *   POST /approvalWorkflow/{id}/approve — resolve with approval
 *   POST /approvalWorkflow/{id}/reject  — resolve with rejection
 *   GET  /approvalWorkflow/{id}/status  — check current state
 */

import * as restate from "@restatedev/restate-sdk";
import type { NotificationChannel } from "../channels/types";

// Channel is injected at startup — not imported directly.
// This keeps the workflow independent of any specific channel.
let channel: NotificationChannel | null = null;

export function setChannel(ch: NotificationChannel) {
  channel = ch;
}

export interface ApprovalRequest {
  /** What is being approved */
  title: string;
  /** Additional context */
  description: string;
  /** Who/what initiated this */
  requestedBy: string;
  /** Optional structured metadata */
  metadata?: Record<string, string>;
}

export interface ApprovalResult {
  request: ApprovalRequest;
  decision: "approved" | "rejected";
  reason: string;
  decidedAt: string;
  /** Time from request to decision */
  durationMs: number;
}

export const approvalWorkflow = restate.workflow({
  name: "approvalWorkflow",
  handlers: {
    /**
     * Main workflow handler — sends notification, waits for decision.
     */
    run: async (
      ctx: restate.WorkflowContext,
      request: ApprovalRequest,
    ): Promise<ApprovalResult> => {
      const workflowId = ctx.key;
      const startedAt = Date.now();

      console.log(`\n🔬 Approval workflow started — ${workflowId}`);
      console.log(`   Title: ${request.title}`);
      console.log(`   Requested by: ${request.requestedBy}`);

      // Step 1: Record the request
      await ctx.run("record-request", () => ({
        workflowId,
        request,
        recordedAt: new Date().toISOString(),
      }));

      // Step 2: Send notification to primary channel
      await ctx.run("notify-channel", async () => {
        if (!channel) {
          console.log(`⚠️  No channel configured — waiting for CLI resolve`);
          return { sent: false };
        }

        const result = await channel.send({
          text:
            `🔔 *Approval Required*\n\n` +
            `*${request.title}*\n` +
            `${request.description}\n\n` +
            `Requested by: ${request.requestedBy}` +
            (request.metadata
              ? `\n${Object.entries(request.metadata).map(([k, v]) => `${k}: ${v}`).join("\n")}`
              : ""),
          actions: [
            { label: "✅ Approve", value: "approve" },
            { label: "❌ Reject", value: "reject" },
          ],
          workflowId,
          serviceName: "approvalWorkflow",
        });

        console.log(`📨 Notification sent via ${result.channel} (msg: ${result.messageId})`);
        return { sent: true, ...result };
      });

      // Step 3: Wait for human decision — THIS IS THE DURABLE PROMISE
      // The workflow blocks here. Kill the worker, restart it, the promise
      // is still waiting. Resolve it hours later and the workflow continues.
      console.log(`⏳ Waiting for human decision on ${workflowId}...`);
      const decision = await ctx.promise<string>("decision");

      // Step 4: Process the decision
      const result = await ctx.run("finalize", () => {
        const isApproved = decision.startsWith("approved");
        const reason = decision.split(":").slice(1).join(":") || "no reason given";

        const finalResult: ApprovalResult = {
          request,
          decision: isApproved ? "approved" : "rejected",
          reason,
          decidedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
        };

        console.log(`\n✅ Workflow ${workflowId} completed`);
        console.log(`   Decision: ${finalResult.decision}`);
        console.log(`   Reason: ${finalResult.reason}`);
        console.log(`   Duration: ${finalResult.durationMs}ms`);

        return finalResult;
      });

      // Step 5: Notify the channel of the outcome
      await ctx.run("notify-outcome", async () => {
        if (!channel) return { notified: false };

        await channel.send({
          text:
            `${result.decision === "approved" ? "✅" : "❌"} *${request.title}*\n\n` +
            `Decision: *${result.decision}*\n` +
            `Reason: ${result.reason}\n` +
            `Duration: ${Math.round(result.durationMs / 1000)}s`,
          actions: [], // no buttons on the outcome message
          workflowId,
          serviceName: "approvalWorkflow",
        });

        return { notified: true };
      });

      return result;
    },

    /**
     * Approve handler — resolves the decision promise.
     * Called externally: POST /approvalWorkflow/{id}/approve
     */
    approve: async (ctx: restate.WorkflowSharedContext, reason: string) => {
      console.log(`👍 Approve signal received for ${ctx.key}: ${reason || "no reason"}`);
      await ctx.promise<string>("decision").resolve(`approved:${reason || "approved"}`);
      return { resolved: "approved", reason };
    },

    /**
     * Reject handler — resolves the decision promise.
     * Called externally: POST /approvalWorkflow/{id}/reject
     */
    reject: async (ctx: restate.WorkflowSharedContext, reason: string) => {
      console.log(`👎 Reject signal received for ${ctx.key}: ${reason || "no reason"}`);
      await ctx.promise<string>("decision").resolve(`rejected:${reason || "rejected"}`);
      return { resolved: "rejected", reason };
    },

    /**
     * Status handler — check if the workflow is still pending.
     * Called externally: GET /approvalWorkflow/{id}/status
     */
    status: async (ctx: restate.WorkflowSharedContext) => {
      // Workflow shared context can read state but we keep it simple:
      // if you can call this, the workflow exists. The decision promise
      // is either pending or resolved.
      return { workflowId: ctx.key, alive: true };
    },
  },
});

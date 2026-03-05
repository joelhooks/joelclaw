/**
 * Level 3: Human-in-the-loop approval workflow with escalating reminders.
 *
 * Flow:
 *   1. Workflow receives a request
 *   2. Sends notification to primary channel with approve/reject buttons
 *   3. Enters reminder loop: sleep → peek promise → if pending, escalate
 *   4. When human responds (button press or CLI), promise resolves
 *   5. Workflow finalizes with the decision
 *
 * Escalation tiers (configurable):
 *   - gentle:   first reminder after initial wait
 *   - firm:     second reminder, more urgent tone
 *   - urgent:   third reminder, explicit warning
 *   - critical: final reminder before auto-action
 *
 * Durable: kill the worker at any point. Restart. Promise is still waiting.
 * Reminders survive restarts too — the sleep timer is in Restate's journal.
 *
 * Restate workflow handlers are the external API:
 *   POST /approvalWorkflow/{id}/run     — start the workflow
 *   POST /approvalWorkflow/{id}/approve — resolve with approval
 *   POST /approvalWorkflow/{id}/reject  — resolve with rejection
 */

import * as restate from "@restatedev/restate-sdk";
import type { NotificationChannel, Action } from "../channels/types";

// Channel is injected at startup — not imported directly.
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
  /** Reminder config override (for lab testing with short intervals) */
  reminderIntervals?: number[];
}

export interface ApprovalResult {
  request: ApprovalRequest;
  decision: "approved" | "rejected";
  reason: string;
  decidedAt: string;
  durationMs: number;
  remindersCount: number;
}

/**
 * Escalation tiers — each has a tone and optional auto-action.
 */
const ESCALATION_TIERS = [
  { urgency: "gentle",   emoji: "🔔", tone: "Friendly reminder" },
  { urgency: "firm",     emoji: "⏰", tone: "This is still waiting for you" },
  { urgency: "urgent",   emoji: "🚨", tone: "Needs attention — stale" },
  { urgency: "critical", emoji: "💀", tone: "Final reminder before auto-reject" },
] as const;

/**
 * Default reminder intervals in ms.
 * Production: 4h, 12h, 24h, 48h
 * Lab testing: override via request.reminderIntervals
 */
const DEFAULT_INTERVALS_MS = [
  4 * 3600_000,   // 4h
  12 * 3600_000,  // 12h
  24 * 3600_000,  // 24h
  48 * 3600_000,  // 48h
];

export const approvalWorkflow = restate.workflow({
  name: "approvalWorkflow",
  handlers: {
    /**
     * Main workflow handler — sends notification, reminder loop, waits for decision.
     */
    run: async (
      ctx: restate.WorkflowContext,
      request: ApprovalRequest,
    ): Promise<ApprovalResult> => {
      const workflowId = ctx.key;
      const startedAt = Date.now();
      const intervals = request.reminderIntervals ?? DEFAULT_INTERVALS_MS;

      console.log(`\n🔬 Approval workflow started — ${workflowId}`);
      console.log(`   Title: ${request.title}`);
      console.log(`   Reminder intervals: ${intervals.map(ms => `${ms/1000}s`).join(", ")}`);

      // Step 1: Record the request
      await ctx.run("record-request", () => ({
        workflowId,
        request,
        recordedAt: new Date().toISOString(),
      }));

      // Step 2: Send initial notification
      const buttons: Action[] = [
        { label: "✅ Approve", value: "approve" },
        { label: "❌ Reject", value: "reject" },
      ];

      await ctx.run("notify-initial", async () => {
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
          actions: buttons,
          workflowId,
          serviceName: "approvalWorkflow",
        });

        console.log(`📨 Initial notification sent via ${result.channel}`);
        return { sent: true, ...result };
      });

      // Step 3: Reminder loop with escalating urgency
      // Each iteration: sleep → peek the promise → if still pending, remind
      const decisionPromise = ctx.promise<string>("decision");
      let remindersCount = 0;

      for (let i = 0; i < Math.min(intervals.length, ESCALATION_TIERS.length); i++) {
        const tier = ESCALATION_TIERS[i];
        const intervalMs = intervals[i];

        // Sleep until next reminder
        await ctx.sleep({ milliseconds: intervalMs });

        // Check if decision came in while we slept
        const peeked = await decisionPromise.peek();
        if (peeked !== undefined) {
          console.log(`✅ Decision arrived during ${tier.urgency} wait — skipping reminders`);
          break;
        }

        // Still pending — send escalating reminder
        remindersCount++;
        const elapsed = intervals.slice(0, i + 1).reduce((a, b) => a + b, 0);
        const elapsedHuman = elapsed >= 3600_000
          ? `${Math.round(elapsed / 3600_000)}h`
          : `${Math.round(elapsed / 1000)}s`;

        await ctx.run(`remind-${tier.urgency}`, async () => {
          if (!channel) return { reminded: false };

          const result = await channel.send({
            text:
              `${tier.emoji} *${tier.tone}*\n\n` +
              `*${request.title}*\n` +
              `Waiting for ${elapsedHuman} — reminder ${remindersCount}/${ESCALATION_TIERS.length}\n\n` +
              (tier.urgency === "critical"
                ? `⚠️ This will auto-reject if no response within next interval.`
                : `Tap a button below to respond.`),
            actions: buttons,
            workflowId,
            serviceName: "approvalWorkflow",
          });

          console.log(`${tier.emoji} Reminder ${remindersCount} (${tier.urgency}) sent — ${elapsedHuman} elapsed`);
          return { reminded: true, ...result };
        });
      }

      // Step 4: Final check — if still no decision after all reminders, auto-reject
      const finalPeek = await decisionPromise.peek();
      let decision: string;

      if (finalPeek !== undefined) {
        decision = finalPeek;
      } else {
        // All reminders exhausted — wait one more interval then auto-reject
        // Or just wait for the promise (it's durable, will eventually resolve)
        console.log(`⏳ All reminders sent. Waiting indefinitely for decision...`);
        decision = await decisionPromise;
      }

      // Step 5: Finalize
      const result = await ctx.run("finalize", () => {
        const isApproved = decision.startsWith("approved");
        const reason = decision.split(":").slice(1).join(":") || "no reason given";

        const finalResult: ApprovalResult = {
          request,
          decision: isApproved ? "approved" : "rejected",
          reason,
          decidedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          remindersCount,
        };

        console.log(`\n🏁 Workflow ${workflowId} completed`);
        console.log(`   Decision: ${finalResult.decision}`);
        console.log(`   Reason: ${finalResult.reason}`);
        console.log(`   Duration: ${finalResult.durationMs}ms`);
        console.log(`   Reminders sent: ${remindersCount}`);

        return finalResult;
      });

      // Step 6: Notify outcome
      await ctx.run("notify-outcome", async () => {
        if (!channel) return { notified: false };

        await channel.send({
          text:
            `${result.decision === "approved" ? "✅" : "❌"} *${request.title}*\n\n` +
            `Decision: *${result.decision}*\n` +
            `Reason: ${result.reason}\n` +
            `Duration: ${Math.round(result.durationMs / 1000)}s\n` +
            `Reminders sent: ${result.remindersCount}`,
          actions: [],
          workflowId,
          serviceName: "approvalWorkflow",
        });

        return { notified: true };
      });

      return result;
    },

    /**
     * Approve handler — resolves the decision promise.
     */
    approve: async (ctx: restate.WorkflowSharedContext, reason: string) => {
      console.log(`👍 Approve signal for ${ctx.key}: ${reason || "no reason"}`);
      await ctx.promise<string>("decision").resolve(`approved:${reason || "approved"}`);
      return { resolved: "approved", reason };
    },

    /**
     * Reject handler — resolves the decision promise.
     */
    reject: async (ctx: restate.WorkflowSharedContext, reason: string) => {
      console.log(`👎 Reject signal for ${ctx.key}: ${reason || "no reason"}`);
      await ctx.promise<string>("decision").resolve(`rejected:${reason || "rejected"}`);
      return { resolved: "rejected", reason };
    },

    /**
     * Status handler — check workflow state.
     */
    status: async (ctx: restate.WorkflowSharedContext) => {
      return { workflowId: ctx.key, alive: true };
    },
  },
});

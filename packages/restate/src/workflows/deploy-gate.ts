/**
 * Deploy Gate — first production Restate workflow.
 *
 * Wraps the system-bus-worker deploy pipeline with a human approval gate.
 * Each step is a durable ctx.run() — kill the worker at any point,
 * restart, and it resumes where it left off.
 *
 * Flow:
 *   1. Authenticate to GHCR
 *   2. Build ARM64 Docker image
 *   3. Push to GHCR (tagged + latest)
 *   4. Notify via primary channel with Approve/Reject buttons
 *   5. Wait for human approval (with escalating reminders)
 *   6. Update k8s manifest with new image tag
 *   7. Apply to cluster
 *   8. Verify rollout
 *   9. Notify outcome
 *
 * Trigger: POST /deployGate/{id}/run
 * Approve: POST /deployGate/{id}/approve
 * Reject:  POST /deployGate/{id}/reject
 */

import * as restate from "@restatedev/restate-sdk";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { NotificationChannel, Action } from "../channels/types";

let channel: NotificationChannel | null = null;

export function setDeployChannel(ch: NotificationChannel) {
  channel = ch;
}

// --- Config ---

const ROOT_DIR = process.env.JOELCLAW_ROOT ?? "/Users/joel/Code/joelhooks/joelclaw";
const MANIFEST = `${ROOT_DIR}/k8s/system-bus-worker.yaml`;
const DOCKERFILE = `${ROOT_DIR}/packages/system-bus/Dockerfile`;
const NAMESPACE = process.env.NAMESPACE ?? "joelclaw";
const DEPLOYMENT = process.env.DEPLOYMENT ?? "system-bus-worker";
const REGISTRY = process.env.REGISTRY ?? "ghcr.io";
const OWNER = process.env.OWNER ?? "joelhooks";
const IMAGE_NAME = process.env.IMAGE_NAME ?? "system-bus-worker";

// Reminder intervals: 5min, 15min, 30min, 1h
const REMINDER_INTERVALS_MS = [
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
];

const ESCALATION_TIERS = [
  { urgency: "gentle", emoji: "🔔", tone: "Deploy is waiting for approval" },
  { urgency: "firm", emoji: "⏰", tone: "Image built and pushed — still needs approval" },
  { urgency: "urgent", emoji: "🚨", tone: "Stale deploy — approve or reject" },
  { urgency: "critical", emoji: "💀", tone: "Final reminder — will auto-reject" },
] as const;

// --- Helpers ---

function exec(cmd: string, label: string): string {
  console.log(`  $ ${cmd}`);
  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 300_000, // 5min timeout per command
      env: { ...process.env, DOCKER_CONFIG: process.env.DOCKER_CONFIG },
    });
    return output.trim();
  } catch (err: any) {
    throw new Error(`${label} failed: ${err.message}\nstdout: ${err.stdout}\nstderr: ${err.stderr}`);
  }
}

// --- Interfaces ---

export interface DeployRequest {
  /** Optional image tag — defaults to timestamp */
  tag?: string;
  /** Override reminder intervals (ms) for testing */
  reminderIntervals?: number[];
  /** Skip the approval gate (for automated deploys) */
  skipApproval?: boolean;
  /** Reason for the deploy */
  reason?: string;
}

export interface DeployResult {
  image: string;
  tag: string;
  decision: "approved" | "rejected" | "skipped";
  reason: string;
  deployedAt?: string;
  rolloutVerified: boolean;
  durationMs: number;
  remindersCount: number;
}

// --- Workflow ---

export const deployGate = restate.workflow({
  name: "deployGate",
  handlers: {
    run: async (
      ctx: restate.WorkflowContext,
      request: DeployRequest,
    ): Promise<DeployResult> => {
      const workflowId = ctx.key;
      const startedAt = Date.now();
      const tag = request.tag ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const image = `${REGISTRY}/${OWNER}/${IMAGE_NAME}:${tag}`;
      const latestImage = `${REGISTRY}/${OWNER}/${IMAGE_NAME}:latest`;
      const intervals = request.reminderIntervals ?? REMINDER_INTERVALS_MS;

      console.log(`\n🚀 Deploy gate started — ${workflowId}`);
      console.log(`   Image: ${image}`);
      console.log(`   Reason: ${request.reason ?? "manual deploy"}`);

      // Step 1: Authenticate to GHCR
      const authResult = await ctx.run("authenticate-ghcr", () => {
        console.log(`🔑 Authenticating to GHCR...`);

        // Try agent-secrets first, fall back to gh auth
        let token: string;
        let source: string;
        try {
          token = exec("secrets lease ghcr_pat --ttl 20m --client-id deploy-gate 2>/dev/null", "secrets");
          source = "agent-secrets";
        } catch {
          token = exec("gh auth token", "gh-auth");
          source = "gh-auth-token";
        }

        const user = exec("gh api user -q .login", "gh-user");

        // Create temp docker config and login — pipe token via env to avoid shell exposure
        const tmpDir = exec("mktemp -d /tmp/docker-ghcr.XXXXXX", "mktemp");
        process.env.DOCKER_CONFIG = tmpDir;
        process.env.__GHCR_TOKEN = token;

        exec(
          `printenv __GHCR_TOKEN | docker login ${REGISTRY} -u ${user} --password-stdin 2>/dev/null`,
          "docker-login",
        );

        delete process.env.__GHCR_TOKEN;

        console.log(`   ✅ Authenticated as ${user} via ${source}`);
        return { user, source, dockerConfig: tmpDir };
      });

      // Step 2: Build image
      const buildResult = await ctx.run("build-image", () => {
        console.log(`🔨 Building ${image}...`);
        process.env.DOCKER_CONFIG = authResult.dockerConfig;

        exec(
          `docker build -f ${DOCKERFILE} -t ${image} -t ${latestImage} ${ROOT_DIR}`,
          "docker-build",
        );

        console.log(`   ✅ Built ${image}`);
        return { image, latestImage, builtAt: new Date().toISOString() };
      });

      // Step 3: Push to GHCR
      const pushResult = await ctx.run("push-ghcr", () => {
        console.log(`📤 Pushing ${image}...`);
        process.env.DOCKER_CONFIG = authResult.dockerConfig;

        exec(`docker push ${image}`, "docker-push-tagged");
        exec(`docker push ${latestImage}`, "docker-push-latest");

        console.log(`   ✅ Pushed to GHCR`);
        return { pushed: true, pushedAt: new Date().toISOString() };
      });

      // Step 4: Approval gate (skip if requested)
      let decision: "approved" | "rejected" | "skipped";
      let decisionReason: string;
      let remindersCount = 0;

      if (request.skipApproval) {
        decision = "skipped";
        decisionReason = "approval skipped per request";
        console.log(`⏩ Approval skipped`);
      } else {
        // Send notification
        const buttons: Action[] = [
          { label: "✅ Deploy", value: "approve" },
          { label: "❌ Rollback", value: "reject" },
        ];

        await ctx.run("notify-approval-request", async () => {
          if (!channel) return { sent: false };

          await channel.send({
            text:
              `🚀 *Deploy Ready — Approval Required*\n\n` +
              `*${DEPLOYMENT}*\n` +
              `Image: \`${image}\`\n` +
              `Reason: ${request.reason ?? "manual deploy"}\n` +
              `Built by: ${authResult.user}\n\n` +
              `Approve to roll out to k8s, or reject to discard.`,
            actions: buttons,
            workflowId,
            serviceName: "deployGate",
          });

          return { sent: true };
        });

        // Reminder loop
        const decisionPromise = ctx.promise<string>("decision");

        for (let i = 0; i < Math.min(intervals.length, ESCALATION_TIERS.length); i++) {
          const tier = ESCALATION_TIERS[i];
          await ctx.sleep({ milliseconds: intervals[i] });

          const peeked = await decisionPromise.peek();
          if (peeked !== undefined) break;

          remindersCount++;
          const elapsed = intervals.slice(0, i + 1).reduce((a, b) => a + b, 0);
          const elapsedMin = Math.round(elapsed / 60_000);

          await ctx.run(`remind-${tier.urgency}`, async () => {
            if (!channel) return;
            await channel.send({
              text:
                `${tier.emoji} *${tier.tone}*\n\n` +
                `\`${image}\`\n` +
                `Waiting: ${elapsedMin}min — reminder ${remindersCount}/${ESCALATION_TIERS.length}`,
              actions: buttons,
              workflowId,
              serviceName: "deployGate",
            });
          });
        }

        // Wait for decision (may already be resolved)
        const rawDecision = await decisionPromise;
        const isApproved = rawDecision.startsWith("approved");
        decision = isApproved ? "approved" : "rejected";
        decisionReason = rawDecision.split(":").slice(1).join(":") || "no reason";

        console.log(`   Decision: ${decision} — ${decisionReason}`);
      }

      // Step 5: Deploy to k8s (only if approved)
      let rolloutVerified = false;

      if (decision === "approved" || decision === "skipped") {
        // Update manifest
        await ctx.run("update-manifest", () => {
          console.log(`📝 Updating manifest → ${image}`);
          const content = readFileSync(MANIFEST, "utf-8");
          const updated = content.replace(
            /image: ghcr\.io\/.*\/system-bus-worker:[^\s]+/,
            `image: ${image}`,
          );
          writeFileSync(MANIFEST, updated);
          return { updated: true };
        });

        // Apply
        await ctx.run("apply-k8s", () => {
          console.log(`☸️  Applying to k8s...`);
          exec(`kubectl apply -f ${MANIFEST}`, "kubectl-apply");
          return { applied: true };
        });

        // Verify rollout
        rolloutVerified = await ctx.run("verify-rollout", () => {
          console.log(`🔍 Verifying rollout...`);
          try {
            exec(
              `kubectl -n ${NAMESPACE} rollout status deployment/${DEPLOYMENT} --timeout=180s`,
              "rollout-status",
            );
            console.log(`   ✅ Rollout verified`);
            return true;
          } catch (err) {
            console.error(`   ❌ Rollout failed:`, err);
            return false;
          }
        });

        // Probe
        await ctx.run("probe-worker", () => {
          try {
            const pod = exec(
              `kubectl -n ${NAMESPACE} get pods -l app=${DEPLOYMENT} -o jsonpath='{.items[0].metadata.name}'`,
              "get-pod",
            );
            const probe = exec(
              `kubectl -n ${NAMESPACE} exec ${pod} -- bun -e 'const r=await fetch("http://127.0.0.1:3111/"); console.log(await r.text());'`,
              "probe",
            );
            console.log(`   🏥 Probe: ${probe.slice(0, 100)}`);
            return { probed: true, response: probe.slice(0, 200) };
          } catch {
            console.log(`   ⚠️  Probe failed (non-fatal)`);
            return { probed: false };
          }
        });

        // Force Inngest re-sync
        await ctx.run("sync-inngest", () => {
          try {
            exec("curl -sf -X PUT http://127.0.0.1:3111/api/inngest", "inngest-sync");
            console.log(`   🔄 Inngest function sync triggered`);
            return { synced: true };
          } catch {
            console.log(`   ⚠️  Inngest sync failed (non-fatal)`);
            return { synced: false };
          }
        });
      } else {
        console.log(`⏭️  Deploy skipped — decision: ${decision}`);
      }

      // Step 6: Build result
      const result: DeployResult = {
        image,
        tag,
        decision,
        reason: decisionReason,
        deployedAt: (decision === "approved" || decision === "skipped")
          ? new Date().toISOString()
          : undefined,
        rolloutVerified,
        durationMs: Date.now() - startedAt,
        remindersCount,
      };

      // Step 7: Notify outcome
      await ctx.run("notify-outcome", async () => {
        if (!channel) return;

        const emoji = decision === "rejected" ? "❌" :
          rolloutVerified ? "✅" : "⚠️";

        await channel.send({
          text:
            `${emoji} *Deploy ${decision}*\n\n` +
            `\`${image}\`\n` +
            `Rollout: ${rolloutVerified ? "verified ✅" : "not verified"}\n` +
            `Duration: ${Math.round(result.durationMs / 1000)}s\n` +
            `Reminders: ${remindersCount}`,
          actions: [],
          workflowId,
          serviceName: "deployGate",
        });
      });

      // Cleanup docker config
      await ctx.run("cleanup", () => {
        try {
          exec(`rm -rf ${authResult.dockerConfig}`, "cleanup");
        } catch { /* non-fatal */ }
        return { cleaned: true };
      });

      console.log(`\n🏁 Deploy gate complete — ${decision}`);
      return result;
    },

    approve: async (ctx: restate.WorkflowSharedContext, reason: string) => {
      console.log(`👍 Deploy approved for ${ctx.key}: ${reason || "approved"}`);
      await ctx.promise<string>("decision").resolve(`approved:${reason || "approved"}`);
      return { resolved: "approved" };
    },

    reject: async (ctx: restate.WorkflowSharedContext, reason: string) => {
      console.log(`👎 Deploy rejected for ${ctx.key}: ${reason || "rejected"}`);
      await ctx.promise<string>("decision").resolve(`rejected:${reason || "rejected"}`);
      return { resolved: "rejected" };
    },
  },
});

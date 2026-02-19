/**
 * Vercel webhook → gateway notification functions.
 *
 * When Vercel fires a webhook, these functions push notifications
 * to the gateway pi session with human-readable deploy status.
 *
 * ADR-0048: Webhook Gateway for External Service Integration (Phase 3)
 */

import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

// ── Deploy succeeded ────────────────────────────────────────────────

export const vercelDeploySucceeded = inngest.createFunction(
  { id: "vercel-deploy-succeeded-notify", name: "Vercel → Gateway: Deploy Succeeded" },
  { event: "vercel/deploy.succeeded" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const {
      deploymentId, deploymentUrl, projectName, target,
      gitCommitMessage, gitCommitAuthor, gitBranch, dashboardUrl,
    } = event.data;

    const agentPrompt = await step.run("build-prompt", () => {
      const targetTag = target === "production" ? " 🚀 **PRODUCTION**" : target ? ` (${target})` : "";
      const commitInfo = gitCommitMessage
        ? `\n**Commit**: "${gitCommitMessage}" by ${gitCommitAuthor || "unknown"} on \`${gitBranch || "main"}\``
        : "";
      const urlLine = deploymentUrl ? `\n**URL**: https://${deploymentUrl}` : "";
      const dashLine = dashboardUrl ? `\n**Dashboard**: ${dashboardUrl}` : "";

      return [
        `## ✅ Deploy Succeeded${targetTag}`,
        "",
        `**Project**: ${projectName || "unknown"}${commitInfo}${urlLine}${dashLine}`,
        `Deployment \`${deploymentId}\``,
      ].join("\n");
    });

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false, reason: "no gateway context" };

      return await gateway.notify("vercel.deploy.succeeded", {
        prompt: agentPrompt,
        deploymentId,
        deploymentUrl,
        projectName,
        target,
        gitCommitMessage,
        gitBranch,
      });
    });

    return {
      status: result.pushed ? "notified" : "skipped",
      deploymentId,
      projectName,
      target,
      result,
    };
  }
);

// ── Deploy error ────────────────────────────────────────────────────

export const vercelDeployError = inngest.createFunction(
  { id: "vercel-deploy-error-notify", name: "Vercel → Gateway: Deploy Error" },
  { event: "vercel/deploy.error" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const {
      deploymentId, deploymentUrl, projectName, target,
      gitCommitMessage, gitCommitAuthor, gitBranch, dashboardUrl,
    } = event.data;

    const agentPrompt = await step.run("build-prompt", () => {
      const targetTag = target === "production" ? " 🔴 **PRODUCTION**" : target ? ` (${target})` : "";
      const commitInfo = gitCommitMessage
        ? `\n**Commit**: "${gitCommitMessage}" by ${gitCommitAuthor || "unknown"} on \`${gitBranch || "main"}\``
        : "";
      const dashLine = dashboardUrl ? `\n**Dashboard**: ${dashboardUrl}` : "";

      return [
        `## ❌ Deploy Failed${targetTag}`,
        "",
        `**Project**: ${projectName || "unknown"}${commitInfo}${dashLine}`,
        `Deployment \`${deploymentId}\``,
        "",
        `Check the Vercel dashboard for build logs. Common causes: lockfile mismatch, TypeScript errors, missing env vars.`,
        `Should I investigate via \`vercel-debug\` skill?`,
      ].join("\n");
    });

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false, reason: "no gateway context" };

      return await gateway.notify("vercel.deploy.error", {
        prompt: agentPrompt,
        deploymentId,
        deploymentUrl,
        projectName,
        target,
        gitCommitMessage,
        gitBranch,
      });
    });

    return {
      status: result.pushed ? "notified" : "skipped",
      deploymentId,
      projectName,
      target,
      result,
    };
  }
);

// ── Deploy created ──────────────────────────────────────────────────

export const vercelDeployCreated = inngest.createFunction(
  { id: "vercel-deploy-created-notify", name: "Vercel → Gateway: Deploy Created" },
  { event: "vercel/deploy.created" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const {
      deploymentId, projectName, target,
      gitCommitMessage, gitCommitAuthor, gitBranch,
    } = event.data;

    const agentPrompt = await step.run("build-prompt", () => {
      const targetTag = target === "production" ? " (production)" : target ? ` (${target})` : "";
      const commitInfo = gitCommitMessage
        ? ` — "${gitCommitMessage}" by ${gitCommitAuthor || "unknown"} on \`${gitBranch || "main"}\``
        : "";

      return `## 🔄 Deploy Started\n\n**${projectName || "unknown"}**${targetTag}${commitInfo}\nDeployment \`${deploymentId}\``;
    });

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false, reason: "no gateway context" };

      return await gateway.notify("vercel.deploy.created", {
        prompt: agentPrompt,
        deploymentId,
        projectName,
        target,
        gitCommitMessage,
        gitBranch,
      });
    });

    return {
      status: result.pushed ? "notified" : "skipped",
      deploymentId,
      projectName,
      target,
      result,
    };
  }
);

// ── Deploy canceled ─────────────────────────────────────────────────

export const vercelDeployCanceled = inngest.createFunction(
  { id: "vercel-deploy-canceled-notify", name: "Vercel → Gateway: Deploy Canceled" },
  { event: "vercel/deploy.canceled" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const { deploymentId, projectName, target } = event.data;

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false, reason: "no gateway context" };

      return await gateway.notify("vercel.deploy.canceled", {
        prompt: `## ⚪ Deploy Canceled\n\n**${projectName || "unknown"}** — Deployment \`${deploymentId}\``,
        deploymentId,
        projectName,
        target,
      });
    });

    return { status: result.pushed ? "notified" : "skipped", deploymentId, projectName, result };
  }
);

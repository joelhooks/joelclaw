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

// ── Deploy error — notify + auto-dispatch fix agent ─────────────────

export const vercelDeployError = inngest.createFunction(
  { id: "vercel-deploy-error-notify", name: "Vercel → Gateway: Deploy Error → Fix" },
  { event: "vercel/deploy.error" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const {
      deploymentId, deploymentUrl, projectName, target,
      gitCommitMessage, gitCommitAuthor, gitBranch, dashboardUrl,
    } = event.data;

    // 1. Notify gateway immediately — Joel knows it broke
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
        `Dispatching agent to diagnose and fix...`,
      ].join("\n");
    });

    const notifyResult = await step.run("notify-gateway", async () => {
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

    // 2. Dispatch agent to diagnose + fix the build
    const requestId = `vercel-fix-${deploymentId}-${Date.now()}`;
    const commitContext = gitCommitMessage
      ? `The failing commit: "${gitCommitMessage}" by ${gitCommitAuthor || "unknown"} on branch ${gitBranch || "main"}.`
      : "";

    await step.sendEvent("dispatch-fix-agent", {
      name: "system/agent.requested",
      data: {
        requestId,
        task: [
          `Vercel deploy failed for ${projectName || "joelclaw"}.`,
          commitContext,
          ``,
          `Debug sequence:`,
          `1. Run \`vercel inspect ${deploymentUrl || "latest"}\` to check status (timeout 10s)`,
          `2. Run \`cd ~/Code/joelhooks/joelclaw && npx turbo run build --filter=web 2>&1 | tail -60\` to reproduce locally`,
          `3. Identify the failure: lockfile mismatch, TypeScript error, missing dep, env var, etc.`,
          `4. Apply the fix. Common fixes:`,
          `   - Lockfile: \`pnpm install\` at monorepo root, commit pnpm-lock.yaml`,
          `   - TS error: fix the type error in the failing file`,
          `   - Missing dep: \`pnpm add <pkg> --filter web\`, commit lockfile`,
          `5. Commit with message "fix: <what you fixed> (auto-repair from deploy failure)"`,
          `6. Push to main: \`git push origin main\``,
          ``,
          `Do NOT modify system-bus code. Focus on apps/web and workspace-level issues.`,
          `If you can't reproduce or fix it, write a summary of what you found to ~/\\.joelclaw/workspace/inbox/${requestId}.json`,
        ].join("\n"),
        tool: "codex",
        cwd: "/Users/joel/Code/joelhooks/joelclaw",
        timeout: 300,
        sandbox: "danger-full-access",
      },
    });

    return {
      status: "dispatched",
      deploymentId,
      projectName,
      target,
      fixRequestId: requestId,
      notified: notifyResult.pushed ?? false,
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

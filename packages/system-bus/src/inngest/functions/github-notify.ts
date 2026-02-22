/**
 * GitHub webhook → gateway notification functions.
 */

import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

function shortSha(value: string): string {
  return value ? value.slice(0, 8) : "unknown";
}

export const githubWorkflowRunCompleted = inngest.createFunction(
  { id: "github-workflow-run-completed-notify", name: "GitHub → Gateway: Workflow Run Completed" },
  { event: "github/workflow_run.completed" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const {
      repository,
      workflowName,
      conclusion,
      status,
      event: trigger,
      branch,
      headSha,
      htmlUrl,
      actorLogin,
      runId,
      runNumber,
    } = event.data as Record<string, string | number | null | undefined>;

    const prompt = await step.run("build-prompt", () => {
      const ok = conclusion === "success";
      const icon = ok ? "✅" : "❌";
      const title = ok ? "Workflow Succeeded" : "Workflow Failed";

      return [
        `## ${icon} GitHub ${title}`,
        "",
        `**Repo**: ${repository || "unknown"}`,
        `**Workflow**: ${workflowName || "unknown"}`,
        `**Conclusion**: ${conclusion || status || "unknown"}`,
        `**Trigger**: ${trigger || "unknown"}`,
        `**Branch**: ${branch || "unknown"}`,
        `**SHA**: \`${shortSha(String(headSha ?? ""))}\``,
        `**Run**: #${runNumber || runId || "unknown"}`,
        `**Actor**: ${actorLogin || "unknown"}`,
        htmlUrl ? `**URL**: ${htmlUrl}` : "",
      ].filter(Boolean).join("\n");
    });

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false, reason: "no gateway context" };
      return gateway.notify("github.workflow_run.completed", {
        prompt,
        repository,
        workflowName,
        conclusion,
        status,
        trigger,
        branch,
        headSha,
        htmlUrl,
        actorLogin,
        runId,
        runNumber,
      });
    });

    return {
      status: result.pushed ? "notified" : "skipped",
      repository,
      workflowName,
      conclusion,
      runId,
      result,
    };
  },
);

export const githubPackagePublished = inngest.createFunction(
  { id: "github-package-published-notify", name: "GitHub → Gateway: Package Published" },
  { event: "github/package.published" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const {
      repository,
      packageName,
      packageType,
      versionName,
      versionHtmlUrl,
      sender,
    } = event.data as Record<string, string | undefined>;

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false, reason: "no gateway context" };
      return gateway.notify("github.package.published", {
        prompt: [
          "## 📦 GitHub Package Published",
          "",
          `**Repo**: ${repository || "unknown"}`,
          `**Package**: ${packageName || "unknown"} (${packageType || "unknown"})`,
          `**Version**: ${versionName || "unknown"}`,
          `**Sender**: ${sender || "unknown"}`,
          versionHtmlUrl ? `**URL**: ${versionHtmlUrl}` : "",
        ].filter(Boolean).join("\n"),
        repository,
        packageName,
        packageType,
        versionName,
        versionHtmlUrl,
        sender,
      });
    });

    return {
      status: result.pushed ? "notified" : "skipped",
      repository,
      packageName,
      versionName,
      result,
    };
  },
);

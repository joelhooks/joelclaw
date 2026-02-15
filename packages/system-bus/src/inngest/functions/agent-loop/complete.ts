import { inngest } from "../../client";
import { $ } from "bun";
import { mintGitHubToken } from "./utils";

/**
 * COMPLETER — Handles agent/loop.complete events.
 * Pushes the feature branch to remote when push is enabled.
 */
export const agentLoopComplete = inngest.createFunction(
  {
    id: "agent-loop-complete",
    retries: 2,
  },
  [{ event: "agent/loop.completed" }],
  async ({ event, step }) => {
    const { loopId, project, branchName, storiesCompleted, storiesFailed } = event.data;

    // Only push if branchName is present (set by planner v2)
    if (!branchName) {
      return { status: "no-branch", loopId };
    }

    // Push the feature branch using GitHub App token
    const pushResult = await step.run("push-branch", async () => {
      try {
        // Mint a fresh GitHub App token for push auth
        const token = await mintGitHubToken();

        // Get remote URL and inject token
        const remoteResult = await $`cd ${project} && git remote get-url origin`.quiet();
        let remoteUrl = remoteResult.text().trim();

        // Convert SSH to HTTPS if needed
        if (remoteUrl.startsWith("git@github.com:")) {
          remoteUrl = remoteUrl.replace("git@github.com:", "https://github.com/");
        }
        if (!remoteUrl.endsWith(".git")) remoteUrl += ".git";

        // Inject token into HTTPS URL
        const authUrl = remoteUrl.replace("https://", `https://x-access-token:${token}@`);

        // Push the branch
        await $`cd ${project} && git push ${authUrl} ${branchName}`.quiet();

        return "pushed";
      } catch (e: any) {
        const errorMsg = e?.message ?? e?.stderr?.toString() ?? "unknown push error";
        return `push_failed: ${errorMsg.slice(0, 500)}`;
      }
    });

    return {
      status: pushResult === "pushed" ? "pushed" : "push-failed",
      loopId,
      branchName,
      pushResult,
    };
  }
);

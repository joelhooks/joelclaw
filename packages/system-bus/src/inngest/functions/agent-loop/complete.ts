import { inngest } from "../../client";
import { $ } from "bun";
import { createLoopOnFailure, mintGitHubToken } from "./utils";

/**
 * COMPLETER — Handles agent/loop.complete events.
 * Merges the worktree branch back to main, then optionally pushes to remote.
 */
export const agentLoopComplete = inngest.createFunction(
  {
    id: "agent-loop-complete",
    onFailure: createLoopOnFailure("complete"),
    cancelOn: [
      {
        event: "agent/loop.cancelled",
        if: "event.data.loopId == async.data.loopId",
      },
    ],
  },
  [{ event: "agent/loop.completed" }],
  async ({ event, step }) => {
    const { loopId, project, branchName, storiesCompleted, storiesFailed, workDir } = event.data;

    // Only proceed if branchName is present (set by planner v2)
    if (!branchName) {
      return { status: "no-branch", loopId };
    }

    // Step 0: Clean loop artifacts from worktree before merge
    await step.run("clean-artifacts", async () => {
      const worktreePath = `/tmp/agent-loop/${loopId}`;
      try {
        // Delete __tests__/ dirs, *.acceptance.test.ts, *.out files, prd.json, progress.txt
        await $`cd ${worktreePath} && find . -name "__tests__" -type d -exec rm -rf {} + 2>/dev/null; find . -name "*.acceptance.test.ts" -delete 2>/dev/null; rm -f *.out prd.json progress.txt`.quiet().nothrow();
        // Commit cleanup if anything changed
        await $`cd ${worktreePath} && git add -A && git diff --cached --quiet || git commit -m "chore: clean loop artifacts"`.quiet().nothrow();
        return { cleaned: true };
      } catch {
        return { cleaned: false };
      }
    });

    // Step 1: Merge worktree branch back to main working directory
    const mergeResult = await step.run("merge-to-main", async () => {
      try {
        // Get the git root of the original project
        const gitRoot = (await $`cd ${project} && git rev-parse --show-toplevel`.quiet()).text().trim();

        // Check if there are any commits on the branch that aren't on main
        const currentBranch = (await $`cd ${gitRoot} && git branch --show-current`.quiet()).text().trim();
        const diffResult = await $`cd ${gitRoot} && git log ${currentBranch}..${branchName} --oneline`.quiet().nothrow();
        const commits = diffResult.text().trim();

        if (!commits) {
          return { merged: false, reason: "no_new_commits" };
        }

        // Stash any dirty state (PRD, progress.txt, etc.) before merge
        const hasChanges = (await $`cd ${gitRoot} && git status --porcelain`.quiet()).text().trim();
        const stashed = hasChanges.length > 0;
        if (stashed) {
          await $`cd ${gitRoot} && git stash --include-untracked`.quiet().nothrow();
        }

        // Merge the worktree branch into the current branch
        const merge = await $`cd ${gitRoot} && git merge ${branchName} --no-edit`.quiet().nothrow();

        if (merge.exitCode !== 0) {
          // Merge conflict — abort and restore stash
          await $`cd ${gitRoot} && git merge --abort`.quiet().nothrow();
          if (stashed) await $`cd ${gitRoot} && git stash pop`.quiet().nothrow();
          return {
            merged: false,
            reason: "merge_conflict",
            error: merge.stderr?.toString()?.slice(0, 500),
          };
        }

        // Restore stashed changes
        if (stashed) {
          await $`cd ${gitRoot} && git stash pop`.quiet().nothrow();
        }

        return {
          merged: true,
          branch: branchName,
          into: currentBranch,
          commits: commits.split("\n").length,
          stashed,
        };
      } catch (e: any) {
        return { merged: false, reason: "error", error: e?.message?.slice(0, 500) };
      }
    });

    // Step 2: Clean up worktree
    const cleanupResult = await step.run("cleanup-worktree", async () => {
      try {
        const gitRoot = (await $`cd ${project} && git rev-parse --show-toplevel`.quiet()).text().trim();
        const worktreePath = `/tmp/agent-loop/${loopId}`;
        await $`cd ${gitRoot} && git worktree remove ${worktreePath} --force`.quiet().nothrow();
        // Delete the branch too (it's merged now)
        if (mergeResult.merged) {
          await $`cd ${gitRoot} && git branch -d ${branchName}`.quiet().nothrow();
        }
        return { cleaned: true };
      } catch {
        return { cleaned: false };
      }
    });

    // Step 3: Sync worker clone (if merge succeeded)
    // The worker runs from a separate clone (~/Code/system-bus-worker/) for stability —
    // editing the monorepo during sessions won't break the running worker.
    // After merging to monorepo, pull changes into the worker clone and restart it.
    let syncResult: { synced: boolean; error?: string } = { synced: false };
    if (mergeResult.merged) {
      syncResult = await step.run("sync-worker-clone", async () => {
        try {
          const workerRoot = `${process.env.HOME}/Code/system-bus-worker`;
          // Pull from monorepo (worker's origin)
          const pull = await $`cd ${workerRoot} && git pull --ff-only`.quiet().nothrow();
          if (pull.exitCode !== 0) {
            // If not fast-forward, force-sync worker clone from origin/main
            await $`cd ${workerRoot} && git fetch origin && git reset --hard origin/main && git clean -fd`
              .quiet()
              .nothrow();
          }
          // Install deps in case new packages were added
          await $`cd ${workerRoot} && bun install --silent`.quiet().nothrow();
          // Restart worker via launchctl
          const uid = (await $`id -u`.quiet()).text().trim();
          await $`launchctl kickstart -k gui/${uid}/com.joel.system-bus-worker`.quiet().nothrow();
          return { synced: true };
        } catch (e: any) {
          return { synced: false, error: e?.message?.slice(0, 500) };
        }
      });
    }

    // Step 4: Push to remote (if merge succeeded)
    let pushResult: string = "skipped";
    if (mergeResult.merged) {
      pushResult = await step.run("push-to-remote", async () => {
        try {
          const token = await mintGitHubToken();
          const remoteResult = await $`cd ${project} && git remote get-url origin`.quiet();
          let remoteUrl = remoteResult.text().trim();

          if (remoteUrl.startsWith("git@github.com:")) {
            remoteUrl = remoteUrl.replace("git@github.com:", "https://github.com/");
          }
          if (!remoteUrl.endsWith(".git")) remoteUrl += ".git";

          const authUrl = remoteUrl.replace("https://", `https://x-access-token:${token}@`);
          const currentBranch = (await $`cd ${project} && git branch --show-current`.quiet()).text().trim();
          await $`cd ${project} && git push ${authUrl} ${currentBranch}`.quiet();

          return "pushed";
        } catch (e: any) {
          const errorMsg = e?.message ?? e?.stderr?.toString() ?? "unknown push error";
          return `push_failed: ${errorMsg.slice(0, 500)}`;
        }
      });
    }

    return {
      status: mergeResult.merged ? "merged" : "merge-failed",
      loopId,
      branchName,
      mergeResult,
      cleanupResult,
      syncResult,
      pushResult,
    };
  }
);

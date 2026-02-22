/**
 * Vault git sync check — push if dirty, alert if diverged.
 * Only notifies gateway on problems (dirty + unpushed, divergence).
 */

import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TERM: "dumb" },
  });
  const [stdout, stderr, code] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), ok: code === 0 };
}

export const checkVaultSync = inngest.createFunction(
  { id: "check/vault-sync", concurrency: { limit: 1 }, retries: 1 },
  { event: "vault/sync.check" },
  async ({ step }) => {
    const vaultPath = `${process.env.HOME ?? "/Users/joel"}/Vault`;

    const state = await step.run("check-git-status", async (): Promise<{
      error?: string;
      dirty: boolean;
      dirtyCount: number;
      unpushed: number;
      behind: number;
      diverged: boolean;
    }> => {
      const status = await git(["status", "--porcelain"], vaultPath);
      if (!status.ok) {
        return {
          error: status.stderr,
          dirty: false,
          dirtyCount: 0,
          unpushed: 0,
          behind: 0,
          diverged: false,
        };
      }

      const dirty = status.stdout.length > 0;
      const dirtyCount = dirty ? status.stdout.split("\n").filter(Boolean).length : 0;

      // Check for unpushed commits
      const log = await git(["log", "origin/main..HEAD", "--oneline"], vaultPath);
      const unpushed = log.ok ? log.stdout.split("\n").filter(Boolean).length : 0;

      // Check for divergence
      await git(["fetch", "--dry-run"], vaultPath);
      const diverge = await git(["rev-list", "--left-right", "--count", "HEAD...origin/main"], vaultPath);
      const behind = diverge.ok ? parseInt(diverge.stdout.split("\t")[1] ?? "0", 10) : 0;

      return { dirty, dirtyCount, unpushed, behind, diverged: behind > 0 };
    });

    if ("error" in state && state.error) {
      return { status: "error", reason: state.error };
    }

    // Auto-commit and push if dirty
    if (state.dirty) {
      const pushed = await step.run("auto-commit-push", async () => {
        const add = await git(["add", "-A"], vaultPath);
        if (!add.ok) return { ok: false, reason: add.stderr };

        const commit = await git(["commit", "-m", "vault: auto-sync from heartbeat"], vaultPath);
        if (!commit.ok) return { ok: false, reason: commit.stderr };

        const push = await git(["push", "origin", "main"], vaultPath);
        return { ok: push.ok, reason: push.ok ? undefined : push.stderr };
      });

      if (!pushed.ok) {
        await step.run("notify-push-failed", async () => {
          await pushGatewayEvent({
            type: "vault.sync.failed",
            source: "inngest/check-vault-sync",
            payload: {
              prompt: `## ⚠️ Vault Push Failed\n\n${state.dirtyCount} dirty files couldn't be pushed: ${pushed.reason}\n\nManual fix: \`cd ~/Vault && git push origin main\``,
            },
          });
        });
        return { status: "push-failed", reason: pushed.reason };
      }

      // NOOP: auto-pushed silently, no need to bother Joel
      return { status: "auto-pushed", filesCommitted: state.dirtyCount };
    }

    // Alert on divergence (upstream has commits we don't)
    if (state.diverged) {
      await step.run("notify-diverged", async () => {
        await pushGatewayEvent({
          type: "vault.sync.diverged",
          source: "inngest/check-vault-sync",
          payload: {
            prompt: `## ⚠️ Vault Diverged\n\nVault is ${state.behind} commit(s) behind origin/main.\n\nFix: \`cd ~/Vault && git pull --rebase origin main\``,
          },
        });
      });
      return { status: "diverged", behind: state.behind };
    }

    // NOOP: clean and in sync
    return { status: "noop" };
  }
);

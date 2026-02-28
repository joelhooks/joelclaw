import { join } from "node:path";
import Redis from "ioredis";
import { upsertFiles } from "../../lib/convex-content-sync";
import { infer } from "../../lib/inference";
import { getRedisPort } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";
import { type SyncResult, syncFiles } from "./vault-sync";

/**
 * Content directories to sync from Vault → website.
 * Add new entries here as content types grow.
 */
const CONTENT_DIRS = [
  {
    name: "adrs",
    source: "/Users/joel/Vault/docs/decisions/",
    dest: "/Users/joel/Code/joelhooks/joelclaw/apps/web/content/adrs/",
    skipFiles: ["readme.md"],
  },
  {
    name: "discoveries",
    source: "/Users/joel/Vault/Resources/discoveries/",
    dest: "/Users/joel/Code/joelhooks/joelclaw/apps/web/content/discoveries/",
    skipFiles: [],
  },
] as const;

const CHANGES_NOT_COMMITTED_LAST_NOTIFIED_KEY =
  "content-sync:changes_not_committed:last_notified";
const CHANGES_NOT_COMMITTED_NOTIFY_COOLDOWN_SECONDS = 6 * 60 * 60;

type ContentSyncResult = {
  name: string;
  sourceCount: number;
  synced: SyncResult["synced"];
};

/**
 * Unified content sync — one function, one commit for all Vault → website content.
 *
 * Triggers:
 * - Hourly cron (safety net)
 * - discovery/captured (after discovery-capture writes a vault note)
 * - system/adr.sync.requested (after ADR edits)
 *
 * All content directories are synced in a single pass with one git commit.
 * Concurrency limit prevents races on the git repo.
 */
export const contentSync = inngest.createFunction(
  {
    id: "system/content-sync",
    retries: 1,
    concurrency: { limit: 1, key: "content-sync" },
    debounce: { period: "45s", timeout: "3m", key: '"vault-sync"' },
  },
  [
    { cron: "0 * * * *" },
    { event: "content/updated" },
    { event: "discovery/captured" },
    { event: "system/adr.sync.requested" },
  ],
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as import("../middleware/gateway").GatewayContext | undefined;
    console.log(
      `[content-sync] started via ${event.name} at ${new Date().toISOString()}`
    );
    await step.run("otel-content-sync-start", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "content-sync",
        action: "content_sync.started",
        success: true,
        metadata: {
          trigger: event.name,
          directoryCount: CONTENT_DIRS.length,
        },
      });
    });

    // Sync all content directories in one step
    const results: ContentSyncResult[] = await step.run(
      "sync-all-content",
      async () => {
        const out: ContentSyncResult[] = [];

        for (const dir of CONTENT_DIRS) {
          const result = await syncFiles(dir.source, dir.dest, {
            skipFiles: dir.skipFiles as unknown as string[],
          });
          out.push({
            name: dir.name,
            sourceCount: result.sourceCount,
            synced: result.synced,
          });
        }

        return out;
      }
    );

    const allSynced = results.flatMap((r) => r.synced);
    let committed = false;

    if (allSynced.length > 0) {
      committed = await step.run("git-commit-push", () => {
        const lines = results
          .filter((r) => r.synced.length > 0)
          .map((r) => {
            const files = r.synced
              .map((s) => `  ${s.status}: ${s.file}`)
              .join("\n");
            return `${r.name} (${r.synced.length}):\n${files}`;
          })
          .join("\n");

        // Stage all content directories
        const gitPaths = CONTENT_DIRS.map(
          (d) =>
            d.dest.replace(
              "/Users/joel/Code/joelhooks/joelclaw/",
              ""
            )
        );

        // commitAndPush stages the first path; stage all paths manually
        return commitAndPushMultiple(
          gitPaths,
          `sync: vault content (${allSynced.length} files)\n\n${lines}`
        );
      });
    }

    // Log summary
    for (const r of results) {
      if (r.synced.length > 0) {
        console.log(
          `[content-sync] ${r.name}: ${r.synced.length} changed`
        );
      }
    }
    console.log(
      `[content-sync] done — ${allSynced.length} total changes, committed=${committed}`
    );

    // ── Sync changed files to Convex ──────────────────────
    // Production site reads from Convex, not filesystem. Without this step,
    // new ADRs/posts are committed to git but invisible on the live site.
    let convexResult: { adrUpserts: number; postUpserts: number; errors: string[] } | undefined;
    if (allSynced.length > 0) {
      convexResult = await step.run("sync-to-convex", async () => {
        // Build full file paths for changed files
        const changedPaths: string[] = [];
        for (const r of results) {
          const dir = CONTENT_DIRS.find((d) => d.name === r.name);
          if (!dir) continue;
          for (const s of r.synced) {
            if (s.status === "deleted") continue; // can't upsert deleted files
            changedPaths.push(join(dir.dest, s.file));
          }
        }

        if (changedPaths.length === 0) {
          return { adrUpserts: 0, postUpserts: 0, errors: [] };
        }

        console.log(`[content-sync] upserting ${changedPaths.length} files to Convex`);
        const result = await upsertFiles(changedPaths);
        console.log(
          `[content-sync] Convex sync: ${result.adrUpserts} ADRs, ${result.postUpserts} posts, ${result.errors.length} errors`
        );
        if (result.errors.length > 0) {
          console.warn("[content-sync] Convex errors:", result.errors);
        }
        return result;
      });
    }

    // Notify gateway if anything changed
    if (allSynced.length > 0 && gateway) {
      await step.run("notify-gateway", async () => {
        try {
          const summary = results
            .filter((r) => r.synced.length > 0)
            .map((r) => `${r.name}: ${r.synced.length}`)
            .join(", ");
          await gateway.notify("content.synced", {
            files: allSynced.length,
            committed,
            summary,
            convex: convexResult
              ? `${convexResult.adrUpserts} ADRs, ${convexResult.postUpserts} posts`
              : "skipped",
          });
        } catch {}
      });
    }
    await step.run("otel-content-sync-finish", async () => {
      const commitSkipped = allSynced.length > 0 && !committed;
      let commitSkippedNotificationSuppressed = false;
      if (commitSkipped) {
        const redis = new Redis({
          host: process.env.REDIS_HOST ?? "localhost",
          port: getRedisPort(),
          lazyConnect: true,
          connectTimeout: 3000,
        });
        redis.on("error", () => {});

        try {
          const lastNotified = await redis.get(CHANGES_NOT_COMMITTED_LAST_NOTIFIED_KEY);
          commitSkippedNotificationSuppressed = Boolean(lastNotified);

          if (!commitSkippedNotificationSuppressed) {
            await redis.set(
              CHANGES_NOT_COMMITTED_LAST_NOTIFIED_KEY,
              new Date().toISOString(),
              "EX",
              CHANGES_NOT_COMMITTED_NOTIFY_COOLDOWN_SECONDS,
            );
          }
        } finally {
          redis.disconnect();
        }
      }

      const level = commitSkipped && !commitSkippedNotificationSuppressed ? "warn" : "info";
      await emitOtelEvent({
        level,
        source: "worker",
        component: "content-sync",
        action: "content_sync.completed",
        success: true,
        error: commitSkipped && !commitSkippedNotificationSuppressed ? "changes_not_committed" : undefined,
        metadata: {
          trigger: event.name,
          totalSynced: allSynced.length,
          committed,
          commitSkipped,
          commitSkippedNotificationSuppressed,
          content: results.map((result) => ({
            name: result.name,
            syncedCount: result.synced.length,
          })),
        },
      });
    });

    return {
      status: "completed",
      committed,
      totalSynced: allSynced.length,
      convex: convexResult ?? null,
      content: results.map((r) => ({
        name: r.name,
        sourceCount: r.sourceCount,
        syncedCount: r.synced.length,
        new: r.synced.filter((s) => s.status === "new").map((s) => s.file),
        updated: r.synced
          .filter((s) => s.status === "updated")
          .map((s) => s.file),
        deleted: r.synced
          .filter((s) => s.status === "deleted")
          .map((s) => s.file),
      })),
    };
  }
);

/**
 * Stage multiple paths, commit, and push. Skips if nothing staged.
 */
async function commitAndPushMultiple(
  paths: string[],
  message: string
): Promise<boolean> {
  const { git } = await import("./vault-sync");

  for (const p of paths) {
    await git("add", p);
  }

  // Check if anything is actually staged
  const diffProc = Bun.spawn(["git", "diff", "--cached", "--quiet"], {
    cwd: "/Users/joel/Code/joelhooks/joelclaw/",
  });
  const clean = (await diffProc.exited) === 0;

  if (clean) {
    console.log("[content-sync] nothing staged, skipping commit");
    return false;
  }

  // Safety gate: haiku agent reviews the diff before pushing.
  // Ensures only content (markdown/MDX/frontmatter) reaches origin — never code.
  const safe = await reviewDiffBeforePush();
  if (!safe) {
    // Unstage and reset — don't leave dirty staged state
    const resetProc = Bun.spawn(["git", "reset", "HEAD"], {
      cwd: REPO_ROOT,
    });
    await resetProc.exited;
    console.log("[content-sync] ⛔ push blocked by safety review — diff contained non-content changes");
    return false;
  }

  await git("commit", "-m", message);
  await git("push", "origin", "main");
  return true;
}

const REPO_ROOT = "/Users/joel/Code/joelhooks/joelclaw/";

const SAFETY_SYSTEM_PROMPT = `You are a git push safety gate for a content sync pipeline.

Your job: review a git diff and determine if it contains ONLY content changes.

SAFE to push (reply YES):
- Markdown (.md) file additions, deletions, modifications
- MDX (.mdx) file additions, deletions, modifications
- YAML frontmatter changes inside .md/.mdx files
- New content files in apps/web/content/ or similar content directories
- .base files (Obsidian database views)

NOT safe to push (reply NO):
- TypeScript (.ts, .tsx) changes
- JavaScript (.js, .jsx) changes
- JSON config files (package.json, tsconfig.json, etc.)
- Lock files (bun.lockb, pnpm-lock.yaml)
- Any file outside content directories that isn't markdown
- Build/config changes of any kind

Reply with exactly one line: YES or NO followed by a brief reason.
Example: "YES — 3 markdown files in apps/web/content/adrs/, frontmatter only"
Example: "NO — includes changes to packages/system-bus/src/inngest/functions/observe.ts"`;

/**
 * Pipe staged diff to Claude Haiku for content-only verification.
 * Returns true if safe to push, false if blocked.
 */
async function reviewDiffBeforePush(): Promise<boolean> {
  try {
    // Get the staged diff stat + file list (compact, cheap tokens)
    const statProc = Bun.spawn(
      ["git", "diff", "--cached", "--stat", "--name-only"],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" }
    );
    const diffStat = await new Response(statProc.stdout).text();
    await statProc.exited;

    if (!diffStat.trim()) return true; // nothing staged

    const safetyModel = "anthropic/claude-haiku";

    const { text: stdout } = await infer(
      `Review this staged git diff for content-only safety:\n\n${diffStat.trim()}`,
      {
        task: "classification",
        model: safetyModel,
        system: SAFETY_SYSTEM_PROMPT,
        component: "content-sync",
        action: "content-sync.safety.review",
        noTools: true,
        print: true,
      }
    );
    if (!stdout.trim()) {
      console.log("[content-sync] safety review returned empty output, blocking push");
      return false;
    }
    const sanitizedStdout = stdout.trim();
    const safe = sanitizedStdout.toUpperCase().startsWith("YES");

    console.log(`[content-sync] safety review: ${sanitizedStdout}`);
    return safe;
  } catch (err) {
    console.log(`[content-sync] safety review error: ${err}, blocking push`);
    return false;
  }
}

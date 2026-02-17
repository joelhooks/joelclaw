import { inngest } from "../client";
import { syncFiles, commitAndPush, type SyncResult } from "./vault-sync";

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
    debounce: { period: "5s", key: '"vault-sync"' },
  },
  [
    { cron: "0 * * * *" },
    { event: "content/updated" },
    { event: "discovery/captured" },
    { event: "system/adr.sync.requested" },
  ],
  async ({ event, step }) => {
    console.log(
      `[content-sync] started via ${event.name} at ${new Date().toISOString()}`
    );

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

    return {
      status: "completed",
      committed,
      totalSynced: allSynced.length,
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

  await git("commit", "-m", message);
  await git("push");
  return true;
}

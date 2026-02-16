import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inngest } from "../client";

const DISCOVERY_SOURCE_DIR = "/Users/joel/Vault/Resources/discoveries/";
const DISCOVERY_DEST_DIR =
  "/Users/joel/Code/joelhooks/joelclaw/apps/web/content/discoveries/";
const MONOREPO_ROOT = "/Users/joel/Code/joelhooks/joelclaw/";

type SyncedFile = {
  file: string;
  status: "new" | "updated";
};

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runGitCommand(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: MONOREPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: process.env.HOME },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with exit ${exitCode}\n${stderr || stdout}`
    );
  }

  return stdout.trim();
}

/**
 * Discovery Sync — copies discovery notes from Vault to the website content dir.
 *
 * Triggers after discovery-capture completes (via discovery/captured event)
 * and on an hourly cron as a safety net.
 */
export const discoverySync = inngest.createFunction(
  {
    id: "system/discovery-sync",
    retries: 1,
  },
  [{ cron: "0 * * * *" }, { event: "discovery/captured" }],
  async ({ event, step }) => {
    console.log(
      `[discovery-sync] started via ${event.name} at ${new Date().toISOString()}`
    );

    const sourceFiles = await step.run("list-source-discoveries", async () => {
      const entries = await readdir(DISCOVERY_SOURCE_DIR, {
        withFileTypes: true,
      });

      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort();

      console.log(
        `[discovery-sync] found ${files.length} source discovery files`
      );
      return files;
    });

    const syncResult = await step.run(
      "sync-new-and-updated-discoveries",
      async () => {
        await mkdir(DISCOVERY_DEST_DIR, { recursive: true });

        const synced: SyncedFile[] = [];

        for (const fileName of sourceFiles) {
          const sourcePath = join(DISCOVERY_SOURCE_DIR, fileName);
          const destPath = join(DISCOVERY_DEST_DIR, fileName);

          const sourceContent = await readFile(sourcePath);
          const sourceHash = sha256(sourceContent);

          let status: SyncedFile["status"] | null = null;
          const destExists = await exists(destPath);

          if (!destExists) {
            status = "new";
          } else {
            const destContent = await readFile(destPath);
            const destHash = sha256(destContent);
            if (sourceHash !== destHash) {
              status = "updated";
            }
          }

          if (status) {
            await writeFile(destPath, sourceContent);
            synced.push({ file: fileName, status });
          }
        }

        return {
          sourceCount: sourceFiles.length,
          synced,
        };
      }
    );

    if (syncResult.synced.length > 0) {
      await step.run("git-add-commit-push", async () => {
        await runGitCommand(["add", "apps/web/content/discoveries/"]);
        await runGitCommand([
          "commit",
          "-m",
          "sync: update discoveries from Vault",
        ]);
        await runGitCommand(["push"]);
      });
    }

    const newFiles = syncResult.synced
      .filter((item) => item.status === "new")
      .map((item) => item.file);
    const updatedFiles = syncResult.synced
      .filter((item) => item.status === "updated")
      .map((item) => item.file);

    console.log(
      `[discovery-sync] synced ${syncResult.synced.length} file(s)`
    );
    if (newFiles.length > 0) {
      console.log(`[discovery-sync] new: ${newFiles.join(", ")}`);
    }
    if (updatedFiles.length > 0) {
      console.log(`[discovery-sync] updated: ${updatedFiles.join(", ")}`);
    }

    return {
      status: "completed",
      sourceCount: syncResult.sourceCount,
      syncedCount: syncResult.synced.length,
      newFiles,
      updatedFiles,
    };
  }
);

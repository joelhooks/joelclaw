import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inngest } from "../client";

const ADR_SOURCE_DIR = "/Users/joel/Vault/docs/decisions/";
const ADR_DEST_DIR =
  "/Users/joel/Code/joelhooks/joelclaw/apps/web/content/adrs/";
const MONOREPO_ROOT = "/Users/joel/Code/joelhooks/joelclaw/";

type SyncedAdr = {
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

export const adrSync = inngest.createFunction(
  {
    id: "system/adr-sync",
    retries: 1,
  },
  [{ cron: "0 * * * *" }, { event: "system/adr.sync.requested" }],
  async ({ event, step }) => {
    console.log(
      `[adr-sync] started via ${event.name} at ${new Date().toISOString()}`
    );

    const sourceFiles = await step.run("list-source-adrs", async () => {
      const entries = await readdir(ADR_SOURCE_DIR, { withFileTypes: true });

      const files = entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".md") &&
            entry.name.toLowerCase() !== "readme.md"
        )
        .map((entry) => entry.name)
        .sort();

      console.log(`[adr-sync] found ${files.length} source ADR files`);
      return files;
    });

    const syncResult = await step.run("sync-new-and-updated-adrs", async () => {
      await mkdir(ADR_DEST_DIR, { recursive: true });

      const synced: SyncedAdr[] = [];

      for (const fileName of sourceFiles) {
        const sourcePath = join(ADR_SOURCE_DIR, fileName);
        const destPath = join(ADR_DEST_DIR, fileName);

        const sourceContent = await readFile(sourcePath);
        const sourceHash = sha256(sourceContent);

        let status: SyncedAdr["status"] | null = null;
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
    });

    if (syncResult.synced.length > 0) {
      await step.run("git-add-commit-push", async () => {
        await runGitCommand(["add", "apps/web/content/adrs/"]);
        await runGitCommand([
          "commit",
          "-m",
          "sync: update ADRs from Vault",
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

    console.log(`[adr-sync] synced ${syncResult.synced.length} ADR file(s)`);
    console.log(`[adr-sync] new: ${newFiles.length} | updated: ${updatedFiles.length}`);
    if (newFiles.length > 0) {
      console.log(`[adr-sync] new files: ${newFiles.join(", ")}`);
    }
    if (updatedFiles.length > 0) {
      console.log(`[adr-sync] updated files: ${updatedFiles.join(", ")}`);
    }

    return {
      status: "completed",
      sourceCount: syncResult.sourceCount,
      syncedCount: syncResult.synced.length,
      newFiles,
      updatedFiles,
      synced: syncResult.synced,
    };
  }
);

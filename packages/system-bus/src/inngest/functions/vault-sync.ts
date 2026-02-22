/**
 * Shared utilities for Vault → website content sync functions.
 *
 * Both adr-sync and discovery-sync copy markdown files from the Vault
 * to the monorepo's web content directory, then commit + push if anything changed.
 * This module extracts the common patterns.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const MONOREPO_ROOT = "/Users/joel/Code/joelhooks/joelclaw/";

export type SyncedFile = {
  file: string;
  status: "new" | "updated" | "deleted";
};

export type SyncResult = {
  sourceCount: number;
  synced: SyncedFile[];
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

/**
 * Run a git command in the monorepo root. Throws on non-zero exit.
 */
export async function git(...args: string[]): Promise<string> {
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
 * Sync markdown files from a Vault source directory to a web content destination.
 * Returns which files were added, updated, or deleted.
 *
 * - Copies new/changed .md files from source → dest
 * - Removes .md files in dest that no longer exist in source
 * - Skips non-.md files and README.md
 */
export async function syncFiles(
  sourceDir: string,
  destDir: string,
  opts: { skipFiles?: string[] } = {}
): Promise<SyncResult> {
  const skipSet = new Set(
    (opts.skipFiles ?? ["readme.md"]).map((f) => f.toLowerCase())
  );

  await mkdir(destDir, { recursive: true });

  // List source files
  const sourceEntries = await readdir(sourceDir, { withFileTypes: true });
  const sourceFileNames = sourceEntries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".md") &&
        !skipSet.has(e.name.toLowerCase())
    )
    .map((e) => e.name);

  const sourceSet = new Set(sourceFileNames);
  const synced: SyncedFile[] = [];

  // Copy new/updated files
  for (const fileName of sourceFileNames) {
    const sourcePath = join(sourceDir, fileName);
    const destPath = join(destDir, fileName);

    const sourceContent = await readFile(sourcePath);
    const sourceHash = sha256(sourceContent);

    const destExists = await exists(destPath);

    if (!destExists) {
      await writeFile(destPath, sourceContent);
      synced.push({ file: fileName, status: "new" });
    } else {
      const destContent = await readFile(destPath);
      if (sha256(destContent) !== sourceHash) {
        await writeFile(destPath, sourceContent);
        synced.push({ file: fileName, status: "updated" });
      }
    }
  }

  // Remove files in dest that no longer exist in source
  const destEntries = await readdir(destDir, { withFileTypes: true });
  for (const entry of destEntries) {
    if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      !skipSet.has(entry.name.toLowerCase()) &&
      !sourceSet.has(entry.name)
    ) {
      await unlink(join(destDir, entry.name));
      synced.push({ file: entry.name, status: "deleted" });
    }
  }

  return { sourceCount: sourceFileNames.length, synced };
}

/**
 * Stage, commit, and push changes for a content subdirectory.
 * Gracefully skips if nothing is staged (handles retry/race conditions).
 * Returns true if a commit was made, false if skipped.
 */
export async function commitAndPush(
  contentPath: string,
  commitMessage: string
): Promise<boolean> {
  await git("add", contentPath);

  // Check if anything is actually staged — guards against memoized step
  // results on Inngest retries when another concurrent run already committed
  const diffProc = Bun.spawn(["git", "diff", "--cached", "--quiet"], {
    cwd: MONOREPO_ROOT,
  });
  const clean = (await diffProc.exited) === 0;

  if (clean) {
    return false;
  }

  await git("commit", "-m", commitMessage);
  await git("push", "origin", "main");
  return true;
}

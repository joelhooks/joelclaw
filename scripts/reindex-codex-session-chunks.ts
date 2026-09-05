#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { reindexCodexSessionChunks } from "../packages/memory/src/codex-reindex";

export const resolveReindexPaths = (
  args: readonly string[],
  env: Record<string, string | undefined>,
  home: string,
  now = new Date(),
) => {
  const option = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return resolve(index >= 0 && args[index + 1] ? args[index + 1]! : fallback);
  };
  const databasePath = option(
    "--db",
    env.SESSION_INDEX_PATH ??
      env.JOELCLAW_SESSIONS_DB ??
      join(home, ".joelclaw", "search", "sessions.db"),
  );
  return {
    databasePath,
    runStorePath: option(
      "--run-store",
      env.MEMORY_RUN_STORE ?? join(home, ".joelclaw", "runs-dev"),
    ),
    backupPath: option(
      "--backup",
      `${databasePath}.pre-codex-reindex-${now.toISOString().replaceAll(":", "-")}`,
    ),
  };
};

export const backupSessionIndex = (databasePath: string, backupPath: string) => {
  if (existsSync(backupPath)) throw new Error("codex session reindex failed: backup-exists");
  const parent = dirname(backupPath);
  const parentExisted = existsSync(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!parentExisted) chmodSync(parent, 0o700);
  const stagingDirectory = join(parent, `.codex-reindex-${randomUUID()}`);
  const stagedBackup = join(stagingDirectory, "sessions.db");
  mkdirSync(stagingDirectory, { mode: 0o700 });
  try {
    const db = new Database(databasePath, { strict: true });
    try {
      db.exec(`VACUUM INTO '${stagedBackup.replaceAll("'", "''")}'`);
    } finally {
      db.close(false);
    }
    chmodSync(stagedBackup, 0o600);
    renameSync(stagedBackup, backupPath);
  } finally {
    if (existsSync(stagedBackup)) unlinkSync(stagedBackup);
    rmdirSync(stagingDirectory);
  }
  const backup = new Database(backupPath, { readonly: true, strict: true });
  try {
    const integrity = backup.query("PRAGMA integrity_check").get() as {
      integrity_check?: string;
    } | null;
    if (integrity?.integrity_check !== "ok") {
      throw new Error("codex session reindex failed: backup-integrity");
    }
  } finally {
    backup.close(false);
  }
  return createHash("sha256").update(readFileSync(backupPath)).digest("hex");
};

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const apply = args.includes("--apply");
  const confirmed = args.includes("--yes");
  const { backupPath, databasePath, runStorePath } = resolveReindexPaths(
    args,
    process.env,
    homedir(),
  );
  try {
    if (apply && !confirmed) {
      throw new Error("codex session reindex failed: confirmation-required");
    }
    const preview = reindexCodexSessionChunks({ databasePath, runStorePath });
    if (!apply) {
      console.log(
        JSON.stringify({
          ok: true,
          mode: "dry-run",
          action: "memory.codex_session_chunks.reindex",
          ...preview,
        }),
      );
    } else {
      const backupSha256 = backupSessionIndex(databasePath, backupPath);
      const receipt = reindexCodexSessionChunks({
        databasePath,
        runStorePath,
        apply: true,
      });
      console.log(
        JSON.stringify({
          ok: true,
          mode: "apply",
          action: "memory.codex_session_chunks.reindex",
          ...receipt,
          backup: {
            filename: basename(backupPath),
            sha256: backupSha256,
          },
        }),
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    const code =
      /^codex session reindex failed: ([a-z0-9-]+)$/u.exec(detail)?.[1] ??
      "reindex-failed";
    console.error(
      JSON.stringify({
        ok: false,
        action: "memory.codex_session_chunks.reindex",
        error: code,
      }),
    );
    process.exitCode = 1;
  }
}

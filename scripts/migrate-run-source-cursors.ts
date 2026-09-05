#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

interface Candidate {
  readonly run_id: string;
  readonly started_at: number;
}

export interface SourceCursorMigrationReceipt {
  readonly applied: boolean;
  readonly scanned_metadata: number;
  readonly eligible_cursors: number;
  readonly duplicate_metadata: number;
  readonly sidecars_planned: number;
  readonly sidecars_created: number;
  readonly sidecars_existing: number;
  readonly conflicts: number;
  readonly invalid: number;
  readonly users_ready: number;
}

const cursorKey = (sourceIdentity: string, fromOffset: number) =>
  createHash("sha256")
    .update(JSON.stringify([sourceIdentity, fromOffset]))
    .digest("hex");

const writeAtomic = (filePath: string, value: unknown) => {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The atomic rename either completed or left no durable artifact.
    }
  }
};

const installSidecar = (filePath: string, candidate: Candidate): "created" | "existing" => {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(candidate)}\n`, { mode: 0o600 });
  try {
    linkSync(temporaryPath, filePath);
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "existing";
    throw error;
  } finally {
    unlinkSync(temporaryPath);
  }
};

export function migrateRunSourceCursors(input: {
  readonly runStorePath: string;
  readonly apply?: boolean;
  readonly now?: () => number;
}): SourceCursorMigrationReceipt {
  const runStorePath = resolve(input.runStorePath);
  const apply = input.apply === true;
  const now = input.now ?? Date.now;
  const users = readdirSync(runStorePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  let scannedMetadata = 0;
  let eligibleCursors = 0;
  let duplicateMetadata = 0;
  let sidecarsPlanned = 0;
  let sidecarsCreated = 0;
  let sidecarsExisting = 0;
  let conflicts = 0;
  let invalid = 0;
  let usersReady = 0;

  for (const userId of users) {
    const userRoot = join(runStorePath, userId);
    const candidates = new Map<string, Candidate>();
    let userInvalid = 0;
    const months = readdirSync(userRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const month of months) {
      const monthPath = join(userRoot, month);
      for (const name of readdirSync(monthPath).sort()) {
        if (!name.endsWith(".metadata.json")) continue;
        scannedMetadata += 1;
        const metadataPath = join(monthPath, name);
        let metadata: {
          from_offset?: unknown;
          run_id?: unknown;
          source_identity?: unknown;
          started_at?: unknown;
        };
        try {
          if (!lstatSync(metadataPath).isFile()) throw new Error("not-regular");
          metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as typeof metadata;
        } catch {
          invalid += 1;
          userInvalid += 1;
          continue;
        }
        const hasCursorField =
          metadata.source_identity !== undefined || metadata.from_offset !== undefined;
        if (!hasCursorField) continue;
        if (
          typeof metadata.source_identity !== "string" ||
          !/^sha256:[0-9a-f]{64}$/u.test(metadata.source_identity) ||
          !Number.isSafeInteger(metadata.from_offset) ||
          Number(metadata.from_offset) < 0 ||
          typeof metadata.run_id !== "string" ||
          metadata.run_id.length === 0 ||
          !Number.isSafeInteger(metadata.started_at)
        ) {
          invalid += 1;
          userInvalid += 1;
          continue;
        }
        const key = cursorKey(metadata.source_identity, Number(metadata.from_offset));
        const candidate = {
          run_id: metadata.run_id,
          started_at: Number(metadata.started_at),
        };
        const existing = candidates.get(key);
        if (existing) duplicateMetadata += 1;
        if (
          existing === undefined ||
          candidate.started_at < existing.started_at ||
          (candidate.started_at === existing.started_at &&
            candidate.run_id.localeCompare(existing.run_id) < 0)
        ) {
          candidates.set(key, candidate);
        }
      }
    }

    eligibleCursors += candidates.size;
    let userConflicts = 0;
    for (const [key, candidate] of candidates) {
      const sidecarPath = join(userRoot, ".source-cursors", `${key}.json`);
      try {
        const existing = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
          run_id?: unknown;
          started_at?: unknown;
        };
        if (
          existing.run_id !== candidate.run_id ||
          existing.started_at !== candidate.started_at
        ) {
          conflicts += 1;
          userConflicts += 1;
        } else {
          sidecarsExisting += 1;
        }
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          invalid += 1;
          userInvalid += 1;
          continue;
        }
      }
      sidecarsPlanned += 1;
      if (!apply) continue;
      const status = installSidecar(sidecarPath, candidate);
      if (status === "created") {
        sidecarsCreated += 1;
      } else {
        const raced = JSON.parse(readFileSync(sidecarPath, "utf8")) as Candidate;
        if (raced.run_id === candidate.run_id && raced.started_at === candidate.started_at) {
          sidecarsExisting += 1;
        } else {
          conflicts += 1;
          userConflicts += 1;
        }
      }
    }
    if (userInvalid === 0 && userConflicts === 0) {
      usersReady += 1;
      if (apply) {
        writeAtomic(join(userRoot, ".source-cursors", "migration-v1.json"), {
          schema_version: 1,
          complete: true,
          completed_at: new Date(now()).toISOString(),
          eligible_cursors: candidates.size,
        });
      }
    }
  }

  return {
    applied: apply,
    scanned_metadata: scannedMetadata,
    eligible_cursors: eligibleCursors,
    duplicate_metadata: duplicateMetadata,
    sidecars_planned: sidecarsPlanned,
    sidecars_created: sidecarsCreated,
    sidecars_existing: sidecarsExisting,
    conflicts,
    invalid,
    users_ready: usersReady,
  };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const apply = args.includes("--apply");
  const confirmed = args.includes("--yes");
  const pathIndex = args.indexOf("--run-store");
  const runStorePath =
    pathIndex >= 0 && args[pathIndex + 1]
      ? args[pathIndex + 1]!
      : process.env.MEMORY_RUN_STORE ?? join(homedir(), ".joelclaw", "runs-dev");
  try {
    if (apply && !confirmed) {
      throw new Error("source cursor migration failed: confirmation-required");
    }
    const receipt = migrateRunSourceCursors({ runStorePath, apply });
    const ok = receipt.conflicts === 0 && receipt.invalid === 0;
    console.log(
      JSON.stringify({
        ok,
        mode: apply ? "apply" : "dry-run",
        action: "memory.run_source_cursors.migrate",
        ...receipt,
      }),
    );
    if (!ok) process.exitCode = 1;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    const code =
      /^source cursor migration failed: ([a-z0-9-]+)$/u.exec(detail)?.[1] ??
      "migration-failed";
    console.error(
      JSON.stringify({
        ok: false,
        action: "memory.run_source_cursors.migrate",
        error: code,
      }),
    );
    process.exitCode = 1;
  }
}

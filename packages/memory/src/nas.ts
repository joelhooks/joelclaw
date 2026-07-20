/**
 * ADR-0243 Rules 10 + 11: NAS is authoritative; paths are user-partitioned.
 *
 * Layout: <base>/<user_id>/<yyyy-mm>/<run-id>.{jsonl,metadata.json}
 *
 * Base path is MEMORY_RUN_STORE env var. Defaults to ~/.joelclaw/runs-dev/
 * for local development. Production sets it to /nas/memory/runs.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function runStoreBase(): string {
  return process.env.MEMORY_RUN_STORE ?? join(homedir(), ".joelclaw", "runs-dev");
}

export function runJsonlPath(userId: string, runId: string, startedAt: number): string {
  const d = new Date(startedAt);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return join(runStoreBase(), userId, `${yyyy}-${mm}`, `${runId}.jsonl`);
}

export function runMetadataPath(
  userId: string,
  runId: string,
  startedAt: number
): string {
  const d = new Date(startedAt);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return join(runStoreBase(), userId, `${yyyy}-${mm}`, `${runId}.metadata.json`);
}

export type RunBlobWriteResult = {
  jsonl_path: string;
  jsonl_bytes: number;
  jsonl_sha256: string;
  created: boolean;
  metadata: Record<string, unknown>;
};

export class RunBlobConflictError extends Error {
  readonly code = "run_blob_conflict";

  constructor(
    readonly runId: string,
    readonly existing: RunBlobWriteResult,
    readonly existingIsPrefix: boolean,
  ) {
    super(`run ${runId} already exists with different JSONL bytes`);
    this.name = "RunBlobConflictError";
  }
}

function runIdentityPath(userId: string, runId: string): string {
  return join(runStoreBase(), userId, ".run-ids", `${runId}.json`);
}

function readStoredRun(jsonlPath: string, metadataPath: string): RunBlobWriteResult {
  const existing = readFileSync(jsonlPath);
  const metadata = existsSync(metadataPath)
    ? (JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>)
    : {};
  return {
    jsonl_path: jsonlPath,
    jsonl_bytes: existing.length,
    jsonl_sha256: createHash("sha256").update(existing).digest("hex"),
    created: false,
    metadata,
  };
}

export function writeRunBlob(
  userId: string,
  runId: string,
  startedAt: number,
  jsonl: string,
  metadata: Record<string, unknown>
): RunBlobWriteResult {
  const requestedPath = runJsonlPath(userId, runId, startedAt);
  const requestedMetadataPath = runMetadataPath(userId, runId, startedAt);
  const identityPath = runIdentityPath(userId, runId);
  let jsonlPath = requestedPath;
  let metadataPath = requestedMetadataPath;
  const hasIdentity = existsSync(identityPath);
  if (hasIdentity) {
    const identity = JSON.parse(readFileSync(identityPath, "utf8")) as {
      jsonl_path?: string;
      metadata_path?: string;
    };
    if (!identity.jsonl_path || !identity.metadata_path) {
      throw new Error(`run identity ${runId} is invalid`);
    }
    jsonlPath = identity.jsonl_path;
    metadataPath = identity.metadata_path;
  }
  const jsonl_sha256 = createHash("sha256").update(jsonl).digest("hex");
  const jsonl_bytes = Buffer.byteLength(jsonl, "utf8");
  if (existsSync(jsonlPath)) {
    const existing = readStoredRun(jsonlPath, metadataPath);
    if (!hasIdentity) {
      mkdirSync(dirname(identityPath), { recursive: true });
      writeFileSync(
        identityPath,
        JSON.stringify({ jsonl_path: jsonlPath, metadata_path: metadataPath }),
        { flag: "wx" },
      );
    }
    if (existing.jsonl_sha256 !== jsonl_sha256) {
      const incoming = Buffer.from(jsonl, "utf8");
      const stored = readFileSync(jsonlPath);
      throw new RunBlobConflictError(
        runId,
        existing,
        incoming.length >= stored.length && incoming.subarray(0, stored.length).equals(stored),
      );
    }
    return existing;
  }
  mkdirSync(dirname(jsonlPath), { recursive: true });
  writeFileSync(jsonlPath, jsonl, { flag: "wx" });
  const storedMetadata = { ...metadata, jsonl_path: jsonlPath };
  writeFileSync(metadataPath, JSON.stringify(storedMetadata, null, 2), { flag: "wx" });
  mkdirSync(dirname(identityPath), { recursive: true });
  writeFileSync(
    identityPath,
    JSON.stringify({ jsonl_path: jsonlPath, metadata_path: metadataPath }),
    { flag: "wx" },
  );
  return {
    jsonl_path: jsonlPath,
    jsonl_bytes,
    jsonl_sha256,
    created: true,
    metadata: storedMetadata,
  };
}

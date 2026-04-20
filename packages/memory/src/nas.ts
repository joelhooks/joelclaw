/**
 * ADR-0243 Rules 10 + 11: NAS is authoritative; paths are user-partitioned.
 *
 * Layout: <base>/<user_id>/<yyyy-mm>/<run-id>.{jsonl,metadata.json}
 *
 * Base path is MEMORY_RUN_STORE env var. Defaults to ~/.joelclaw/runs-dev/
 * for local development. Production sets it to /nas/memory/runs.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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

export function writeRunBlob(
  userId: string,
  runId: string,
  startedAt: number,
  jsonl: string,
  metadata: Record<string, unknown>
): { jsonl_path: string; jsonl_bytes: number; jsonl_sha256: string } {
  const jsonlPath = runJsonlPath(userId, runId, startedAt);
  const metadataPath = runMetadataPath(userId, runId, startedAt);
  mkdirSync(dirname(jsonlPath), { recursive: true });
  writeFileSync(jsonlPath, jsonl);
  writeFileSync(
    metadataPath,
    JSON.stringify({ ...metadata, jsonl_path: jsonlPath }, null, 2)
  );
  const jsonl_sha256 = createHash("sha256").update(jsonl).digest("hex");
  const jsonl_bytes = Buffer.byteLength(jsonl, "utf8");
  return { jsonl_path: jsonlPath, jsonl_bytes, jsonl_sha256 };
}

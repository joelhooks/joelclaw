#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  classifyHistoricalSourceCursorFields,
  parseHistoricalSourceCursorClaim,
} from "../packages/memory/src/source-cursor";

interface Candidate {
  readonly run_id: string;
  readonly started_at: number;
  readonly sourceIdentity: string;
  readonly fromOffset: number;
  readonly metadataPath: string;
}

type StoredClaim = Pick<Candidate, "run_id" | "started_at">;

interface FileFingerprint {
  readonly device: bigint;
  readonly inode: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly changedNanoseconds: bigint;
  readonly size: bigint;
}

interface BodyProof {
  readonly path: string;
  readonly digest: string;
  readonly fingerprint: FileFingerprint;
  readonly size: number;
}

interface PrefixProofInput {
  readonly runStorePath: string;
  readonly sourceIdentity: string;
  readonly fromOffset: number;
  readonly existing: StoredClaim;
  readonly candidates: readonly Candidate[];
  readonly onProofChunk?: () => void;
}

export interface SourceCursorMigrationReceipt {
  readonly applied: boolean;
  readonly scanned_metadata: number;
  readonly eligible_cursors: number;
  readonly duplicate_metadata: number;
  readonly sidecars_planned: number;
  readonly sidecars_created: number;
  readonly sidecars_existing: number;
  readonly proven_preserved_prefix_claims: number;
  readonly conflicts: number;
  readonly invalid: number;
  readonly users_ready: number;
}

const cursorKey = (sourceIdentity: string, fromOffset: number) =>
  createHash("sha256")
    .update(JSON.stringify([sourceIdentity, fromOffset]))
    .digest("hex");

const isInside = (root: string, candidate: string): boolean => {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
};

const regularFileInRoot = (root: string, candidate: string): string | null => {
  if (!isAbsolute(candidate)) return null;
  const lexicalPath = resolve(candidate);
  try {
    if (!lstatSync(lexicalPath).isFile()) return null;
    const realPath = realpathSync(lexicalPath);
    return isInside(root, realPath) ? realPath : null;
  } catch {
    return null;
  }
};

const fileFingerprint = (descriptor: number): FileFingerprint | null => {
  const stats = fstatSync(descriptor, { bigint: true });
  if (!stats.isFile() || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    device: stats.dev,
    inode: stats.ino,
    modifiedNanoseconds: stats.mtimeNs,
    changedNanoseconds: stats.ctimeNs,
    size: stats.size,
  };
};

const sameFingerprint = (left: FileFingerprint, right: FileFingerprint): boolean =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.modifiedNanoseconds === right.modifiedNanoseconds &&
  left.changedNanoseconds === right.changedNanoseconds &&
  left.size === right.size;

const proveBodyDigest = (
  path: string,
  expectedDigest: string,
  onProofChunk?: () => void,
): BodyProof | null => {
  const descriptor = openSync(path, "r");
  try {
    const before = fileFingerprint(descriptor);
    if (before === null) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      onProofChunk?.();
    }
    const after = fileFingerprint(descriptor);
    const digest = hash.digest("hex");
    if (after === null || !sameFingerprint(before, after) || digest !== expectedDigest) {
      return null;
    }
    return {
      path,
      digest,
      fingerprint: before,
      size: Number(before.size),
    };
  } finally {
    closeSync(descriptor);
  }
};

const proofBodyFields = (
  value: unknown,
): { readonly jsonlPath: string; readonly jsonlSha256: string } | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const jsonlPath = Reflect.get(value, "jsonl_path");
  const jsonlSha256 = Reflect.get(value, "jsonl_sha256");
  if (
    typeof jsonlPath !== "string" ||
    typeof jsonlSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(jsonlSha256)
  ) {
    return null;
  }
  return { jsonlPath, jsonlSha256 };
};

const readExact = (descriptor: number, buffer: Buffer, length: number): boolean => {
  let offset = 0;
  while (offset < length) {
    const bytesRead = readSync(descriptor, buffer, offset, length - offset, null);
    if (bytesRead === 0) return false;
    offset += bytesRead;
  }
  return true;
};

const bodyIsPrefix = (candidate: BodyProof, existing: BodyProof): boolean => {
  if (candidate.size > existing.size) return false;
  const candidateDescriptor = openSync(candidate.path, "r");
  const existingDescriptor = openSync(existing.path, "r");
  try {
    const candidateBefore = fileFingerprint(candidateDescriptor);
    const existingBefore = fileFingerprint(existingDescriptor);
    if (
      candidateBefore === null ||
      existingBefore === null ||
      !sameFingerprint(candidateBefore, candidate.fingerprint) ||
      !sameFingerprint(existingBefore, existing.fingerprint)
    ) {
      return false;
    }
    const candidateBuffer = Buffer.allocUnsafe(64 * 1024);
    const existingBuffer = Buffer.allocUnsafe(64 * 1024);
    let remaining = candidate.size;
    while (remaining > 0) {
      const length = Math.min(remaining, candidateBuffer.length);
      if (
        !readExact(candidateDescriptor, candidateBuffer, length) ||
        !readExact(existingDescriptor, existingBuffer, length) ||
        !candidateBuffer.subarray(0, length).equals(existingBuffer.subarray(0, length))
      ) {
        return false;
      }
      remaining -= length;
    }
    const candidateAfter = fileFingerprint(candidateDescriptor);
    const existingAfter = fileFingerprint(existingDescriptor);
    return (
      candidateAfter !== null &&
      existingAfter !== null &&
      sameFingerprint(candidateAfter, candidate.fingerprint) &&
      sameFingerprint(existingAfter, existing.fingerprint)
    );
  } finally {
    closeSync(candidateDescriptor);
    closeSync(existingDescriptor);
  }
};

export const proveExistingSourceCursorPrefix = (input: PrefixProofInput): boolean => {
  try {
    const runStoreRoot = realpathSync(resolve(input.runStorePath));
    const records: Array<{
      readonly claim: StoredClaim;
      readonly body: BodyProof;
    }> = [];
    const bodies = new Map<string, BodyProof>();

    for (const scanned of input.candidates) {
      const metadataPath = regularFileInRoot(runStoreRoot, scanned.metadataPath);
      if (metadataPath === null) return false;
      const metadata: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
      const cursor = classifyHistoricalSourceCursorFields(metadata);
      const claim = parseHistoricalSourceCursorClaim(metadata);
      const bodyFields = proofBodyFields(metadata);
      if (
        cursor._tag !== "Valid" ||
        claim === null ||
        bodyFields === null ||
        cursor.sourceIdentity !== input.sourceIdentity ||
        cursor.fromOffset !== input.fromOffset ||
        scanned.sourceIdentity !== input.sourceIdentity ||
        scanned.fromOffset !== input.fromOffset ||
        claim.run_id !== scanned.run_id ||
        claim.started_at !== scanned.started_at
      ) {
        return false;
      }
      const bodyPath = regularFileInRoot(runStoreRoot, bodyFields.jsonlPath);
      if (bodyPath === null) return false;
      const expectedDigest = bodyFields.jsonlSha256;
      let body = bodies.get(bodyPath);
      if (body === undefined) {
        body = proveBodyDigest(bodyPath, expectedDigest, input.onProofChunk) ?? undefined;
        if (body === undefined) return false;
        bodies.set(bodyPath, body);
      } else if (body.digest !== expectedDigest) {
        return false;
      }
      records.push({ claim, body });
    }

    const ownerRecords = records.filter(
      (record) =>
        record.claim.run_id === input.existing.run_id &&
        record.claim.started_at === input.existing.started_at,
    );
    const owner = ownerRecords[0]?.body;
    if (owner === undefined) return false;
    for (const record of ownerRecords) {
      if (record.body.size !== owner.size || !bodyIsPrefix(record.body, owner)) return false;
    }
    return records.every((record) => bodyIsPrefix(record.body, owner));
  } catch {
    return false;
  }
};

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
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({ run_id: candidate.run_id, started_at: candidate.started_at })}\n`,
    { mode: 0o600 },
  );
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
  readonly onProofChunk?: () => void;
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
  let provenPreservedPrefixClaims = 0;
  let conflicts = 0;
  let invalid = 0;
  let usersReady = 0;

  for (const userId of users) {
    const userRoot = join(runStorePath, userId);
    const candidates = new Map<string, Candidate>();
    const candidateRecords = new Map<string, Candidate[]>();
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
        let metadata: unknown;
        try {
          if (!lstatSync(metadataPath).isFile()) throw new Error("not-regular");
          metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
        } catch {
          invalid += 1;
          userInvalid += 1;
          continue;
        }
        const cursor = classifyHistoricalSourceCursorFields(metadata);
        if (cursor._tag === "Absent") continue;
        if (cursor._tag === "Invalid") {
          invalid += 1;
          userInvalid += 1;
          continue;
        }
        const parsedCandidate = parseHistoricalSourceCursorClaim(metadata);
        if (parsedCandidate === null) {
          invalid += 1;
          userInvalid += 1;
          continue;
        }
        const candidate: Candidate = {
          ...parsedCandidate,
          sourceIdentity: cursor.sourceIdentity,
          fromOffset: cursor.fromOffset,
          metadataPath,
        };
        const key = cursorKey(cursor.sourceIdentity, cursor.fromOffset);
        const records = candidateRecords.get(key) ?? [];
        records.push(candidate);
        candidateRecords.set(key, records);
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
        const existing = parseHistoricalSourceCursorClaim(
          JSON.parse(readFileSync(sidecarPath, "utf8")),
        );
        if (existing === null) {
          invalid += 1;
          userInvalid += 1;
        } else if (
          existing.run_id === candidate.run_id &&
          existing.started_at === candidate.started_at
        ) {
          sidecarsExisting += 1;
        } else if (
          proveExistingSourceCursorPrefix({
            runStorePath,
            sourceIdentity: candidate.sourceIdentity,
            fromOffset: candidate.fromOffset,
            existing,
            candidates: candidateRecords.get(key) ?? [],
            onProofChunk: input.onProofChunk,
          })
        ) {
          sidecarsExisting += 1;
          provenPreservedPrefixClaims += 1;
        } else {
          conflicts += 1;
          userConflicts += 1;
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
        const raced = parseHistoricalSourceCursorClaim(
          JSON.parse(readFileSync(sidecarPath, "utf8")),
        );
        if (raced === null) {
          invalid += 1;
          userInvalid += 1;
        } else if (
          raced.run_id === candidate.run_id &&
          raced.started_at === candidate.started_at
        ) {
          sidecarsExisting += 1;
        } else if (
          proveExistingSourceCursorPrefix({
            runStorePath,
            sourceIdentity: candidate.sourceIdentity,
            fromOffset: candidate.fromOffset,
            existing: raced,
            candidates: candidateRecords.get(key) ?? [],
            onProofChunk: input.onProofChunk,
          })
        ) {
          sidecarsExisting += 1;
          provenPreservedPrefixClaims += 1;
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
    proven_preserved_prefix_claims: provenPreservedPrefixClaims,
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

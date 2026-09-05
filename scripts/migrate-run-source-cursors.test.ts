import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateRunSourceCursors } from "./migrate-run-source-cursors";

const source = `sha256:${"a".repeat(64)}`;
const cursorName = `${createHash("sha256")
  .update(JSON.stringify([source, 0]))
  .digest("hex")}.json`;

const writeMetadata = (month: string, name: string, value: unknown) =>
  writeFileSync(join(month, `${name}.metadata.json`), JSON.stringify(value));

const writeCursorRecord = (input: {
  readonly month: string;
  readonly name: string;
  readonly runId: string;
  readonly startedAt: number;
  readonly body: string;
  readonly sourceIdentity?: string;
  readonly fromOffset?: number;
  readonly digest?: string;
  readonly jsonlPath?: string;
  readonly writeBody?: boolean;
}) => {
  const bodyPath = input.jsonlPath ?? join(input.month, `${input.name}.jsonl`);
  if (input.writeBody !== false) writeFileSync(bodyPath, input.body);
  writeMetadata(input.month, input.name, {
    run_id: input.runId,
    started_at: input.startedAt,
    source_identity: input.sourceIdentity ?? source,
    from_offset: input.fromOffset ?? 0,
    jsonl_path: bodyPath,
    jsonl_sha256:
      input.digest ?? createHash("sha256").update(input.body).digest("hex"),
  });
  return bodyPath;
};

const writeExistingClaim = (
  root: string,
  claim: { readonly run_id: string; readonly started_at: number },
) => {
  const sidecarRoot = join(root, "user", ".source-cursors");
  mkdirSync(sidecarRoot, { recursive: true });
  const bytes = `${JSON.stringify(claim)}\n`;
  writeFileSync(join(sidecarRoot, cursorName), bytes);
  return { bytes, sidecarRoot };
};

test("offline source-cursor migration preserves fractional timestamps and skips paired-null legacy cursors", () => {
  const root = mkdtempSync(join(tmpdir(), "source-cursor-migration-"));
  const month = join(root, "user", "2026-09");
  mkdirSync(month, { recursive: true });
  writeMetadata(month, "later", {
    run_id: "later-run",
    started_at: 20.75,
    source_identity: source,
    from_offset: 0,
  });
  writeMetadata(month, "earlier", {
    run_id: "earlier-run",
    started_at: 10.25,
    source_identity: source,
    from_offset: 0,
  });
  writeMetadata(month, "legacy", { run_id: "legacy" });
  writeMetadata(month, "legacy-null", {
    run_id: "legacy-null",
    started_at: 5.5,
    source_identity: null,
    from_offset: null,
  });
  try {
    expect(migrateRunSourceCursors({ runStorePath: root })).toMatchObject({
      applied: false,
      scanned_metadata: 4,
      eligible_cursors: 1,
      duplicate_metadata: 1,
      sidecars_planned: 1,
      sidecars_created: 0,
      invalid: 0,
      users_ready: 1,
    });
    const receipt = migrateRunSourceCursors({
      runStorePath: root,
      apply: true,
      now: () => Date.parse("2026-09-05T00:00:00.000Z"),
    });
    expect(receipt).toMatchObject({
      applied: true,
      sidecars_planned: 1,
      sidecars_created: 1,
      conflicts: 0,
      invalid: 0,
      users_ready: 1,
    });
    const sidecarRoot = join(root, "user", ".source-cursors");
    expect(JSON.parse(readFileSync(join(sidecarRoot, cursorName), "utf8"))).toEqual({
      run_id: "earlier-run",
      started_at: 10.25,
    });
    expect(JSON.parse(readFileSync(join(sidecarRoot, "migration-v1.json"), "utf8"))).toMatchObject({
      schema_version: 1,
      complete: true,
      eligible_cursors: 1,
    });
    expect(statSync(sidecarRoot).mode & 0o777).toBe(0o700);
    expect(statSync(join(sidecarRoot, cursorName)).mode & 0o777).toBe(0o600);
    expect(statSync(join(sidecarRoot, "migration-v1.json")).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration fails closed for nonobjects, mixed cursor fields, invalid timestamps, and symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "source-cursor-invalid-"));
  const month = join(root, "user", "2026-09");
  mkdirSync(month, { recursive: true });
  writeMetadata(month, "null", null);
  writeMetadata(month, "array", []);
  writeMetadata(month, "mixed", {
    run_id: "mixed",
    started_at: 1.5,
    source_identity: null,
    from_offset: 0,
  });
  writeMetadata(month, "bad-identity", {
    run_id: "bad-identity",
    started_at: 1.5,
    source_identity: "not-a-digest",
    from_offset: 0,
  });
  writeMetadata(month, "negative-time", {
    run_id: "negative-time",
    started_at: -0.5,
    source_identity: source,
    from_offset: 0,
  });
  writeMetadata(month, "out-of-date-range", {
    run_id: "out-of-date-range",
    started_at: 8_640_000_000_000_001,
    source_identity: source,
    from_offset: 0,
  });
  writeMetadata(month, "paired-null", {
    run_id: "paired-null",
    started_at: 1.5,
    source_identity: null,
    from_offset: null,
  });
  const symlinkTarget = join(root, "outside.json");
  writeFileSync(symlinkTarget, JSON.stringify({ run_id: "outside" }));
  symlinkSync(symlinkTarget, join(month, "linked.metadata.json"));

  try {
    const receipt = migrateRunSourceCursors({ runStorePath: root, apply: true });
    expect(receipt).toMatchObject({
      applied: true,
      scanned_metadata: 8,
      eligible_cursors: 0,
      conflicts: 0,
      invalid: 7,
      users_ready: 0,
    });
    expect(existsSync(join(root, "user", ".source-cursors", "migration-v1.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a verified full owner preserves exact sidecar bytes over an older prefix snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "source-cursor-prefix-"));
  const month = join(root, "user", "2026-09");
  mkdirSync(month, { recursive: true });
  const prefix = "p".repeat(70_000);
  writeCursorRecord({
    month,
    name: "a-prefix",
    runId: "prefix-run",
    startedAt: 10.25,
    body: prefix,
  });
  writeCursorRecord({
    month,
    name: "z-owner",
    runId: "owner-run",
    startedAt: 20.5,
    body: `${prefix}suffix`,
  });
  const { bytes, sidecarRoot } = writeExistingClaim(root, {
    run_id: "owner-run",
    started_at: 20.5,
  });

  try {
    expect(migrateRunSourceCursors({ runStorePath: root, apply: true })).toMatchObject({
      conflicts: 0,
      invalid: 0,
      proven_preserved_prefix_claims: 1,
      sidecars_existing: 1,
      sidecars_created: 0,
      users_ready: 1,
    });
    expect(readFileSync(join(sidecarRoot, cursorName), "utf8")).toBe(bytes);
    expect(JSON.parse(readFileSync(join(sidecarRoot, "migration-v1.json"), "utf8"))).toMatchObject({
      complete: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a verified owner may differ by Run ID when every candidate body is exactly equal", () => {
  const root = mkdtempSync(join(tmpdir(), "source-cursor-equal-"));
  const month = join(root, "user", "2026-09");
  mkdirSync(month, { recursive: true });
  writeCursorRecord({
    month,
    name: "candidate",
    runId: "candidate-run",
    startedAt: 10,
    body: "same-body",
  });
  writeCursorRecord({
    month,
    name: "owner",
    runId: "owner-run",
    startedAt: 20,
    body: "same-body",
  });
  const { bytes, sidecarRoot } = writeExistingClaim(root, {
    run_id: "owner-run",
    started_at: 20,
  });

  try {
    expect(migrateRunSourceCursors({ runStorePath: root })).toMatchObject({
      conflicts: 0,
      proven_preserved_prefix_claims: 1,
      users_ready: 1,
    });
    expect(readFileSync(join(sidecarRoot, cursorName), "utf8")).toBe(bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every competing candidate must be a prefix of the verified owner", () => {
  const root = mkdtempSync(join(tmpdir(), "source-cursor-divergent-"));
  const month = join(root, "user", "2026-09");
  mkdirSync(month, { recursive: true });
  writeCursorRecord({
    month,
    name: "a-earliest-prefix",
    runId: "earliest-run",
    startedAt: 10,
    body: "shared-prefix",
  });
  writeCursorRecord({
    month,
    name: "m-divergent",
    runId: "divergent-run",
    startedAt: 15,
    body: "different-body",
  });
  writeCursorRecord({
    month,
    name: "z-owner",
    runId: "owner-run",
    startedAt: 20,
    body: "shared-prefix-and-suffix",
  });
  const { bytes, sidecarRoot } = writeExistingClaim(root, {
    run_id: "owner-run",
    started_at: 20,
  });

  try {
    expect(migrateRunSourceCursors({ runStorePath: root, apply: true })).toMatchObject({
      conflicts: 1,
      proven_preserved_prefix_claims: 0,
      users_ready: 0,
    });
    expect(readFileSync(join(sidecarRoot, cursorName), "utf8")).toBe(bytes);
    expect(existsSync(join(sidecarRoot, "migration-v1.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shorter existing owner remains a conflict", () => {
  const root = mkdtempSync(join(tmpdir(), "source-cursor-short-owner-"));
  const month = join(root, "user", "2026-09");
  mkdirSync(month, { recursive: true });
  writeCursorRecord({
    month,
    name: "candidate",
    runId: "candidate-run",
    startedAt: 10,
    body: "longer-candidate-body",
  });
  writeCursorRecord({
    month,
    name: "owner",
    runId: "owner-run",
    startedAt: 20,
    body: "short",
  });
  const { sidecarRoot } = writeExistingClaim(root, {
    run_id: "owner-run",
    started_at: 20,
  });

  try {
    expect(migrateRunSourceCursors({ runStorePath: root, apply: true })).toMatchObject({
      conflicts: 1,
      proven_preserved_prefix_claims: 0,
      users_ready: 0,
    });
    expect(existsSync(join(sidecarRoot, "migration-v1.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the owner metadata must exist and match the exact cursor, Run ID, and original timestamp", () => {
  for (const mismatch of ["missing", "identity", "offset", "timestamp"] as const) {
    const root = mkdtempSync(join(tmpdir(), `source-cursor-${mismatch}-`));
    const month = join(root, "user", "2026-09");
    mkdirSync(month, { recursive: true });
    writeCursorRecord({
      month,
      name: "candidate",
      runId: "candidate-run",
      startedAt: 10,
      body: "prefix",
    });
    if (mismatch !== "missing") {
      writeCursorRecord({
        month,
        name: "owner",
        runId: "owner-run",
        startedAt: mismatch === "timestamp" ? 21 : 20,
        body: "prefix-suffix",
        sourceIdentity: mismatch === "identity" ? `sha256:${"b".repeat(64)}` : source,
        fromOffset: mismatch === "offset" ? 1 : 0,
      });
    }
    const { sidecarRoot } = writeExistingClaim(root, {
      run_id: "owner-run",
      started_at: 20,
    });
    try {
      expect(migrateRunSourceCursors({ runStorePath: root, apply: true })).toMatchObject({
        conflicts: 1,
        proven_preserved_prefix_claims: 0,
        users_ready: 0,
      });
      expect(existsSync(join(sidecarRoot, "migration-v1.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("missing, tampered, symlinked, and out-of-root bodies cannot prove a prefix owner", () => {
  for (const failure of ["missing", "digest", "symlink", "outside"] as const) {
    const root = mkdtempSync(join(tmpdir(), `source-cursor-body-${failure}-`));
    const month = join(root, "user", "2026-09");
    mkdirSync(month, { recursive: true });
    writeCursorRecord({
      month,
      name: "candidate",
      runId: "candidate-run",
      startedAt: 10,
      body: "prefix",
    });
    const ownerBody = "prefix-suffix";
    const normalOwnerPath = join(month, "owner.jsonl");
    let ownerPath = normalOwnerPath;
    let writeBody = true;
    let digest: string | undefined;
    if (failure === "missing") writeBody = false;
    if (failure === "digest") digest = "0".repeat(64);
    if (failure === "outside") ownerPath = join(root, "..", `outside-${Date.now()}.jsonl`);
    if (failure === "symlink") {
      const target = join(month, "owner-target.jsonl");
      writeFileSync(target, ownerBody);
      symlinkSync(target, normalOwnerPath);
      writeBody = false;
    }
    writeCursorRecord({
      month,
      name: "owner",
      runId: "owner-run",
      startedAt: 20,
      body: ownerBody,
      jsonlPath: ownerPath,
      writeBody,
      ...(digest === undefined ? {} : { digest }),
    });
    const { sidecarRoot } = writeExistingClaim(root, {
      run_id: "owner-run",
      started_at: 20,
    });
    try {
      expect(migrateRunSourceCursors({ runStorePath: root, apply: true })).toMatchObject({
        conflicts: 1,
        proven_preserved_prefix_claims: 0,
        users_ready: 0,
      });
      expect(existsSync(join(sidecarRoot, "migration-v1.json"))).toBe(false);
    } finally {
      if (failure === "outside" && existsSync(ownerPath)) rmSync(ownerPath);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("body mutation during streaming proof remains blocked", () => {
  const root = mkdtempSync(join(tmpdir(), "source-cursor-mutation-"));
  const month = join(root, "user", "2026-09");
  mkdirSync(month, { recursive: true });
  const candidatePath = writeCursorRecord({
    month,
    name: "a-candidate",
    runId: "candidate-run",
    startedAt: 10,
    body: "p".repeat(70_000),
  });
  writeCursorRecord({
    month,
    name: "z-owner",
    runId: "owner-run",
    startedAt: 20,
    body: `${"p".repeat(70_000)}suffix`,
  });
  const { sidecarRoot } = writeExistingClaim(root, {
    run_id: "owner-run",
    started_at: 20,
  });
  let mutated = false;

  try {
    expect(
      migrateRunSourceCursors({
        runStorePath: root,
        apply: true,
        onProofChunk: () => {
          if (mutated) return;
          mutated = true;
          appendFileSync(candidatePath, "mutation");
        },
      }),
    ).toMatchObject({
      conflicts: 1,
      proven_preserved_prefix_claims: 0,
      users_ready: 0,
    });
    expect(mutated).toBe(true);
    expect(existsSync(join(sidecarRoot, "migration-v1.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an authoritative sidecar disagreement remains untouched and blocks the marker", () => {
  const root = mkdtempSync(join(tmpdir(), "source-cursor-conflict-"));
  const month = join(root, "user", "2026-09");
  const sidecarRoot = join(root, "user", ".source-cursors");
  mkdirSync(month, { recursive: true });
  mkdirSync(sidecarRoot, { recursive: true });
  writeMetadata(month, "candidate", {
    run_id: "earliest-run",
    started_at: 10.25,
    source_identity: source,
    from_offset: 0,
  });
  const existing = `${JSON.stringify({ run_id: "authoritative-run", started_at: 11.5 })}\n`;
  writeFileSync(join(sidecarRoot, cursorName), existing);

  try {
    expect(migrateRunSourceCursors({ runStorePath: root, apply: true })).toMatchObject({
      conflicts: 1,
      invalid: 0,
      sidecars_created: 0,
      users_ready: 0,
    });
    expect(readFileSync(join(sidecarRoot, cursorName), "utf8")).toBe(existing);
    expect(existsSync(join(sidecarRoot, "migration-v1.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
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

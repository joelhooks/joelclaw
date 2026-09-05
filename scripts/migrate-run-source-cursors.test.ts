import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateRunSourceCursors } from "./migrate-run-source-cursors";

const source = `sha256:${"a".repeat(64)}`;
const cursorName = `${createHash("sha256")
  .update(JSON.stringify([source, 0]))
  .digest("hex")}.json`;

test("offline source-cursor migration plans then atomically installs sidecars and marker", () => {
  const root = mkdtempSync(join(tmpdir(), "source-cursor-migration-"));
  const month = join(root, "user", "2026-09");
  mkdirSync(month, { recursive: true });
  writeFileSync(
    join(month, "later.metadata.json"),
    JSON.stringify({
      run_id: "later-run",
      started_at: 20,
      source_identity: source,
      from_offset: 0,
    }),
  );
  writeFileSync(
    join(month, "earlier.metadata.json"),
    JSON.stringify({
      run_id: "earlier-run",
      started_at: 10,
      source_identity: source,
      from_offset: 0,
    }),
  );
  writeFileSync(join(month, "legacy.metadata.json"), JSON.stringify({ run_id: "legacy" }));
  try {
    expect(migrateRunSourceCursors({ runStorePath: root })).toMatchObject({
      applied: false,
      scanned_metadata: 3,
      eligible_cursors: 1,
      duplicate_metadata: 1,
      sidecars_planned: 1,
      sidecars_created: 0,
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
      started_at: 10,
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

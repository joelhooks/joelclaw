import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  RunBlobConflictError,
  runMetadataPath,
  writeRunBlob,
} from "../src/nas";

const originalStore = process.env.MEMORY_RUN_STORE;
let fixtureRoot: string | undefined;

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
  if (originalStore === undefined) delete process.env.MEMORY_RUN_STORE;
  else process.env.MEMORY_RUN_STORE = originalStore;
});

describe("writeRunBlob", () => {
  test("accepts idempotent redelivery under the same Run ID", () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "run-blob-fixture-"));
    process.env.MEMORY_RUN_STORE = fixtureRoot;
    const startedAt = 1_700_000_000_000;
    const metadata = { run_id: "stable-run", captured_at: 1 };

    const first = writeRunBlob("user", "stable-run", startedAt, "one\n", metadata);
    const second = writeRunBlob("user", "stable-run", startedAt, "one\n", {
      ...metadata,
      captured_at: 2,
    });

    expect(second).toMatchObject({
      jsonl_path: first.jsonl_path,
      jsonl_bytes: first.jsonl_bytes,
      jsonl_sha256: first.jsonl_sha256,
      created: false,
    });
    expect(
      JSON.parse(readFileSync(runMetadataPath("user", "stable-run", startedAt), "utf8")),
    ).toMatchObject({ captured_at: 1 });
  });

  test("rejects different bytes under an existing Run ID across month paths", () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "run-blob-fixture-"));
    process.env.MEMORY_RUN_STORE = fixtureRoot;
    const january = Date.UTC(2026, 0, 1);
    const february = Date.UTC(2026, 1, 1);
    writeRunBlob("user", "stable-run", january, "one\n", { run_id: "stable-run" });

    expect(() =>
      writeRunBlob("user", "stable-run", february, "different\n", {
        run_id: "stable-run",
      }),
    ).toThrow(RunBlobConflictError);
  });
});

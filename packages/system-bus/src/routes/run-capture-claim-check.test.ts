import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunCaptureClaimCheck } from "./run-capture-claim-check";

let fixtureRoot: string | undefined;

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

function fixtureSpool() {
  fixtureRoot = mkdtempSync(join(tmpdir(), "run-capture-claim-check-"));
  const spoolDir = join(fixtureRoot, "spool");
  mkdirSync(spoolDir, { mode: 0o700 });
  return { spoolDir, root: fixtureRoot };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("run capture claim-check file validation", () => {
  test("rejects malformed UTF-8 even when the raw-byte digest matches", () => {
    const { spoolDir } = fixtureSpool();
    const bytes = Buffer.from([0xff, 0x0a]);
    const path = join(spoolDir, "invalid.jsonl");
    writeFileSync(path, bytes, { mode: 0o600 });

    expect(readRunCaptureClaimCheck(path, sha256(bytes), spoolDir)).toBeNull();
  });

  test("rejects an allowlist root that is itself a symlink", () => {
    const { spoolDir, root } = fixtureSpool();
    const linkedRoot = join(root, "spool-link");
    symlinkSync(spoolDir, linkedRoot);
    const bytes = Buffer.from('{"type":"message"}\n');
    const path = join(spoolDir, "capture.jsonl");
    writeFileSync(path, bytes, { mode: 0o600 });

    expect(readRunCaptureClaimCheck(path, sha256(bytes), linkedRoot)).toBeNull();
  });
});

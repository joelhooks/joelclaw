import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createSafeScratchDir, resolveSafeScratchCleanup } from "./safe-scratch-dir";

const originalTmpdir = process.env.TMPDIR;
const fixtures: string[] = [];

function fixture(base = tmpdir()): string {
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "scratch-fixture-"));
  fixtures.push(dir);
  return realpathSync(dir);
}

afterEach(() => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

for (const prefix of ["discovery", "transcript-web"]) {
  test(`${prefix}: works with a macOS-shaped TMPDIR outside /tmp`, async () => {
    const home = fixture();
    // Lives outside /tmp, like $TMPDIR under /var/folders on macOS.
    const root = join(fixture(join(homedir(), ".cache")), "var", "folders", "xx", "T");
    mkdirSync(root, { recursive: true });
    process.env.TMPDIR = root;

    const dir = await createSafeScratchDir(prefix, { homeDir: home });
    expect(dir).not.toBeNull();
    expect(existsSync(dir as string)).toBe(true);
    expect(dir as string).toContain(`${prefix}-`);
    expect(resolveSafeScratchCleanup(dir as string, { homeDir: home })).toBe(dir);
  });

  test(`${prefix}: works with TMPDIR=/tmp`, async () => {
    process.env.TMPDIR = "/tmp";
    const dir = await createSafeScratchDir(prefix);
    expect(dir).not.toBeNull();
    if (dir) {
      expect(resolveSafeScratchCleanup(dir)).toBe(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${prefix}: works with TMPDIR unset`, async () => {
    delete process.env.TMPDIR;
    const dir = await createSafeScratchDir(prefix);
    expect(dir).not.toBeNull();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
}

test("rejects a TMPDIR inside protected harness paths", async () => {
  const home = fixture();
  for (const protectedRoot of [
    join(home, ".pi", "tmp"),
    join(home, ".joelclaw", "capture", "tmp"),
  ]) {
    mkdirSync(protectedRoot, { recursive: true });
    process.env.TMPDIR = protectedRoot;
    expect(await createSafeScratchDir("discovery", { homeDir: home })).toBeNull();
    expect(resolveSafeScratchCleanup(protectedRoot, { homeDir: home })).toBeNull();
  }
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSafeTemporaryDirectory } from "./protected-harness-paths";

export type SafeScratchDirOptions = {
  /** Temp root to create under. Defaults to the platform temp dir (`TMPDIR`). */
  tmpRoot?: string;
  homeDir?: string;
};

/**
 * Create a scratch directory under the platform temp dir and validate only the
 * new child. The temp root itself is never a valid scratch target (it equals the
 * root), and on macOS it is not under `/tmp`, so it must not be validated alone.
 * Returns null when the child resolves outside the root or into a protected path.
 */
export async function createSafeScratchDir(
  prefix: string,
  options: SafeScratchDirOptions = {},
): Promise<string | null> {
  const tmpRoot = options.tmpRoot ?? tmpdir();
  const dir = await mkdtemp(join(tmpRoot, `${prefix}-`));
  return resolveSafeTemporaryDirectory(dir, { tmpRoot, homeDir: options.homeDir });
}

/** Re-validate a scratch directory before removing it. */
export function resolveSafeScratchCleanup(
  dir: string,
  options: SafeScratchDirOptions = {},
): string | null {
  return resolveSafeTemporaryDirectory(dir, {
    tmpRoot: options.tmpRoot ?? tmpdir(),
    homeDir: options.homeDir,
  });
}

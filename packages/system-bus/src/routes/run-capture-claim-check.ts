import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { TextDecoder } from "node:util";

export const DEFAULT_RUN_CAPTURE_CLAIM_CHECK_SPOOL_DIR = join(
  homedir(),
  ".joelclaw",
  "capture-spool",
);
export const DEFAULT_RUN_CAPTURE_MAX_CLAIM_CHECK_BYTES = 128 * 1024 * 1024;

export function readRunCaptureClaimCheck(
  pathValue: unknown,
  expectedSha256: unknown,
  spoolDir = DEFAULT_RUN_CAPTURE_CLAIM_CHECK_SPOOL_DIR,
  maxBytes = DEFAULT_RUN_CAPTURE_MAX_CLAIM_CHECK_BYTES,
): string | null {
  if (
    typeof pathValue !== "string" ||
    pathValue.length === 0 ||
    !isAbsolute(pathValue) ||
    typeof expectedSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(expectedSha256) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  ) {
    return null;
  }

  try {
    const rootInfo = lstatSync(spoolDir);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null;
    const canonicalRoot = realpathSync(spoolDir);
    const canonicalPath = realpathSync(pathValue);
    const pathFromRoot = relative(canonicalRoot, canonicalPath);
    if (
      pathFromRoot.length === 0 ||
      pathFromRoot === ".." ||
      pathFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(pathFromRoot)
    ) {
      return null;
    }

    const info = statSync(canonicalPath);
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) return null;

    const bytes = readFileSync(canonicalPath);
    if (bytes.byteLength !== info.size) return null;
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== expectedSha256) return null;

    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

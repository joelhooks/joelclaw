import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function isSameOrInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function canonicalizePath(path: string): string | null {
  const missingSegments: string[] = [];
  let current = resolve(path);

  while (true) {
    try {
      return resolve(realpathSync(current), ...missingSegments);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;

      const parent = dirname(current);
      if (parent === current) return null;
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

export type SafeTemporaryPathOptions = {
  tmpRoot?: string;
  homeDir?: string;
  allowRoot?: boolean;
};

/** Resolve a scratch target only when its canonical path stays under a safe temp root. */
export function resolveSafeTemporaryPath(
  path: string,
  options: SafeTemporaryPathOptions = {},
): string | null {
  const configuredHomeDir = options.homeDir ?? process.env.HOME ?? homedir();
  const homeDir = canonicalizePath(configuredHomeDir);
  const realTmpRoot = canonicalizePath(options.tmpRoot ?? "/tmp");
  const realCandidate = canonicalizePath(path);
  if (!homeDir || !realTmpRoot || !realCandidate) return null;
  try {
    if (lstatSync(resolve(path)).isSymbolicLink()) return null;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "ENOENT" && code !== "ENOTDIR") return null;
  }
  if (isProtectedHarnessPath(realTmpRoot, homeDir)) return null;
  if (!isSameOrInside(realTmpRoot, realCandidate)) return null;
  if (realCandidate === realTmpRoot && options.allowRoot !== true) return null;
  if (isProtectedHarnessPath(realCandidate, homeDir)) return null;
  return realCandidate;
}

/** Resolve an existing scratch directory; reject files and unsafe aliases. */
export function resolveSafeTemporaryDirectory(
  path: string,
  options: Omit<SafeTemporaryPathOptions, "allowRoot"> = {},
): string | null {
  const safePath = resolveSafeTemporaryPath(path, options);
  if (!safePath) return null;
  try {
    return statSync(safePath).isDirectory() ? safePath : null;
  } catch {
    return null;
  }
}

/** True when a path belongs to an agent harness, Run store, or capture outbox. */
export function isProtectedHarnessPath(
  path: string,
  homeDir = process.env.HOME || homedir(),
): boolean {
  const canonicalHome = canonicalizePath(homeDir);
  const expandedPath =
    path.startsWith("~/") && canonicalHome ? join(canonicalHome, path.slice(2)) : path;
  const candidate = canonicalizePath(expandedPath);
  if (!canonicalHome || !candidate) return true;

  const roots = [
    ".pi",
    ".claude",
    ".codex",
    ".cursor",
    ".grok",
    ".opencode",
    ".config/opencode",
    ".local/share/opencode",
    "Library/Application Support/opencode",
    ".joelclaw/runs-dev",
    ".joelclaw/capture",
    ".joelclaw/outbox",
  ].map((root) => join(canonicalHome, root));

  const configuredRunStore = process.env.MEMORY_RUN_STORE?.trim();
  if (configuredRunStore) {
    const expandedRunStore = configuredRunStore.startsWith("~/")
      ? join(canonicalHome, configuredRunStore.slice(2))
      : configuredRunStore;
    const canonicalRunStore = canonicalizePath(expandedRunStore);
    if (!canonicalRunStore) return true;
    roots.push(canonicalRunStore);
  }
  if (roots.some((root) => isSameOrInside(root, candidate))) return true;

  const homeRelativePath = relative(canonicalHome, candidate);
  return homeRelativePath.split(sep).includes("outbox");
}

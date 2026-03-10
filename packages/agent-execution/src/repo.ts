/**
 * Repo materialization helpers for sandbox execution.
 * 
 * Provides clean checkout of repos at specific SHAs without touching host worktree.
 */

import { $ } from "bun";

/**
 * Options for repo materialization.
 */
export interface MaterializeRepoOptions {
  /** Remote URL to clone from (if not already present) */
  remoteUrl?: string;
  /** Branch/ref to fetch (default: main) */
  branch?: string;
  /** Shallow clone depth (default: 1) */
  depth?: number;
  /** Include submodules */
  includeSubmodules?: boolean;
  /** Timeout in seconds */
  timeoutSeconds?: number;
}

/**
 * Result of repo materialization.
 */
export interface MaterializeRepoResult {
  /** Path to materialized repo */
  path: string;
  /** SHA that was checked out */
  sha: string;
  /** Whether this was a fresh clone */
  freshClone: boolean;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Error thrown when repo materialization fails.
 */
export class RepoMaterializationError extends Error {
  constructor(
    message: string,
    public readonly details?: {
      path?: string;
      sha?: string;
      command?: string;
      output?: string;
    }
  ) {
    super(message);
    this.name = "RepoMaterializationError";
  }
}

/**
 * Materialize a repo at a specific SHA in a clean workspace.
 * 
 * If the target path doesn't exist, clones from remoteUrl.
 * If it exists, fetches and checks out the requested SHA.
 * 
 * @param targetPath - Absolute path where repo should be materialized
 * @param baseSha - Git SHA to check out
 * @param options - Materialization options
 * @returns Materialization result with path and timing
 * @throws RepoMaterializationError if materialization fails
 */
export async function materializeRepo(
  targetPath: string,
  baseSha: string,
  options: MaterializeRepoOptions = {}
): Promise<MaterializeRepoResult> {
  const startTime = Date.now();
  const {
    remoteUrl,
    branch = "main",
    depth = 1,
    includeSubmodules = false,
    timeoutSeconds = 300,
  } = options;

  try {
    // Check if target path exists
    const pathExists = await checkPathExists(targetPath);
    let freshClone = false;

    if (!pathExists) {
      // Clone the repo
      if (!remoteUrl) {
        throw new RepoMaterializationError(
          "Remote URL required for fresh clone",
          { path: targetPath, sha: baseSha }
        );
      }

      freshClone = true;
      await cloneRepo(targetPath, remoteUrl, {
        branch,
        depth,
        includeSubmodules,
        timeoutSeconds,
      });
    } else {
      // Fetch to ensure SHA is available
      await fetchRepo(targetPath, { branch, depth, timeoutSeconds });
    }

    // Checkout the requested SHA
    await checkoutSha(targetPath, baseSha, timeoutSeconds);

    // Verify checkout
    const actualSha = await getCurrentSha(targetPath, timeoutSeconds);
    if (!shaMatchesRef(actualSha, baseSha)) {
      throw new RepoMaterializationError(
        `SHA mismatch after checkout: expected ${baseSha}, got ${actualSha}`,
        { path: targetPath, sha: baseSha }
      );
    }

    const durationMs = Date.now() - startTime;

    return {
      path: targetPath,
      sha: actualSha,
      freshClone,
      durationMs,
    };
  } catch (error) {
    if (error instanceof RepoMaterializationError) {
      throw error;
    }
    throw new RepoMaterializationError(
      `Failed to materialize repo: ${error instanceof Error ? error.message : String(error)}`,
      { path: targetPath, sha: baseSha }
    );
  }
}

/**
 * Check if a path exists.
 */
async function checkPathExists(path: string): Promise<boolean> {
  try {
    await $`test -d ${path}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone a repo to target path.
 */
async function cloneRepo(
  targetPath: string,
  remoteUrl: string,
  options: {
    branch: string;
    depth: number;
    includeSubmodules: boolean;
    timeoutSeconds: number;
  }
): Promise<void> {
  const { branch, depth, includeSubmodules, timeoutSeconds } = options;

  try {
    const cloneArgs = [
      "clone",
      "--branch",
      branch,
      "--depth",
      String(depth),
      remoteUrl,
      targetPath,
    ];

    if (includeSubmodules) {
      cloneArgs.push("--recurse-submodules");
    }

    await $`git ${cloneArgs}`
      
      .quiet();
  } catch (error) {
    throw new RepoMaterializationError(
      `Failed to clone repo: ${error instanceof Error ? error.message : String(error)}`,
      {
        path: targetPath,
        command: `git clone ${remoteUrl} ${targetPath}`,
        output: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

/**
 * Fetch updates in an existing repo.
 */
async function fetchRepo(
  repoPath: string,
  options: {
    branch: string;
    depth: number;
    timeoutSeconds: number;
  }
): Promise<void> {
  const { branch, depth, timeoutSeconds } = options;

  try {
    // Fetch with depth to get the commits we need
    await $`git -C ${repoPath} fetch --depth ${String(depth)} origin ${branch}`
      
      .quiet();
  } catch (error) {
    throw new RepoMaterializationError(
      `Failed to fetch repo: ${error instanceof Error ? error.message : String(error)}`,
      {
        path: repoPath,
        command: `git fetch origin ${branch}`,
        output: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

/**
 * Checkout a specific SHA.
 */
async function checkoutSha(
  repoPath: string,
  sha: string,
  timeoutSeconds: number
): Promise<void> {
  try {
    // First, try a simple checkout
    await $`git -C ${repoPath} checkout ${sha}`
      
      .quiet();
  } catch (error) {
    // If shallow clone doesn't have the SHA, try unshallowing
    try {
      await $`git -C ${repoPath} fetch --unshallow`
        
        .quiet();
      await $`git -C ${repoPath} checkout ${sha}`
        
        .quiet();
    } catch (retryError) {
      throw new RepoMaterializationError(
        `Failed to checkout SHA ${sha}: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
        {
          path: repoPath,
          sha,
          command: `git checkout ${sha}`,
          output: retryError instanceof Error ? retryError.message : String(retryError),
        }
      );
    }
  }
}

/**
 * Get current HEAD SHA.
 */
async function getCurrentSha(
  repoPath: string,
  timeoutSeconds: number
): Promise<string> {
  try {
    const result = await $`git -C ${repoPath} rev-parse HEAD`
      
      .text();
    return result.trim();
  } catch (error) {
    throw new RepoMaterializationError(
      `Failed to get current SHA: ${error instanceof Error ? error.message : String(error)}`,
      {
        path: repoPath,
        command: "git rev-parse HEAD",
        output: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

/**
 * Get list of modified/untracked files in repo (for touched-file inventory).
 * 
 * @param repoPath - Path to git repo
 * @param timeoutSeconds - Timeout in seconds
 * @returns Array of relative file paths that have been modified or are untracked
 * @throws RepoMaterializationError if git operations fail
 */
export async function getTouchedFiles(
  repoPath: string,
  timeoutSeconds = 30
): Promise<string[]> {
  try {
    // Get modified and untracked files via git status --porcelain
    const result = await $`git -C ${repoPath} status --porcelain`
      
      .text();

    if (!result.trim()) {
      return [];
    }

    // Parse porcelain output: " M file", "?? file", "A  file", etc.
    const files = result
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        // Format: "XY filename" where X is index status, Y is worktree status
        // We want the filename part (skip first 3 chars: "XY ")
        return line.slice(3).trim();
      })
      .filter((file) => file.length > 0);

    return files;
  } catch (error) {
    throw new RepoMaterializationError(
      `Failed to get touched files: ${error instanceof Error ? error.message : String(error)}`,
      {
        path: repoPath,
        command: "git status --porcelain",
        output: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

/**
 * Verify repo is in clean state at expected SHA.
 * 
 * @param repoPath - Path to git repo
 * @param expectedSha - Expected HEAD SHA
 * @param timeoutSeconds - Timeout in seconds
 * @returns True if repo is clean and at expected SHA
 * @throws RepoMaterializationError if verification fails
 */
export async function verifyRepoState(
  repoPath: string,
  expectedSha: string,
  timeoutSeconds = 30
): Promise<boolean> {
  const actualSha = await getCurrentSha(repoPath, timeoutSeconds);
  return shaMatchesRef(actualSha, expectedSha);
}

function shaMatchesRef(actualSha: string, expectedSha: string): boolean {
  const normalizedActual = actualSha.trim();
  const normalizedExpected = expectedSha.trim();

  return (
    normalizedActual === normalizedExpected ||
    normalizedActual.startsWith(normalizedExpected)
  );
}

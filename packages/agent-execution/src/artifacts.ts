/**
 * Artifact export helpers for sandbox execution.
 * 
 * Produces auditable patch artifacts and manifests from sandbox runs.
 */

import { $ } from "bun";
import { getTouchedFiles } from "./repo.js";
import type { ExecutionArtifacts } from "./types.js";

/**
 * Options for generating patch artifacts.
 */
export interface GeneratePatchOptions {
  /** Repo path to generate patch from */
  repoPath: string;
  /** Base SHA (start of diff range) */
  baseSha: string;
  /** Head SHA (end of diff range, default: HEAD) */
  headSha?: string;
  /** Include untracked files in patch */
  includeUntracked?: boolean;
  /** Verification commands that were run */
  verificationCommands?: string[];
  /** Verification success flag */
  verificationSuccess?: boolean;
  /** Verification output */
  verificationOutput?: string;
  /** Execution log path */
  executionLogPath?: string;
  /** Verification log path */
  verificationLogPath?: string;
  /** Timeout in seconds */
  timeoutSeconds?: number;
}

/**
 * Error thrown when artifact generation fails.
 */
export class ArtifactGenerationError extends Error {
  constructor(
    message: string,
    public readonly details?: {
      repoPath?: string;
      baseSha?: string;
      headSha?: string;
      command?: string;
      output?: string;
    }
  ) {
    super(message);
    this.name = "ArtifactGenerationError";
  }
}

/**
 * Generate a patch artifact from a git repo.
 * 
 * Creates a git patch from baseSha to headSha (or HEAD) plus manifest metadata.
 * 
 * @param options - Patch generation options
 * @returns ExecutionArtifacts with patch content and metadata
 * @throws ArtifactGenerationError if patch generation fails
 */
export async function generatePatchArtifact(
  options: GeneratePatchOptions
): Promise<ExecutionArtifacts> {
  const {
    repoPath,
    baseSha,
    headSha: providedHeadSha,
    includeUntracked = true,
    verificationCommands,
    verificationSuccess,
    verificationOutput,
    executionLogPath,
    verificationLogPath,
    timeoutSeconds = 60,
  } = options;

  try {
    // Get actual HEAD SHA
    const headSha = providedHeadSha || (await getCurrentSha(repoPath, timeoutSeconds));

    // Get touched files
    const touchedFiles = await getTouchedFiles(repoPath, timeoutSeconds);

    // Generate patch
    const patch = await generatePatch(repoPath, baseSha, headSha, {
      includeUntracked,
      timeoutSeconds,
    });

    // Build artifacts object
    const artifacts: ExecutionArtifacts = {
      headSha,
      touchedFiles,
      patch,
    };

    // Add verification data if provided
    if (verificationCommands) {
      artifacts.verification = {
        commands: verificationCommands,
        success: verificationSuccess ?? false,
        output: verificationOutput,
      };
    }

    // Add log references if provided
    if (executionLogPath || verificationLogPath) {
      artifacts.logs = {
        executionLog: executionLogPath,
        verificationLog: verificationLogPath,
      };
    }

    return artifacts;
  } catch (error) {
    if (error instanceof ArtifactGenerationError) {
      throw error;
    }
    throw new ArtifactGenerationError(
      `Failed to generate patch artifact: ${error instanceof Error ? error.message : String(error)}`,
      { repoPath, baseSha, headSha: providedHeadSha }
    );
  }
}

/**
 * Get current HEAD SHA.
 */
async function getCurrentSha(repoPath: string, timeoutSeconds: number): Promise<string> {
  try {
    const result = await $`git -C ${repoPath} rev-parse HEAD`
      
      .text();
    return result.trim();
  } catch (error) {
    throw new ArtifactGenerationError(
      `Failed to get current SHA: ${error instanceof Error ? error.message : String(error)}`,
      {
        repoPath,
        command: "git rev-parse HEAD",
        output: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

/**
 * Generate a git patch between two SHAs.
 */
async function generatePatch(
  repoPath: string,
  baseSha: string,
  headSha: string,
  options: {
    includeUntracked: boolean;
    timeoutSeconds: number;
  }
): Promise<string> {
  const { includeUntracked, timeoutSeconds } = options;

  try {
    // Generate diff/patch from baseSha to headSha
    let patch: string;

    // Check if we have commits between baseSha and headSha
    const hasCommits = await checkCommitRange(repoPath, baseSha, headSha, timeoutSeconds);

    if (hasCommits) {
      // Use git format-patch for committed changes
      patch = await $`git -C ${repoPath} format-patch --stdout ${baseSha}..${headSha}`
        
        .text();
    } else if (baseSha === headSha) {
      // Use git diff for uncommitted changes (diff between HEAD and working tree)
      patch = await $`git -C ${repoPath} diff HEAD`
        
        .text();
    } else {
      // Use git diff for uncommitted changes at baseSha
      patch = await $`git -C ${repoPath} diff ${baseSha}`
        
        .text();
    }

    // If including untracked files, add them
    if (includeUntracked) {
      const untrackedPatch = await getUntrackedFilesPatch(repoPath, timeoutSeconds);
      if (untrackedPatch) {
        patch = patch + "\n" + untrackedPatch;
      }
    }

    return patch;
  } catch (error) {
    throw new ArtifactGenerationError(
      `Failed to generate patch: ${error instanceof Error ? error.message : String(error)}`,
      {
        repoPath,
        baseSha,
        headSha,
        command: `git format-patch/diff ${baseSha}..${headSha}`,
        output: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

/**
 * Check if there are commits in the range baseSha..headSha.
 */
async function checkCommitRange(
  repoPath: string,
  baseSha: string,
  headSha: string,
  timeoutSeconds: number
): Promise<boolean> {
  try {
    const result = await $`git -C ${repoPath} rev-list --count ${baseSha}..${headSha}`
      
      .text();
    const count = Number.parseInt(result.trim(), 10);
    return count > 0;
  } catch {
    // If command fails, assume no commits (might be uncommitted changes)
    return false;
  }
}

/**
 * Get patch content for untracked files.
 */
async function getUntrackedFilesPatch(
  repoPath: string,
  timeoutSeconds: number
): Promise<string> {
  try {
    // Get list of untracked files
    const result = await $`git -C ${repoPath} ls-files --others --exclude-standard`
      
      .text();

    const untrackedFiles = result
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (untrackedFiles.length === 0) {
      return "";
    }

    // Generate patch-like content for untracked files
    let patch = "\n# Untracked files\n";
    for (const file of untrackedFiles) {
      const content = await $`cat ${repoPath}/${file}`
        
        .text();
      
      patch += `\n--- /dev/null\n`;
      patch += `+++ b/${file}\n`;
      patch += `@@ -0,0 +1,${content.split("\n").length} @@\n`;
      for (const line of content.split("\n")) {
        patch += `+${line}\n`;
      }
    }

    return patch;
  } catch (error) {
    // If we can't get untracked files, log but don't fail
    console.warn(`Warning: failed to include untracked files: ${error}`);
    return "";
  }
}

/**
 * Write artifact bundle to disk.
 * 
 * @param artifacts - Execution artifacts to write
 * @param outputPath - Path to write artifacts.json
 * @returns Written file path
 * @throws ArtifactGenerationError if write fails
 */
export async function writeArtifactBundle(
  artifacts: ExecutionArtifacts,
  outputPath: string
): Promise<string> {
  try {
    const content = JSON.stringify(artifacts, null, 2);
    await Bun.write(outputPath, content);
    return outputPath;
  } catch (error) {
    throw new ArtifactGenerationError(
      `Failed to write artifact bundle: ${error instanceof Error ? error.message : String(error)}`,
      { output: error instanceof Error ? error.message : String(error) }
    );
  }
}

/**
 * Read artifact bundle from disk.
 * 
 * @param inputPath - Path to artifacts.json
 * @returns Parsed execution artifacts
 * @throws ArtifactGenerationError if read/parse fails
 */
export async function readArtifactBundle(inputPath: string): Promise<ExecutionArtifacts> {
  try {
    const file = Bun.file(inputPath);
    const content = await file.text();
    const artifacts = JSON.parse(content) as ExecutionArtifacts;
    return artifacts;
  } catch (error) {
    throw new ArtifactGenerationError(
      `Failed to read artifact bundle: ${error instanceof Error ? error.message : String(error)}`,
      { output: error instanceof Error ? error.message : String(error) }
    );
  }
}

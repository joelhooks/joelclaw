import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFilePromise = promisify(execFile)

export const FLEET_DEFAULT_SCOPE = {
  project: "joelclaw-fleet",
  workstream: "default",
} as const

export type RepositoryScope = {
  readonly project: string
  readonly workstream: string
}

export type GitCommandResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly transient: boolean }

export type GitCommand = (
  cwd: string,
  ...arguments_: readonly string[]
) => Promise<GitCommandResult>

export type GitHubRepositoryIdentity = {
  readonly canonicalRepository: string
  readonly project: string
  readonly repositoryHost: "github.com"
  readonly repositoryName: string
  readonly repositoryOwner: string
}

export type TrustedRepositoryScopeResolution = GitHubRepositoryIdentity & {
  readonly _tag: "TrustedRepository"
  readonly repositoryRoot: string
  readonly scope: RepositoryScope
  readonly workstreamResolution: "branch" | "detached-head" | "branch-fallback"
}

export type RepositoryScopeResolution =
  | TrustedRepositoryScopeResolution
  | { readonly _tag: "NoRepository" }
  | { readonly _tag: "UntrustedRepository"; readonly repositoryRoot: string }
  | { readonly _tag: "TransientFailure" }

export function canonicalScopeKey(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9._/-]+/gu, "-")
    .replaceAll(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "")
    .slice(0, 240)
  return normalized.length === 0 ? fallback : normalized
}

export function parseGitHubRemote(remote: string): GitHubRepositoryIdentity | undefined {
  const match = remote
    .trim()
    .match(
      /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/iu,
    )
  if (!match) return undefined

  const owner = canonicalScopeKey(match[1] ?? "", "unknown")
  const name = canonicalScopeKey(match[2] ?? "", "unknown")
  if (owner === "unknown" || name === "unknown") return undefined

  return {
    canonicalRepository: `github.com/${owner}/${name}`,
    project: `${owner}.${name}`,
    repositoryHost: "github.com",
    repositoryName: name,
    repositoryOwner: owner,
  }
}

export const runGit: GitCommand = async (cwd, ...arguments_) => {
  try {
    const result = await execFilePromise("git", ["-C", cwd, ...arguments_], {
      encoding: "utf8",
      timeout: 2_000,
    })
    return { ok: true, value: result.stdout.trim() }
  } catch (error) {
    const details = error as { readonly code?: number | string; readonly killed?: boolean }
    return {
      ok: false,
      transient: details.killed === true || details.code === "ETIMEDOUT",
    }
  }
}

export async function resolveRepositoryScope(input: {
  readonly cwd: string
  readonly git?: GitCommand
}): Promise<RepositoryScopeResolution> {
  const git = input.git ?? runGit
  const root = await git(input.cwd, "rev-parse", "--show-toplevel")
  if (!root.ok) return root.transient ? { _tag: "TransientFailure" } : { _tag: "NoRepository" }

  const remote = await git(root.value, "remote", "get-url", "origin")
  if (!remote.ok) {
    return remote.transient
      ? { _tag: "TransientFailure" }
      : { _tag: "UntrustedRepository", repositoryRoot: root.value }
  }

  const identity = parseGitHubRemote(remote.value)
  if (!identity) return { _tag: "UntrustedRepository", repositoryRoot: root.value }

  const branch = await git(root.value, "symbolic-ref", "--quiet", "--short", "HEAD")
  const workstream = canonicalScopeKey(branch.ok ? branch.value : "default", "default")
  return {
    _tag: "TrustedRepository",
    ...identity,
    repositoryRoot: root.value,
    scope: { project: identity.project, workstream },
    workstreamResolution: branch.ok
      ? "branch"
      : branch.transient
        ? "branch-fallback"
        : "detached-head",
  }
}

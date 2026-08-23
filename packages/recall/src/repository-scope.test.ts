import { describe, expect, test } from "bun:test"

import {
  type GitCommand,
  type GitCommandResult,
  parseGitHubRemote,
  resolveRepositoryScope,
} from "./repository-scope"

function gitFixture(results: Readonly<Record<string, GitCommandResult>>): GitCommand {
  return async (_cwd, ...args) => results[args.join(" ")] ?? { ok: false, transient: false }
}

for (const [label, remote] of [
  ["SSH", "git@github.com:joelhooks/joelclaw.git"],
  ["SSH URL", "ssh://git@github.com/joelhooks/joelclaw.git"],
  ["HTTPS", "https://github.com/joelhooks/joelclaw.git"],
] as const) {
  test(`parses ${label} GitHub remotes`, () => {
    expect(parseGitHubRemote(remote)).toMatchObject({
      canonicalRepository: "github.com/joelhooks/joelclaw",
      project: "joelhooks.joelclaw",
    })
  })
}

describe("repository scope resolution", () => {
  test("resolves a trusted branch", async () => {
    const result = await resolveRepositoryScope({
      cwd: "/repo/subdir",
      git: gitFixture({
        "rev-parse --show-toplevel": { ok: true, value: "/repo" },
        "remote get-url origin": { ok: true, value: "git@github.com:JoelHooks/JoelClaw.git" },
        "symbolic-ref --quiet --short HEAD": { ok: true, value: "worker/Recall Cutover" },
      }),
    })
    expect(result).toMatchObject({
      _tag: "TrustedRepository",
      scope: { project: "joelhooks.joelclaw", workstream: "worker/recall-cutover" },
      workstreamResolution: "branch",
    })
  })

  test("preserves capture's detached-HEAD default workstream", async () => {
    const result = await resolveRepositoryScope({
      cwd: "/repo",
      git: gitFixture({
        "rev-parse --show-toplevel": { ok: true, value: "/repo" },
        "remote get-url origin": { ok: true, value: "https://github.com/joelhooks/joelclaw" },
        "symbolic-ref --quiet --short HEAD": { ok: false, transient: false },
      }),
    })
    expect(result).toMatchObject({
      _tag: "TrustedRepository",
      scope: { project: "joelhooks.joelclaw", workstream: "default" },
      workstreamResolution: "detached-head",
    })
  })

  test("preserves capture fallback on a transient branch lookup failure", async () => {
    const result = await resolveRepositoryScope({
      cwd: "/repo",
      git: gitFixture({
        "rev-parse --show-toplevel": { ok: true, value: "/repo" },
        "remote get-url origin": { ok: true, value: "https://github.com/joelhooks/joelclaw" },
        "symbolic-ref --quiet --short HEAD": { ok: false, transient: true },
      }),
    })
    expect(result).toMatchObject({
      _tag: "TrustedRepository",
      scope: { project: "joelhooks.joelclaw", workstream: "default" },
      workstreamResolution: "branch-fallback",
    })
  })

  test("reports no repository without choosing fleet default", async () => {
    const result = await resolveRepositoryScope({
      cwd: "/tmp",
      git: gitFixture({
        "rev-parse --show-toplevel": { ok: false, transient: false },
      }),
    })
    expect(result).toEqual({ _tag: "NoRepository" })
  })

  test("rejects an untrusted remote", async () => {
    const result = await resolveRepositoryScope({
      cwd: "/repo",
      git: gitFixture({
        "rev-parse --show-toplevel": { ok: true, value: "/repo" },
        "remote get-url origin": { ok: true, value: "git@gitlab.com:joelhooks/joelclaw.git" },
      }),
    })
    expect(result).toEqual({ _tag: "UntrustedRepository", repositoryRoot: "/repo" })
  })
})

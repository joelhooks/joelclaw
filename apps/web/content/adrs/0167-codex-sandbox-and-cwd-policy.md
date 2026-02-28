# ADR-0167: Codex Sandbox + CWD Policy

**Status**: proposed
**Date**: 2026-02-28
**Supersedes**: none
**Superseded-by**: 

## Context

Codex tasks intermittently fail to write files due to sandbox/cwd mismatches rather than code errors. This creates false negatives, wasted retries, and lost trust in autonomous execution.

Observed failure modes:
- Task started without correct `cwd`, so writes target the wrong workspace.
- Task needs to touch files outside repo cwd (dotfiles, symlink targets), but sandbox remained `workspace-write`.
- Task needs host-level network/tool access, but sandbox limits block it.
- Failure appears as "did not write files" even though prompt quality was fine.

Sandboxing is still mandatory, but policy must be explicit and repeatable.

## Decision

Adopt a mandatory Codex invocation policy across joelclaw prompts and agent guides:

1. Every Codex task MUST set `cwd` explicitly.
2. Every Codex task MUST set `sandbox` explicitly.
3. Sandbox selection rubric:
   - `workspace-write`: default for repo-local edits inside `cwd`
   - `danger-full-access`: required when task touches paths outside `cwd`, uses host dotfiles/symlink targets, or requires host-level tools/network blocked by workspace sandbox
   - `read-only`: analysis-only tasks, never for write tasks
4. If a Codex write task fails with sandbox/permission symptoms, retry once with `danger-full-access` and same prompt + cwd.
5. Do not interpret sandbox write failures as code failure until sandbox/cwd policy is satisfied.

## Implementation

- Update gateway agent policy (`~/.joelclaw/gateway/AGENTS.md`) with explicit `cwd` + `sandbox` requirement and anti-patterns.
- Update system prompt (`SYSTEM.md`) non-negotiables to require explicit codex sandbox/cwd.
- Add codex usage guidance to joelclaw docs (`docs/`), and keep current via documentation mandate.

## Consequences

### Positive
- Eliminates a major class of false task failures.
- Preserves sandbox safety while restoring autonomy.
- Makes execution policy auditable and teachable.

### Negative
- Slightly more verbose Codex dispatch calls.
- More deliberate escalation to `danger-full-access` when justified.

### Neutral
- Does not remove sandboxing; it makes sandbox choice explicit.
- Keeps principle of least privilege by defaulting to `workspace-write`.

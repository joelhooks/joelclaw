---
status: "proposed"
date: 2026-02-14
decision-makers: "Joel Hooks"
consulted: "Claude (pi session 2026-02-14), Codex (implementation review)"
informed: "All agents operating on this system"
---

# Upgrade durable coding loops to v2 with Docker-isolated execution and stronger loop controls

## Context and Problem Statement

ADR-0005 established the durable PLANNER → IMPLEMENTOR → REVIEWER → JUDGE loop on Inngest and was implemented on 2026-02-14. Initial build + smoke test validated the architecture but exposed practical failures in v1 execution:

- loop execution shares the host working tree with humans, causing collisions
- launchd PATH variability makes CLI tool discovery brittle
- implementor prompts lack project context, causing thrash on real repos
- story execution lacks branch isolation for clean review/merge
- `maxIterations` is accepted but not enforced
- story duration is not measured end-to-end
- harness can double-commit when codex auto-commits

ADR-0005 already flagged Docker sandboxing as a v2 requirement. This ADR formalizes the full v2 upgrade package so loop execution becomes isolated, repeatable, and observable.

Related: [ADR-0005 — Durable multi-agent coding loops](0005-durable-multi-agent-coding-loops.md), [ADR-0006 — Observability (Prometheus + Grafana)](0006-observability-prometheus-grafana.md)

## Decision Drivers

* **Isolation and safety** — loop runs must not modify host state beyond intentional git push
* **Concurrency** — multiple loops should run safely on the same project without working tree conflicts
* **Deterministic runtime** — codex/claude/pi/git/bun availability must not depend on launchd shell environment
* **Code quality throughput** — implementor must receive enough repo context to reduce retry churn
* **Reviewable output** — each loop should produce a dedicated feature branch for human merge
* **Control correctness** — `maxIterations` and story-attempt bounds must be hard-enforced
* **Observability alignment** — story duration and outcomes must feed ADR-0006 metrics

## Considered Options

* **Option A: Keep current host execution (no isolation)**
* **Option B: Git worktree isolation on host**
* **Option C: Per-loop Docker sandbox containers (repo clone + branch + toolchain)**

## Decision Outcome

Chosen option: **Option C — per-loop Docker sandbox containers**, with additional loop-control and prompt-quality upgrades as one cohesive v2 change.

Each loop run creates an isolated container image/runtime with `bun`, `git`, `codex`, `claude`, and `pi` preinstalled. The loop clones the target repo via GitHub App installation credentials (`joelclawgithub[bot]`, App ID `2867136`) using ephemeral HTTPS tokens, creates `agent-loop/{loopId}`, executes stories, and pushes the branch for human review.

This decision also mandates:

- richer implementor prompt construction from project artifacts
- feature-branch lifecycle managed by PLANNER at loop start
- strict `maxIterations` enforcement in planner flow control
- story duration propagation through IMPLEMENTOR → REVIEWER → JUDGE and emitted terminal events
- double-commit prevention in harness commit step
- fallback launchd PATH documentation for non-Docker execution

### Consequences

* Good, because host working tree collisions are eliminated by container-local clones
* Good, because Docker image pins tool paths and versions, removing launchd PATH drift
* Good, because parallel loop runs are possible without git index/worktree contention
* Good, because branch-per-loop yields clean PR review and merge workflow
* Good, because richer prompts should reduce implementor retries on mature codebases
* Good, because duration metrics become available for ADR-0006 Prometheus dashboards
* Bad, because container image build/maintenance adds operational surface area
* Bad, because clone + environment startup adds per-loop latency
* Bad, because GitHub App auth flow introduces additional failure modes (token minting, installation scope)
* Neutral, because worktrees remain a valid fallback where Docker is unavailable

## Scope of Supersession and Relationships

- **Depends on ADR-0005**: v2 extends the accepted multi-agent architecture; no role-model change.
- **Supersedes ADR-0005 sections**: v1 execution limitations and the deferred v2 sandbox recommendation are replaced by this concrete design and implementation plan.
- **Related to ADR-0006**: this ADR introduces duration and outcome fields that must be exported as Prometheus metrics (`story_duration_seconds`, pass/fail counters, iteration counts, retry counts).

## Implementation Plan

### 1) Docker sandbox execution model

Create a dedicated runtime image for loop execution and move all IMPLEMENTOR/REVIEWER/JUDGE tool execution into per-loop containers.

- Build image with fixed toolchain:
  - `bun`
  - `git`
  - `codex` CLI
  - `claude` CLI
  - `pi` CLI
- At `agent/loop.start` (or first planner step):
  - create container for `loopId`
  - mint GitHub App installation token from secrets (`github_app_id`, `github_app_client_id`, `github_app_installation_id`, `github_app_pem`)
  - clone repo over HTTPS into container workspace
  - create and checkout `agent-loop/{loopId}`
- On terminal success/failure/cancel:
  - push branch when configured (always on completion, optionally on failure for forensic review)
  - collect logs/artifacts
  - remove container

### 2) Rich implementor prompt assembly

Upgrade prompt builder to include project context and prior attempts.

Inputs to include before each IMPLEMENTOR call:

- story title, description, acceptance criteria (existing)
- `progress.txt` codebase patterns section (if present)
- `CLAUDE.md` and/or `AGENTS.md` instructions (if present)
- key project file inventory (entrypoints, config, package manifests, test config)
- prior attempt feedback from REVIEWER/JUDGE events for the same story

Guardrails:

- cap prompt sections by token budget with deterministic truncation order
- include file paths and short excerpts, not whole-file dumps

### 3) Feature branch lifecycle per loop

PLANNER owns branch creation and branch metadata.

- On loop start, PLANNER records branch name `agent-loop/{loopId}` in loop state
- All story commits target this branch
- At loop completion, push branch and emit branch/ref metadata in `agent/loop.complete`
- Human reviews and merges branch; loop never commits directly to default branch

### 4) Enforce `maxIterations`

In planner story selection:

- compute `attemptedStories = completedStories + skippedStories`
- if `attemptedStories >= maxIterations`, stop loop and emit `agent/loop.complete` with reason `max_iterations_reached`
- record final counters in terminal event payload

### 5) Story duration tracking

Add timing envelope for each story attempt.

- set `storyStartTime` at IMPLEMENTOR entry
- pass timestamp through REVIEWER and JUDGE payloads
- emit `durationMs` (and/or seconds) in:
  - `agent/loop.story.pass`
  - `agent/loop.story.fail`
- export metrics in observability pipeline (ADR-0006):
  - histogram: story duration
  - counters: pass/fail by tool and attempt number

### 6) Double-commit prevention

Before harness commit step:

- detect if working tree has staged/unstaged changes
- if no changes, skip harness commit (assume tool already committed or no-op)
- if changes exist, commit once with deterministic message containing `loopId/storyId/attempt`

Optional hardening:

- prefer codex sandbox/no-auto-commit mode when available
- verify final HEAD contains expected story marker before handing to REVIEWER

### 7) PATH reliability and non-Docker fallback

Primary path reliability comes from Docker image tool installation.

Fallback requirement for host-mode execution:

- document required PATH entries in launchd plist for `codex`, `claude`, `pi`, `bun`, `git`
- add startup preflight that resolves required binaries and fails fast with actionable diagnostics

### Affected Paths

- `~/Code/system-bus/src/inngest/functions/agent-loop-plan.ts`
- `~/Code/system-bus/src/inngest/functions/agent-loop-implement.ts`
- `~/Code/system-bus/src/inngest/functions/agent-loop-review.ts`
- `~/Code/system-bus/src/inngest/functions/agent-loop-judge.ts`
- `~/Code/system-bus/src/inngest/client.ts` (event payload extensions for duration/branch/metrics fields)
- `~/Code/system-bus/src/inngest/functions/lib/agent-loop/` (new: container runner, GitHub App auth, prompt builder, git helpers)
- `~/Code/system-bus/docker/agent-loop-runner/Dockerfile` (new)
- `~/Code/system-bus/docker/agent-loop-runner/entrypoint.sh` (new)
- `~/Code/system-bus/prometheus/` + metrics bridge modules (for ADR-0006 integration)
- `~/Library/LaunchAgents/*.plist` or service-managed launchd plist (PATH fallback docs/preflight)
- `~/Vault/Projects/09-joelclaw/ralph-inngest.md` (update operational docs)

### Dependencies and Secrets

- GitHub App bot identity: `joelclawgithub[bot]` (App ID `2867136`)
- Secrets in `agent-secrets`:
  - `github_app_id`
  - `github_app_client_id`
  - `github_app_installation_id`
  - `github_app_pem`
- Container runtime available on host (Docker Desktop / Docker Engine)

### Patterns to Follow

- Preserve ADR-0005 role boundaries (PLANNER/IMPLEMENTOR/REVIEWER/JUDGE)
- Keep event-driven handoffs and idempotency keys `(loopId, storyId, attempt)`
- Emit structured terminal events for all stop conditions (complete, fail, cancel, max-iterations)

### Patterns to Avoid

- No direct host-repo mutation during loop execution
- No default-branch commits from autonomous loop runs
- No implicit dependence on shell startup files for tool discovery

## Verification

### Functional

- [ ] Loop start creates isolated container and clones target repo via GitHub App HTTPS token
- [ ] PLANNER creates and records branch `agent-loop/{loopId}`
- [ ] IMPLEMENTOR prompt includes story data + project context artifacts + prior feedback
- [ ] `maxIterations` stops loop exactly at configured threshold and emits reason
- [ ] Story pass/fail events include measured duration field
- [ ] Harness does not create duplicate commits when tool already committed
- [ ] Branch is pushed and visible for PR workflow on completion

### Isolation and Safety

- [ ] Human editing host repo during loop does not affect in-container execution
- [ ] Two loops can run concurrently for the same project without working tree collisions
- [ ] Container cleanup occurs on completion and cancel paths

### Observability (ADR-0006 linkage)

- [ ] Prometheus receives story duration histogram samples
- [ ] Prometheus receives pass/fail/retry counters tagged by tool
- [ ] Dashboard panel can show loop duration percentiles and pass/fail rate

### Fallback and Operations

- [ ] Host-mode preflight fails with clear missing-binary diagnostics when PATH is incomplete
- [ ] launchd PATH requirements are documented in ops docs and verified once

## Pros and Cons of the Options

### Option A: Current host execution (no isolation)

* Good, because zero new infra and fastest startup path
* Good, because simplest local debugging during development
* Bad, because conflicts with human working tree are unavoidable
* Bad, because PATH/tool discovery under launchd is fragile
* Bad, because poor safety boundary for autonomous tools
* Bad, because concurrent loops on one repo are unsafe

### Option B: Git worktree isolation

* Good, because lower overhead than containers
* Good, because native git workflow without image maintenance
* Good, because separate checkout per loop can reduce direct collisions
* Bad, because still shares host environment and PATH issues
* Bad, because worktree/index edge cases are operationally brittle at scale
* Bad, because weaker safety boundary versus Docker
* Neutral, because acceptable fallback where Docker cannot run

### Option C: Per-loop Docker sandbox containers (Chosen)

* Good, because strongest isolation for filesystem/process/toolchain
* Good, because deterministic CLI availability and versions
* Good, because safer failure domain and easier concurrency model
* Good, because clean branch-oriented clone/push workflow via GitHub App HTTPS auth
* Bad, because image build, caching, and lifecycle management add complexity
* Bad, because startup latency and resource overhead are higher than worktrees
* Bad, because requires robust credential minting and container orchestration logic

## Follow-up Work

- Define `agent-loop-runner` image versioning and upgrade policy
- Add cancellation behavior tests for in-container subprocesses
- Add load test for concurrent loop runs to validate resource bounds
- Add ADR-0006 dashboard panels for loop duration, retries, and success rate

## More Information

- This ADR captures the v2 upgrade set discovered during implementation + initial smoke testing of ADR-0005 on 2026-02-14.

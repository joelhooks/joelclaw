---
status: shipped
date: 2026-02-14
implemented: 2026-02-15
verified: 2026-02-14
decision-makers: "Joel Hooks"
consulted: "Claude (pi session 2026-02-14), Cursor scaling-agents research (Jan 2026), AgentCoder (Huang et al.), ChatDev, MetaGPT, AgentMesh"
informed: "All agents operating on this system"
---

# Adopt Inngest multi-agent pipeline for durable autonomous coding loops

## Context and Problem Statement

joelclaw needs the ability to execute long-running autonomous coding workloads — send an event, go AFK, wake up to stacked PRs with every iteration traceable. No durable autonomous coding loop exists in the system today.

The Ralph pattern (Geoffrey Huntley) proved that a bash loop spawning fresh AI instances per iteration, guided by a PRD, produces working software. Matt Pocock documented the HITL→AFK progression, quality entropy risks, and Docker sandboxing requirements. But bash ralph has no durability (dies with terminal), no observability (blank screen unless you pipe through jq), no retry (whole loop fails), and no multi-tool dispatch (one CLI for everything).

The question: **How should joelclaw implement durable, observable, multi-agent autonomous coding loops that survive crashes, support per-story tool dispatch, and produce high-quality stacked PRs?**

Related: [ADR-0003 — joelclaw over OpenClaw](0003-joelclaw-over-openclaw.md), [ADR-0004 — AT Protocol as bedrock](0004-atproto-federation-native-app.md)

## Decision Drivers

* **Durability** — loops must survive crashes, reboots, and disconnects without losing state
* **Observability** — every iteration must be a traceable run in `igs`, visible from phone via PDS events
* **Quality** — output must pass typecheck + lint + tests + independently-written tests + agent review + agent judgment. No entropy accumulation.
* **Tool flexibility** — different stories need different tools (codex for pure code, pi for browser/research, claude for deep reasoning). Tool and model selection must be per-role, per-story, dynamic.
* **Simplicity** — AgentCoder (3 agents) outperformed ChatDev (7 agents) and MetaGPT (5 agents) on both quality and token efficiency. Fewer roles, tighter pipeline.
* **Learnability** — the system should learn from MCQ approvals and coding outcomes to improve recommendations over time (lamarck-style playbook)
* **Stacked PRs** — each story produces a clean, atomic, independently-reviewable commit. Aspire to jj/Graphite stacked PR workflow, pragmatically use git now.
* **Infrastructure reuse** — Inngest is already running, proven (video pipeline, transcript processing). Don't introduce a new orchestrator.

## Considered Options

* **Option A: Bash ralph (status quo pattern)**
* **Option B: Pi's built-in `ralph_loop` tool**
* **Option C: Inngest multi-agent pipeline with PLANNER→IMPLEMENTOR→REVIEWER→JUDGE**
* **Option D: Off-the-shelf multi-agent framework (CrewAI, AutoGen, LangGraph)**

## Decision Outcome

Chosen option: **Option C — Inngest multi-agent pipeline**, because it builds on proven infrastructure (Inngest already running), each role is an independent function run (retryable, traceable via `igs`), the pipeline maps to the architecture that Cursor validated at scale (Planner-Worker-Judge, Jan 2026), and it stays within the joelclaw principle of owning every layer.

### Consequences

* Good, because every iteration is an Inngest run — `igs run <id>` gives full step trace, timing, errors
* Good, because loops survive crashes/reboots — Inngest handles retry, state lives in events + git
* Good, because REVIEWER writes tests independently from IMPLEMENTOR (AgentCoder insight — avoids biased tests)
* Good, because PDS events enable phone-based observability without terminal access
* Good, because MCQ approval gate at kickoff prevents the system from guessing at intent
* Good, because preference learning shortens the approval flow over time
* Bad, because 4 Inngest functions per story × N stories = many function runs. Monitoring overhead increases.
* Bad, because tool spawning (codex, claude, pi) from within an Inngest function requires subprocess management and output capture
* Bad, because Inngest step output size limits require claim-check pattern for large outputs (already hit this with transcript pipeline)
* Neutral, because git is used now but the commit strategy should evolve toward jj/Graphite stacked PRs when practical

## Implementation Plan

### Architecture: 4-Role Event Chain

```
MCQ Kickoff (human approves plan + tool assignments)
    │
    ▼
agent/loop.start
    │
    ▼
┌──────────────────────────────────────┐
│  PLANNER (agent-loop-plan)           │
│                                      │
│  Reads PRD + progress.txt            │
│  Finds next story (highest priority, │
│    passes: false)                    │
│  Selects tool+model per role         │
│  Emits: agent/loop.implement         │
│                                      │
│  If no stories remain →              │
│    agent/loop.complete               │
└──────────┬───────────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│  IMPLEMENTOR (agent-loop-implement)  │
│                                      │
│  Reads story + codebase patterns     │
│  Writes code + commits               │
│  Does NOT write tests                │
│  Emits: agent/loop.review            │
└──────────┬───────────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│  REVIEWER (agent-loop-review)        │
│                                      │
│  Writes tests from acceptance        │
│    criteria text — does NOT review   │
│    implementation code when          │
│    designing tests (AgentCoder       │
│    insight: independent test design  │
│    avoids bias)                      │
│  Then runs: typecheck + lint + tests │
│    in the implemented repo           │
│  Produces structured feedback        │
│  Emits: agent/loop.judge             │
│    with { feedback, testResults }    │
└──────────┬───────────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│  JUDGE (agent-loop-judge)            │
│                                      │
│  Reads: test results + feedback      │
│  Decision:                           │
│    PASS → update prd.json,           │
│           append progress.txt,       │
│           slog write,                │
│           emit PDS event,            │
│           emit agent/loop.plan       │
│           (next story)               │
│    FAIL → emit agent/loop.implement  │
│           with feedback              │
│           (max N retries)            │
│    FAIL+MAX_RETRIES → skip story,    │
│           flag for human review,     │
│           emit agent/loop.plan       │
└──────────────────────────────────────┘
```

Each box is a **separate Inngest function run**. Independent retry, independent `igs run <id>` trace, independent timeout configuration.

### Affected Paths

* `~/Code/system-bus/src/inngest/functions/agent-loop-plan.ts` — **new**
* `~/Code/system-bus/src/inngest/functions/agent-loop-implement.ts` — **new**
* `~/Code/system-bus/src/inngest/functions/agent-loop-review.ts` — **new**
* `~/Code/system-bus/src/inngest/functions/agent-loop-judge.ts` — **new**
* `~/Code/system-bus/src/inngest/client.ts` — add event types for `agent/loop.*`
* `~/Code/joelhooks/igs/src/cli.ts` — add `igs loop` subcommands (start, status, cancel)
* `~/Vault/Projects/09-joelclaw/ralph-inngest.md` — update to reference this ADR

### Dependencies

* Existing: Inngest, Bun, Effect (for igs CLI)
* Tools spawned: `codex` CLI, `claude` CLI, `pi` CLI (all already installed)
* PRD format: snarktank/ralph-compatible `prd.json` with optional `tool` field per story
* Progress format: ralph-compatible `progress.txt` with `## Codebase Patterns` section

### Event Schema

Every event carries `loopId` + `storyId` + `attempt` for idempotency. Inngest deduplicates on event ID; functions use the `(loopId, storyId, attempt)` tuple as an idempotency key for git operations (commit messages include the tuple, duplicate commits are detected and skipped).

```typescript
// Start a loop — emitted by igs or MCQ approval
"agent/loop.start" → {
  loopId: string,           // unique ID for this loop run (ULID)
  project: string,          // absolute path to project
  prdPath: string,          // relative path to prd.json within project
  maxRetries: number,       // per-story retry limit (default: 2)
  maxIterations: number,    // total stories to attempt (default: all)
  toolAssignments: Record<string, {  // per-story tool overrides (from MCQ)
    implementor: "codex" | "claude" | "pi",
    reviewer: "claude" | "pi",
  }>,
}

// Internal pipeline events — ALL carry loopId + storyId + attempt
// story object is NOT passed between events — only storyId.
// Each function reads the canonical story from prd.json to avoid drift.
"agent/loop.plan"       → { loopId, project, prdPath }
"agent/loop.implement"  → { loopId, project, storyId, tool, attempt, feedback? }
"agent/loop.review"     → { loopId, project, storyId, commitSha, attempt }
"agent/loop.judge"      → { loopId, project, storyId, testResults, feedback, attempt }

// Control events
"agent/loop.cancel"     → { loopId, reason }

// Terminal events
"agent/loop.complete"   → { loopId, project, summary, storiesCompleted, storiesFailed, cancelled }
"agent/loop.story.pass" → { loopId, storyId, commitSha, attempt, duration }
"agent/loop.story.fail" → { loopId, storyId, reason, attempts }
```

**Idempotency contract**: Each function checks `(loopId, storyId, attempt)` before performing side effects. If a commit with message `feat: [loopId] [storyId] attempt-N` already exists in git, the implementor skips re-execution and emits review directly. If prd.json already shows `passes: true` for a story, the planner skips it.

### Concurrency & Safety

```typescript
// One loop per project at a time
// NOTE: v1 uses project path. Future: branch-aware key (path + branch).
concurrency: {
  key: "agent-loop/{{ event.data.project }}",
  limit: 1,
}

// Tool-specific timeouts
// codex: 15 min, claude: 20 min, pi: 20 min
// Configured per function via Inngest timeout option
```

### Cancellation Contract

Every role function checks for cancellation at entry:

```typescript
// Step 0 in every agent-loop-* function:
const cancelled = await step.run("check-cancel", async () => {
  // Read a cancel flag from a known location
  // e.g., /tmp/agent-loop/{loopId}/cancelled
  // or check for agent/loop.cancel event via step.waitForEvent with 0 timeout
  return isCancelled(event.data.loopId);
});
if (cancelled) return { status: "cancelled" }; // do not emit next event
```

**`igs loop cancel <loopId>`** does three things:
1. Emits `agent/loop.cancel` event with `{ loopId, reason }`
2. Writes cancel flag to `/tmp/agent-loop/{loopId}/cancelled`
3. Kills any subprocess spawned by the current function (via PID file at `/tmp/agent-loop/{loopId}/pid`)

**Subprocess management**: Every tool invocation writes its PID to `/tmp/agent-loop/{loopId}/pid`. On cancel, SIGTERM is sent. If the process doesn't exit within 10s, SIGKILL. On function entry, stale PID files from previous attempts are cleaned up.

**Orphan prevention**: A cleanup Inngest cron function (`agent-loop-cleanup`) runs hourly, finds `/tmp/agent-loop/*/pid` files where the PID is still running but no corresponding Inngest run is active, and kills them.

### Patterns to Follow

* **Claim-check for large outputs** — write to file, pass path between steps (proven fix from transcript pipeline, ADR-implicit)
* **slog write per iteration** — structured log entry for every story attempt
* **PDS event per iteration** — `dev.joelclaw.loop.iteration` record for phone observability (ADR-0004)
* **progress.txt Codebase Patterns** — consolidated learnings at top of progress file (Matt Pocock pattern)
* **AGENTS.md/CLAUDE.md updates** — when the implementor discovers reusable patterns (snarktank/ralph pattern)

### Patterns to Avoid

* **No flat peer-to-peer coordination** — Cursor proved this fails at scale. Strict role hierarchy.
* **No more than 4 roles** — AgentCoder proved fewer agents = better results + lower cost
* **No PDS in critical path** — PDS gets milestone records asynchronously (per ADR-0004 reconciliation above). PDS failure must not block loop execution.
* **No global tool assignment** — each story gets its own tool selection. No "codex for everything."
* **v1: no Docker sandboxing** — tools run directly on host. This is a known security risk accepted for v1 (single user, own machine, own repos). v2 must add Docker sandboxing for AFK mode before this system is used on untrusted codebases or by other users.

### Migration Steps

None — this is net-new. The existing `ralph_loop` tool in pi is unrelated infrastructure (it spawns codex directly, no Inngest involvement). Both can coexist. The Inngest loop is for AFK durable workloads; pi's ralph_loop remains for ad hoc interactive use.

### Verification

- [x] `agent-loop-plan` function registered in Inngest, visible in `igs functions` — **VERIFIED**: 6 functions registered (plan, implement, review, judge, complete, retro)
- [x] `agent-loop-implement` spawns codex, captures output, commits on success — **VERIFIED**: supports codex, claude, pi. Commit format: `feat: [loopId] [storyId] attempt-N`. Tool output captured to `/tmp/agent-loop/{loopId}/{storyId}-{attempt}.out`
- [x] `agent-loop-review` writes tests from acceptance criteria without reading implementation code — **VERIFIED**: `buildTestPrompt()` explicitly instructs "Do NOT read or examine the implementation code first". Supports `freshTests` mode for re-writes.
- [x] `agent-loop-review` runs typecheck + lint + tests, produces structured feedback — **VERIFIED**: `runChecks()` runs `tsc --noEmit`, biome/eslint, `bun test`. Claim-check pattern for feedback >10KB.
- [x] `agent-loop-judge` routes to next story on PASS, back to implementor on FAIL with feedback — **VERIFIED**: PASS → `updateStoryPass()` + `agent/loop.plan`. FAIL → `agent/loop.implement` with feedback + retry ladder tool selection.
- [x] `agent-loop-judge` skips story after max retries, flags for human review — **VERIFIED**: `markStorySkipped()` + "⚠️ NEEDS HUMAN REVIEW" in progress.txt
- [x] Full loop: `igs send agent/loop.start` → stories execute → `agent/loop.complete` emitted — **VERIFIED**: `loop-1771127699-adr10-v3` completed 4/4 stories. Retrospective written to Vault.
- [x] Each iteration visible as separate run in `igs runs` — **VERIFIED**: each role is a separate Inngest function run with own ID
- [ ] PDS event emitted per iteration (observable from phone) — **DEFERRED**: PDS not yet stood up (Phase 0 dependency per [ADR-0004](0004-atproto-federation-native-app.md)). `dev.joelclaw.loop.*` Lexicons defined above; write code added when PDS is running.
- [x] ~~slog entry written per story attempt~~ — **REMOVED BY DESIGN**: slog writes per story were too noisy. Loop observability comes from `igs loop status` (Redis-backed), retrospective notes in Vault, and future PDS events. Intentional decision, not a gap.
- [x] prd.json updated (passes: true) only after JUDGE passes — **VERIFIED**: Redis-backed PRD state. `updateStoryPass()` writes to Redis + disk.
- [x] progress.txt appended with learnings after each story — **VERIFIED**: `appendProgress()` called on PASS, FAIL, SKIP, and RECHECK
- [x] Loop survives worker restart mid-execution (Inngest replays from last completed step) — **VERIFIED BY DESIGN**: each role is a separate function run, Inngest handles replay
- [x] Duplicate event delivery does not create duplicate commits (idempotency check) — **VERIFIED**: `commitExists()` checks git log for `[loopId] [storyId] attempt-N` before re-execution
- [x] `igs loop cancel <loopId>` stops the loop — no further events emitted, subprocess killed — **VERIFIED**: writes cancel flag, sends SIGTERM to PID, emits cancel event, cleans Redis key
- [x] Orphan subprocess cleanup: after cancel, no tool processes remain running — **VERIFIED**: `killSubprocess()` does SIGTERM → 10s wait → SIGKILL. No cron cleanup function yet (documented as `agent-loop-cleanup` in ADR, not implemented).
- [x] JUDGE FAIL → IMPLEMENTOR retry includes feedback from previous attempt — **VERIFIED**: feedback passed through event chain. `hasSameConsecutiveFailures()` detects stuck loops and triggers `freshTests` mode.
- [x] JUDGE FAIL at max retries → story skipped, flagged, loop continues to next story — **VERIFIED**: `markStorySkipped()` + emit `agent/loop.plan` for next story
- [x] Single-story test: one story PRD → PLAN → IMPLEMENT → REVIEW → JUDGE → PASS → COMPLETE — **VERIFIED**: multiple real loop runs completed (see retrospectives in `~/Vault/system/retrospectives/`)

### Beyond-ADR features implemented

- [x] **Retro function** (`agent-loop-retro`): auto-generates retrospective markdown in `~/Vault/system/retrospectives/` on loop complete. Not in original ADR.
- [x] **Recommendations file** (`.agent-loop-recommendations.json`): tool rankings, retry patterns, suggested retry ladder written per project. Feeds into next loop's PLANNER prompt. (Lamarck learning pattern.)
- [x] **Complete function** (`agent-loop-complete`): pushes feature branch to GitHub via minted GitHub App token. Not in original ADR.
- [x] **Redis-backed PRD state**: PRD seeded to Redis on loop start, updated atomically. 7-day TTL. Prevents race conditions from disk I/O.
- [x] **Docker sandbox** (`docker/agent-loop-runner/`): Dockerfile + entrypoint for isolated tool execution. `spawnInContainer()` in utils.ts. Toggled via `AGENT_LOOP_DOCKER=1` env var.
- [x] **Retry ladder**: configurable tool sequence for retries (default: codex → claude → codex). Judge selects next tool from ladder.
- [x] **Fresh-tests mode**: when same tests fail consecutively, reviewer deletes existing tests and writes fresh ones (avoids test-lock).
- [x] **Recheck on complete**: planner rechecks skipped stories before emitting complete — some pass after later fixes.
- [x] **igs loop CLI**: `start`, `status`, `list`, `cancel`, `nuke` subcommands. Status reads from Redis + Inngest events. List shows all active loops.
- [x] **Branch lifecycle**: planner creates `agent-loop/{loopId}` branch on start, verifies checkout on re-entry.
- [x] **Smart commit**: detects if tool already committed (codex does this), avoids double-commit.
- [x] **Rich implementor prompts**: includes codebase patterns, CLAUDE.md, AGENTS.md, file listing, recommendations — with priority-based truncation to 8KB budget.

## Pros and Cons of the Options

### Option A: Bash ralph (status quo pattern)

The original Ralph pattern — a bash `for` loop spawning fresh CLI instances.

* Good, because dead simple — 50 lines of bash, zero infrastructure
* Good, because proven by many practitioners (Geoffrey Huntley, Matt Pocock, hundreds of forks)
* Good, because no dependencies beyond a CLI tool
* Bad, because dies with terminal — no durability across crashes or reboots
* Bad, because no observability — blank screen or jq pipe hacks
* Bad, because no per-story retry — whole loop fails on one bad iteration
* Bad, because single tool — can't dispatch codex for code and pi for browser testing
* Bad, because no quality pipeline — single agent does everything (implement + test + review)

### Option B: Pi's built-in `ralph_loop` tool

Pi's existing tool that spawns codex in a loop with prd.json.

* Good, because already exists and works
* Good, because runs within pi's context (access to skills, tools, memory)
* Neutral, because still ephemeral — tied to the pi session lifetime
* Bad, because not durable — pi session ends, loop ends
* Bad, because single-tool (codex only via the tool's current implementation)
* Bad, because not independently observable — no `igs run` per iteration
* Bad, because no multi-agent review pipeline

### Option C: Inngest multi-agent pipeline (chosen)

4-role pipeline as separate Inngest function runs, event-chained.

* Good, because durable — survives crashes, reboots, disconnects
* Good, because observable — every iteration is an `igs run`, step traces, timing
* Good, because retryable — each role retries independently
* Good, because multi-tool — different tool per story per role
* Good, because validated architecture — Cursor's Planner-Worker-Judge scaled to 1M+ lines
* Good, because independent test generation — REVIEWER writes tests from criteria, not implementation (AgentCoder insight)
* Good, because builds on existing infrastructure — Inngest already running, proven with video pipeline
* Bad, because most complex option — 4 new Inngest functions, event schema, subprocess management
* Bad, because Inngest step output limits require claim-check pattern for large data
* Bad, because tool spawning from Inngest functions is subprocess management (stdout capture, timeout, exit codes)

### Option D: Off-the-shelf multi-agent framework (CrewAI, AutoGen, LangGraph)

Use an existing framework designed for multi-agent coordination.

* Good, because designed for multi-agent orchestration out of the box
* Good, because community support and documentation
* Bad, because introduces a second orchestrator alongside Inngest — violates "own every layer" principle
* Bad, because framework opinions conflict with existing architecture (Effect, Bun, HATEOAS)
* Bad, because not durable in the Inngest sense — most run in-process, don't survive crashes
* Bad, because black-box coordination logic — debugging means reading their code, not ours
* Bad, because Python-centric ecosystems (CrewAI, AutoGen, LangGraph) — our stack is TypeScript/Bun

## More Information

### Prior Art & Credits

| Source | What We Took | Citation |
|--------|-------------|----------|
| **Geoffrey Huntley** | The Ralph pattern — bash loop, fresh context per iteration, PRD-driven | [ghuntley.com](https://ghuntley.com) |
| **snarktank/ralph** | Canonical implementation — prd.json, progress.txt, AGENTS.md, prompt templates | [github.com/snarktank/ralph](https://github.com/snarktank/ralph) |
| **Matt Pocock** (AI Hero) | HITL→AFK progression, small steps, quality entropy, Docker sandboxes, streaming | [11 Tips](https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum), [Getting Started](https://www.aihero.dev/getting-started-with-ralph), [Streaming](https://www.aihero.dev/heres-how-to-stream-claude-code-with-afk-ralph) |
| **Cursor** (Jan 2026) | Planner-Worker-Judge hierarchy at scale. Flat coordination fails. Removed integrator role. Model selection per role. **Caveat**: Cursor ran hundreds of concurrent agents on million-line codebases. Our system is single-user, serial, small repos. The hierarchy pattern is directional guidance, not a 1:1 proof. | [cursor.com/blog/scaling-agents](https://cursor.com/blog/scaling-agents) |
| **AgentCoder** (Huang et al.) | 3 agents > 7 agents. Independent test generation avoids bias. 96.3% pass@1 with lower token cost. **Caveat**: Benchmarked on HumanEval/MBPP (isolated function generation), not real multi-file repos. Our workloads are repo-level stories with acceptance criteria, which is a different complexity class. The "fewer agents, independent tests" principles transfer; the specific numbers don't. | [arxiv.org/abs/2312.13010](https://arxiv.org/abs/2312.13010) |
| **ChatDev** | Role-based multi-agent software dev (CEO, CTO, programmer, reviewer, tester). "Communicative dehallucination." | [arxiv.org/abs/2307.07924](https://arxiv.org/abs/2307.07924) |
| **MetaGPT** | PRD generation, technical design, API interface generation, code review as pipeline stages. | [arxiv.org/abs/2308.00352](https://arxiv.org/abs/2308.00352) |
| **AgentMesh** | Planner-Coder-Debugger-Reviewer pipeline. Modular, extensible, role-per-LLM. | [arxiv.org/abs/2507.19902](https://arxiv.org/abs/2507.19902) |

### Revisit Triggers

* **4-role overhead exceeds quality benefit** → collapse to 2 roles (implementor + judge) as first simplification, then to single-agent ralph if 2-role also underperforms. The 4-role architecture is a hypothesis informed by prior art (Cursor, AgentCoder), not experimentally proven in this system. First 3 real loop runs should be evaluated: did REVIEWER catch bugs IMPLEMENTOR missed? Did JUDGE add value beyond REVIEWER's test results? If not, merge roles.
* **Token cost per story exceeds acceptable threshold** → track via slog. If 4-role overhead consistently 3x+ the cost of a single-agent approach for equivalent quality, simplify.
* **Tool/model landscape changes** so dramatically that one tool does everything well → remove dynamic dispatch, hardcode the winner
* **Inngest step output limits or timeout constraints** make subprocess spawning unworkable → evaluate running tools outside Inngest with Inngest as coordinator only (emit event → external runner → callback event)

### Relationship to AT Protocol (ADR-0004)

ADR-0004 establishes AT Protocol as the bedrock data layer — "every record is a PDS record." This ADR does NOT contradict that. The reconciliation:

**PDS is the canonical store. Git is the working buffer.**

During loop execution, working state (prd.json, progress.txt, uncommitted code) lives in git because tools (codex, claude, pi) operate on files in a git repo. This is ephemeral working state, not canonical records.

When milestones complete, canonical records are written to PDS:

* `dev.joelclaw.loop.iteration` — PDS record per story attempt, written by JUDGE on PASS or final FAIL
* `dev.joelclaw.loop.complete` — PDS record when loop finishes, written by final PLAN step
* `dev.joelclaw.system.log` — slog entries (which are themselves PDS records per ADR-0004)
* `dev.joelclaw.loop.start` — PDS record capturing the approved plan + tool assignments from MCQ kickoff

PDS writes are async and non-blocking. If PDS is temporarily unreachable, the loop continues and PDS writes are retried by Inngest's built-in retry. Loop execution is never gated on PDS availability — but all milestone data eventually reaches PDS as the canonical record. Git working state is ephemeral; PDS records are permanent.

#### Authoritative PDS Records (`dev.joelclaw.loop.*`)

These Lexicon records are the canonical loop data on the PDS, per ADR-0004:

```
dev.joelclaw.loop.run
  - loopId: string (ULID)
  - project: string
  - prdPath: string
  - status: "running" | "completed" | "cancelled" | "failed"
  - toolAssignments: object (from MCQ approval)
  - startedAt: datetime
  - completedAt: datetime?
  - storiesCompleted: number
  - storiesFailed: number
  - createdAt: datetime

dev.joelclaw.loop.iteration
  - loopId: string
  - storyId: string
  - attempt: number
  - role: "plan" | "implement" | "review" | "judge"
  - tool: string (codex | claude | pi)
  - status: "started" | "passed" | "failed" | "skipped"
  - commitSha: string?
  - feedback: string?
  - duration: number (ms)
  - tokensUsed: number?
  - createdAt: datetime
```

`dev.joelclaw.loop.run` is created at loop start, updated at completion. `dev.joelclaw.loop.iteration` is created by each role function on completion. Together they provide the full loop history on PDS — queryable from the iPhone app, indexed by Qdrant, and federated via AT Protocol.

### Relationship to Memory System (Project 08)

MCQ approvals at kickoff (tool assignments, story order, quality criteria) feed into the lamarck-style playbook:

* Joel's choices become playbook bullets ("prefers codex for database migrations", "always requires test coverage")
* Over time, PLANNER's MCQ recommendations improve — fewer questions needed because the system already knows Joel's technical taste
* This is Lamarckian inheritance applied to workload planning: experience from past loops gets inherited by future loops

### Resolved Design Questions (with defaults)

1. **Iteration timeout** — Per-tool: codex 15 min, claude 20 min, pi 20 min. Configured via Inngest function timeout. If exceeded, Inngest kills the step and marks the attempt failed.
2. **Output capture** — Unified approach: all tools write stdout to `/tmp/agent-loop/{loopId}/{storyId}-{attempt}.out`. Exit code determines success. Tool-specific parsing: claude stream-json → extract result; codex → exit code + stdout; pi → session file. A `parseToolOutput(tool, outputPath)` utility normalizes to `{ success: boolean, output: string, tokensUsed?: number }`.
3. **Branch management** — v1: single feature branch per PRD (ralph pattern). Planner creates/checks out branch at loop start. Stories commit sequentially (concurrency: 1 per project guarantees no parallel commits). If main diverges, that's a human merge — the loop doesn't rebase automatically. Revisit for jj/Graphite stacked PRs in v2.
4. **Docker sandboxes** — v1: no Docker sandbox. Tools run directly on the host. The project directory is mounted as the CWD. v2: Docker sandbox for AFK mode (Matt Pocock recommendation). This is a known risk accepted for v1 — the loop runs on Joel's own machine against his own repos.
5. **Cost tracking** — Yes. `parseToolOutput` extracts `tokensUsed` where available (claude stream-json includes this). Written to slog and PDS per iteration. Aggregated in `agent/loop.complete` summary.

### Remaining Open Questions

1. **Stacked PRs** — jj/Graphite integration is aspirational. v1 uses standard git branch + sequential commits. When/if jj is adopted, the branch management logic in PLANNER changes but the event chain stays the same.
2. **Model selection learning** — the lamarck playbook captures tool preferences, but the PLANNER's model-selection prompt needs design work. Deferred to implementation.

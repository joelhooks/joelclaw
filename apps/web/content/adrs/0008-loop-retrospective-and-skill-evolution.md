---
status: "implemented"
date: 2026-02-14
implemented: 2026-02-15
decision-makers: "Joel Hooks"
consulted: "Codex (drafting), Alex Hillman patterns (kuato, andy-timeline), John Lindquist patterns (lamarck)"
informed: "All agents operating on this system"
---

# Add post-loop retrospective for skill evolution and memory ingestion

## Context and Problem Statement

ADR-0005 established the durable PLANNER → IMPLEMENTOR → REVIEWER → JUDGE loop. ADR-0007 improved loop execution quality (Docker isolation, duration tracking, stricter controls). The system can now run autonomous coding loops, but it still lacks a first-class post-loop learning step.

Today, loop outcomes are visible in runs/logs, but lessons are not consistently converted into:

- skill updates (`SKILL.md` drift correction)
- structured memory artifacts (`lamarck`-style reflection)
- playbook updates for future planning (`MEMORY.md` pipeline)
- narrative timeline entries
- observability metrics that explain what improved and what regressed

The memory system architecture (Project 08) defines this missing bridge explicitly: Layer 3 (PLAYBOOK) needs structured reflections, and Layer 2 (TIMELINE) needs curated development events. Without a retrospective function, loop experience is mostly ephemeral.

The question: **How should the agent-loop pipeline convert each `agent/loop.complete` into safe skill evolution plus memory-ready reflection artifacts that improve future loop performance?**

Related: [ADR-0005 — Durable multi-agent coding loops](0005-durable-multi-agent-coding-loops.md), [ADR-0006 — Observability (Prometheus + Grafana)](0006-observability-prometheus-grafana.md), [ADR-0007 — Agent loop v2 improvements](0007-agent-loop-v2-improvements.md), [Memory System — Agent Memory Architecture](../../Projects/08-memory-system/index.md)

## Decision Drivers

* **Memory-system alignment** — retrospective output must be directly consumable by Layer 3 (PLAYBOOK) and useful for Layer 2 (TIMELINE)
* **Traceability** — retrospective processing must be its own Inngest run, inspectable via `igs`
* **Skill quality** — learned codebase patterns must reconcile against active skills to reduce instruction drift
* **Safety** — skill mutation must be constrained and reviewable; no blind rewrites of structural content
* **Operational value** — retrospectives must produce metrics that correlate tool choices with outcomes (pass rate, retries, duration, cost)
* **Composability** — output contracts should feed existing memory, timeline, and observability pipelines without bespoke manual glue
* **Attribution fidelity** — adopted patterns must preserve source credit (Alex Hillman and John Lindquist)

## Considered Options

* **Option A: No automatic retrospective** — keep loop completion as terminal state and rely on ad-hoc manual notes
* **Option B: Lightweight summary only** — generate text reflection but do not update skills or memory layers structurally
* **Option C: Dedicated `agent-loop-retro` function with guarded skill updates and memory-native output contracts**

## Decision Outcome

Chosen option: **Option C — dedicated `agent-loop-retro` Inngest function** triggered by `agent/loop.complete`.

The retrospective is a separate run with its own retries, timeout, and observability surface. It consumes loop artifacts (`progress.txt`, run metadata, tool usage, touched paths), detects skill drift, applies safe additive skill updates, and writes a structured reflection entry in `lamarck`-compatible diary format for the memory system pipeline.

This decision makes retrospective output a first-class writer into memory layers:

- **Layer 3 (PLAYBOOK)**: reflection entry is direct input for `memory/playbook.reflect` and playbook bullet lifecycle
- **Layer 2 (TIMELINE)**: loop-level milestone summary is emitted as timeline candidate material
- **Layer 0 (SYSTEM LOG)**: retrospective action and outcomes are appended as canonical events
- **Observability (ADR-0006)**: retrospective metrics exported for dashboards and alerts

### Consequences

* Good, because each loop gains a deterministic learning step instead of relying on human memory
* Good, because skill evolution becomes continuous and evidence-based (from real loop outcomes)
* Good, because planner/tool recommendations improve over time through playbook feedback decay
* Good, because retrospective and execution runs are decoupled; failures in retro do not invalidate completed code work
* Bad, because drift detection and patch generation add computational and operational complexity
* Bad, because incorrect drift inference can propose noisy skill edits without strong thresholds
* Neutral, because structural skill refactors still require human approval and branch workflow

## Scope of Supersession and Relationships

- **Extends ADR-0005**: adds a post-completion stage after `agent/loop.complete`
- **Extends ADR-0007**: uses v2 timing/attempt data as retrospective quality signals
- **Integrates Project 08 Memory System**: retrospective output is the main bridge from coding loops to Layer 3 playbook learning and Layer 2 narrative generation
- **Related to ADR-0006**: retrospective publishes loop effectiveness metrics for Prometheus/Grafana dashboards

## Implementation Plan

### 1) Add retrospective function and trigger

Create `agent-loop-retro` as a standalone Inngest function:

- Trigger: `agent/loop.complete`
- Input: loop summary payload + project path + branch + story outcomes + retry counters + timing metadata
- Execution model: separate run, independently retryable and traceable (`igs run <id>`)
- Failure behavior: mark retrospective status separately; do not reopen completed loop

Event addition:

- `agent/loop.retro.complete` — terminal retrospective output event containing skill drift summary, reflection path, and metrics payload

### 2) Artifact collection and normalization

At retrospective start, gather canonical inputs:

- `progress.txt` sections:
  - `## Codebase Patterns`
  - per-story progress notes
- loop artifacts from prior events:
  - story pass/fail/skipped
  - attempt counts and retry exhaustion
  - tool selection per role
  - duration and timing metrics from ADR-0007 flow
- execution footprint:
  - files touched, primary directories, test files changed
  - error classes and repeated failure reasons

Normalize into a single retrospective working object (JSON) for deterministic downstream steps.

### 3) Skill relevance inference and drift detection

Determine candidate skills using three weighted signals:

- **Signal 1: skill load evidence** (if available from runtime instrumentation)
- **Signal 2: file-path affinity** (paths touched mapped to skill domains)
- **Signal 3: tool/event affinity** (event types and role-tool usage mapped to skill scope)

Drift detection strategy:

- Extract learned patterns/gotchas from `progress.txt` and judge/reviewer feedback
- Compare against current skill bodies/references with fuzzy similarity thresholding
- Classify each finding:
  - `no_drift`
  - `additive_drift` (missing gotcha/pattern/example)
  - `structural_drift` (skill flow/contract mismatch)

Output contract includes confidence score and rationale per skill.

### 4) Safe skill update policy

Apply a strict mutation policy:

- **Auto-apply allowed** only for `additive_drift` with high confidence and no structural section edits
- **Propose-only required** for `structural_drift`:
  - generate patch proposal in vault note
  - open branch/PR workflow for human review
- Never rewrite entire skill files wholesale
- Preserve frontmatter and existing trigger semantics
- Keep source attribution and changelog notes for applied updates

All applied updates are committed to a dedicated branch, never direct-to-default.

### 5) Reflection output for memory pipeline (Layer 3)

Write a `lamarck`-style diary reflection entry per loop completion with structured fields:

- loop identity (`loopId`, project, branch, date)
- outcomes (completed/failed/skipped stories + reasons)
- tool effectiveness by role (pass rate, retries, duration, token/cost where available)
- discovered codebase patterns
- gotchas and workarounds
- skill drift findings and applied/proposed actions
- recommendations for next loop
- confidence/quality metadata for downstream curation

Store reflection in vault path consumed by memory pipeline (for example `~/Vault/system/memory/retrospectives/YYYY/MM/loop-<loopId>.md`).

This output is designed to feed `memory/playbook.reflect` directly into playbook bullets and MEMORY export.

### 6) Timeline candidate generation (Layer 2)

From the same retrospective object, generate a concise timeline candidate entry:

- what was built
- what changed in process/tooling
- lesson learned summary
- links to branch/commits/ADR references

Write to timeline intake location for weekly curation.

### 7) Planner intelligence feedback

Emit retrospective-derived recommendation data for planner consumption:

- tool ranking by story type and failure mode
- retry-risk heuristics
- suggested reviewer/implementor pairings
- anti-pattern warnings

Persist as machine-readable memory artifact so planner prompts can include evidence-backed tool guidance.

### 8) Observability integration (ADR-0006)

Export metrics from retrospective output:

- loop success/failure/skipped counters
- retry distribution
- tool effectiveness counters by role
- story and loop duration summaries
- retro processing latency/failure count
- skill drift count by classification (`additive`, `structural`)

Expose as Prometheus-compatible series for Grafana dashboards.

### 9) Affected Paths

- `~/Code/system-bus/src/inngest/functions/agent-loop/retro.ts` (new)
- `~/Code/system-bus/src/inngest/client.ts` (add `agent/loop.retro.complete` schema)
- `~/Code/system-bus/src/inngest/functions/agent-loop/` (shared helpers for artifact loading and drift scoring)
- `~/Code/system-bus/src/inngest/functions/memory/` (integration hooks for playbook/timeline ingestion)
- `~/Code/system-bus/prometheus/` (metric registration for retrospective series)
- `~/Vault/system/memory/retrospectives/` (new reflection artifacts)
- `~/Vault/system/timeline/` (timeline intake entries)
- skill paths under `~/.pi/agent/skills/*/SKILL.md` (targeted additive updates)

### 10) Data Contracts

`agent/loop.retro.complete` payload (minimum):

```json
{
  "loopId": "01...",
  "project": "/path/to/repo",
  "retroStatus": "success",
  "stories": {
    "completed": 3,
    "failed": 1,
    "skipped": 1
  },
  "skillDrift": [
    {
      "skill": "agent-loop",
      "classification": "additive_drift",
      "confidence": 0.92,
      "action": "applied"
    }
  ],
  "reflection": {
    "path": "~/Vault/system/memory/retrospectives/2026/02/loop-01....md",
    "format": "lamarck-diary-v1"
  },
  "timelineCandidatePath": "~/Vault/system/timeline/inbox/2026-02-14-loop-01....md",
  "metrics": {
    "retroDurationMs": 12345,
    "retryCount": 4
  }
}
```

### 11) Patterns to Follow

- Keep retrospective as independent function run boundary
- Write memory artifacts in structured, parser-friendly formats
- Treat reflection as source material; playbook curation remains gated by quality checks and decay logic
- Preserve source attribution when adopting patterns:
  - Alex Hillman (`kuato`, `andy-timeline`)
  - John Lindquist (`lamarck`)

### 12) Patterns to Avoid

- No direct skill structural rewrites without review
- No coupling retro success to loop completion success
- No freeform narrative-only reflection that bypasses machine-readable fields
- No metrics without loop/story IDs (must remain traceable)

## Verification

### Retrospective Function

- [ ] `agent-loop-retro` is registered and listed by `igs functions`
- [ ] `agent/loop.complete` triggers exactly one retrospective run per loop completion
- [ ] Retrospective run is independently traceable in `igs run <id>`

### Drift Detection and Skill Safety

- [ ] Candidate skill set is produced from tool usage, file paths, and event-type signals
- [ ] Drift classifier emits `no_drift`, `additive_drift`, or `structural_drift` with confidence scores
- [ ] Auto-apply changes occur only for allowed additive updates
- [ ] Structural updates are emitted as proposals and not auto-applied
- [ ] Any applied skill edits land on a non-default branch

### Memory System Integration

- [ ] Reflection artifact is written in `lamarck` diary-compatible structured format
- [ ] Reflection is ingested by memory playbook pipeline without manual transformation
- [ ] Timeline candidate artifact is generated for weekly curation flow
- [ ] Retrospective writes produce vault changes that can be indexed by QMD

### Planner Feedback Quality

- [ ] Planner receives retrospective recommendation artifact for subsequent loop runs
- [ ] Recommendation artifact includes tool effectiveness and retry-risk signals
- [ ] At least one follow-up loop demonstrates changed recommendation behavior based on prior retro data

### Observability (ADR-0006)

- [ ] Prometheus captures retrospective counters and latency
- [ ] Grafana dashboard can show loop outcomes by tool and retry distribution
- [ ] Retro processing failures surface as alertable signals

## Pros and Cons of the Options

### Option A: No automatic retrospective

* Good, because no new implementation complexity
* Good, because zero risk of accidental skill edits
* Bad, because loop learnings remain mostly unstructured and perishable
* Bad, because memory-system Layer 3 input remains incomplete
* Bad, because planner intelligence cannot improve systematically from outcomes

### Option B: Lightweight summary only

* Good, because easy to implement quickly
* Good, because provides some narrative history
* Neutral, because can support manual learning workflows
* Bad, because lacks structured contracts for playbook and planner feedback
* Bad, because does not address skill drift remediation
* Bad, because observability correlation remains shallow

### Option C: Dedicated retrospective function with guarded skill evolution (Chosen)

* Good, because creates durable, structured learning artifacts per completed loop
* Good, because directly connects loops to memory layers and planner improvement
* Good, because adds explicit safety controls for skill mutation
* Good, because yields measurable loop-learning metrics in observability stack
* Bad, because requires robust drift inference and patch governance
* Bad, because increases pipeline surface area and maintenance cost

## More Information

### Attribution

This ADR intentionally adopts and credits patterns from:

- **Alex Hillman** (`kuato`) for session-structured recall and searchable operational memory
- **Alex Hillman** (`andy-timeline`) for narrative timeline as institutional memory
- **John Lindquist** (`lamarck`) for reflection → playbook learning pipeline, feedback decay, and memory inheritance framing

### Revisit Triggers

Revisit this ADR if any of the following occur:

- Retrospective false-positive drift proposals exceed acceptable review burden
- Memory pipeline cannot ingest retrospective artifacts without frequent manual cleanup
- Planner recommendations do not measurably improve after multiple loop cycles
- Skill update safety policy blocks too many useful additive updates

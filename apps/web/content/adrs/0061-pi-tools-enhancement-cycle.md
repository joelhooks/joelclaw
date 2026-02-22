---
status: proposed
date: 2026-02-19
decision-makers: Joel
consulted: oh-my-pi (can1357/oh-my-pi) patterns
informed: pi-tools consumers, joelclaw system
tags:
  - pi-tools
  - joelclaw
  - inngest
  - developer-experience
supersedes: null
related:
  - "0059"
  - "0060"
---

# ADR-0061: pi-tools Enhancement Cycle — Commit Tool, Web Extractors, MCQ

## Context and Problem Statement

After evaluating oh-my-pi (`can1357/oh-my-pi`) as a potential replacement for stock pi, we decided to stay on stock pi and cherry-pick patterns into pi-tools (see ADR-0059 for LSP, ADR-0060 for swarm/DAG). Three additional capabilities are worth adopting:

1. **Commit tool** — oh-my-pi has a 43-file agentic commit system with hunk-level staging, split commits, changelog generation, and conventional commit validation. pi-tools has nothing for commits.

2. **Web scraper site-specific handlers** — oh-my-pi's `src/web/scrapers/` has specialized extractors for npm, PyPI, crates.io, arxiv, NVD, GitHub, and more. pi-tools `web-search` does generic extraction — developer sources deserve targeted parsing.

3. **MCQ improvements** — oh-my-pi's ask tool supports multi-select, per-option descriptions, and multi-part question chaining. pi-tools MCQ is single-select with flat text options.

All three should be evaluated through the Inngest lens — joelclaw's killer feature is durable event-driven execution. Where a capability benefits from durability, scheduling, or event triggers, it should have an Inngest-backed mode alongside the interactive pi extension.

## Decision

### 1. Commit Tool — Hybrid Interactive + Event-Driven

#### Interactive Mode: `/commit` slash command

A pi-tools slash command (or extension-registered command) that:

1. Runs `git diff --cached` (or `git diff` if nothing staged) to collect changes
2. Groups changes by concern — detects unrelated changes that should be separate commits
3. Proposes conventional commit messages with:
   - Type/scope detection from file paths and diff content
   - Filler-word and meta-phrase rejection ("various improvements", "update files", "fix stuff")
   - Conventional commit format validation (`type(scope): description`)
4. Supports hunk-level staging — when changes span multiple concerns, stage individual hunks
5. Optionally proposes changelog entries for affected packages
6. User confirms or edits, then commits (and optionally pushes)

oh-my-pi reference: `packages/coding-agent/src/commit/` — 43 files covering agentic analysis, map-reduce for large diffs, conventional commit validation, changelog generation, and git operations.

**What to port:** The analysis patterns (scope detection, validation rules, filler-word detection, conventional commit format). NOT the full 43-file system — adapt the ideas to a focused pi extension.

**What to skip for v1:** Map-reduce for massive diffs (solve later if needed), Cursor provider integration, multi-credential model selection.

#### Event-Driven Mode: `commit/requested` Inngest event

For automated workflows where commits happen without interactive input:

```typescript
// After loop story completes
await step.sendEvent("commit/requested", {
  data: {
    repo: "/path/to/repo",
    context: "Implemented story: Add user authentication",
    push: true,
    changelog: true,
  }
});

// Scheduled repo grooming
// cron: "0 2 * * *" — nightly at 2am
// Scan repos for uncommitted changes, auto-commit with conventional format
```

The `commit/requested` Inngest function:
1. `step.run("analyze")` — run the same analysis logic as interactive mode
2. `step.run("validate")` — ensure conventional format, no filler words
3. `step.run("commit")` — `git commit` with generated message
4. `step.run("push")` — optional `git push`
5. `step.run("notify")` — gateway notification with commit summary

Shares the core analysis/validation logic with the interactive slash command. The trigger and confirmation flow differ — interactive asks the user, event-driven commits autonomously.

**Use cases:**
- Post-loop auto-commit: loop `complete.ts` emits `commit/requested` after story passes
- Scheduled grooming: nightly cron scans repos with dirty working trees
- Webhook-triggered: GitHub PR event → analyze changes → suggest commit message improvements
- Swarm agent output: swarm agents commit their work at the end of each task

### 2. Web Extractors — Shared Library for pi-tools + Inngest Pipelines

#### The Problem

pi-tools `web-search` fetches URLs and extracts content generically. But developer-facing sources have structured data that generic extraction misses:

- **npm**: package name, version, dependencies, weekly downloads, README
- **PyPI**: package metadata, classifiers, requirements
- **GitHub**: repo stats, file tree, README, recent commits
- **crates.io**: crate metadata, features, dependencies
- **arxiv**: title, authors, abstract, PDF link, categories
- **NVD/CVE**: vulnerability ID, severity, affected versions, references
- **MDN**: API signatures, browser compat tables, examples
- **Stack Overflow**: question, accepted answer, vote counts

#### The Solution

A shared extractor library (`packages/system-bus/src/extractors/` or `pi-tools/extractors/`) with site-specific handlers:

```typescript
interface SiteExtractor {
  /** URL patterns this extractor handles */
  patterns: RegExp[];
  /** Extract structured content from the page */
  extract(url: string, html: string): ExtractedContent;
}

interface ExtractedContent {
  title: string;
  type: string;  // "npm-package" | "github-repo" | "arxiv-paper" | etc.
  structured: Record<string, unknown>;  // site-specific structured data
  markdown: string;  // clean markdown for LLM consumption
}
```

**Used in two contexts:**

1. **pi-tools `web-search` extension** (synchronous, in-session) — when the agent searches and a result URL matches a known pattern, use the site-specific extractor for richer output
2. **Inngest pipelines** (durable, event-driven) — enrichment steps in existing and future pipelines:
   - `discovery/noted` → fetch URL → site-specific extraction → vault storage with structured metadata
   - `research/requested` → fan-out search → per-result extraction → synthesis
   - `meeting/noted` → extract URLs mentioned in transcript → enrich each
   - Future swarm agents doing web research

oh-my-pi reference: `packages/coding-agent/src/web/scrapers/` — site-specific handlers for package registries, code hosts, research sources, forums, docs, security databases.

**What to port:** The URL pattern matching and extraction logic for the highest-value sources (npm, GitHub, PyPI, arxiv, MDN). NOT the full multi-provider search system (we have our own via pi-tools web-search + Brave API).

#### Inngest Integration

New utility functions usable from any Inngest step:

```typescript
// In any Inngest function
const content = await step.run("extract-url", async () => {
  const html = await fetch(url).then(r => r.text());
  return extractWithSiteHandler(url, html);
  // Returns structured ExtractedContent if handler matches,
  // falls back to generic defuddle extraction
});
```

The extractors are a **shared library**, not an Inngest function themselves. They're called from within steps in existing pipelines (discovery, meeting analysis, future research pipelines).

### 3. MCQ Improvements — Pi Extension Only

No Inngest angle — MCQ is inherently interactive (user presses 1-4 in a terminal session).

Improvements from oh-my-pi's ask tool:

#### Multi-Select

Current MCQ: single-select only (pick one option).
Add: multi-select mode where multiple options can be chosen.

```typescript
// New parameter
multiSelect?: boolean;  // default: false

// When true, user can toggle multiple options before confirming
// Return value changes from single string to string[]
```

#### Per-Option Descriptions

Current MCQ: flat text options.
Add: optional description per option shown as dimmed secondary text.

```typescript
// Options can be string OR { label, description }
options: [
  { label: "PostgreSQL", description: "Best for relational data, ACID compliance" },
  { label: "Redis", description: "In-memory, fastest for key-value + pub/sub" },
  { label: "SQLite", description: "Zero-config, embedded, good for single-node" },
]
```

#### Adaptive Multi-Part Flow

Current MCQ: batch questions, answers come back all at once.
Improvement: the MCQ tool description already says "prefer 1-2 questions at a time" — reinforce this in the extension by making follow-up calls feel seamless (no visible re-render jank between question batches).

oh-my-pi reference: `packages/coding-agent/src/tools/ask.ts` — structured ask tool with typed options and multi-select.

## Consequences

### Positive

- Conventional commits become automatic — both interactive and event-driven
- Web search gets dramatically smarter for developer sources
- MCQ becomes more expressive for complex decision gathering
- Inngest integration means commit analysis and web extraction are reusable across all pipelines
- Post-loop auto-commits eliminate the manual "commit the loop's work" step
- Site-specific extractors improve vault quality for discovery/noted pipeline

### Negative

- Commit tool adds complexity — must handle edge cases (merge commits, empty diffs, binary files)
- Site-specific extractors are maintenance burden — sites change their HTML structure
- MCQ multi-select changes the tool's return type — models need to handle array responses

### Follow-up Tasks

**Commit Tool:**
- [ ] Create `pi-tools/commit/` extension with `/commit` command
- [ ] Implement diff analysis (scope detection, concern grouping)
- [ ] Implement conventional commit validation (format, filler-word rejection)
- [ ] Implement hunk-level staging for split commits
- [ ] Create `commit/requested` Inngest function in system-bus
- [ ] Add `commit/requested` event to Inngest client schema
- [ ] Wire post-loop auto-commit in `complete.ts`
- [ ] Optional: changelog generation for monorepo packages

**Web Extractors:**
- [ ] Create shared extractor library (location TBD: pi-tools or system-bus)
- [ ] Implement extractors for: npm, GitHub, PyPI, arxiv, MDN (v1 set)
- [ ] Integrate into pi-tools `web-search` extension (synchronous path)
- [ ] Integrate into `discovery/noted` Inngest pipeline (enrichment step)
- [ ] Add extractor for crates.io, NVD, Stack Overflow (v2)

**MCQ:**
- [ ] Add multi-select mode to MCQ extension
- [ ] Add per-option descriptions rendering
- [ ] Test multi-select with Claude's tool use (verify model handles array return)

## Implementation Plan

### Affected Paths

**Commit tool:**
- `pi-tools/commit/index.ts` — **new** extension + `/commit` slash command
- `pi-tools/commit/analysis.ts` — diff analysis, scope detection, concern grouping
- `pi-tools/commit/validation.ts` — conventional commit validation, filler rejection
- `pi-tools/commit/git.ts` — git operations (diff, stage hunks, commit, push)
- `packages/system-bus/src/inngest/functions/commit-requested.ts` — **new** Inngest function
- `packages/system-bus/src/inngest/events.ts` — add `commit/requested` event
- `packages/system-bus/src/inngest/functions/complete.ts` — wire auto-commit post-loop

**Web extractors:**
- `packages/system-bus/src/extractors/` — **new** shared library
  - `index.ts` — router (URL pattern → extractor)
  - `npm.ts`, `github.ts`, `pypi.ts`, `arxiv.ts`, `mdn.ts` — site handlers
  - `types.ts` — ExtractedContent interface
- `pi-tools/web-search/web-search.ts` — integrate extractor calls for known URLs
- `packages/system-bus/src/inngest/functions/discovery-noted.ts` — add extraction step

**MCQ:**
- `pi-tools/mcq/index.ts` — add multi-select mode + per-option descriptions

### Patterns to Follow

- Commit validation rules from oh-my-pi `packages/coding-agent/src/commit/analysis/` — adapt patterns, don't copy code
- Web extractors pattern-match URLs then parse HTML — use defuddle as fallback for unmatched URLs
- MCQ multi-select follows oh-my-pi ask tool's `multiSelect` parameter pattern
- Inngest functions follow existing joelclaw conventions (step naming, Redis state, gateway notifications)
- Shared libraries between pi-tools and system-bus: put in system-bus if Inngest functions need them, import from pi-tools via shared package or duplicated module

### What to Avoid

- Don't build the full 43-file commit system from oh-my-pi — extract the patterns, build lean
- Don't scrape sites that have APIs — use npm registry API, GitHub API, PyPI JSON API where available
- Don't change MCQ's default behavior — multi-select is opt-in, single-select remains default
- Don't make web extractors block the search response — extract in background, return generic result immediately if extraction is slow

### Verification

**Commit tool:**
- [ ] `/commit` with staged changes → proposes conventional commit message with correct type/scope
- [ ] `/commit` with mixed concerns → suggests split into multiple commits
- [ ] Filler message "update stuff" → rejected with explanation
- [ ] `commit/requested` Inngest event → auto-commits with conventional format, pushes, notifies gateway
- [ ] Post-loop story completion → auto-commit fires

**Web extractors:**
- [ ] Search for "express npm" → result includes package version, weekly downloads, deps
- [ ] Search for "CVE-2024-1234" → result includes severity, affected versions
- [ ] `discovery/noted` with npm URL → vault note has structured package metadata
- [ ] Unknown URL → falls back to generic defuddle extraction (no error)

**MCQ:**
- [ ] `multiSelect: true` → user can toggle multiple options, returns array
- [ ] Options with descriptions → descriptions render as dimmed secondary text
- [ ] Default (no multiSelect) → behavior unchanged from current

## More Information

### Reference Implementation

oh-my-pi (`can1357/oh-my-pi`):
- `packages/coding-agent/src/commit/` — 43-file agentic commit system
- `packages/coding-agent/src/commit/analysis/conventional.ts` — conventional commit validation
- `packages/coding-agent/src/commit/analysis/validation.ts` — filler-word detection
- `packages/coding-agent/src/web/scrapers/` — site-specific extractors
- `packages/coding-agent/src/tools/ask.ts` — structured ask tool with multi-select

Credit: Can Boluk (@can1357) for the patterns. MIT licensed.

### Inngest Integration Summary

| Capability | Interactive (pi extension) | Event-driven (Inngest) |
|-----------|--------------------------|----------------------|
| Commit tool | `/commit` slash command | `commit/requested` function — post-loop, scheduled, webhook-triggered |
| Web extractors | Inline in `web-search` tool | Shared library called from discovery, meeting, research pipelines |
| MCQ | In-session tool only | N/A — inherently interactive |

### Related ADRs

- **ADR-0059** — Multi-Language LSP Extension (same enhancement cycle, different capability)
- **ADR-0060** — Inngest-Backed Swarm/DAG (same enhancement cycle, Inngest-first)
- **ADR-0005** — Durable multi-agent coding loops (Inngest foundation)
- **ADR-0053** — Event-emitter prompts and Agency triage (commit auto-trigger pattern)

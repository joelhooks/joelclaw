---
status: proposed
date: 2026-02-22
decision-makers: joel
consulted: claude (gateway session 2026-02-22)
---

# ADR-0092: Unified pi-infer Abstraction with Model Fallback

## Context

The joelclaw codebase shells out to `pi` (via `Bun.spawnSync`) in **13+ files across 15+ call sites** for LLM inference — recall rewrite, o11y triage, email cleanup, meeting analysis, memory observe/promote/review, task triage, media processing, diagnostics, and log summarization.

Each call site independently handles:
- Model selection (hardcoded strings: `"haiku"`, `"sonnet"`, `TRIAGE_MODEL`, etc.)
- Timeout configuration (varying from 3s to 20s)
- stdout/stderr parsing
- Error handling and fallback behavior
- Environment setup (`TERM: "dumb"`, etc.)

The recall rewrite fix (ADR-0077, commit `6f2fab7`) introduced an escalating fallback pattern — Haiku 10s → Haiku 15s → codex-spark 20s — that proved effective. This pattern should be the default for all pi inference, not copy-pasted per call site.

## Decision

Create a shared `piInfer()` utility that encapsulates the pi subprocess pattern with model fallback.

### API

```ts
// packages/shared/src/pi-infer.ts

interface PiInferOptions {
  prompt: string
  systemPrompt?: string
  models?: PiModelAttempt[]       // override default fallback chain
  mode?: "text" | "json"          // --mode flag
  extraArgs?: string[]            // additional pi flags
  spawn?: SpawnHook               // test injection
}

interface PiModelAttempt {
  model: string                   // e.g. "anthropic/claude-haiku"
  timeout: number                 // ms
}

interface PiInferResult {
  text: string
  model: string                   // which model succeeded
  strategy: string                // e.g. "haiku" | "openai" | "fallback"
  attempts: number                // how many tries before success
  error?: string                  // last error if fell through to raw
}

const DEFAULT_MODELS: PiModelAttempt[] = [
  { model: "anthropic/claude-haiku", timeout: 10_000 },
  { model: "anthropic/claude-haiku", timeout: 15_000 },
  { model: "openai/gpt-5.3-codex-spark", timeout: 20_000 },
]

function piInfer(options: PiInferOptions): PiInferResult
```

### Behavior

1. Iterate through model attempts in order
2. Each attempt: `Bun.spawnSync(["pi", "--no-tools", "--no-session", "--no-extensions", "--print", "--mode", mode, "--model", model, ...extraArgs, prompt])`
3. On success (exit 0 + non-empty stdout): return result with model info
4. On failure: capture error, try next attempt
5. After all attempts exhausted: return with `strategy: "fallback"` and last error
6. `spawn` hook preserved for unit testing

### Call sites to migrate

| File | Current model | Notes |
|------|--------------|-------|
| `cli/commands/recall.ts` | haiku → codex-spark | Already has escalation — extract |
| `cli/commands/logs.ts` | hardcoded | 2 call sites |
| `cli/commands/diagnose.ts` | hardcoded | 1 call site |
| `system-bus/observability/triage.ts` | TRIAGE_MODEL | 1 call site |
| `system-bus/functions/check-email.ts` | hardcoded | 1 call site |
| `system-bus/functions/email-cleanup.ts` | hardcoded | 2 call sites |
| `system-bus/functions/observe.ts` | hardcoded | 1 call site |
| `system-bus/functions/reflect.ts` | hardcoded | 1 call site |
| `system-bus/functions/promote.ts` | hardcoded | 1 call site |
| `system-bus/functions/task-triage.ts` | hardcoded | 1 call site |
| `system-bus/functions/meeting-analyze.ts` | hardcoded | 1 call site |
| `system-bus/functions/media-process.ts` | hardcoded | 1 call site |
| `system-bus/functions/memory/batch-review.ts` | hardcoded | 1 call site |

### Where to put it

`packages/shared/src/pi-infer.ts` — new shared package, or add to existing shared utils if one exists. Both `packages/cli` and `packages/system-bus` depend on it.

## Consequences

- **Single place** to update model preferences, timeout strategy, and env setup
- **Automatic resilience** — every pi call gets fallback for free
- **Testable** — spawn hook means unit tests don't need real pi
- **Observable** — can add OTEL emit inside piInfer for all inference calls
- **Risk**: migration touches 13 files; do incrementally, verify each with existing tests

## Status

Proposed. Pending implementation priority decision.

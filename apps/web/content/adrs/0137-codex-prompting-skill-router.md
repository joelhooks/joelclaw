---
type: adr
status: shipped
date: 2026-02-25
tags: [adr, skills, codex, prompting, automation, pi]
deciders: [joel]
related: ["0093-agent-friendly-navigation-contract", "0097-forward-triggers-memory-preload", "0130-slack-channel-integration", "0135-pi-langfuse-instrumentation"]
---

# ADR-0137: Codex Prompting Skill Router for Intent-to-Tool Delegation

## Status

accepted

## Context

User requests use natural-language handoff phrases like “send to codex,” “prompt codex,” and “use codex” to request explicit Codex delegation. Historically these intentions were not guaranteed to map consistently to the canonical skill and handoff guidance.

Meanwhile, system behavior requires:

- a stable, discoverable skill contract under `joelclaw/skills`
- model and execution defaults (`gpt-5.3-codex`) when unspecified
- deterministic routing language aligned with OpenAI Codex prompting best practices
- durable observability-oriented workflows that fit existing `Inngest`/`pi`/`gateway` conventions

Recent incident work also showed that volume-mount and cross-model root-cause flows should be explicitly framed for Codex without burying operational context.

## Decision

Create and publish a dedicated skill named `codex-prompting` with:

- canonical trigger phrases (`send to codex`, `prompt codex`, `use codex`, `ask codex`)
- embedded prompt contract (Goal/Context/Constraints/Do/Deliver/Rollback format)
- explicit references to the OpenAI Codex prompting guidance
- routing instructions to the relevant local skills and CLI surfaces for execution
- required metadata file set (`SKILL.md`, `agents/openai.yaml`, `assets/*`, `references/*`)
- registration via standard symlinks in `~/.agents/skills`, `~/.pi/agent/skills`, and `~/.claude/skills`

The skill is treated as **baked-in routing behavior** and not a one-off note.

## Decision Outcome

- New skill directory added at `~/Code/joelhooks/joelclaw/skills/codex-prompting`
- `agents/openai.yaml` added for Codex metadata and icon contracts
- Reference guide copied into `skills/codex-prompting/references/`
- Symlinks created in all three standard skill roots
- Change logged via `slog` under tool `skills` (configure event)

## Implementation

1. Added `codex-prompting` skill with execution contract and trigger mapping.
2. Added `openai.yaml` interface metadata and required assets.
3. Copied OpenAI Codex prompt guide reference so the skill remains self-contained.
4. Synced skill roots so all runtime contexts (`~/.agents`, `~/.pi/agent`, `~/.claude`) resolve to the repo canonical source.
5. Logged the change in `~/Vault/system/system-log.jsonl`.

## Alternatives considered

- Rely on ad-hoc phrase detection in session prompts.
  - Rejected because behavior was inconsistent and undocumented.
- Create only a one-off SKILL entry in AGENTS without canonical repo files.
  - Rejected because source-of-truth rule mandates repo-canonical skills with symlinked consumers.
- Add only static phrase aliases to gateway/dispatcher.
  - Rejected because it does not provide structured Codex-ready prompt contracts.

## Consequences

### Positive
- Stable invocation semantics for Codex delegation phrases.
- Less ambiguity when asking for Codex execution, root-cause investigation, or retry policy design.
- Higher quality handoff prompts because the skill enforces required context and skill references.

### Negative
- Additional operational surface area in the skill directory and decision log (small).

### Risks
- If phrase patterns expand (e.g., “delegate to codex” variants), the skill trigger section must be updated.
- Future changes to OpenAI Codex best practices require reference refresh in `references/codex-prompting-guide.md`.

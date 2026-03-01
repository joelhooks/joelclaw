---
name: pdf-brain
description: "Research and library synthesis from the docs/PDF corpus, mapped to joelclaw system philosophy and concrete operational actions (especially k8s reliability). Trigger on: 'research this', 'from the library', 'from the books', 'pdf brain', 'correlate this', 'synthesize', or any request to derive practical architecture/ops guidance from the docs corpus. This skill is analysis-only; for ingestion/backfill workflows use pdf-brain-ingest."
---

# PDF Brain — Research → Practical System Moves

Use this skill when the user wants evidence-backed synthesis from the docs library (books, PDFs, long-form references), not generic web summarization.

This skill is for turning research into:
1) system philosophy implications, and
2) immediate execution plans (with bias toward k8s/infra reliability).

## When to Use

Trigger cues (explicit or implied):
- “research this”
- “from the library” / “from the books”
- “pdf brain”
- “correlate this to our system”
- “expand this into practical ideas”
- “what does this mean for k8s right now?”

Use when the ask is synthesis across multiple references, especially for distributed systems, reliability, resilience, event-driven architecture, and operations.

## Core Workflow

### 0) Clarify the target (brief)

Extract three anchors:
- **Decision horizon**: immediate fix / near-term hardening / long-term architecture
- **System surface**: gateway, worker, k8s, content pipeline, memory, etc.
- **Output form**: principles, action plan, ADR input, runbook checklist

If scope is unclear, ask one tight clarifying question.

### 1) Retrieve evidence from corpus

Use `joelclaw docs search` first, then `joelclaw docs context` for local windows.

Preferred pattern:
```bash
joelclaw docs search "<topic>" --limit 8 --semantic true
joelclaw docs search "<topic>" --doc <doc-id> --limit 8 --semantic true
joelclaw docs context <chunk-id> --mode snippet-window --before 1 --after 1
```

For noisy terms, pin to known doc IDs and use focused query phrases.

### 2) Build an evidence ledger

Keep a compact ledger while reading:
- `doc`
- `chunk-id`
- `claim` (one sentence)
- `relevance` (why it matters to this problem)

Never output synthesis without traceable evidence.

### 3) Convert evidence into principles

Turn each claim into an operational principle in imperative form:
- “Treat partial failure as normal.”
- “Fail fast at dependency boundaries.”
- “Prefer idempotent replay-safe remediation loops.”

Avoid vague advice. Each principle must imply a technical behavior.

### 4) Correlate to joelclaw philosophy

Map principles to existing joelclaw operating rules:
- single source of truth
- silent failures are bugs
- Inngest durability + retries
- CLI-first agent interface
- observability required at every step
- skill/doc updates when reality changes

If a principle conflicts with current behavior, call it out directly.

### 5) Translate into immediate k8s moves

For each principle, produce:
1. **Concrete change** (file/service/config path)
2. **Validation gate** (exact command)
3. **Failure signal** (what proves it did not work)
4. **Rollback or containment move**

Use this structure:

```markdown
- Principle:
- k8s/infra move:
- Implementation path:
- Verify:
- Failure signal:
- Next escalation:
```

### 6) Package output for action

Default output sections:
1. Evidence-backed principles (with chunk IDs)
2. System philosophy implications
3. Immediate k8s action plan (ordered by risk reduction)
4. ADR impact (new ADR vs update existing)

## K8s-Specific Correlation Heuristics

When the topic involves distributed systems reliability, prioritize these mappings:

- **Partial failure + nondeterminism** → avoid localhost-only liveness assumptions
- **Bulkheads/circuit breakers** → isolate critical probe paths and fail fast on dependency meltdown
- **Error-budget thinking** → gate risky deploy velocity on reliability state
- **Idempotent consumers + dedupe** → make heal/repair loops replay-safe
- **Observability for unknown-unknowns** → emit high-cardinality structured telemetry from probe + repair paths
- **Loose coupling / stable boundaries** → keep host bootstrap logic in adapters, keep control logic platform-neutral

## Rules

- Do not fabricate quotes or claims.
- Always cite chunk IDs for non-obvious assertions.
- Do not output “book report” fluff. Translate to operations.
- If infra changes are proposed, include verification commands.
- If work implies architectural policy change, tie it to an ADR path.

## Anti-Patterns

- Dumping generic best practices with no corpus evidence
- Mixing strategic and tactical advice with no prioritization
- Suggesting broad rewrites when a bounded hardening step reduces risk faster
- Treating one-host reliability hacks as long-term architecture

## Minimum Deliverable

A good response from this skill includes:
- 5–10 evidence-backed principles
- explicit mapping to joelclaw rules
- top 3 immediate k8s actions with verify commands
- ADR recommendation (update existing or propose new)

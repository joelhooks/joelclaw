---
name: session-search
displayName: Session Search
description: Search captured agent Runs and raw local/remote Pi sessions, especially dark-wizard sessions, using the joelclaw sessions bridge. Use when the user asks to search sessions, find prior dark-wizard/Panda/pi/codex/claude context, recover conversation history, verify session indexing, or bypass stale rag_search_sessions/Typesense results.
version: 0.1.0
author: joel
tags:
  - joelclaw
  - sessions
  - typesense
  - ssh
  - memory
---

# Session Search

Use this when Joel asks for session/conversation history or when `rag_search_sessions` is missing config, stale, or too narrow.

Canonical terms:

- **Run**: captured agent invocation in Central/Typesense.
- **Conversation**: sibling Runs sharing interactive context.
- **Session Search Bridge**: CLI convenience that searches Central's derived Run index plus raw Pi session JSONL on the local Machine or a remote Machine over SSH.

## Fast path

Search both Central Typesense and raw dark-wizard Pi sessions from Panda:

```bash
joelclaw sessions search "<query>" \
  --source both \
  --machine dark-wizard \
  --ssh-target joel@dark-wizard \
  --limit 8
```

Read the JSON. Prefer hits with:

- `source: "typesense"` when the derived index is current
- `source: "local"` when running on the Machine that has the raw Pi files
- `source: "ssh"` when Typesense is stale or you need raw remote session files from another Machine

## Extract task context

When search finds a candidate but snippets are too thin, extract bounded task context without a background reader agent:

```bash
joelclaw sessions search "<query>" --source both --machine dark-wizard --limit 5 --extract
# singular alias also works:
joelclaw session search "<query>" --source both --machine dark-wizard --limit 5 --extract
```

For a known raw transcript path or session id:

```bash
joelclaw sessions extract <session-id-or-path> --query "<topic>" --format markdown
```

Use `sessions inspect` for deterministic evidence around exact text:

```bash
joelclaw sessions inspect <session-id-or-path> --around "<regex>" --before 20 --after 80
```

Use `sessions chunks` when you want matching chunks/snippets and neighboring raw context without full extraction:

```bash
joelclaw sessions chunks "<query>" --source local --machine dark-wizard --limit 20 --context-before 2 --context-after 4
```

Use `sessions signals` when the job is not recovery but analysis: finding high-signal user turns, friction, preferences, approvals, or decisions. This is ADR-0247-backed and deterministic in v1:

```bash
joelclaw sessions signals --kind friction --source local --machine dark-wizard --since 14d --limit 20
joelclaw sessions signals --kind any --source local --machine dark-wizard --since 14d --sample 20 --review-out ~/.joelclaw/session-signals/review.jsonl --evaluate
joelclaw sessions signals --kind mode-mismatch --source local --machine dark-wizard --since 14d --evaluate
joelclaw sessions friction --source local --machine dark-wizard --since 14d
```

`friction` is an alias for `signals --kind friction`. The command filters to user turns first, classifies turnKind, and includes assistant/tool turns only as bounded evidence context. V1 includes `operator_intent`, `review_feedback`, and `approval`; it excludes task payloads, source material, and handoffs by default because those caused noisy false positives. Joel's `fuck`, `fucking`, and `fuckin` are strong emphasis signals, not automatic anger; classify by nearby critique/praise/correction language. `ShitRat` is agent identity, not friction. Use `--kind mode-mismatch` when hunting wrong execution shape: inline vs background, visual vs response, durable Inngest vs ad-hoc script, or feedback-blocking vs async.

Extraction returns session ID, path, dates, cwd, user prompts, decisions, commands run, files touched, outputs/receipts, verification, blockers, next actions, and transcript line evidence. It redacts likely secrets and does not dump whole transcripts.

Shape rules:

- `search --extract` attaches `extraction` directly to each emitted hit when available. `.result.extractions` is a compatibility convenience list. Piped `| jq` usage is supported for large envelopes.
- `extract --format markdown` still emits the canonical JSON envelope; rendered markdown is at `.result.markdown`.
- `chunks` exposes top-level `.result.chunks` / `.result.hits`, with source mirrors under `.result.local.chunks` and `.result.typesense.chunks`.
- Source metadata distinguishes `rawReturned` from `emittedHits` / `emittedChunks`.
- `signals` returns `kind`, `clusters`, `hits`, `signals[]`, stable `hitId`, exact `path`, and transcript line numbers. Treat it as a signal radar, not memory truth; promote only derived reusable guidance.
- Use `--sample N --review-out path.jsonl` to create a small golden set for human/agent labeling before tuning the classifier. Review rows include `verdict`, `correctedKind`, and `note` placeholders.
- Each signal includes `turnKind` plus a small reducer-shaped `improvement` route: surface (`system-prompt`, `skill`, `cli`, `harness`, `docs`, `memory`, `adr`, `none`), target, confidence, reviewPriority, suggested next step, and reason. Use `--evaluate` to summarize routing coverage by surface, kind, turnKind, confidence, and review priority.

## Source-specific searches

Typesense only:

```bash
joelclaw sessions search "<query>" --source typesense --machine dark-wizard --limit 8
```

Raw local Pi sessions only, for example on dark-wizard itself:

```bash
joelclaw sessions search "<query>" --source local --machine dark-wizard --limit 8
```

Raw remote Pi sessions only:

```bash
joelclaw sessions search "<query>" --source ssh --ssh-target joel@dark-wizard --limit 8
```

All Machines in Typesense:

```bash
joelclaw sessions search "<query>" --source typesense --machine all --limit 8
```

## When results disagree

If SSH finds fresh hits but Typesense does not, raw capture exists and the derived index is stale. Use the recovery runbook:

```bash
read ~/Code/joelhooks/joelclaw/docs/runbooks/typesense-session-indexing.md
```

Then verify:

```bash
KEY=$(secrets lease typesense_api_key)
curl -fsS -G http://localhost:8108/collections/runs_dev/documents/search \
  -H "X-TYPESENSE-API-KEY: $KEY" \
  --data-urlencode 'q=*' \
  --data-urlencode 'filter_by=agent_runtime:=pi && machine_id:=dark-wizard' \
  --data-urlencode 'per_page=3' \
  --data-urlencode 'sort_by=started_at:desc' \
  --data-urlencode 'include_fields=id,machine_id,started_at,tags' \
  | jq '[.hits[].document | {id,machine_id,started_at:(.started_at/1000|todateiso8601)}]'
```

## Local and SSH requirements

The bridge expects the Machine being scanned to have:

- `python3`
- raw Pi sessions under `~/.pi/agent/sessions/**/*.jsonl`

SSH mode also needs:

- `ssh joel@dark-wizard` access

Smoke test:

```bash
ssh joel@dark-wizard 'hostname && python3 --version && find ~/.pi/agent/sessions -type f -name "*.jsonl" | head'
```

On dark-wizard itself:

```bash
joelclaw sessions search "<query>" --source local --machine dark-wizard --limit 8
```

With `--source both`, the raw side uses `local` when the current hostname matches `--machine`; otherwise it uses `ssh`. That keeps dark-wizard from SSHing to itself. If the local Machine has no Typesense credential, `both` skips Typesense and returns raw local hits with `typesenseSkipped`; use `--source local` when you want that explicitly. If Typesense is unavailable in `both` mode, the CLI reports `typesenseUnavailable` and continues with raw results.

## Rules

- Do not print secrets.
- Do not copy raw session files unless Joel asks; return pointers and snippets first.
- Use bounded search output. No full transcript dumps.
- If you change indexing, services, config, or this skill, write a slog entry and commit.

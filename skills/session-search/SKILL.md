---
name: session-search
displayName: Session Search
description: Search captured agent Runs and raw remote Pi sessions, especially dark-wizard sessions, using the joelclaw sessions bridge. Use when the user asks to search sessions, find prior dark-wizard/Panda/pi/codex/claude context, recover conversation history, verify session indexing, or bypass stale rag_search_sessions/Typesense results.
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
- **Session Search Bridge**: CLI convenience that searches Central's derived Run index plus raw Pi session JSONL on a remote Machine over SSH.

## Fast path

Search both Central Typesense and raw dark-wizard Pi sessions:

```bash
joelclaw sessions search "<query>" \
  --source both \
  --machine dark-wizard \
  --ssh-target joel@dark-wizard \
  --limit 8
```

Read the JSON. Prefer hits with:

- `source: "typesense"` when the derived index is current
- `source: "ssh"` when Typesense is stale or you need raw remote session files

## Source-specific searches

Typesense only:

```bash
joelclaw sessions search "<query>" --source typesense --machine dark-wizard --limit 8
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

## SSH requirements

The bridge expects dark-wizard to have:

- `ssh joel@dark-wizard` access
- `python3`
- raw Pi sessions under `~/.pi/agent/sessions/**/*.jsonl`

Smoke test:

```bash
ssh joel@dark-wizard 'hostname && python3 --version && find ~/.pi/agent/sessions -type f -name "*.jsonl" | head'
```

## Rules

- Do not print secrets.
- Do not copy raw session files unless Joel asks; return pointers and snippets first.
- Use bounded search output. No full transcript dumps.
- If you change indexing, services, config, or this skill, write a slog entry and commit.

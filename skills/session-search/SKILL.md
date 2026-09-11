---
name: session-search
displayName: Session Search
description: Search captured agent Runs and raw local/remote Pi sessions, especially flagg sessions, using the joelclaw sessions bridge. Use when the user asks to search sessions, find prior flagg/Panda/pi/codex/claude context, recover conversation history, verify session indexing, or bypass stale rag_search_sessions/Typesense results.
version: 0.1.0
author: joel
tags:
  - joelclaw
  - sessions
  - typesense
  - ssh
  - memory
---

# Session evidence

Use `recall` through Executor's saved memory connection first. This skill handles exact session evidence and capture/index diagnosis when those are part of the request.

Before transcript search, chunks, inspection, or extraction, obtain the current scope-bound `evidenceDrilldownReceipt` and use the discovered tool schema that accepts it. Keep private queries in MCP arguments. A recall success, missing projection, zero hits, or stale index is not raw-access authorization.

Metadata diagnosis may inspect capture timestamps, file counts, outbox counts, indexing health, and admission receipts without opening transcript bodies. Native files are source evidence, capture receipts prove admission, and the index is a derived projection; do not confuse them.

For capture/index repairs, read `agent-session-capture-backup` and the current operator archive-maintenance runbook. Inspect the existing repair script and help before use. Replay and environment repair are mutations, not read-only diagnostics. Preserve native evidence and other sessions' work.

Use bounded evidence windows only for the requested question. Verify runtime, session identity, and source dates. Return the relevant receipt, conclusion, and exact missing capability. Never replace unavailable indexed recall with unapproved local or remote transcript scraping.

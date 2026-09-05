---
name: recall
displayName: Recall
description: "Fan-out search across all memory sources when context is unclear or vaguely referenced. Triggers on: 'from earlier', 'remember when', 'what we discussed', 'that thing with', 'the conversation about', 'did we ever', 'what happened with', 'you mentioned', 'we talked about', 'earlier today', 'last session', 'the other day', or any vague reference to past context that needs resolution before the agent can act."
version: 1.0.0
author: Joel Hooks
tags: [joelclaw, memory, recall, context, retrieval]
---

# Recall

Use the saved `memory` connection managed by Executor for prior decisions, project context, and conversation-derived memory. Discover the connection and callable tools for this session; historical examples do not prove availability.

Start with composed recall using the exact project/workstream scope and access envelope. Correct the scope on `No projection head`. A disconnected direct MCP server does not prove the saved connection is unavailable.

Keep private queries in structured MCP arguments, never shell arguments or logs. Read the operator's current integration contract before memory drilldown or Granola work.

Raw transcript search, inspection, and extraction require a valid `evidenceDrilldownReceipt` for the exact scope and evidence. Discover the tool schema that accepts it. A successful recall, empty result, stale index, or inaccessible provider does not itself authorize raw fallback. If the contract cannot provide the required evidence, report that gap and continue with supported sources.

Separate recalled claims from current source or live facts. Return a concise synthesis with source receipts and uncertainty. Do not fan out into unrelated mail, transcripts, or private stores merely because they are searchable.

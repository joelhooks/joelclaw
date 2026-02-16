---
title: "Background agents: async task dispatch via Inngest with file inbox notifications"
status: proposed
date: 2026-02-16
deciders: Joel Hooks
consulted: Claude (pi session 2026-02-16)
informed: All agents operating on this system
related:
  - "[ADR-0005 — Durable multi-agent coding loops](0005-durable-multi-agent-coding-loops.md)"
  - "[ADR-0023 — Docker sandbox for agent loops](0023-docker-sandbox-for-agent-loops.md)"
  - "[ADR-0025 — Network architecture](0025-k3s-cluster-for-joelclaw-network.md)"
---

# ADR-0026: Background Agents via Inngest with File Inbox Notifications

## Context

Interactive agent sessions (pi, Claude Code) are synchronous — the user waits while work happens. Some tasks don't need that: "go research this", "audit the codebase for X", "run a system check at 3am". Today the only option is the `codex` background tool in pi-tools, which spawns a process directly. That works but isn't durable (dies if the machine restarts), isn't observable (no Inngest trace), and can't be triggered by cron or other events.

We already have Inngest for durable execution and an event bus for coordination. The missing piece is a way for a session to **request background work** and **get notified when it's done** — even if the session has ended and a new one started.

## Decision

Send a `system/agent.requested` event to Inngest. An Inngest function dispatches the work (codex, claude, pi, or any tool). On completion, it writes the result to a file inbox. A pi-tools extension watches the inbox and injects results into the active session.

### Skill-based dispatch

Background agents are **skill-aware**. The requesting agent doesn't need to know which tool or machine handles the work — the dispatch function reads a skill manifest that maps task types to capabilities:

- What tools are available (codex, claude, pi, custom scripts)
- What the network can handle (local LLM, CUDA inference, embedding, transcription)
- Where workloads should run (which node, what resource constraints)

Any agent harness that can send an Inngest event gets access to the full network's capabilities. The skill manifest is the contract — "here's what background agents can do." This means a pi session, a Claude Code session, a cron job, or a webhook can all request the same work.

### Bias toward background

The default posture should be: **fire it off, don't block.** Most tasks don't need the requesting session to wait. The main chat context should stay fast and responsive — not filled with 500 lines of codex output for a task the user doesn't need to watch.

When an agent is considering whether to do work inline or dispatch it:
- **Inline**: Quick lookups, file reads, small edits — anything under ~30 seconds that the user is actively waiting for.
- **Background**: Research, audits, multi-file refactors, system checks, anything exploratory, anything that takes >1 minute. Fire and forget. Result arrives in the inbox.

## How It Works

```
Session (pi/claude)              Inngest                         Agent (codex/claude/pi)
    │                               │                                │
    ├── system/agent.requested ────►│                                │
    │   {                           │                                │
    │     requestId: "req_abc123",  │                                │
    │     sessionId: "pi_xyz",      │                                │
    │     task: "audit all launchd  │                                │
    │       plists for security",   │                                │
    │     tool: "codex",            │                                │
    │     cwd: "/Users/joel",       │                                │
    │     priority: "normal"        │                                │
    │   }                           │                                │
    │                               ├── spawn agent ────────────────►│
    │                               │                                │
    │   (session continues or ends) │                                │ (does work)
    │                               │                                │
    │                               │◄── exit + stdout/stderr ───────┤
    │                               │                                │
    │                               ├── write inbox file             │
    │                               │   ~/.joelclaw/workspace/       │
    │                               │     inbox/req_abc123.json      │
    │                               │                                │
    │                               ├── emit system/agent.completed  │
    │                               │   (for chaining)               │
    │                               │                                │
    │◄── fs.watch fires ────────────┤                                │
    │    inject as system message   │                                │
    ▼                               ▼                                ▼
```

### Inbox file format

```json
{
  "requestId": "req_abc123",
  "sessionId": "pi_xyz",
  "status": "completed",
  "task": "audit all launchd plists for security",
  "tool": "codex",
  "result": "Found 4 plists. All use absolute paths. No credentials in arguments. vault-log-sync runs as user, not root. Recommendation: add StandardErrorPath to all plists for debugging.",
  "startedAt": "2026-02-16T08:00:00Z",
  "completedAt": "2026-02-16T08:02:34Z",
  "durationMs": 154000
}
```

On failure:

```json
{
  "requestId": "req_abc123",
  "sessionId": "pi_xyz",
  "status": "failed",
  "task": "...",
  "tool": "codex",
  "error": "Process exited with code 1: Cannot find module ...",
  "startedAt": "...",
  "completedAt": "...",
  "durationMs": 12000
}
```

### Inbox lifecycle

- **Write**: Inngest function writes `~/.joelclaw/workspace/inbox/{requestId}.json` on completion/failure.
- **Read**: Pi-tools extension watches directory with `fs.watch`. On new file, reads it, injects as system message in active session.
- **Ack**: After injection, move to `inbox/ack/` (not delete — audit trail).
- **Orphan**: If no session is active when the file appears, it stays in `inbox/`. Next session start scans for unacknowledged results and presents them.
- **TTL**: Files in `inbox/ack/` older than 7 days get cleaned up.

## Three Pieces to Build

### 1. Inngest function: `system/agent-dispatch`

```typescript
// packages/system-bus/src/inngest/functions/agent-dispatch.ts
inngest.createFunction(
  { id: "system/agent-dispatch", retries: 1 },
  { event: "system/agent.requested" },
  async ({ event, step }) => {
    const { requestId, sessionId, task, tool, cwd, priority } = event.data;

    const result = await step.run("execute-agent", async () => {
      // spawn codex/claude/pi based on tool
      // capture stdout, stderr, exit code
      // respect timeout (default 10 min)
    });

    await step.run("write-inbox", async () => {
      // write result to ~/.joelclaw/workspace/inbox/{requestId}.json
    });

    await step.sendEvent("notify-completion", {
      name: "system/agent.completed",
      data: { requestId, sessionId, status: result.status }
    });
  }
);
```

### 2. Pi-tools extension: inbox watcher

A pi-tools extension that:
- On session start: scan `inbox/` for unacked results, present any found
- During session: `fs.watch` on `inbox/`, inject new results as system messages
- On injection: move file to `inbox/ack/`

### 3. Pi tool: `background_agent`

A tool available in pi sessions:

```
background_agent(task: "audit launchd plists", tool: "codex", cwd: "/Users/joel")
→ returns { requestId: "req_abc123", status: "dispatched" }
```

The agent can then continue with other work. When the result arrives, it appears as a system message.

## Use Cases

| Trigger | Task | Tool |
|---------|------|------|
| User request | "research SKOS taxonomy best practices" | codex |
| User request | "audit the codebase for TODO comments" | codex |
| Inngest cron (3am daily) | System health deep-check | pi |
| Inngest cron (weekly) | Vault consistency audit | codex |
| Event chain | After video-download completes, enrich metadata | codex |
| User request | "go fix the TypeScript errors in system-bus" | claude |

## What This Enables Later

- **3am system check**: Inngest cron fires `system/agent.requested` at 3am. Codex runs a system audit. Results are in the inbox when Joel opens pi in the morning.
- **Agent chains**: `system/agent.completed` event triggers another `system/agent.requested`. Multi-step autonomous workflows without a monolithic loop.
- **Priority queues**: `priority` field enables future scheduling — urgent tasks run immediately, normal tasks queue behind active work.
- **Multi-machine dispatch**: When k3s arrives (ADR-0025), the Inngest function can schedule agents on specific nodes. GPU-heavy tasks go to the GPU box, research tasks go wherever.

## What This Does NOT Replace

- **Agent loops (ADR-0005)**: Loops are multi-story, multi-iteration coding workflows with PRDs, test-writers, reviewers. Background agents are single-task, fire-and-forget.
- **Interactive sessions**: If the user needs to collaborate with the agent, that's a session, not a background task.
- **`codex` tool in pi-tools**: The existing tool works for quick background tasks within a session. This ADR is for durable, cross-session, cron-triggerable work.

## Verification Criteria

- [ ] `system/agent.requested` event triggers agent-dispatch function
- [ ] Codex/claude/pi can be spawned as the background tool
- [ ] Result written to inbox file on success and failure
- [ ] Pi-tools extension detects new inbox files and injects as system messages
- [ ] Unacked inbox files presented on session start
- [ ] `system/agent.completed` event emitted for chaining
- [ ] 3am cron system check produces a result in the inbox by morning

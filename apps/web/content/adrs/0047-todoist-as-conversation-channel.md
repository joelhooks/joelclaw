---
status: accepted
date: 2026-02-18
deciders: Joel
tags:
  - architecture
  - tasks
  - conversation
  - gateway
  - joelclaw
---

# ADR-0047: Todoist as Async Conversation Channel

## Context

joelclaw has Telegram as a real-time conversation channel (text, photos, voice notes). But many decisions don't need real-time chat — they need structured, persistent, async threads where the agent asks a question, Joel thinks about it on his phone, and replies when ready.

Ali Abdaal's Todoist setup (adopted 2026-02-18, see ADR-0045) uses **task comments as the source of truth for async communication** between a team. His "Questions/Approvals" project is a delegation inbox where team members post questions as tasks, the decision-maker responds via comments, and the task is completed when resolved.

In joelclaw, the agent IS the team. The same pattern works:

```
Agent creates task: "Should we use LiveKit or ElevenLabs for voice? (ADR-0043)"
  → Joel comments from phone: "LiveKit, we want self-hosted"
    → Agent picks up comment, has full task context
      → Agent responds: "Done. Updated ADR-0043 for LiveKit. Created 3 subtasks."
        → Joel taps ✅
```

Every task is a thread. Every comment is a message. The task description is the system prompt. Completion is resolution.

This is fundamentally different from chat:
- **Chat is ephemeral** — messages scroll away, context is lost between sessions
- **Tasks are durable** — persistent context, structured metadata (labels, priority, project), visible on every device, searchable
- **Tasks have outcomes** — complete, reschedule, delete. Chat just... continues.

## Decision

Add Todoist as a **conversation channel** in the gateway, alongside Telegram. The agent can initiate conversations by creating tasks with questions, and respond to Joel's comments on any task.

### Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Todoist    │     │   Inngest    │     │   Agent Loop    │
│  (Joel's     │────▶│   Cron       │────▶│   Function      │
│   phone)    │     │  (2 min poll)│     │                 │
└─────────────┘     └──────────────┘     └────────┬────────┘
       ▲                                          │
       │            ┌──────────────┐              │
       └────────────│  Todoist API │◀─────────────┘
         comment    │  addComment  │   agent reply
                    └──────────────┘
```

### Inbound: Poll-Based Comment Detection

Use Todoist's Activity Log API to detect new comments. No public webhook endpoint needed — the Mac Mini polls from inside the tailnet.

```typescript
// Inngest cron: every 2 minutes
inngest.createFunction(
  { id: "todoist-comment-poll" },
  { cron: "*/2 * * * *" },
  async ({ step }) => {
    const lastCheck = await step.run("get-last-check", () =>
      redis.get("todoist:last-comment-check")
    );

    const activities = await step.run("poll-activities", () =>
      todoist.getActivities({
        objectEventTypes: ["note:added"],
        dateFrom: lastCheck || new Date(Date.now() - 120_000).toISOString(),
        annotateNotes: true,    // includes comment content
        annotateParents: true,  // includes parent task info
      })
    );

    // Filter to comments by Joel (not by the agent)
    const joelComments = activities.results.filter(
      a => a.initiator_id !== AGENT_USER_ID
    );

    for (const comment of joelComments) {
      await step.sendEvent("emit-comment", {
        name: "todoist/comment.added",
        data: {
          taskId: comment.parent_item_id,
          commentContent: comment.extra_data?.content,
          taskContent: comment.extra_data?.parent_name,
        },
      });
    }

    await step.run("update-checkpoint", () =>
      redis.set("todoist:last-comment-check", new Date().toISOString())
    );
  }
);
```

### Processing: Task-Scoped Agent Conversation

When a comment is detected, load the full conversation context and run the agent:

```typescript
inngest.createFunction(
  { id: "todoist-comment-respond" },
  { event: "todoist/comment.added" },
  async ({ event, step }) => {
    // Load full task context
    const task = await step.run("load-task", () =>
      todoist.getTask(event.data.taskId)
    );

    const { results: comments } = await step.run("load-comments", () =>
      todoist.getComments({ taskId: event.data.taskId })
    );

    // Build conversation from task + comments
    const conversation = [
      { role: "system", content: buildTaskSystemPrompt(task) },
      ...comments.map(c => ({
        role: c.postedBy === AGENT_USER_ID ? "assistant" : "user",
        content: c.content,
      })),
    ];

    // Agent processes and decides action
    const response = await step.ai.infer("respond", {
      model: "anthropic/claude-sonnet",
      body: { messages: conversation },
    });

    // Post reply as comment
    await step.run("post-reply", () =>
      todoist.addComment({
        taskId: event.data.taskId,
        content: response.choices[0].message.content,
      })
    );

    // Agent may also take actions based on the conversation
    const actions = parseActions(response);
    if (actions.complete) {
      await step.run("complete-task", () =>
        todoist.closeTask(event.data.taskId)
      );
    }
    if (actions.createSubtasks) {
      for (const subtask of actions.createSubtasks) {
        await step.run(`create-subtask-${subtask.id}`, () =>
          todoist.addTask({ ...subtask, parentId: event.data.taskId })
        );
      }
    }
  }
);
```

### Outbound: Agent Initiates Conversations

The agent creates tasks when it needs Joel's input:

```typescript
// Agent needs a decision
await todoist.addTask({
  content: "Choose: LiveKit (self-hosted) or ElevenLabs (managed) for voice?",
  description: [
    "## Context",
    "ADR-0043 Phase 3 needs a realtime voice provider.",
    "",
    "## Options",
    "1. **LiveKit Agents** — OSS, self-host on k8s, WebRTC, pluggable STT/LLM/TTS",
    "2. **ElevenLabs Agents** — managed, WebSocket, good TTS, less control",
    "",
    "## My recommendation",
    "LiveKit — aligns with self-hosted principle, already have k8s cluster.",
    "",
    "**Reply with your choice and I'll update the ADR.**",
  ].join("\n"),
  labels: ["review"],
  priority: 2,
});
```

The task description IS the briefing. Joel reads it on his phone, comments "LiveKit", and the agent takes it from there.

### Labels as Routing

| Label | Meaning |
|-------|---------|
| `review` | Agent needs Joel's decision — shows in "needs input" filter |
| `agent` | Agent is handling autonomously — Joel can observe |
| `waiting` | Blocked on external (not Joel, not agent) |

Todoist filter for Joel's daily review: `@review & !completed` — shows everything the agent is waiting on him for.

### Conversation-Aware Task System Prompt

```typescript
function buildTaskSystemPrompt(task: Task): string {
  return [
    "You are Joel's AI assistant, responding in the context of a specific task.",
    `Task: ${task.content}`,
    task.description ? `\nBrief:\n${task.description}` : "",
    `\nProject: ${task.projectId}`,
    task.labels.length ? `Labels: ${task.labels.join(", ")}` : "",
    task.due ? `Due: ${task.due.string}` : "",
    "\nRules:",
    "- Be concise — this is a task comment, not an essay",
    "- If you can take action (update ADRs, create tasks, run code), do it and report what you did",
    "- If you need more info, ask a specific question",
    "- If the decision is made, summarize the outcome and complete the task",
  ].join("\n");
}
```

## Alternatives Considered

### A: Todoist Webhooks (Push)

Todoist supports webhooks for Pro accounts. A webhook would POST to a URL when a comment is added — lower latency than polling.

**Rejected for now** because:
- Requires a public-facing endpoint (Caddy + Tailscale funnel or similar)
- Adds infrastructure complexity
- 2-minute poll latency is fine for async decisions
- Can upgrade to webhooks later without changing the event schema

### B: Telegram Only

Keep all conversation in Telegram. Tasks are just a to-do list, not a conversation channel.

**Rejected** because Telegram is ephemeral — messages lack structure, decisions get lost in scroll, no persistent thread per topic. Tasks-as-threads solves this.

### C: GitHub Issues / Discussions

Use GitHub issues as the conversation layer. Already has threads, labels, assignment.

**Rejected** because Joel doesn't live in GitHub on his phone. Todoist is already on every device. Meet Joel where he is.

## Consequences

### Positive
- **Structured async decisions** — every question has a persistent thread with context
- **Phone-native** — Joel comments from Todoist app, not SSH or browser
- **Durable** — conversations survive session restarts, compactions, everything
- **Searchable** — Todoist search + filters find past decisions
- **Observable** — `@review` filter shows everything waiting on Joel
- **Composable** — agent can take action from comments (create subtasks, update ADRs, complete tasks)
- **No new apps** — Todoist is already installed and active

### Negative
- **2-minute latency** (poll-based) — not suitable for real-time conversation (that's what Telegram is for)
- **Comment threading is flat** — Todoist comments don't nest, long conversations get linear
- **API rate limits** — polling every 2 min is ~720 calls/day, well within Todoist's limits
- **Agent identity** — comments from the agent use Joel's token (appears as Joel). Could confuse if Joel reads old threads. Mitigation: prefix agent comments with `🤖` or similar.

### Risks
- **Comment storms** — agent and Joel both comment rapidly, creating a loop. Mitigation: agent only responds to comments from Joel (filter by `initiator_id`), never to its own.
- **Stale context** — task description may be outdated by the time Joel comments. Mitigation: agent re-reads task + all comments on every trigger.

## Implementation Status

**Phase 4 implemented first** — webhooks proved simpler than polling.

### ✅ Phase 4: Webhooks (2026-02-18)
- Todoist webhook → Tailscale Funnel :443 → worker :3111 → HMAC verify → Inngest event
- 3 Inngest functions: `todoist-comment-notify`, `todoist-task-completed-notify`, `todoist-task-created-notify`
- API enrichment step fetches task title + project name from Todoist API v1
- Gateway notifications via `gateway.notify()` → Redis → pi session
- Webhook URL: `https://panda.tail7af24.ts.net/webhooks/todoist`
- Key files: `src/webhooks/providers/todoist.ts`, `src/inngest/functions/todoist-notify.ts`
- Gotchas learned: Caddy drops Funnel POST bodies (point Funnel directly at worker); HMAC uses `client_secret` not "Verification token"; `joelclaw refresh` required after function deploy

### ⬜ Phase 1: Respond via Comments
- Agent posts reply as comment on the originating task
- Not yet implemented — gateway currently acknowledges but doesn't write back to Todoist

### ⬜ Phase 2: Agent-Initiated Questions
- Agent creates tasks with `review` label when decisions are needed
- Task description includes structured briefing (context, options, recommendation)

### ⬜ Phase 3: Actions from Comments
- Agent parses intent from Joel's comment (approve, reject, modify, defer)
- Takes actions: update ADRs, create subtasks, complete task, reschedule

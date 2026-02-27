---
name: joelclaw
description: "Operate the joelclaw event bus and agent loop infrastructure via the joelclaw CLI (igs is a legacy alias). Use for: sending events, checking runs, starting/monitoring/cancelling agent loops, debugging failed runs, checking health, restarting the worker, inspecting step traces. Triggers: 'joelclaw', 'send an event', 'check inngest', 'start a loop', 'loop status', 'why did this fail', 'debug run', 'check worker', 'restart worker', 'runs', 'what failed', 'igs', or any Inngest/event-bus/agent-loop task."
---

# joelclaw — Event Bus & Agent Loop CLI

The `joelclaw` CLI (formerly `igs`, kept as a legacy alias) is the agent-facing interface to the joelclaw event bus (Inngest) and agent loop infrastructure.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  k3d cluster "joelclaw" (k3s v1.33.6, namespace: joelclaw) │
│                                                              │
│  StatefulSet: inngest    → NodePort 8288 (API), 8289 (dash) │
│  StatefulSet: redis      → NodePort 6379                     │
│  StatefulSet: qdrant     → NodePort 6333, 6334               │
│                                                              │
│  ⚠️ Service named inngest-svc (not inngest)                  │
│     k8s auto-injects INNGEST_PORT env collision otherwise    │
└─────────────────────────────────────────────────────────────┘
        ↕ NodePort on localhost
┌─────────────────────────────────────────────────────────────┐
│  system-bus worker (Bun + Hono, launchd, port 3111)         │
│  ~/Code/system-bus-worker/packages/system-bus/               │
│  16 Inngest functions registered                             │
└─────────────────────────────────────────────────────────────┘
```

**Inngest event key**: `37aa349b89692d657d276a40e0e47a15`
**k8s manifests**: `~/Code/joelhooks/joelclaw/k8s/`

## joelclaw CLI Reference

### Output Modes

Most commands support `--compact/-c` for plain-text output. **Use compact mode for monitoring** — it's directly readable without JSON parsing. JSON (default) is for programmatic use.

```bash
joelclaw loop status -c                    # plain text, one line per story
joelclaw runs -c                           # plain text, one line per run
joelclaw loop status                       # full HATEOAS JSON (default)
joelclaw loop status -v                    # JSON + descriptions, acceptance criteria, output paths
```

### Send Events

```bash
joelclaw send "event/name" --data '{"key":"value"}'
joelclaw send "pipeline/video.download" --data '{"url":"https://youtube.com/watch?v=XXX"}'
joelclaw send "memory/session.compaction.pending" --data '{"sessionId":"test","messages":"..."}'
```

### View Runs

```bash
joelclaw runs                              # recent 10
joelclaw runs -c                           # compact — one line per run
joelclaw runs --status FAILED              # just failures
joelclaw runs --status COMPLETED --hours 1 # last hour's completions
joelclaw run <RUN_ID>                      # step trace + errors for one run
```

### View Events

```bash
joelclaw events                            # last 4 hours
joelclaw events --prefix memory/ --hours 24  # memory pipeline events
joelclaw events --prefix agent/ --hours 24   # agent loop events
joelclaw events --count 50 --hours 48        # wider window
```

### View Logs

```bash
joelclaw logs                              # worker stdout (default 30 lines)
joelclaw logs errors                       # worker stderr (stack traces)
joelclaw logs server                       # inngest k8s pod logs
joelclaw logs server -n 50 --grep error    # filtered server errors
joelclaw logs worker --grep "observe"      # grep worker logs
```

### Story Pipeline (ADR-0155)

The 3-stage story pipeline runs individual PRD stories through implement → prove → judge.

```bash
# Fire a single story from a PRD
joelclaw send agent/story.start -d '{
  "prdPath": "/Users/joel/Code/joelhooks/joelclaw/prd.json",
  "storyId": "CFP-2"
}'

# ALWAYS use absolute path for prdPath — worker CWD is packages/system-bus/
# Story IDs must match an id in the PRD's stories array

# Monitor the run
joelclaw event <EVENT_ID>                  # map event → run
joelclaw run <RUN_ID>                      # step trace + errors
```

**PRD format** (Zod-validated at runtime):
```json
{
  "name": "Project Name",
  "context": {},
  "stories": [
    {
      "id": "STORY-1",
      "title": "What to build",
      "description": "Details",
      "priority": 1,
      "acceptance": ["criterion 1", "criterion 2"],
      "files": ["path/to/relevant/file.ts"]
    }
  ]
}
```

**Critical rules:**
- `context` must be `{}` or object with optional fields — NEVER null or string
- Every story MUST have `priority` (number)
- `acceptance` or `acceptance_criteria` (array of strings) — both accepted
- **NEVER set `retries: 0`** on any Inngest function — breaks restart safety (ADR-0156)

### Legacy Agent Loops

```bash
# Start with planner-generated PRD (preferred)
joelclaw loop start --project ~/Code/system-bus-worker/packages/system-bus \
  --goal "Implement feature X per ADR-0021" \
  --context ~/Vault/docs/decisions/0021-agent-memory-system.md \
  --max-retries 2

# Start with existing PRD file
joelclaw loop start --project PATH --prd prd.json --max-retries 2

# Monitor (compact is best for polling)
joelclaw loop status <LOOP_ID> -c

# Live watch (polls every 15s, prints on change, exits on completion)
joelclaw watch <LOOP_ID>
joelclaw watch                             # auto-detects active loop
joelclaw watch -i 30                       # poll every 30s

# Management
joelclaw loop list                         # all loops in Redis
joelclaw loop cancel <LOOP_ID>             # stop + cleanup
joelclaw loop nuke dead                    # remove completed loops from Redis
```

### System Health

```bash
joelclaw status                            # health: server + worker + k8s pods
joelclaw functions                         # list all registered functions
joelclaw refresh                           # force re-register with Inngest server
```

### Discover

```bash
joelclaw discover "https://example.com" --context "why this is interesting"
```

## Event Types

### Pipelines
| Event | Chain |
|-------|-------|
| `pipeline/video.download` | → video-download → transcript-process → content-summarize |
| `pipeline/transcript.process` | → transcript-process → content-summarize |
| `content/summarize` | → content-summarize |
| `content/updated` | → content-sync (git commit vault changes) |

### Memory (ADR-0021)
| Event | Chain |
|-------|-------|
| `memory/session.compaction.pending` | → observe-session |
| `memory/session.ended` | → observe-session |
| `memory/observations.accumulated` | → reflect |
| `memory/observations.reflected` | → promote (if proposals pending) |

### Agent Loops
| Event | Flow |
|-------|------|
| `agent/loop.started` | → plan → test-writer → implement → review → judge |
| `agent/loop.story.passed` | → plan (next story) |
| `agent/loop.story.failed` | → plan (retry or next) |
| `agent/loop.completed` | → complete (merge-back + cleanup) |

### Google Workspace (ADR-0040)
| Event | Purpose |
|-------|---------|
| `google/calendar.checked` | Calendar events fetched |
| `google/gmail.checked` | Email search/summary completed |
| `google/gmail.archived` | Messages archived |

### System
| Event | Purpose |
|-------|---------|
| `system/log` | System log entry |
| `discovery/noted` | URL/idea captured |

## Debugging Failed Runs

```bash
joelclaw runs --status FAILED -c           # 1. find the failure
joelclaw run <RUN_ID>                      # 2. step trace + inline errors
joelclaw logs errors                       # 3. worker stderr (stack traces)
joelclaw logs server --grep error          # 4. inngest server errors
```

All inspection goes through `joelclaw`. No raw curl/GraphQL needed.

### Common failure patterns

| Symptom | Cause | Fix |
|---------|-------|-----|
| Events accepted but functions never run | Inngest can't reach worker | `igs refresh`, restart worker |
| "Unable to reach SDK URL" in k8s logs | Worker not accessible from cluster | Restart worker, `igs refresh` |
| Loop story SKIPPED | Tests/typecheck failed in worktree | Check attempt output — code often landed anyway |
| Run stuck in RUNNING | Worker crashed mid-step | `igs logs errors`, restart worker |
| `INNGEST_PORT` env collision | k8s service named `inngest` | Service is `inngest-svc` — keep this name |

## Restarting Services

```bash
launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker  # restart worker
joelclaw refresh                                                       # re-register functions
kubectl rollout restart statefulset/inngest -n joelclaw           # restart inngest pod
joelclaw status                                                        # verify everything
```

## Agent Loop Infrastructure

### Pipeline

```
joelclaw loop start → agent/loop.started
  → PLANNER (claude) reads project + generates PRD
    → TEST-WRITER → IMPLEMENTOR (codex) → REVIEWER (claude) → JUDGE (claude)
      pass → next story | fail → retry with feedback | exhausted → skip
  → COMPLETER merges worktree branch, cleans up
```

### Worktree mechanics

- Created at `/tmp/agent-loop/{loopId}/`, branch `agent-loop/{loopId}`
- `pnpm install` runs after creation and on re-entry
- Complete stashes dirty state (prd.json, progress.txt), merges, pops

### Monitoring a running loop

```bash
joelclaw watch                             # best — live updates, exits on completion
joelclaw loop status -c                    # one-shot compact check
tail -40 /tmp/agent-loop/<LOOP_ID>/<STORY_ID>-<ATTEMPT>.out  # what the agent actually did
```

### Loop gotchas

- **Don't edit monorepo while loop runs** — `git add -A` scoops unrelated changes
- **igs repo IS safe to edit during loops** — it's separate at `~/Code/joelhooks/igs/`
- **Worktree branch not auto-deleted on cancel** — clean manually
- **Loop restart not idempotent** — cancel leaves state in 3 places (cancel flag, Redis, git branch)
- **Skipped stories often have code that landed** — later stories may include the work, or first attempt was correct but tests over-specified

## Monitoring Agent Sessions

Codex sessions write JSONL transcripts to `~/.codex/sessions/YYYY/MM/DD/*.jsonl`. When a story pipeline run is active, monitor it by tailing the most recent session.

### Find the active session
```bash
# Most recently modified codex session
ls -t ~/.codex/sessions/$(date +%Y/%m/%d)/*.jsonl | head -1
```

### Extract what codex is doing (reasoning summaries)
```bash
SESSION=$(ls -t ~/.codex/sessions/$(date +%Y/%m/%d)/*.jsonl | head -1)

# Reasoning summaries — high-level intent
grep '"response_item"' "$SESSION" | \
  jq -r '.payload | select(.type == "reasoning") | .summary[]?.text // empty'

# Tool calls — what files it's reading/editing
grep '"response_item"' "$SESSION" | \
  jq -r '.payload | select(.type == "function_call") | .name + ": " + (.arguments // "" | .[:200])' | \
  tail -20

# Live tail (poll every 10s)
watch -n 10 'grep "response_item" "'"$SESSION"'" | jq -r ".payload | select(.type == \"reasoning\") | .summary[]?.text // empty" | tail -10'
```

### JSONL entry structure
Each line: `{ type, timestamp, payload }`
- `type: "response_item"` → codex output (reasoning, function_call, function_call_output, custom_tool_call)
- `type: "event_msg"` → system/user messages
- `type: "turn_context"` → turn metadata

Payload subtypes for `response_item`:
- `payload.type: "reasoning"` → `payload.summary[].text` has the readable summary
- `payload.type: "function_call"` → `payload.name` (e.g. `exec_command`), `payload.arguments` (JSON with cmd, workdir)
- `payload.type: "function_call_output"` → command results (can be large)

### Future: `joelclaw agent watch`
CLI command to stream codex session activity in real-time. Until built, use the patterns above.

## Key Paths

| What | Path |
|------|------|
| igs CLI source | `~/Code/joelhooks/igs/` |
| Worker source (canonical) | `~/Code/joelhooks/joelclaw/packages/system-bus/` |
| Worker clone (launchd runs from) | `~/Code/system-bus-worker/packages/system-bus/` |
| Function implementations | `src/inngest/functions/` |
| Event type definitions | `src/inngest/client.ts` |
| Server entrypoint | `src/serve.ts` |
| k8s manifests | `~/Code/joelhooks/joelclaw/k8s/` |
| Worker logs (stdout) | `~/.local/log/system-bus-worker.log` |
| Worker logs (stderr) | `~/.local/log/system-bus-worker.err` |
| Loop attempt output | `/tmp/agent-loop/{loopId}/{storyId}-{attempt}.out` |

## Improving igs

igs is at `~/Code/joelhooks/igs/` — Effect-TS CLI, safe to edit while loops run against the monorepo. Commands in `src/commands/`, one file per command. Follow the [cli-design skill](../cli-design/SKILL.md).

When monitoring reveals a gap — missing data, extra manual step, bad next_actions — **fix igs immediately**. The nanny is the primary consumer; it discovers what's missing.

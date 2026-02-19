# inngest-monitor — Pi Extension Design

## Purpose

Pi extension that sends Inngest events and monitors their run lifecycle in a persistent widget via GQL polling. No Redis dependency.

## Config

```typescript
const INNGEST_URL = process.env.INNGEST_URL ?? "http://localhost:8288";
const INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY ?? "37aa349b89692d657d276a40e0e47a15";
const GQL_URL = `${INNGEST_URL}/v0/gql`;
const EVENT_API = `${INNGEST_URL}/e/${INNGEST_EVENT_KEY}`;
const POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_S = 300;
const COMPLETED_LINGER_MS = 15_000;
```

## Tools

### inngest_send

Parameters:
- `event` (string, required) — event name e.g. "video/download"
- `data` (string, optional) — JSON payload, default "{}"
- `follow` (boolean, optional) — monitor runs, default true
- `timeout` (number, optional) — follow timeout seconds, default 300

Flow:
1. POST to EVENT_API with `{ name: event, data: parsed_data }`
2. Response: `{ ids: ["01J..."], status: 200 }` — ids are run IDs
3. If follow: start background polling loop for each run ID
4. Return immediately with event info

### inngest_runs

Parameters:
- `run_id` (string, optional) — specific run ID for detail view

## Send Event API

```
POST http://localhost:8288/e/37aa349b89692d657d276a40e0e47a15
Content-Type: application/json
{ "name": "video/download", "data": { "url": "..." } }
→ { "ids": ["01J..."], "status": 200 }
```

## GQL Queries

### Run status
```graphql
{ run(runID: "${id}") { id status functionID startedAt endedAt output } }
```
Status: RUNNING, COMPLETED, FAILED, CANCELLED, QUEUED

### Step trace (live progress)
```graphql
{
  runTrace(runID: "${id}") {
    name status attempts duration isRoot startedAt endedAt
    stepOp stepID outputID
    childrenSpans {
      name status attempts duration startedAt endedAt
      stepOp stepID outputID
      childrenSpans {
        name status attempts duration startedAt endedAt
        stepOp stepID outputID
      }
    }
  }
}
```
Flatten childrenSpans recursively. Skip isRoot=true entries. Each non-root span is a step.

### Function names (cache once)
```graphql
{ functions { id name } }
```

### Error details (for failed steps)
```graphql
{ runTraceSpanOutputByID(outputID: "${id}") { data error { message name stack } } }
```

## Tracked Run State

```typescript
interface TrackedRun {
  eventId: string;
  eventName: string;
  eventData: any;
  runId: string;
  functionName: string;
  status: "polling" | "running" | "completed" | "failed" | "cancelled" | "timeout";
  startedAt: number;
  finishedAt: number | null;
  steps: { name: string; status: string }[];
  currentStep: string | null;
  output: string | null;
  error: string | null;
  pollTimer: ReturnType<typeof setInterval> | null;
}
```

## Polling

After sending event with follow=true:
1. For each runId, create a TrackedRun
2. Start setInterval at POLL_INTERVAL_MS (3s)
3. Each tick: GQL query for run status + runTrace
4. Update TrackedRun.status, steps, currentStep
5. refreshWidget()
6. If terminal (COMPLETED/FAILED/CANCELLED): stop polling, set finishedAt, send message
7. If timeout exceeded: stop polling, set status="timeout"

## Widget

Same pattern as codex-exec. One line per visible run:
```
◆ video-ingest-pipeline 12s  step: download-video
✓ email-cleanup 45s  3 steps
✗ system-health 12s  FAILED: Redis unreachable
```

Running: icon + functionName + elapsed + "step: " + currentStep
Completed: icon + functionName + elapsed + stepCount + "steps"
Failed: icon + functionName + elapsed + "FAILED: " + errorSnippet
Auto-hide when no visible runs (returns []).
Timer managed by polling intervals (no separate status timer needed — polling does the refresh).

## Messages

- On completion: `pi.sendMessage({ customType: "inngest-run-complete", display: false, ... }, { triggerTurn, deliverAs: "followUp" })`
- triggerTurn: true if error OR no other runs still polling; false otherwise
- Content: function name, status, elapsed, step summary, output/error
- Register message renderer for "inngest-run-complete"

## Renderers

renderCall for inngest_send: `inngest_send video/download {"url":"..."}`
renderResult for inngest_send: `◆ video-ingest-pipeline running · 01JX...`

renderCall for inngest_runs: `inngest_runs` or `inngest_runs 01JX...`
renderResult for inngest_runs: collapsed summary with expandable step trace

## Extension Structure

Standard pi extension pattern:
```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, Container, Spacer } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // Widget setup in session_start
  // inngest_send tool
  // inngest_runs tool
  // Message renderer for inngest-run-complete
  // Cleanup in session_shutdown
}
```

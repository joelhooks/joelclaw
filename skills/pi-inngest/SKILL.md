---
name: pi-inngest
displayName: Pi + Inngest
description: Use Pi from Inngest safely in joelclaw. Covers event-driven detached Pi CLI runners, direct pi-ai calls inside step.run, service-account OAuth auth, claim-check files, and when to choose each pattern.
version: 0.1.0
author: joel
tags:
  - pi
  - inngest
  - workflows
  - service-account
  - inference
---

# Pi + Inngest

Use this when implementing, reviewing, or debugging joelclaw flows where Inngest orchestrates work and Pi provides model execution, tool execution, or harness-native agent behavior.

This skill is joelclaw-specific. It assumes Inngest and Pi are first-class local infrastructure, not incidental dependencies.

## When to Use

Load this skill when the task mentions:

- Pi inside Inngest
- `pi-ai`, `@earendil-works/pi-ai`, or legacy `@mariozechner/pi-ai`
- launching `pi` from an Inngest function
- `step.waitForEvent` around agent work
- detached Pi CLI children
- link ingest `pi/workflow.*` events
- service-account Pi auth
- OpenAI Codex OAuth/subscription auth from Pi
- choosing between Pi CLI and direct `pi-ai`

Also use it when an Inngest function needs LLM context work and the current path is drifting into ad hoc API keys, polling loops, or mystery subprocesses.

## Core Rule

Inngest owns durability. Pi owns agent/model execution.

Do not blur that boundary:

- Inngest functions should emit and wait on events, persist claim-check files, and record terminal outcomes.
- Pi CLI should be treated as an external actor, not an in-process library.
- Direct `pi-ai` is allowed only for bounded model calls where Pi session/harness behavior is not needed.
- Never smuggle raw model API keys into a Pi subprocess when machine OAuth auth is available.

## Decision Guide

| Use this | When | Avoid when |
|---|---|---|
| Direct `pi-ai` inside `step.run` | Short deterministic source-context calls, classification, extraction repair, summary/context generation, no Pi tools/session needed | Need Pi tools, skills, extension behavior, session artifacts, long-running agent work, or isolation from the worker process |
| Detached Pi CLI + event result | Need real Pi harness behavior, tool policy, session logs, read/write tools, long-running agent work, or process isolation | Tiny model-only calls where `pi-ai` would be simpler and faster |
| Synchronous `pi -p` inside one `step.run` | Tiny smoke/probe only | Production long-running work; this loses the event-driven shape and can wedge a step |
| Polling result files with `step.sleep` | Temporary proof shim only | Production orchestration; prefer `step.waitForEvent` plus a timeout watchdog |

Bench receipt from 2026-06-20:

- Direct `pi-ai` in `step.run`: 2/2 ok, ~5.5-6.5s wall, usage surfaced around 368 tokens / ~$0.0077 per call.
- Detached Pi CLI + result event: 2/2 ok, ~8.0-9.1s wall, wrote `pi-session/`, `pi-output.txt`, and `pi-result.json`.
- Receipt root: `/Users/joel/.local/state/joelclaw-central/tmp/pi-runner-bench/e36f592d-786a-4c15-ba1d-affb5820bbdf`.

Takeaway: use direct `pi-ai` for bounded source-context summarization. Use detached Pi CLI when harness parity, tools, session artifacts, or isolation matter.

## Service Account Auth Contract

joelclaw Central services should use the macOS `joelclaw` service account for durable machine-owned auth where practical.

Current local facts:

- Central Inngest runs as `com.joelclaw.central.inngest` under user `joelclaw`.
- Joel-user clients/canaries may still run as Joel when they write Joel-side Brain files.
- Pi auth is file-backed by `auth.json` in Pi's agent dir.
- Pi agent dir is resolved by `PI_CODING_AGENT_DIR`; otherwise Pi uses `~/.pi/agent` for the current OS user.
- The verified model lane for this work is `openai-codex/gpt-5.6-sol`.

For durable service access:

1. Prefer a real service-owned Pi agent dir, usually:

```txt
/Users/joelclaw/.pi/agent
```

2. Set this explicitly in launchd/env for any service that calls Pi or `pi-ai`:

```sh
PI_CODING_AGENT_DIR=/Users/joelclaw/.pi/agent
```

3. Keep `auth.json` owned by `joelclaw` and mode `0600` or stricter. Never print it.

4. Verify auth without printing tokens:

```sh
sudo -u joelclaw \
  PI_CODING_AGENT_DIR=/Users/joelclaw/.pi/agent \
  node --input-type=module <<'NODE'
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai';

const provider = 'openai-codex';
const model = getModel(provider, 'gpt-5.6-sol');
const registry = ModelRegistry.create(AuthStorage.create());
const auth = await registry.getApiKeyAndHeaders(model);
console.log(JSON.stringify({
  provider,
  status: registry.getProviderAuthStatus(provider),
  ok: auth.ok,
  hasApiKey: Boolean(auth.apiKey),
  hasHeaders: Boolean(auth.headers && Object.keys(auth.headers).length),
  error: auth.error,
}, null, 2));
NODE
```

Expected safe shape:

```json
{
  "provider": "openai-codex",
  "status": { "configured": true, "source": "stored" },
  "ok": true,
  "hasApiKey": true
}
```

Do not rely on Joel's personal `~/.pi/agent/auth.json` from a Central service unless the service intentionally runs as Joel. Do not copy auth across accounts casually. If a one-time migration is unavoidable, record it as an explicit operator action, preserve `0600` permissions, and verify via the safe status check above.

### Bridging Joel auth to the service account

Best options, in order:

1. **Independent service login**: run Pi OAuth login under `joelclaw` with `PI_CODING_AGENT_DIR=/Users/joelclaw/.pi/agent`. This is cleanest but requires an interactive browser/device-code flow.
2. **One-time provider bridge**: copy only the `openai-codex` OAuth credential from Joel's Pi auth store into the `joelclaw` Pi auth store. This grants the service account Joel's subscription-backed Codex access, so treat it as a privileged operator action.
3. **Do not symlink auth files** across accounts. Shared lock files, refresh races, ownership, and `/Users/joel` permissions make this fucky and fragile.

Repo helper:

```sh
cd /Users/joel/Code/joelhooks/joelclaw-central
scripts/setup-pi-service-auth.sh --dry-run
sudo scripts/setup-pi-service-auth.sh --apply
sudo scripts/setup-pi-service-auth.sh --test
```

The helper:

- copies only the `openai-codex` OAuth credential;
- installs a service-readable Pi package wrapper at `/Users/Shared/joelclaw/bin/pi` because Joel's personal global Pi install lives under `/Users/joel/.local/share`, which the service account should not depend on;
- sets and tests `PI_CODING_AGENT_DIR=/Users/joelclaw/.pi/agent`;
- verifies both `AuthStorage`/`ModelRegistry` and the Pi CLI as `joelclaw` without printing tokens.

## Utah Sidecar Lesson

Utah's `sidecar-management` skill has the right shape: small dynamic Inngest functions live in a watched workspace, reconnect automatically, and notify the main agent by event. Steal the shape, not the names.

For joelclaw, the equivalent doctrine is:

- keep core runtime stable;
- let small event handlers/workflows be loaded as sidecar-style functions where practical;
- one function per file;
- no top-level side effects;
- watcher/reconnect beats manual restart for operator iteration;
- functions communicate by events and claim-check paths, not direct session poking;
- use structured logs, because sidecar bugs without logs are archaeology.

This pairs naturally with Pi-Inngest: sidecar functions can choose direct `pi-ai` for small model steps or detached Pi CLI for harness-native work.

## Pattern A: Direct `pi-ai` in `step.run`

Use this for bounded model calls where a Pi session is unnecessary.

### Implementation Skeleton

Declare package dependencies in the package doing the work. Do not import from a global absolute install path in production code; scratch tests may do that only as a receipt-gathering hack.

```ts
import { Inngest } from 'inngest';
import { complete, getModel } from '@earendil-works/pi-ai';
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';

const inngest = new Inngest({ id: 'joelclaw-example' });

async function runPiAiSummary(prompt: string) {
  const model = getModel('openai-codex', 'gpt-5.6-sol');
  const registry = ModelRegistry.create(AuthStorage.create());
  const auth = await registry.getApiKeyAndHeaders(model);

  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.error || 'missing openai-codex auth');
  }

  const result = await complete(
    model,
    {
      systemPrompt: 'Return concise, grounded JSON only.',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      tools: [],
    },
    { apiKey: auth.apiKey, headers: auth.headers },
  );

  const text = result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');

  return {
    text,
    usage: result.usage,
    stopReason: result.stopReason,
  };
}

export const summarize = inngest.createFunction(
  { id: 'summarize-with-pi-ai', retries: 2, triggers: [{ event: 'source/summary.requested' }] },
  async ({ event, step }) => {
    return await step.run('complete-pi-ai', async () =>
      runPiAiSummary(event.data.prompt),
    );
  },
);
```

### Rules

- Keep prompts bounded and deterministic.
- Keep calls inside `step.run` idempotent or make output writes idempotent.
- Surface `usage` and `stopReason` in receipts when useful.
- Do not use this path if the work needs Pi tools, filesystem edits via Pi, skills, extensions, or a Pi session log.
- Do not manually read or print `auth.json`; use `AuthStorage` / `ModelRegistry` and print only booleans/status.

## Pattern B: Detached Pi CLI + Event Result

Use this for real Pi harness work.

The shape:

1. Inngest receives `pi/workflow.requested`.
2. A short `step.run` writes `pi-request.json` and spawns a detached child/wrapper.
3. The wrapper invokes `pi -p @pi-prompt.md` with a filtered environment.
4. The child writes `pi-result.json` and artifacts under a claim-check directory.
5. The wrapper emits `pi/workflow.result.ready` with `{ workflowId, sourceId, resultPath }`.
6. The parent function uses `step.waitForEvent` to wait for that result.
7. A result step reads `pi-result.json` and emits one of:
   - `pi/workflow.context.completed`
   - `pi/workflow.needs_human`
   - `pi/workflow.failed`

### Event Names

Use explicit event names. For link ingest, prefer:

```txt
pi/workflow.requested
pi/workflow.result.ready
pi/workflow.context.completed
pi/workflow.needs_human
pi/workflow.failed
```

The wait event must match a stable unique ID, usually `data.workflowId`.

Do not match only `sourceId` when multiple workflows can run for the same source.

### Inngest Skeleton

```ts
export const piWorkflowCli = inngest.createFunction(
  {
    id: 'pi-workflow-cli',
    retries: 0,
    triggers: [{ event: 'pi/workflow.requested' }],
  },
  async ({ event, step }) => {
    const { workflowId, sourceId } = event.data;

    await step.run('start-detached-pi-cli', async () => {
      const requestPath = await writePiRequestClaimCheck(event.data);
      spawnDetachedPiWrapper({ workflowId, sourceId, requestPath });
      return { workflowId, sourceId, requestPath };
    });

    const resultEvent = await step.waitForEvent('wait-for-pi-workflow-result', {
      event: 'pi/workflow.result.ready',
      timeout: '4m',
      match: 'data.workflowId',
    });

    if (!resultEvent) {
      const failure = await step.run('write-timeout-failure', async () =>
        writePiWorkflowFailureContext({ workflowId, sourceId, reason: 'timeout' }),
      );
      await step.sendEvent('emit-pi-workflow-failed', {
        name: 'pi/workflow.failed',
        data: failure,
      });
      return failure;
    }

    const result = await step.run('read-pi-result', async () =>
      readJson(resultEvent.data.resultPath),
    );

    await step.sendEvent('emit-terminal-pi-event', routePiResultToEvent(result));
    return result;
  },
);
```

### Pi Wrapper Rules

- Use `spawn`, not `execFile`, for long Pi sessions. `execFile(pi)` has hung under Node pipe capture on this machine.
- Detach the child from the Inngest function process when the work may be long.
- Give the Pi subprocess only the env it needs:
  - `HOME`
  - `USER` / `LOGNAME`
  - `PATH`
  - `SHELL`
  - `PI_CODING_AGENT_DIR`
  - harmless display/color/session env if needed
- Do not pass `INNGEST_EVENT_KEY`, webhook secrets, Discord tokens, or broad service env into the `pi` subprocess.
- The wrapper may hold Inngest dispatch auth to emit `pi/workflow.result.ready`; the Pi CLI child should not need it.
- Write all large or detailed outputs as files, then send event claim-check paths.

### CLI Invocation Defaults

For link-ingest style context work:

```sh
pi \
  --model openai-codex/gpt-5.6-sol \
  --thinking low \
  --no-extensions \
  --no-context-files \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --session-dir "$WORKFLOW_DIR/pi-session" \
  --name "Link Ingest Context" \
  --tools read \
  -p "@$WORKFLOW_DIR/pi-prompt.md"
```

Tighten or expand tools intentionally. Default to read-only for source-context work.

## Failure Handling

Every Pi-Inngest path needs a terminal event.

- Direct `pi-ai` errors should fail the step or emit a typed failure event with a claim-check receipt.
- Detached Pi CLI start failures must write failure context and emit `pi/workflow.failed`.
- Timeout failures must write a timeout receipt before emitting failure.
- Global Inngest failure handlers can add observability, but they are not a replacement for workflow-level terminal events.

For Discord-facing flows, keep progress quiet:

- registry/manifest progress only during work.
- Discord gets terminal indexed/failed or focused HITL only.

## Testing Checklist

Before calling a Pi-Inngest implementation done:

1. Verify service auth without printing secrets.
2. Run a direct `pi-ai` smoke if that path is used.
3. Run a detached Pi CLI child smoke if that path is used.
4. Prove `step.waitForEvent` resumes from `pi/workflow.result.ready`.
5. Prove timeout writes a failure claim-check and emits terminal failure.
6. Verify the Pi child environment does not include unnecessary service secrets.
7. Check logs/receipts and keep reusable findings in Brain.

Useful local receipts from the link-ingest runner work live in:

```txt
/Users/joel/.brain/projects/joelclaw-link-ingest-2026-06-17.svx
/Users/joel/Code/joelhooks/joelclaw-central/.brain/projects/link-ingest-router-2026-06-17.svx
```

## Documentation Rule

Use this skill for reusable implementation doctrine.

Use Brain for live project memory and receipts.

Use repo scripts/tests for executable proofs.

Do not bury operational truth only in chat transcripts. Chat is compost, not storage. 🐀

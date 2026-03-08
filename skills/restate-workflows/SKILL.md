---
name: restate-workflows
displayName: Restate Workflows
description: "Bridge external or isolated repos into joelclaw's ADR-0217 runtime using the `joelclaw` CLI boundary. Use when a repo needs to submit sandboxed/background work, emit queue jobs, define a workflow request payload, or hand work off to the Redis → Dkron → Restate stack without coupling to private internals. Triggers: 'send work to the queue', 'submit sandboxed work', 'isolated repo', 'restate workflow request', 'queue emit wrapper', 'background job bridge'."
version: 0.1.0
author: Joel Hooks
tags: [restate, workflows, queue, cli, sandbox, adr-0217, integration]
---

# Restate Workflows

Use this skill when another repo needs to hand work to joelclaw's runtime.

The boundary is the `joelclaw` CLI.

Do not reach into Redis directly. Do not import private joelclaw packages. Do not pretend the other repo knows internal queue schemas unless you have explicitly verified them.

## The runtime shape

ADR-0217 currently reads best as:

- **Redis is the pressure layer** — queue admission, bursts, pause/resume, family control
- **Dkron is the clock** — scheduled starts
- **Restate is the durable executor** — workflow identity, retries, DAG progress
- **Sandboxed runners are the side-effect boundary** — isolated code-changing work

An external repo should integrate at the edge, not by coupling itself to the middle.

That means:
- submit work through `joelclaw queue emit`
- carry enough metadata for idempotency and tracing
- let joelclaw decide how that request reaches Restate or a sandbox runner

## When to use

Use this skill when a user asks for any of these:

- "send work to the queue"
- "have this repo request background work"
- "bridge this repo into joelclaw"
- "submit sandboxed work"
- "emit a workflow request"
- "wrap joelclaw queue emit"
- "run this in Restate from another repo"

## Non-negotiable rules

- **CLI boundary only.** Use `joelclaw queue emit` unless the user explicitly wants a different joelclaw command surface.
- **Never talk to Redis directly** from the external repo.
- **Never depend on private joelclaw internals** (`@joelclaw/*`, Redis keys, internal TypeScript types, worker-only contracts) unless the repo itself is the joelclaw monorepo.
- **Keep changes inside the calling repo.** Build a wrapper in that repo; do not assume you can edit joelclaw at the same time.
- **Inspect live help first.** The CLI contract wins over memory.
- **Prefer explicit workflow families.** If there is no verified family for the job, stop and document the proposed family/contract instead of guessing silently.
- **Machine-readable output by default.** The wrapper should return stable JSON that callers can parse.
- **Support dry-run.** The repo should be able to show the exact request without enqueuing it.

## First steps

Run these before designing the bridge:

```bash
joelclaw queue --help
joelclaw queue emit --help
```

If the target repo is supposed to monitor results too, also inspect:

```bash
joelclaw jobs status --hours 1 --count 10
joelclaw queue observe --hours 1
```

If you are unsure whether a workflow family already exists, search docs or ask instead of inventing one.

## What to build in the external repo

The default deliverable is a thin wrapper command/module/script around `joelclaw queue emit`.

Good shapes:
- `scripts/request-work.ts`
- `bin/request-background-work`
- `src/lib/joelclaw/requestWorkflow.ts`
- `src/cli/restate-workflow.ts`

Bad shape:
- raw shell one-liners scattered across the repo with no contract doc or tests

## Minimum request payload

Every request payload should include these fields unless the target family has a stricter contract:

```json
{
  "idempotencyKey": "repo-name:task-type:base-sha:input-hash",
  "requestId": "uuid-or-stable-derived-id",
  "repo": {
    "path": "/abs/path/or/null",
    "url": "git@github.com:owner/repo.git",
    "name": "repo-name",
    "baseSha": "abc123",
    "branch": "main"
  },
  "task": {
    "kind": "sandboxed-change",
    "prompt": "what the runtime should do",
    "artifacts": ["patch", "test-report", "summary.json"]
  },
  "caller": {
    "source": "external-repo-name",
    "requestedBy": "human-or-agent",
    "sessionId": "optional-session-id",
    "callback": {
      "kind": "poll",
      "target": "joelclaw jobs status"
    }
  },
  "meta": {
    "dryRun": false,
    "createdAt": "2026-03-08T05:00:00.000Z"
  }
}
```

### Required semantics

- `idempotencyKey` must be stable for the same intended work request
- `baseSha` must reflect the code the sandbox should start from
- `prompt` must say what success looks like
- `artifacts` must list what the caller expects back
- `caller.source` must identify who emitted the request

## Emission pattern

The wrapper should construct JSON, then call the CLI.

Example pattern:

```bash
joelclaw queue emit <event-family> --data '<json>'
```

Example Node/Bun sketch:

```ts
import { spawn } from "node:child_process";

export async function requestWorkflow(event: string, payload: unknown, dryRun = false) {
  const data = JSON.stringify(payload);

  if (dryRun) {
    return {
      ok: true,
      mode: "dry-run",
      event,
      payload,
    };
  }

  return await new Promise((resolve, reject) => {
    const child = spawn("joelclaw", ["queue", "emit", event, "--data", data], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, mode: "live", event, payload, stdout });
        return;
      }
      reject(new Error(`joelclaw queue emit failed (${code}): ${stderr || stdout}`));
    });
  });
}
```

## Family selection

Do not hijack an unrelated proof family just because it exists.

Rules:
- `content/updated` is a dogfood family, not a generic bucket for outside repos
- if a verified workflow request family already exists, use it
- if no family exists, document the proposed name and payload contract in the repo instead of guessing

A good stop-and-document line is:

> No canonical workflow-request family was verified in the target runtime. This repo now emits a validated payload object locally and documents the proposed `sandbox/work.requested` contract, but does not enqueue live requests until the runtime family is confirmed.

That is honest. Honesty beats fake integration.

## Required wrapper features

### 1. Dry-run mode

The command must be able to print the exact event + payload without sending it.

Dry-run output should be parseable JSON, for example:

```json
{
  "ok": true,
  "mode": "dry-run",
  "event": "sandbox/work.requested",
  "payload": { "...": "..." }
}
```

### 2. Clear errors

Handle these explicitly:
- `joelclaw` binary missing
- invalid JSON/payload serialization
- command non-zero exit
- caller omitted `baseSha`, `prompt`, or `idempotencyKey`

### 3. Machine-readable success output

Return stable JSON on success, not prose.

At minimum:

```json
{
  "ok": true,
  "mode": "live",
  "event": "sandbox/work.requested",
  "idempotencyKey": "...",
  "stdout": "raw joelclaw output"
}
```

### 4. Local tests

Tests should verify:
- payload construction
- idempotency key stability
- dry-run behavior
- CLI invocation shape
- failure handling

Mock the CLI process if needed. Do not require the real runtime for unit tests.

## README contract

Document these four things in the calling repo:

1. what command submits work
2. what event family it emits
3. what payload fields are required
4. how to verify the request from joelclaw surfaces

Minimum verification section:

```bash
joelclaw jobs status --hours 1 --count 10
joelclaw queue observe --hours 1
```

If there is a known workflow ID or downstream surface, include it.

## Anti-patterns

Do not do this:
- writing directly to Redis
- importing joelclaw monorepo code into the external repo
- hiding event-family uncertainty behind vague names like `task/run`
- omitting `baseSha` for code-changing work
- printing unstructured human-only output from the wrapper
- building a wrapper with no dry-run or no tests
- pretending Restate-native execution is already wired if the current path is still transitional

## Recommended deliverables

When asked to implement this integration in another repo, deliver:

1. the wrapper command/module
2. payload contract documentation
3. example invocation
4. verification steps
5. tests

## Short prompt for another agent

If you need to hand this off, use:

> Use `/skill:restate-workflows`. Build a thin wrapper in this repo around `joelclaw queue emit` so the repo can request sandboxed/background work from joelclaw without talking to Redis or private joelclaw internals. Inspect `joelclaw queue --help` and `joelclaw queue emit --help` first. Include idempotency key, repo/base SHA, task prompt, requested artifacts, caller metadata, dry-run mode, machine-readable output, README usage, and tests. If no canonical event family is verified, stop and document the proposed family/contract instead of guessing.

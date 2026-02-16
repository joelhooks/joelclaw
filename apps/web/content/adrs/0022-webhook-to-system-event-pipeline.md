---
status: proposed
date: 2026-02-15
decision-makers: Joel Hooks
consulted: Claude (pi session 2026-02-15)
informed: All agents operating on this machine
related:
  - "[ADR-0018 — Pi-native gateway with Redis event bridge](0018-pi-native-gateway-redis-event-bridge.md)"
  - "[ADR-0010 — Central system loop gateway](0010-system-loop-gateway.md)"
  - "[ADR-0019 — Event naming convention (past-tense)](0019-event-naming-past-tense.md)"
  - "[ADR-0005 — Durable multi-agent coding loops](0005-durable-multi-agent-coding-loops.md)"
  - "[ADR-0007 — Agent loop v2 improvements](0007-agent-loop-v2-improvements.md)"
---

# Adopt webhook-to-system-event pipeline for external signal ingestion

## Context and Problem Statement

ADR-0018 established the Redis event bridge as the inbound path for system events: external signals → Redis list → pi extension drains → agent acts. It defined the schema (`SystemEvent`), the keys (`joelclaw:events:{sessionKey}`), the pub/sub notify channel, and the heartbeat drain lifecycle. What it left unspecified is **how external services actually push events into that bridge**.

Today the system has no way to receive signals from external platforms. When a Vercel deploy fails, Joel reads the build log manually, diagnoses the error, and fixes it. When a GitHub PR gets a review, nobody knows until Joel checks. The system's SENSE pathway (ADR-0010) has no ears.

This ADR defines the **webhook ingestion layer** — the thin HTTP surface on the system-bus worker that accepts webhooks from external services, normalizes them into `SystemEvent` payloads, and pushes them into the Redis bridge. It also defines the first concrete consumer: an Inngest function that auto-repairs Vercel build failures.

### Prior Art: OpenClaw's Inbound Router

OpenClaw's gateway handles inbound signals through channel-specific monitors (Discord `gateway-plugin.ts`, WhatsApp `monitor.ts`, etc.) that call `enqueueSystemEvent(text, { sessionKey })`. Each monitor is a persistent connection (WebSocket for Discord, long-poll for WhatsApp) that normalizes platform events into plain-text system events.

Our system differs: external services push to us via HTTP webhooks rather than us maintaining persistent connections. The normalization step is the same — platform-specific payload → structured `SystemEvent` — but the transport is reversed (push vs. pull).

### What We Have

| Component | Status | Role in this ADR |
|---|---|---|
| System-bus Hono worker | ✅ Running on `:3111` | Receives webhook POSTs |
| Caddy HTTPS proxy | ✅ `panda.tail7af24.ts.net:3443` → `:3111` | TLS termination for webhooks |
| Redis event bridge | ✅ Defined in ADR-0018 | Target for normalized events |
| `pushGatewayEvent()` | 🔜 Defined in ADR-0018, not yet implemented | Shared helper for LPUSH + PUBLISH |
| Inngest event bus | ✅ Running | Durable workflow trigger for repair functions |
| Pi gateway extension | 🔜 Defined in ADR-0018, not yet built | Drains Redis → injects into session |
| Agent loop infra | ✅ ADR-0005/0007 | Potential executor for complex repairs |

### Trigger Events

In this session alone, 3 build failures required manual intervention:

1. **TypeScript type error** — `children.props` is of type `unknown` in `mdx.tsx` (commit `9917dda`)
2. **MDX parsing** — bare angle brackets in code blocks breaking JSX parser (earlier session)
3. **Stale lockfile** — pnpm lockfile out of sync after dependency changes (earlier session)

Each followed the same pattern: Vercel build fails → Joel reads error log → Joel diagnoses → Joel commits fix → Joel pushes → Vercel rebuilds. The diagnosis and fix for type errors, lockfile issues, and MDX parse errors are mechanical — exactly the kind of work an agent should handle.

## Decision Drivers

- **Close the feedback loop**: Deploy failures should be detected and repaired without human intervention for mechanical errors.
- **Reusable pattern**: The webhook → normalize → Redis bridge path should work for any external service, not just Vercel.
- **Thin ingestion, thick processing**: The webhook route validates and normalizes. Heavy work (diagnosis, repair, retry) happens in Inngest functions.
- **ADR-0018 alignment**: Use the Redis event bridge exactly as specified — `pushGatewayEvent()`, same schema, same keys.
- **ADR-0019 compliance**: Event names describe what happened: `webhook/vercel.deployment.failed`, not `deploy/fix-build`.
- **Security**: Webhook endpoints are on Tailscale-only HTTPS. Vercel webhook secrets validate payload authenticity.

## Considered Options

### Option A: Webhook → Inngest event directly (bypass Redis bridge)

Webhook hits the Hono worker, which calls `inngest.send()` to emit an Inngest event. An Inngest function handles the repair. The pi gateway extension never sees it.

**Pros**: Simpler — no Redis bridge involvement for repairs. Inngest handles durability and retries natively.
**Cons**: The agent doesn't know about deploy failures in its session context. No `prependSystemEvents` notification. Bifurcates the signal path — some external events go through Redis bridge (ADR-0018), others go directly to Inngest.

### Option B: Webhook → Redis bridge → pi session AND Inngest event (dual-path)

Webhook hits the Hono worker, which does both: (1) `pushGatewayEvent()` to notify the pi session, and (2) `inngest.send()` to trigger a durable repair function. The agent sees the failure in its session context AND the repair pipeline starts automatically.

**Pros**: Agent is aware of what's happening (observability). Repair runs durably in Inngest. Follows ADR-0018's bridge pattern. Future webhook types that don't need durable processing (e.g., "PR merged" notification) use just the Redis path.
**Cons**: Slightly more complex — two writes per webhook. But both are fire-and-forget, < 5ms each.

### Option C: Webhook → Redis bridge only (agent decides action)

Webhook normalizes to `SystemEvent`, pushes to Redis. On next heartbeat drain, the agent reads the event, decides whether to act, and if so, triggers the repair itself (via `igs send` or direct fix).

**Pros**: Maximum agent autonomy — the agent decides whether and how to repair. Simplest webhook handler (just normalize + push).
**Cons**: Latency — repair waits for next heartbeat drain (up to 30 min). Build failures are time-sensitive. Also depends on the gateway extension (ADR-0018 Phase 1) being fully implemented, which it isn't yet.

## Decision Outcome

**Option B: Dual-path (Redis bridge + Inngest event).**

Deploy failures are time-sensitive — waiting up to 30 minutes for a heartbeat drain is too slow. The Inngest function starts repair immediately. The Redis bridge notifies the agent so it has situational awareness ("a deploy failed, repair is in progress"). For future webhook types that are purely informational (PR merged, issue opened), only the Redis path fires — no Inngest function needed.

The webhook route follows a consistent pattern:
1. **Validate** — check webhook secret / signature
2. **Normalize** — extract relevant fields into `SystemEvent` shape
3. **Push to Redis bridge** — `pushGatewayEvent()` (agent notification)
4. **Conditionally emit Inngest event** — only for event types that need durable processing

### Consequences

**Good:**
- Deploy failures get auto-repaired in seconds, not minutes.
- The agent sees all external signals in its session (observability via Redis bridge).
- The pattern is reusable — adding GitHub, Slack, or PDS webhooks follows the same route structure.
- Vercel webhook setup is one-time config (URL + secret in Vercel dashboard).

**Bad:**
- The system-bus worker gains HTTP surface area exposed to Vercel's webhook delivery. *Mitigation*: Tailscale HTTPS only. Webhook secret validation on every request. Vercel can only reach us if it knows the Tailscale hostname (not on public internet).
- Auto-repair could commit broken fixes if the diagnosis is wrong. *Mitigation*: The repair function pushes to a branch, runs `tsc --noEmit` locally before pushing, and the Vercel rebuild is the final gate. If the fix doesn't build either, the function stops (max 1 retry) and pushes a `webhook/vercel.repair.failed` event to the Redis bridge so the agent knows.

**Neutral:**
- This ADR can be implemented before ADR-0018's gateway extension. The Inngest repair function works independently. The Redis bridge push is a bonus notification — if nobody's draining the bridge yet, events just accumulate harmlessly (no TTL on the list).

## Webhook Route Design

### URL Structure

```
POST /webhook/vercel    — Vercel deploy webhooks
POST /webhook/github    — GitHub webhooks (future)
POST /webhook/custom    — Generic webhook with type in body (future)
```

All routes live on the existing Hono worker (`serve.ts`), proxied via Caddy at `https://panda.tail7af24.ts.net:3443/webhook/vercel`.

### Vercel Webhook Payload

Vercel sends different event types. We care about:

| Vercel Event | Our Event Name | Action |
|---|---|---|
| `deployment.error` | `webhook/vercel.deployment.failed` | Trigger repair function |
| `deployment.succeeded` | `webhook/vercel.deployment.succeeded` | Notify agent (Redis only) |
| `deployment.created` | (ignored) | No action |

### Webhook Secret Validation

Vercel signs webhooks with a secret. The route validates before processing:

```typescript
import { createHmac } from "node:crypto";

function verifyVercelSignature(body: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha1", secret).update(body).digest("hex");
  return signature === expected;
}
```

Secret stored in `agent-secrets` as `vercel_webhook_secret`. Leased at worker startup.

### Normalized Event Shape

```typescript
// Pushed to Redis bridge via pushGatewayEvent()
{
  type: "webhook/vercel.deployment.failed",
  source: "vercel",
  payload: {
    deploymentId: "dpl_xxx",
    project: "joelclaw",
    url: "https://vercel.com/joelhooks-projects/joelclaw/xxx",
    commitSha: "9917dda",
    commitMessage: "fix: type narrowing for extractText",
    branch: "main",
    buildError: "Type error: 'children.props' is of type 'unknown'.",
    buildLogUrl: "https://vercel.com/joelhooks-projects/joelclaw/xxx/logs"
  }
}
```

## Repair Function Design

### `webhook/repair-build`

Triggered by: `webhook/vercel.deployment.failed` Inngest event.

```typescript
export const repairBuild = inngest.createFunction(
  {
    id: "webhook-repair-build",
    retries: 1,
    concurrency: [{ limit: 1, scope: "account" }],  // one repair at a time
  },
  { event: "webhook/vercel.deployment.failed" },
  async ({ event, step }) => {
    // Step 1: Fetch build log
    const buildLog = await step.run("fetch-build-log", async () => {
      // Use Vercel API or scrape build log URL
      // Extract the error section (last ~50 lines before "exited with 1")
    });

    // Step 2: Diagnose via pi
    const diagnosis = await step.run("diagnose", async () => {
      // pi -p --no-session --model "anthropic/claude-sonnet-4-5"
      // Prompt: "Here is a Vercel build error. Identify the file and exact fix needed.
      //          Return JSON: { file, oldText, newText, explanation }"
      // Include: build log, recent git diff, file contents around error
    });

    // Step 3: Apply fix
    const fix = await step.run("apply-fix", async () => {
      // Read the file, apply the edit (surgical replacement)
      // Run tsc --noEmit to verify the fix compiles
      // If tsc fails, abort — don't push a broken fix
    });

    // Step 4: Commit and push
    await step.run("commit-push", async () => {
      // git add <file>
      // git commit -m "fix(auto-repair): <explanation>\n\nTriggered by: <deploymentId>"
      // git push origin main
    });

    // Step 5: Notify agent
    await step.run("notify-agent", async () => {
      await pushGatewayEvent({
        type: "webhook/vercel.repair.completed",
        source: "inngest",
        payload: {
          deploymentId: event.data.deploymentId,
          file: diagnosis.file,
          explanation: diagnosis.explanation,
        },
      });
    });
  }
);
```

### Repair Scope (What It Can Fix)

Phase 1 — mechanical errors only:

| Error Type | Detection | Fix Strategy |
|---|---|---|
| TypeScript type errors | `Type error:` in build log | Read file, add type assertion/narrowing |
| Missing imports | `Cannot find module` | Add import statement |
| Stale lockfile | `Lockfile is out of date` | Run `pnpm install`, commit lockfile |
| MDX parse errors | `Could not parse expression` | Escape problematic syntax |

### What It Won't Fix

- Logic bugs (tests pass but behavior wrong)
- Runtime errors (build succeeds, app crashes)
- Dependency conflicts requiring human judgment
- Errors in files outside the web app (`packages/cli/`, `packages/system-bus/`)

If diagnosis fails or the fix doesn't compile (`tsc --noEmit` fails), the function:
1. Pushes `webhook/vercel.repair.failed` to the Redis bridge
2. Returns `{ status: "failed", reason: "..." }` (visible in Inngest dashboard)
3. Does NOT retry beyond the 1 configured retry

## Implementation Plan

### Phase 1: Webhook Route + Repair Function

**Story 1: Add webhook route to system-bus**

Files:
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/webhook/vercel.ts` (new — route handler)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/serve.ts` (add webhook routes)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/client.ts` (add event types)

Steps:
1. Add `vercel_webhook_secret` to `agent-secrets`
2. Create `webhook/vercel.ts` — validate signature, normalize payload, dual-path (Redis + Inngest)
3. Mount route: `app.post("/webhook/vercel", vercelWebhook)`
4. Add event types to `client.ts`:
   - `"webhook/vercel.deployment.failed"` — triggers repair
   - `"webhook/vercel.deployment.succeeded"` — informational
   - `"webhook/vercel.repair.completed"` — repair notification
   - `"webhook/vercel.repair.failed"` — repair failure notification
5. Update root `/` health JSON with webhook routes
6. Restart worker: `launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker`

**Story 2: Implement repair function**

Files:
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/webhook/repair-build.ts` (new)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/index.ts` (export)
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/serve.ts` (register)

Steps:
1. Create `repair-build.ts` with 5-step pipeline (fetch log → diagnose → fix → commit → notify)
2. Use `pi -p --no-session --model "anthropic/claude-sonnet-4-5"` for diagnosis
3. Apply fix using Node.js `fs` (read file, string replace, write)
4. Verify with `tsc --noEmit` before committing
5. Commit with `fix(auto-repair):` prefix and deployment ID reference
6. Export and register in `serve.ts`

**Story 3: Configure Vercel webhook**

Steps:
1. Go to `https://vercel.com/joelhooks-projects/joelclaw/settings/webhooks`
2. Add webhook:
   - URL: `https://panda.tail7af24.ts.net:3443/webhook/vercel`
   - Events: `deployment.error`, `deployment.succeeded`
   - Secret: generate and store in `agent-secrets`
3. Test with a deliberate type error commit

**Story 4: Implement `pushGatewayEvent()` helper** (from ADR-0018)

Files:
- `~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/agent-loop/utils.ts`

This helper is defined in ADR-0018 but not yet implemented. The webhook route needs it. Implement:
```typescript
export async function pushGatewayEvent(event: Omit<SystemEvent, "id" | "ts">) {
  const redis = getRedis();
  const full = { ...event, id: ulid(), ts: Date.now() };
  const key = `joelclaw:events:${process.env.GATEWAY_SESSION_KEY ?? "main"}`;
  await redis.lpush(key, JSON.stringify(full));
  await redis.publish(
    key.replace("events:", "notify:"),
    JSON.stringify({ eventId: full.id, type: full.type })
  );
}
```

### Phase 2: Additional Webhook Sources (Future)

- **GitHub webhooks** — PR reviews, CI failures, issue mentions
- **Custom/generic** — PDS firehose events, Slack mentions
- Each follows the same pattern: validate → normalize → dual-path

## Verification

### Automated: `joelclaw gateway test --webhook`

```bash
joelclaw gateway test --webhook
```

1. Check webhook route is reachable (`GET /webhook/vercel` returns 405 Method Not Allowed — route exists but only accepts POST)
2. POST a synthetic `deployment.error` payload with valid signature
3. Verify Redis bridge received the event (`LLEN joelclaw:events:main`)
4. Verify Inngest received the event (check for pending `webhook-repair-build` run)
5. Report result

### Manual: Deliberate Break Test

1. Commit a file with a known type error (e.g., `(x as any).foo.bar.baz`)
2. Push to main
3. Watch Vercel fail
4. Watch Inngest `webhook-repair-build` function execute
5. Verify fix committed and Vercel rebuilds successfully

### Structural Checks

```bash
# Webhook route exists
curl -s -o /dev/null -w "%{http_code}" -X GET https://panda.tail7af24.ts.net:3443/webhook/vercel
# Expected: 405

# Event types registered
grep "webhook/vercel" ~/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/client.ts
# Expected: 4 event types

# Repair function registered
grep "webhook-repair-build" ~/Code/joelhooks/joelclaw/packages/system-bus/src/serve.ts
# Expected: found in functions array

# No secrets in code
grep -r "whsec_\|webhook_secret.*=" ~/Code/joelhooks/joelclaw/packages/system-bus/src/ | grep -v "process.env\|agent-secrets"
# Expected: no matches
```

## More Information

### Vercel Webhook Documentation

Vercel webhooks: `https://vercel.com/docs/observability/webhooks`. Key details:
- Signed with HMAC SHA1 using the webhook secret
- `x-vercel-signature` header contains the signature
- Payload includes `deployment.id`, `deployment.meta.githubCommitSha`, `deployment.meta.githubCommitMessage`
- `deployment.error` type fires on build failure with error details

### Credit

- **Nick Steinberger** ([OpenClaw](https://github.com/openclaw/openclaw)) — inbound router pattern, `enqueueSystemEvent` → normalize → inject model that this webhook layer adapts
- ADR-0018 — Redis event bridge design that this ADR implements the first concrete inbound source for

### Relationship to ADR-0018

This ADR is the **first concrete implementation** of ADR-0018's inbound router (Responsibility #5 in the gateway shape table). ADR-0018 defined the Redis bridge protocol and the pi extension that drains it. This ADR defines what pushes events into that bridge from outside the system.

```
                     ADR-0018                          ADR-0018
                   (this ADR)                        (gateway ext)
  Vercel ──webhook──→ Hono ──pushGatewayEvent──→ Redis ──drain──→ pi session
                        │
                        └──inngest.send──→ Inngest ──repair-build──→ git push
```

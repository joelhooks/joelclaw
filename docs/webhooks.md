# Webhooks

Canonical notes for the webhook gateway and subscription dispatch path.

## HTTP gateway

- server: `packages/system-bus/src/webhooks/server.ts`
- endpoint: `POST /webhooks/:provider`
- providers:
  - `todoist`
  - `front`
  - `vercel`
  - `github`
  - `mux`
  - `joelclaw`

Contract:

1. Verify provider signature from raw request body.
2. Normalize payload into typed internal events.
3. Emit to Inngest as `<provider>/<event>`.

## GitHub workflow path

- provider adapter: `packages/system-bus/src/webhooks/providers/github.ts`
- normalized event: `github/workflow_run.completed`
- payload includes:
  - `deliveryId`
  - workflow + run metadata (`runId`, `workflowName`, `branch`, `conclusion`, etc.)

## Session-scoped webhook subscriptions (ADR-0185)

Redis keys:

- `joelclaw:webhook:subscriptions` (hash: `id -> subscription json`)
- `joelclaw:webhook:index:<provider>:<event>` (set of subscription IDs)
- `joelclaw:webhook:events:<subscription-id>` (replay list)
- `joelclaw:webhook:notify:<subscription-id>` (pub/sub channel)
- `joelclaw:webhook:dedup:<subscription-id>:<delivery-key>` (idempotency)

CLI surface:

```bash
joelclaw webhook subscribe github workflow_run.completed --repo joelhooks/joelclaw --stream
joelclaw webhook list
joelclaw webhook stream <subscription-id>
joelclaw webhook unsubscribe <subscription-id>
```

## Dispatch function

- function: `webhook-subscription-dispatch-github-workflow-run-completed`
- file: `packages/system-bus/src/inngest/functions/webhook-subscription-dispatch.ts`
- trigger: `github/workflow_run.completed`

Behavior:

1. Match active subscriptions for `github/workflow_run.completed`.
2. Prune expired/invalid subscriptions from Redis.
3. Best-effort fetch GitHub workflow artifacts.
4. Deduplicate delivery per subscription.
5. Fan out matched payload to subscription replay list + notify channel.
6. Push `webhook.subscription.matched` to gateway routing with `originSession` for immediate follow-up turn.

## Verification

```bash
# create + stream
joelclaw webhook subscribe github workflow_run.completed \
  --repo joelhooks/joelclaw --workflow CI --conclusion success --stream --timeout 30

# inspect subscriptions
joelclaw webhook list

# stream existing subscription
joelclaw webhook stream <subscription-id> --timeout 30 --replay 10

# remove subscription
joelclaw webhook unsubscribe <subscription-id>
```

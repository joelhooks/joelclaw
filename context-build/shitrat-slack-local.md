# Context Build: ShitRat Slack Local Operator Events

Scope: inspect repo docs/code for gateway, system-bus, message-store, Slack, webhook, and event patterns. No repo code edited. No secret values copied. Slack workspace/channel/user IDs intentionally omitted.

## Goal Restated

Build a local ShitRat Slack agent that can observe Slack conversations the authorized user belongs to and turn relevant messages into operator events for Joel, without turning Slack into an auto-reply firehose.

Best fit in this repo: reuse the existing gateway/operator-relay + channel intelligence pipeline instead of inventing a parallel notification path.

## Existing Concepts That Matter

### 1. Gateway Slack channel already exists

`packages/gateway/src/channels/slack.ts`

- `:18` `emitChannelMessageEvent()` sends `channel/message.received` to Inngest for Typesense indexing.
- `:60` `SlackStartOptions` carries bot/app tokens, allowed user id, reaction emoji, important channel config.
- `:517` `handleIncomingMessage()` parses Slack message events and decides route.
- `:558` invoke path: Joel DMs, bot mentions, and tracked mention threads enqueue a real gateway prompt.
- `:596` passive path: Joel-authored messages or important-channel messages become `slack.signal.received` Redis events with `passiveIntel`, `joelSignal`, and `importantChannel` flags.
- `:786` `startSlackChannel()` dynamically loads `@slack/bolt` and starts Socket Mode.
- `:845`, `:860` registers `message` and `app_mention` handlers.
- `:1215` exposes Slack runtime state for gateway health.

Current behavior is deliberately split:

```text
Slack DM / mention / tracked thread
  -> enqueueToGateway(source=slack:<channel[:thread]>)
  -> prompt live gateway session

Joel-authored channel message OR configured important channel
  -> pushGatewayEvent(type=slack.signal.received, source=slack-intel:<channel>)
  -> operator relay triage
  -> immediate/batched/suppressed

All invoke/passive messages
  -> channel/message.received
  -> channel_messages / conversation_threads context pipeline
```

Important: the current Socket Mode listener sees app-delivered events. It is not user-level omnipresence across every Slack conversation Joel belongs to.

### 2. Gateway operator relay is the canonical event-to-operator surface

`packages/gateway/src/operator-relay.ts`

- `:26` action patterns score messages for urgency.
- `:370` `classifyOperatorSignal()` returns `immediate | batched | suppressed | ingested`.
- `:226` Slack passive signals are summarized as `Slack <channel>: ...` when source starts `slack-intel:`.
- `:442` `buildSignalDigestPrompt()` creates correlated batched briefs.
- `:478` `buildSignalRelayGuidance()` tells the gateway how to brief Joel.

`packages/gateway/src/channels/redis.ts`

- `:32` central Redis list is `joelclaw:events:gateway`.
- `:558` `drainEvents()` drains gateway events and performs relay triage.
- `:619` all events pass through `classifyOperatorSignal()`.
- `:740` actionable events become a gateway prompt via `buildPrompt()`.
- `:955` `flushBatchDigest()` emits correlated digest prompts.
- `:1029` local gateway-side `pushGatewayEvent()` writes to Redis + pub/sub.

This is the cleanest place for ShitRat Slack operator events to land: emit `slack.signal.received` with `source: slack-intel:<channel>` and a structured payload.

### 3. Command queue persists, dedupes, batches, and suppresses passive intel

`packages/gateway/src/command-queue.ts`

- `:2` imports `@joelclaw/message-store` for durable Redis priority storage.
- `:198` human latest-wins supersession is metadata-driven.
- `:520` `enqueueResolved()` persists messages unless Redis fails.
- `:696` `enqueue()` supports batch window metadata.
- `:960` `passiveIntel: true` entries are logged + acked without prompting the session.
- `:1223` `replayUnacked()` restores unacked queue state on startup.

`packages/gateway/src/daemon.ts`

- `:343` `isHumanChannelTurn()` excludes `slack-intel:*` from direct human turn handling.
- `:367` `buildHumanTurnQueueMetadata()` adds latest-wins batching for real human channel turns.
- `:4410` `enqueueToGateway()` injects channel context, classifies thread, then enqueues.
- `:4618` outbound Slack channel suppresses replies to `slack-intel:*`.
- `:4644` daemon starts Slack channel with the derived allowed user id.
- `:3565` `GET /health/slack` exposes Slack health.

This protects against the agent replying to channel chatter. Keep that boundary.

### 4. Message store is priority + dedup, but Slack priority is not first-class yet

`packages/message-store/src/store.ts`

- `:131` `classifyPriority()` maps slash commands to P0, Telegram/iMessage to P1, heartbeat to P2, default to P3.
- `:162` initializes gateway queue keys on Redis.
- `:184` `persist()` dedupes for 30s, classifies priority, writes to `@joelclaw/queue`.
- `:306` `drainByPriority()` handles aging promotion and P3 coalescing.

Risk: real Slack human invokes currently fall through to default P3 unless metadata/source handling elsewhere compensates. If ShitRat emits high-priority operator events, be explicit with metadata or update priority classification.

### 5. System-bus already has channel-message intelligence

`packages/system-bus/src/inngest/functions/channel-message-ingest.ts`

- `:113` `channelMessageIngest` handles `channel/message.received`.
- `:144` ensures `channel_messages` collection then upserts raw message.
- `:185` emits `channel/message.classify.requested`.

`packages/system-bus/src/inngest/functions/channel-message-classify.ts`

- `:377` `resolveDestination()` sends actionable `signal` messages to `session`, context to `digest`, noise to dropped.
- `:389` `resolveThreadId()` only resolves Slack threads when `threadId` exists; email uses conversation id.
- `:423` `channelMessageClassify` classifies via shared `infer()`.
- `:602` emits `channel/message.signal` for actionable messages.
- `:633` emits `conversation/thread.updated` when a thread id exists.

Gap: there is no current consumer for `channel/message.signal`. If relevance should come from the classifier, implementation needs a bridge function that turns `channel/message.signal` into a gateway/operator event, likely `slack.signal.received` for Slack.

### 6. Conversation thread memory exists, but top-level Slack messages may not aggregate

`packages/system-bus/src/inngest/functions/conversation-thread-aggregate.ts`

- `:223` `conversationThreadAggregate` handles `conversation/thread.updated`.
- `:202` enriches new thread, every 5 new messages, or after a 30m gap.
- `:318` emits `conversation/thread.enrichment.requested`.

`packages/system-bus/src/inngest/functions/conversation-thread-enrich.ts`

- `:172` prompt contract summarizes operational threads for Joel.
- `:202` `conversationThreadEnrich` enriches Slack/email threads.
- `:287` upserts `conversation_threads` with summary, related projects/contacts, vault gap, urgency, and `needs_joel`.

`packages/system-bus/src/lib/typesense.ts`

- `:200` `channel_messages` schema stores message text, classification, concepts, urgency, actionability, MiniLM embedding.
- `:234` `conversation_threads` schema stores thread aggregate/enrichment output.
- `:781` `ensureChannelMessagesCollection()` patches fields safely.

Current Slack caveat: `packages/gateway/src/channels/slack.ts:511-514` drops `threadId` for top-level messages, and `channel-message-classify.ts:389-392` only emits thread updates when Slack `threadId` exists. If “observe channels” means channel-level conversations, use `thread_ts ?? ts` or another stable top-level conversation key.

### 7. Slack historical backfill exists, host-only

`packages/system-bus/src/inngest/functions/slack-backfill.ts`

- `:213` leases the Slack user token through local `secrets` CLI.
- `:272` `slackChannelBackfill` handles `channel/slack.backfill.requested`.
- `:388` uses `conversations.history`.
- `:414` expands `conversations.replies` for threads.
- `:346` uses `search.messages` to catch active replies whose parent is outside the window.
- `:689` `slackBackfillBatch` fans out backfill requests.

Docs say this indexes legacy `slack_messages`; realtime intelligence now writes `channel_messages` / `conversation_threads`. Useful for catch-up, not the primary live operator-event path.

### 8. Webhook gateway patterns are ready if Slack Events API is used

`packages/system-bus/src/webhooks/types.ts`

- `:7` `NormalizedEvent` shape.
- `:16` `WebhookProvider` interface: verify raw-body signature, normalize payload into internal events.

`packages/system-bus/src/webhooks/server.ts`

- `:21` provider registry.
- `:166` `POST /webhooks/:provider` route.
- `:203` signature verification before JSON parse/normalize.
- `:98` `dispatchWebhookEvents()` sends direct Inngest events or queue pilots.

`docs/webhooks.md` and `skills/webhooks/references/new-provider-checklist.md` define the new-provider pattern. There is no Slack webhook provider today.

### 9. Gateway middleware is the normal system-bus -> gateway API

`packages/system-bus/src/inngest/middleware/gateway.ts`

- `:28` `GatewayContext` gives functions `progress`, `notify`, and `alert`.
- `:129` sleep gate queues non-passthrough events while asleep.
- `:190` `notify()` pushes typed gateway events.
- `:214` `alert()` pushes central alerts.

`packages/system-bus/src/inngest/functions/agent-loop/utils.ts`

- `:285` `pushGatewayEvent()` writes event JSON to registered gateway sessions.
- `:303` reads `joelclaw:gateway:sessions`.
- `:326` writes to `joelclaw:events:<session>` + pub/sub.

For a `channel/message.signal` bridge, use the middleware when inside an Inngest function, or `pushGatewayEvent()` if the function needs explicit central routing.

## Event Types Already Defined

`packages/system-bus/src/inngest/client.ts`

- `:1167` `channel/slack.backfill.requested`
- `:1198` `channel/message.received`
- `:1217` `channel/message.signal`
- `:1240` `conversation/thread.updated`

No new event family is strictly required for the first implementation if the ShitRat observer emits `channel/message.received` and the bridge emits `slack.signal.received`.

## Docs / Prior Research

- `docs/gateway.md:338` documents Slack passive firehose prerequisites and the canonical `slack.signal.received` relay path.
- `docs/gateway.md:367` documents important-channel intelligence: collect, index, batch/escalate, no auto-answer.
- `docs/inngest-functions.md:255` documents channel-message -> classify -> thread aggregate -> enrichment flow.
- `context-build/slack-platform-research.md:5` says bot tokens are not user omnipresence.
- `context-build/slack-platform-research.md:64` maps user-level scopes for continuous observation.
- `context-build/slack-platform-research.md:87` recommends bot UI + per-user OAuth/user token + targeted search/history over bulk scraping.

Key platform constraint from the research: observing conversations the user belongs to is a user-token/OAuth problem, not a bot Socket Mode trick. Socket Mode changes delivery, not visibility.

## Likely Integration Points

### Preferred path: local user-token observer -> existing relay

Build a local observer actor that:

1. Discovers authorized-user conversations with Slack user-token APIs.
2. Maintains Redis cursors per channel/thread.
3. Fetches recent deltas with bounded polling or receives Events API callbacks if configured.
4. Dedupes by Slack `channel:ts`.
5. Emits raw messages to `channel/message.received` for `channel_messages` / classifier / thread memory.
6. Emits relevant operator events as `slack.signal.received` with `source: slack-intel:<channel>` and payload fields matching `operator-relay.ts` expectations.
7. Never posts in Slack channels. Only operator-facing output should go to Joel’s DM / gateway channels.

Why: this preserves the current relay policy, digesting, quiet-hours behavior, sleep handling, passive-intel suppression, and gateway health surfaces.

### Bridge needed if classifier decides relevance

If relevance should come from `channel-message-classify`, add a small system-bus function:

```text
channel/message.signal
  -> channel-message-signal-to-gateway
  -> pushGatewayEvent({
       type: "slack.signal.received",
       source: `slack-intel:${channelId}`,
       payload: { prompt, slackChannelId, slackChannelName, slackThreadTs, ... }
     })
```

This closes the current dead-end where `channel/message.signal` is emitted but not consumed.

### Webhook path if using Slack Events API

If Slack Events API is chosen instead of local polling:

- Add `packages/system-bus/src/webhooks/providers/slack.ts` implementing `WebhookProvider`.
- Verify Slack request signatures from raw body.
- Handle URL verification challenge.
- Normalize message events into `channel/message.received` or a Slack-specific event.
- Register provider in `webhooks/server.ts` and update `serve.ts` provider list/docs.

This is cleaner for realtime delivery but raises public endpoint + Slack app config + signature-secret rollout work.

### Avoid direct session prompts for ambient Slack

Do not enqueue ambient channel messages directly with `source=slack:*`. That bypasses relay scoring and risks replies. Ambient observation should use `source=slack-intel:*` and `passiveIntel` metadata or the Redis event path.

## Suggested State Machine

This is not boolean-soup territory. Use an explicit XState v5 actor for the local observer.

Sketch:

```text
stopped
  -> starting
  -> syncMembership
  -> observing
      -> pollChannel
      -> normalize
      -> emitRawMessage
      -> emitOperatorSignal? / awaitClassifier
      -> persistCursor
  -> backoff on rate_limit/transient API error
  -> degraded on auth/revocation/missing_scope
  -> stopped on shutdown
```

Persist enough state to resume safely:

- membership snapshot timestamp
- per-channel latest Slack ts cursor
- per-channel backoff/rate-limit deadline
- dedupe keys for recent `channel:ts`
- last successful observation timestamp for health

## Tests / Build Commands

Narrow tests for likely edits:

```bash
bun test packages/gateway/src/operator-relay.test.ts
bun test packages/gateway/src/command-queue.test.ts
bun test packages/gateway/src/channel-health.test.ts
bun test packages/system-bus/src/inngest/functions/channel-message-classify.test.ts
bun test packages/system-bus/src/webhooks/server.test.ts
bun test packages/message-store/__tests__/store.test.ts
```

Type checks:

```bash
bunx tsc --noEmit -p packages/gateway/tsconfig.json
bunx tsc --noEmit -p packages/system-bus/tsconfig.json
bunx tsc --noEmit -p packages/message-store/tsconfig.json
```

Broader repo checks:

```bash
pnpm lint
pnpm lint:biome
pnpm check-types
```

Runtime verification after implementation, not during this context build:

```bash
joelclaw gateway status
joelclaw gateway diagnose --hours 1 --lines 120
joelclaw gateway events
joelclaw runs --count 10
```

If system-bus functions change, normal rollout docs say restart/register the worker and verify functions registration.

## Risks / Gotchas

1. **Slack visibility is constrained.** Existing Socket Mode bot/app events do not observe every channel the user exists in. User-level observation needs a user token/OAuth grant, scopes, admin approval, revocation handling, and rate-limit handling.

2. **Privacy boundary is sharp.** Slack content is private context. Do not commit Slack IDs, token values, channel taxonomies, raw dumps, or message content. Store only minimal derived state unless Joel explicitly approves raw retention.

3. **`channel/message.signal` is currently a dead-end.** The classifier emits it, but no function consumes it. Either bridge it to gateway relay or do relevance in the local observer and emit `slack.signal.received` directly.

4. **Timestamp units look inconsistent.** Slack realtime emits `Math.floor(Date.now() / 1000)` at `slack.ts:591` and `:649`, but `channel-message-ingest.ts:63` says timestamps are unix-ms. Thread stale/enrich logic compares timestamps against `Date.now()` ms. Fix before relying on thread freshness.

5. **Top-level Slack messages may never become conversation threads.** `slack.ts:511-514` drops top-level `thread_ts`, and `channel-message-classify.ts:389-392` only emits thread updates for Slack when `threadId` exists. Decide whether channel-level top-level messages should use their own `ts` as thread id.

6. **Duplicate paths are easy.** Current gateway important-channel listener can emit both `channel/message.received` and `slack.signal.received`. A new local observer could duplicate the same message. Use Slack `channel:ts` idempotency in Redis and consistent event IDs.

7. **Current Slack indexing is fire-and-forget.** `emitChannelMessageEvent()` silently catches fetch failures. For an observer, failures need OTEL and retry/backoff so “observing” does not secretly mean “dropping.”

8. **Priority may be wrong for Slack human/operator events.** `message-store` treats Telegram/iMessage as P1 but not Slack. If Slack is a first-class operator source, add coverage or metadata hints.

9. **No direct tests around Slack channel internals.** `handleIncomingMessage()` is not exported. Implementation will be easier to test if pure normalization/routing logic is extracted behind test utils.

10. **Gateway must stay available.** Do not run a heavy all-channel poller inside the hot gateway turn loop. Prefer a sidecar actor with bounded work, Redis cursors, and observable degraded modes.

## Compact Meta-Prompt for Implementation

Implement a local ShitRat Slack observer in joelclaw. Read `context-build/shitrat-slack-local.md` first. Reuse existing patterns: gateway `slack.signal.received`, `operator-relay.ts`, Redis `pushGatewayEvent`, system-bus `channel/message.received`, and `channel-message-classify`. Do not store secret values or Slack IDs in repo. Never auto-reply in Slack channels.

Preferred architecture: XState v5 local observer actor with states for startup, membership sync, polling/receiving, normalization, emit, cursor persist, rate-limit backoff, degraded auth/scope, and shutdown. Use user-token visibility for “channels the user exists in”; do not assume bot Socket Mode can see them. Emit raw messages to `channel/message.received` with ms timestamps and stable `threadId` policy. Close the `channel/message.signal` dead-end with a bridge to `slack.signal.received` or emit `slack.signal.received` directly after deterministic relevance scoring. Deduplicate by Slack `channel:ts`. Add focused tests for normalization, dedupe, relay classification, passive-intel suppression, timestamp units, and signal bridging. Run targeted Bun tests and package type checks.

# PRD: Reply Grants Channel Routing v1

## Objective

Prevent joelclaw from posting garbage public Slack replies while preserving Joel-authorized contextual chats with collaborators.

## Success Criteria

- Non-Joel Slack mentions never post publicly without an active Reply Grant or Joel approval.
- Every Slack mention sends Joel a Telegram alert with grant state and a private suggested reply path.
- Joel can create/extend a Reply Grant by direct Slack instruction, Slack URL command, or `:joelclaw:` reaction.
- Active Reply Grants allow follow-up thread chat only for permitted invokers.
- Redis is the runtime source for active Reply Grants.
- OTEL records grant creation, use, expiration, rejection, and public post attempts.
- XState controls public reply lifecycle.
- CASL-style policy controls who can mention/request/consume/administer.
- Unit tests cover permission decisions and state transitions.
- Functional tests cover Slack mention → Telegram approval → Slack post and active grant follow-up.

## Scope

### In scope

- Slack public reply control only.
- New pure package: `@joelclaw/channel-routing`.
- Gateway adapter integration for Slack + Telegram approval.
- Canonical private policy file: `~/.joelclaw/gateway/channel-permissions.json`.
- Redis projection/cache for runtime grant state.
- OTEL instrumentation.
- CLI or gateway command affordances enough to inspect policy/grants.

### Out of scope

- Discord/iMessage public participation.
- Full database/PDS persistence for grants.
- Permanent always-interactive channels.
- Allowing passive intel messages to post public replies.

## Domain Terms

- **Reply Grant**: User-issued, short-lived permission for joelclaw to send public replies into a specific external thread.
- **Invoker Allowlist**: External participants allowed to consume a Reply Grant via follow-up messages.
- **Channel Permission Policy**: Durable allow/block/RBAC policy for external channel participants and channels.

## V1 Defaults

- `maxReplies`: 5
- `idleTtlMs`: 30 minutes
- `absoluteTtlMs`: 2 hours
- `conversationMode`: starts active after a bot reply, idles after 2 human-only messages or idle TTL
- `scope`: Slack thread only

## Required Flows

### 1. Non-Joel mention without grant

1. Slack app mention arrives.
2. Channel-routing checks CASL permissions.
3. No active Reply Grant exists.
4. Gateway sends Telegram alert to Joel.
5. Gateway creates private draft suggestion.
6. No Slack reply is posted.
7. Telegram buttons allow: Send suggested, Edit first, Grant only, Ignore.

### 2. Joel direct instruction in Slack

1. Joel mentions joelclaw in Slack with an instruction.
2. Gateway creates/extends a Reply Grant for the thread.
3. Gateway posts public reply.
4. Grant usage is recorded in Redis and OTEL.

### 3. Joel `:joelclaw:` reaction

1. Joel reacts to a Slack message.
2. Gateway creates/extends a Reply Grant for that thread.
3. If reacted message is clearly addressed/actionable, Telegram may ask to approve a reply.
4. Otherwise no immediate public reply.

### 4. Active grant follow-up

1. Allowed invoker sends a follow-up in the granted thread.
2. CASL permits consumeGrant and grant includes invoker.
3. Conversation mode is active.
4. Gateway posts public reply through deterministic actor transition.
5. Replies used increments.
6. Telegram receives a receipt with Close Grant / Open Thread actions.

### 5. Blocked actor

1. Blocked Slack user mentions joelclaw.
2. No public reply.
3. OTEL records rejection.
4. Optional Telegram digest/alert, no private draft by default.

## State Machine Sketch

```txt
mentioned
  -> classifyActor
  -> checkGrant
  -> noGrant.awaitingApproval
  -> approved.createGrant
  -> approved.postPublicReply
  -> activeGrant

activeGrant
  -> checkInvoker
  -> checkConversationMode
  -> postPublicReply
  -> updateGrant
  -> notifyReceipt

any
  -> rejected
  -> recorded
```

## Testing Plan

### Unit tests

- CASL policy denies blocked users.
- Trusted collaborator can request grant but cannot administer.
- Reply Grant expiration rejects use.
- Reply Grant max replies rejects use.
- Invoker Allowlist gates follow-up use.
- No-grant mention emits notify/draft intents, not post intent.
- Active grant follow-up emits post/update/notify intents.

### Functional tests

- Simulate Slack mention without grant and verify Telegram approval payload, no Slack send.
- Simulate Send Suggested callback and verify grant written, Slack post called once, OTEL emitted.
- Simulate active grant follow-up from allowed invoker and verify public reply.
- Simulate non-allowed participant follow-up and verify rejection + Telegram alert/no Slack send.
- Simulate stale source/internal heartbeat and verify Slack post is impossible.

## Milestones

1. ADR + PRD accepted.
2. Pure `@joelclaw/channel-routing` package with tests.
3. Gateway Redis/OTEL/policy adapters.
4. Telegram approval UI.
5. Slack functional tests with mocked adapters.
6. Manual canary in `#brain-joel` with Joel notified in Slack at each milestone.

## Implementation Audit — 2026-05-21

Objective: ship durable Slack public-reply routing backed by ADR + PRD, implemented with Reply Grants, tested at unit/functional/E2E levels, and keep Joel updated in Slack.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Write ADR | `docs/decisions/0244-reply-grants-channel-routing.md`; committed in `97821811` | Done |
| Write full PRD | `docs/prd-reply-grants-channel-routing.md`; committed in `97821811`; this audit records live status | Done |
| Lock in domain language | `CONTEXT.md` terms for Reply Grant, Invoker Allowlist, Channel Participation Policy; commits `aa4726f0`, `8237831f` | Done |
| Implement pure policy/state package | `packages/channel-routing` with CASL policy, XState machine shell, grant helpers, approval resolver; commits `97821811`, `64bb5eb4` | Done |
| Gateway Slack routing adapter | `packages/gateway/src/channels/slack.ts`; non-DM mentions and active grants route through `routeSlackMention`; commits `4b51b06a`, `c863970f`, `b00b9261` | Done |
| Redis Reply Grant runtime state | Slack adapter writes `replyGrant:slack:<channel>:<thread>` with TTL; Telegram approval callback writes same key | Done |
| Telegram approval UI | Alert includes `Send suggested`, `Edit first`, `Grant`, `Ignore`, `Open thread`; `replygrant:*` callback handler in `packages/gateway/src/channels/telegram.ts` | Done for v1; `Edit first` drafts privately for Joel instead of sending public Slack |
| Non-Joel mention without grant must not post publicly | `routeSlackMention` unit test expects notify/draft/otel and no `postPublicReply`; Slack adapter returns before enqueue when no post intent | Done by unit/adapter evidence; needs live human event confirmation |
| Active grant follow-up | Functional test covers no-grant mention → grant decision → active follow-up → `postPublicReply` intent; Slack send success updates grant usage and sends Telegram receipt with Close Grant/Open Thread | Done by functional test + adapter code |
| `:joelclaw:` reaction creates grant | `handleReactionAdded` writes Reply Grant only for `joelclaw` reaction and ignores other reactions | Done by adapter code; no live canary yet |
| Unit tests | `pnpm --filter @joelclaw/channel-routing test` → 13 tests passing at 2026-05-21T15:25Z | Done |
| Type checks | `pnpm --filter @joelclaw/channel-routing exec tsc --noEmit` passed at 2026-05-21T15:25Z | Done for package |
| Gateway syntax/build checks | `bun build packages/gateway/src/channels/slack.ts --target bun`; `bun build packages/gateway/src/channels/telegram.ts --target bun` passed at 2026-05-21T15:25Z | Done |
| Gateway deployed/restarted | `joelclaw gateway restart`; post-warmup `joelclaw gateway status` showed healthy Slack/Telegram and pid `32695` | Done |
| Slack milestone updates | Slack DMs sent after foundation, adapter routing, callbacks, functional test/restart, Send Suggested | Done |
| End-to-end canary | Synthetic Redis→gateway→Slack canary posted root `1779377477.787609`, gateway replied in thread `1779377534.167019`, Redis grant showed `repliesUsed: 1`, then root/replies/grant were deleted; API-authored human-mention canary remains weak for Slack app-mention ingress | Done for gateway egress + grant accounting; human Slack ingress still recommended |

Open gaps before completion:

1. Strong human-ingress E2E proof from a real human/non-bot Slack event in `#brain-joel` or equivalent is still recommended, but the live egress/grant-accounting path has been canaried with real Slack posts and Redis state.
2. Gateway-wide TypeScript still has unrelated pre-existing daemon errors (`AgentSession.newSession`, optional telemetry fields), so gateway verification currently relies on targeted Bun bundle checks for edited adapters plus package tsc.

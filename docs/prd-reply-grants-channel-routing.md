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

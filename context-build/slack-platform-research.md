# Research: Slack platform constraints for user-level omnipresence

_Current as of 2026-05-20. Sources are Slack official docs unless noted._

## Summary

Slack does **not** support an invisible, all-seeing bot. Bot tokens and bot event subscriptions are limited to conversations the bot/app is party to, with narrow exceptions like posting to public channels.

The only plausible “user-level omnipresence” path without inviting a bot is **per-user OAuth + user scopes**: each user grants a user token, and Events API/Web API access is limited to conversations that user can see plus the scopes/admin approval granted. That is still consented, revocable, rate-limited, and security-review bait.

## Crisp recommendations

1. **Prefer an interaction-driven agent, not passive surveillance.** Use Slack’s Real-time Search API for user-initiated context and targeted `conversations.history` / `conversations.replies` only when needed. Slack explicitly frames RTS as safer than bulk channel indexing and says not to scrape unrelated workspace data. [Real-time Search API](https://docs.slack.dev/apis/web-api/real-time-search-api/) [Rate-limit changelog](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)
2. **If background observation is truly required, make it per-user and explicit.** Request user scopes for the conversation types you need, subscribe to workspace `message.*` events, and store only the minimum derived state. Do not pretend this is a normal bot. It’s a high-trust data access product.
3. **Do not build around Socket Mode as a permission trick.** Socket Mode only changes delivery transport. It does not expand visibility. Slack also says Socket Mode apps currently can’t be listed in the Slack Marketplace, which matters for commercial distribution. [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
4. **For commercial apps, plan for Marketplace/security review early.** New non-Marketplace commercial apps have brutal `conversations.history` / `conversations.replies` limits: 1 request/minute and 15 objects/request. Internal customer-built apps and Marketplace apps keep higher limits. [conversations.history](https://docs.slack.dev/reference/methods/conversations.history/) [Rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)
5. **Use optional scopes and graceful degradation.** Put risky read scopes behind optional user/admin approval where possible. Admins can approve only subsets of bot/user scopes. [Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/) [Managing app approvals](https://docs.slack.dev/admins/managing-app-approvals/)

## Findings

1. **Bot tokens are app identity, not user omnipresence.** Bot tokens (`xoxb-`) represent the installed app/bot and are not tied to a human user. Bot event visibility is perspectival to the bot user, so a bot receives events for conversations it belongs to. Slack’s Events API example says a bot receives `message.channels` for `#random` because the bot has a bot subscription **and membership** in `#random`. [Tokens](https://docs.slack.dev/authentication/tokens/) [Events API](https://docs.slack.dev/apis/events-api/)

2. **User tokens are the only Slack-native way to act/read as a user.** User tokens (`xoxp-`) represent workspace members. Slack says user tokens “represent the same access a user has to a workspace” and gain resource-based scopes, e.g. `channels:history` grants access to `conversations.history` for public channels. Request user scopes via `user_scope` in OAuth, or Slack’s user-specific `oauth/v2_user/authorize` flow; returned user tokens live under `authed_user`. [Tokens](https://docs.slack.dev/authentication/tokens/) [OAuth](https://docs.slack.dev/authentication/installing-with-oauth/)

3. **Events API can be user-perspectival, but only for authorized users and granted scopes.** Slack says workspace events are tied to OAuth scopes and “users who have authorized your app can see” the event. Example: if a user authorizes private channel history, the app sees activity only in private channels that user is a member of, not all private channels. Multiple authorized users may see the same event; Slack sends one event and one authorization, and you can call `apps.event.authorizations.list` to enumerate all authorizations. [Events API](https://docs.slack.dev/apis/events-api/)

4. **Message events are split by conversation type.** To observe message events, subscribe to the relevant Events API types: `message.channels` for public channels, `message.groups` for private channels, `message.im` for DMs, and `message.mpim` for group DMs. Required scopes track those types: `channels:history`, `groups:history`, `im:history`, `mpim:history`. [message event](https://docs.slack.dev/reference/events/message/) [channels:history](https://docs.slack.dev/reference/scopes/channels.history/) [groups:history](https://docs.slack.dev/reference/scopes/groups.history/) [im:history](https://docs.slack.dev/reference/scopes/im.history/) [mpim:history](https://docs.slack.dev/reference/scopes/mpim.history/)

5. **Conversation listing is also scope-filtered.** `conversations.list` returns channel-like objects based on the token’s access and `types` parameter. `users.conversations` lists conversations the calling user is a member of; non-public channels are restricted to shared membership. For a user-level agent, use `users.conversations` to stay inside “channels this user belongs to” instead of accidentally sweeping public channels the user could see but hasn’t joined. [conversations.list](https://docs.slack.dev/reference/methods/conversations.list/) [users.conversations](https://docs.slack.dev/reference/methods/users.conversations/) [Conversations API](https://docs.slack.dev/apis/web-api/using-the-conversations-api/)

6. **Bot membership is still required for bot-read private/DM/MPIM visibility.** Scope pages for `groups:history`, `im:history`, and `mpim:history` describe access to conversations the Slack app has been added to. Bot tokens cannot silently read private channels/DMs they are not party to. Public channels are less strict for user tokens, but bot read access still commonly fails with “make sure your app is a member” errors. [groups:history](https://docs.slack.dev/reference/scopes/groups.history/) [im:history](https://docs.slack.dev/reference/scopes/im.history/) [conversations.history](https://docs.slack.dev/reference/methods/conversations.history/)

7. **A bot can join public channels, but not silently join private spaces.** `channels:join` lets a bot join public channels via `conversations.join`. `chat:write.public` lets a bot post to public channels it is not a member of, but it does not grant read visibility. Private channels and DMs require membership/invitation or user-token access. [channels:join](https://docs.slack.dev/reference/scopes/channels.join/) [conversations.join](https://docs.slack.dev/reference/methods/conversations.join/) [chat:write.public](https://docs.slack.dev/reference/scopes/chat.write.public/)

8. **Socket Mode is transport, not authority.** Socket Mode uses an app-level `xapp-` token with `connections:write` to receive Events API/interactivity over WebSockets instead of HTTP. It does not change OAuth scopes, event subscriptions, or conversation visibility. Slack says Socket Mode apps currently can’t be listed in the Slack Marketplace, though they can be Enterprise org deployable. [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)

9. **Event throughput has a platform cap.** Events API deliveries max out at 30,000 events per workspace/team per app per 60 minutes; Slack sends `app_rate_limited` events if exceeded. Apps must ack event delivery within 3 seconds. High-volume “watch every message” designs can hit this fast. [Events API](https://docs.slack.dev/apis/events-api/)

10. **History/replies crawling is now heavily constrained for unreviewed commercial apps.** Since May 29, 2025, new non-Marketplace commercially distributed apps and new installs of existing unlisted apps get `conversations.history` and `conversations.replies` limited to 1 request/minute and 15 objects/request. Slack says this is specifically to reduce bulk data exfiltration risk. Internal customer-built apps and Marketplace apps are not hit by those new limits. [Rate-limit changelog](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/) [conversations.history](https://docs.slack.dev/reference/methods/conversations.history/)

11. **Real-time Search is the safer AI-agent path, but it is not passive background observation.** RTS is designed for user interactions and searches content the authenticated user has access to. Private/DM/MPIM search requires user consent; users may revoke that consent. Slack says you must not store/copy data from this API, use it for training, or scrape unrelated workspace data. `assistant.search.context` has limits around 10+ req/min for most teams, an additional user-level 10 req/min limit, and max 20 results/page. [Real-time Search API](https://docs.slack.dev/apis/web-api/real-time-search-api/) [assistant.search.context](https://docs.slack.dev/reference/methods/assistant.search.context/)

12. **Assistant APIs give user-present context, not omniscience.** Agents & AI Apps provide top-bar/split-pane entry, `assistant:write`, thread status/title/prompts, and events like `assistant_thread_started` and `assistant_thread_context_changed`. Those events tell you what channel the user is viewing while the assistant container is open; Slack says to call `conversations.info` first to see if the app has access. This is useful context, not background monitoring across all channels. [Developing agents](https://docs.slack.dev/ai/developing-agents/) [assistant_thread_started](https://docs.slack.dev/reference/events/assistant_thread_started/) [assistant_thread_context_changed](https://docs.slack.dev/reference/events/assistant_thread_context_changed/) [assistant:write](https://docs.slack.dev/reference/scopes/assistant.write/)

13. **Admin approval is a real product constraint.** Workspaces can require app approval; admins can approve/restrict apps and selectively approve bot/user scopes. Optional scopes let users choose from admin-preapproved scopes. Slack’s security docs explicitly call `channels:history` a higher-risk scope that may require manual review. [Managing app approvals](https://docs.slack.dev/admins/managing-app-approvals/) [Security](https://docs.slack.dev/security) [Optional scopes](https://docs.slack.dev/changelog/2026/03/16/optional-scopes/)

14. **Security posture must assume high blast radius.** Slack recommends token rotation, IP allowlisting for token use, secure token storage, request verification, no token leaks between users, and AI-specific prompt-injection/exfiltration controls. For a user-token agent, cross-user token isolation is non-negotiable. [Security best practices](https://docs.slack.dev/security) [Token rotation](https://docs.slack.dev/authentication/using-token-rotation/)

15. **Slack Connect and Enterprise add edge cases.** Slack Connect event visibility depends on a valid scoped token and the event occurring in a channel the authorized user is a member of. Slack recommends exposing less information in shared channels by default. Enterprise installs, org-wide apps, GovSlack domains, EKM, and workspace migrations can all affect visibility and operations. [Slack Connect](https://docs.slack.dev/apis/slack-connect/) [conversations.history errors](https://docs.slack.dev/reference/methods/conversations.history/)

## Can true background observation happen without inviting a bot?

**Short answer: Yes, but only as a user-authorized app, not as a bot.**

| Scenario | Possible? | Notes |
|---|---:|---|
| Bot silently observes all channels a user belongs to | **No** | Bot events/read access are bot-perspectival and membership-bound. |
| Bot observes public channels after joining them | **Partially** | Bot can join public channels with `channels:join`; this is visible and not private/DM coverage. |
| Bot reads private channels/DMs/MPIMs without invite | **No** | Needs membership/invite, or use a user token instead. |
| User-token app observes channels the user can see | **Yes, scoped** | Requires each user’s OAuth grant, user history scopes, Events API subscriptions, admin approval, and revocation handling. |
| User-token app observes all workspace private channels | **No** | Only conversations the authorized user can see/member of. |
| Agent searches all user-accessible content on demand | **Yes, better fit** | Use Real-time Search with search scopes and consent; do not store/scrape. |

## Scope map for a user-level agent

Minimum continuous-observation user scopes, if you insist on the spicy path:

- Public channel message events/history: `channels:history`
- Private channel message events/history: `groups:history`
- DM message events/history: `im:history`
- MPIM message events/history: `mpim:history`
- Conversation discovery: `channels:read`, `groups:read`, `im:read`, `mpim:read`
- Threads: `conversations.replies` uses the same relevant history scopes

Common bot scopes for the app shell:

- Bot interaction: `app_mentions:read`, `chat:write`, maybe `im:history` for app DMs
- Agent UI: `assistant:write`
- Socket Mode transport: app-level token with `connections:write` only if not Marketplace-bound

For on-demand AI context:

- `search:read.public` is required for RTS public search
- `search:read.private`, `search:read.im`, `search:read.mpim` require user consent in Slack client and may be revoked
- `search:read.files` if files should be searched

## Architecture recommendation

**Best default:**

1. Bot token for Slack-native UI: mentions, DMs, App Home/Agent entry, streaming/status.
2. Per-user OAuth token for user-specific context when the user connects Slack.
3. Real-time Search for user-initiated “find/summarize/answer” requests.
4. Targeted `conversations.replies` / `conversations.history` only after search returns a specific thread/channel.
5. No bulk ingestion unless the customer is internal/Enterprise and explicitly wants that compliance posture.

**If continuous background observation is a hard requirement:**

1. Treat it like a security product, not a cute agent feature.
2. Make every monitored user explicitly authorize user scopes.
3. Subscribe to workspace `message.channels`, `message.groups`, `message.im`, `message.mpim` events.
4. Use `users.conversations` to bound the user’s membership set.
5. Store minimal derived metadata; avoid raw message retention unless contract/admin/legal says yes.
6. Build scope checks, token revocation handling, audit logs, data deletion, per-user isolation, and admin reporting before launch.
7. Expect app approval friction and Marketplace review questions.

## Sources

### Kept

- Slack Tokens (https://docs.slack.dev/authentication/tokens/) — token types and user-token access model.
- Installing with OAuth (https://docs.slack.dev/authentication/installing-with-oauth/) — `scope` vs `user_scope`, user token issuance, optional scopes.
- Using token rotation (https://docs.slack.dev/authentication/using-token-rotation/) — rotating user/bot tokens and 12-hour access tokens.
- Events API (https://docs.slack.dev/apis/events-api/) — user/bot visibility model, delivery behavior, rate limit.
- Socket Mode (https://docs.slack.dev/apis/events-api/using-socket-mode/) — WebSocket delivery and Marketplace caveat.
- Message event reference (https://docs.slack.dev/reference/events/message/) — message event variants by conversation type.
- Conversations API guide (https://docs.slack.dev/apis/web-api/using-the-conversations-api/) — scope filtering across conversation types.
- conversations.history (https://docs.slack.dev/reference/methods/conversations.history/) — history access, errors, and current limits.
- conversations.list (https://docs.slack.dev/reference/methods/conversations.list/) — token-access filtered listing.
- users.conversations (https://docs.slack.dev/reference/methods/users.conversations/) — calling-user membership listing.
- Scope refs: `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:join`, `chat:write.public` — exact scope coverage.
- Rate-limit changelog (https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/) — 2025 history/replies reductions and rationale.
- Real-time Search API (https://docs.slack.dev/apis/web-api/real-time-search-api/) — recommended AI context retrieval model and data-use constraints.
- assistant.search.context (https://docs.slack.dev/reference/methods/assistant.search.context/) — RTS method limits and behavior.
- Developing agents (https://docs.slack.dev/ai/developing-agents/) — Agent/App Assistant APIs and context events.
- Managing app approvals (https://docs.slack.dev/admins/managing-app-approvals/) — admin approval and selective scope grants.
- Security best practices (https://docs.slack.dev/security) — token storage, IP allowlists, prompt-injection/data exfiltration concerns.
- Slack Connect (https://docs.slack.dev/apis/slack-connect/) — shared-channel authorization caveats.

### Dropped

- Legacy RTM API docs — useful as a warning only; granular Slack apps cannot use RTM for this, and Slack recommends Events API/Socket Mode instead.
- SDK tutorials — redundant implementation examples, not source-of-truth constraints.
- Legacy `search.*` methods — Slack now recommends Real-time Search for AI context.
- Non-official blog/forum results — skipped; official Slack docs covered the constraints directly.

## Gaps

- Slack’s scope pages sometimes say “app has been added to,” while the token docs say user tokens represent the user’s own visible resources. Before product commitment, verify user-token `message.groups`, `message.im`, and `message.mpim` delivery in a test workspace.
- Marketplace acceptance for a passive user-token observer is a policy/business risk, not just a technical question. Ask Slack partner/dev support early.
- Real-time Search availability and semantic search features depend on app type, plan, and Slack AI Search availability. Verify target customer plans.
- Enterprise Grid, GovSlack, EKM, retention/legal holds, Slack Connect, and guest users can change practical access behavior. Test those explicitly if they matter.

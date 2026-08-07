---
name: egghead-slack
displayName: egghead Slack Intelligence
description: Operate the private egghead Slack integration without leaking workspace data. Covers passive monitoring, explicit ShitRat work triggers, and approval-bound thread replies.
version: 0.3.0
author: joel
tags:
  - slack
  - channels
  - intelligence
---

# egghead Slack Intelligence

This repository copy is the public-safe operating contract. Private workspace IDs, channel maps, people, message content, and runtime bindings belong in the local runtime overlay. Never add them here.

## Boundaries

- Slack content is private by default.
- Never publish channel IDs, user IDs, workspace IDs, channel rosters, direct-message maps, customer data, message text, files, or private links.
- Never print or persist token values.
- One gateway transport owns outbound Slack communication.
- Workers return evidence to the gateway. Workers do not post directly.
- Ordinary channel messages remain passive intelligence.

## Credentials

Runtime credentials come from `agent-secrets`:

- `slack_bot_token` for Socket Mode, reactions, and bot-authored replies.
- `slack_app_token` for the Socket Mode connection.
- `slack_user_token` for approved read-only search and context retrieval.

Lease credentials only for the command that needs them. Do not copy them into files, logs, prompts, or shell history.

## Read workflow

Use `jc-slack` instead of raw Slack API calls when the command exists:

```bash
jc-slack channels --query <term>
jc-slack search '<query>' --channel <channel-name>
jc-slack context '<message-permalink>'
jc-slack board <channel-name-or-id>
```

Read the source thread before deciding or replying. A permalink is the stable input for thread work.

## ShitRat work trigger

Joel authorized one deterministic participation path:

- A human posts exact `:shitrat:` or directly mentions the existing bot.
- The source channel name matches `lc-*` or `cc-*`.
- Joel's personal Slack token from agent-secrets can see the channel.
- A private channel-context binding resolves one exact repository, `cwd`, Brain entry, skill set, and validation contract.

The transport immediately adds Joel's `:shitrat:` reaction. A warm `openai-codex/gpt-5.6-luna` triage call reads the activation, generates the first ShitRat-voice reply, and classifies it as `social`, `answer`, or `work`. Social and answer activations reply and stop. Real work replies first, then launches a fresh Herdr/Pi worktree in the resolved project. The worker sends private progress and final receipts; the gateway projects them into the source thread, adds `:white_check_mark:` after the final result, then releases the pane and worktree.

The gateway rewrites worker receipts instead of pasting them. Lead with the outcome, explain the cause in plain language, retain only useful technical receipts, and finish with the next action or unresolved risk. Use short Slack paragraphs, flat bullets, `*bold*`, inline code, and `<url|label>` links. Do not use Markdown headings, tables, nested bullet soup, or wall-of-text chronology. Default final results to 1,200 characters and progress updates to 320 characters. Sound like ShitRat: terse, technical, skeptical, ELI5 without deleting the truth.

This trigger does not require a Task Grant, Reply Grant, or separate Joel approval. An unmapped channel fails closed and receives a binding-needed reply. The gateway never guesses a repository.

## Approval-bound replies

Outside the ShitRat work trigger, a channel reply requires Joel to approve the exact text.

Start with a preview:

```bash
jc-slack reply '<message-permalink>' --text-file <path>
```

The preview returns an approval-bound confirmation command. Run that exact command only after Joel approves the exact reply text. The CLI delegates delivery to the single gateway transport and returns a delivery receipt.

Outside the exact ShitRat trigger, do not bypass this flow with a user token, raw `chat.postMessage`, or a second Slack listener. The gateway's typed ShitRat delivery boundary is the only personal-token exception.

## Passive intelligence

Configured important channels can feed non-bot messages into the private indexing and relay pipeline. Passive messages can be indexed, batched, or escalated. They do not grant permission to reply.

Runtime configuration and exact channel bindings live outside this public repository. The local runtime overlay may include private IDs and channel names, but those values must not flow back into commits, tests, docs, screenshots, or published artifacts.

## Backfill

The host worker owns Slack history backfills because it can lease local credentials. Backfills paginate channel history, expand active threads, and write private search records. Do not move this work to a cluster worker until credential leasing has a cluster-safe adapter.

Relevant events:

- `channel/slack.backfill.requested`
- `channel/slack.backfill.batch.requested`
- `channel/message.received`
- `slack.signal.received`

## Public fixtures

Tests and examples must use fictional values:

- channel: `lc-example-project`
- channel ID: `CEXAMPLE`
- actor: `UTEAMMATE`
- repository: `/tmp/example-project`

Never paste production Slack values into public fixtures.

## Related code

- `packages/gateway/src/slack-work-request.ts`
- `packages/gateway/src/chat-sdk-inbound/`
- `packages/gateway/src/gateway-decision-executor.ts`
- `packages/cli/src/commands/messages.ts`
- `skills/slack-link/SKILL.md`

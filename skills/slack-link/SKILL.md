---
name: slack-link
displayName: Slack Link Context
description: Fetch Slack message context. Use immediately whenever Joel pastes a Slack message permalink (`*.slack.com/archives/<channel>/p<timestamp>`), drops a bare Slack link, or asks what a Slack link says. The first action is always `jc-slack context '<url>'`.
version: 0.1.0
author: joel
tags:
  - slack
  - permalink
  - context
---

# Slack Link Context

A Slack message permalink in Joel's prompt is executable context.

## Procedure

1. Run this before reasoning, summarizing, or asking questions:

   ```bash
   jc-slack context '<permalink>'
   ```

2. Use the returned bounded JSON as the source.
3. If Joel pasted only the link, report the message, useful thread context, and likely request.
4. If the message contains a work request, follow Joel's prompt and fleet work-tagging rules.

## Rules

- Do not ask Joel to paste the Slack text.
- Do not open Slack in a browser.
- Do not call Slack with `curl`.
- Do not lease or print a Slack token. `jc-slack` owns authentication.
- `jc-slack context` is read-only. Do not react or post unless Joel's request or fleet rules require it.
- If `jc-slack` is absent or cannot run, report that exact capability gap. Do not call the link unreadable.

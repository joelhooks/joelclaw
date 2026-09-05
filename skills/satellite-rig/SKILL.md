---
name: satellite-rig
displayName: Satellite Rig
description: "Set up and repair thin joelclaw satellite Machines such as blaine/Dark-Tower. Use when adding joelclaw CLI, Typesense access, session search/capture, Central relay, or satellite health on non-Panda machines. Triggers: satellite, blaine, Dark-Tower, setup joelclaw on another machine, Typesense access on satellite, joelclaw satellite health."
version: 0.1.0
author: joel
tags:
  - joelclaw
  - satellite
  - typesense
  - sessions
  - ssh
  - ops
disable-model-invocation: true
---

# Satellite setup and repair

A satellite is a thin client of configured Central services. It owns local connectors, capture/outbox durability, credentials, and backup freshness; it does not gain a duplicate gateway or cluster merely because it needs access.

Read the current topology/placement contract and verify source and target identities. Discover Central URLs from the endpoint resolver and current manifests, not old host examples. Use the repository’s satellite bootstrap/repair installer after inspecting its live help and planned changes.

Verify remote reachability, CLI availability in a non-interactive shell, configured endpoint health, capture admission, outbox progress, and backup receipts. Keep transcript contents behind the scoped session evidence contract. An absent index is not permission to scrape native transcripts.

Use the approved auth mechanism. Do not copy another machine’s agent auth files, expose secrets in shell output, or overwrite dotfiles without inspecting them. Preserve intentional skill deletions, existing links, and unrelated work; repair only identified installer-owned damage.

A diagnosis request produces evidence. An explicit setup or repair request authorizes scoped fixes and verification. Sending a repair notification or live canary still needs its destination/content authorization. Stop on an unexpected target or destructive diff and report the precise unresolved choice.

Report the actual host role, changed configuration paths, readiness and capture receipts, and remaining failure. Keep private topology in private reports.

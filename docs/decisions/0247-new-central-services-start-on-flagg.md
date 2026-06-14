---
status: accepted
date: 2026-06-13
decision-makers:
  - Joel Hooks
project_thread_url: https://eggheadio.slack.com/archives/C09LKT871PE/p1781360738642719
related:
  - 0245-project-threads-operator-workrooms
  - ../../docs/runbooks/flagg-gate5-staged-migration.md
  - ../../../vault/docs/decisions/0246-mac-studio-central-runtime-migration.md
---

# ADR-0247: New Central-owned services start on Flagg

While Panda remains the current Central for legacy joelclaw runtime, new Central-owned services should be born on Flagg under the `joelclaw` service identity and launchd/reboot contract. This prevents new work from deepening Panda's dev-account-as-infrastructure debt while preserving the no-split-brain rule from the Mac Studio migration: any flagg-hosted pre-cutover service must have explicitly scoped authority, explicit routing, reversible state, and documented canary evidence.

## Considered options

- **Start new services on Panda until whole-Central cutover** — rejected because it adds fresh debt to the host we are trying to retire as Central.
- **Treat Flagg as active peer Central immediately** — rejected because joelclaw still has one logical Central; Panda and Flagg must not share long-lived authoritative ownership.
- **Start new Central-owned services on Flagg with scoped authority** — accepted because it lets new work use the target service account and reboot contract without pretending the whole Central cutover has shipped.

## 2026-06-13/14 Rhizomatic canary application

The first scoped service using this decision is now `com.joelclaw.chorus-rhizomatic`: Myk Bilokonsky's upstream `mbilokonsky/rhizomatic` Chorus HTTP MCP server running on Flagg under the `joelclaw` service identity. It binds to loopback `127.0.0.1:4821` and stores signed Chorus deltas at `/Users/Shared/joelclaw/services/rhizomatic/chorus-memory.jsonl`. The public `joelhooks/pi-rhizomatic` package is a runtime adapter, not a copied implementation of Myk's substrate.

Evidence: `chorus-adapter-20260614T041223Z-{blaine,flagg,panda}` proved Blaine, Flagg, and Panda can each use Pi/Claude/Codex-style canary calls through the adapter against the same Chorus store. Blaine and Panda reach the service through launchd SSH tunnels from local `127.0.0.1:7331` to Flagg `127.0.0.1:4821`; Flagg clients call `127.0.0.1:4821/mcp` directly. The earlier fake reference service `com.joelclaw.rhizomatic` is disabled and retained only as dev/canary scaffolding until removed.

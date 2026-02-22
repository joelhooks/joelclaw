---
status: accepted
date: 2026-02-21
decision-makers: joel
---

# ADR-0085: Data-Driven Network Page via Convex

## Context

The `/network` page on joelclaw.com is hardcoded — every pod, daemon, function count, and node description is a TypeScript array literal. Adding a service or updating a count requires a code change and Vercel deploy. This is at odds with the system's event-driven architecture where infrastructure state is already observable.

## Decision

Make the network page fully data-driven from Convex using the existing `contentResources` table (ADR-0084). A dedicated Inngest function collects live infrastructure state and pushes it to Convex. The page renders as a fully cached static server component.

### Data Model

Uses `contentResources` with these types:

- **`network_node`** — machines on the tailnet. Fields: `publicName` (Stephen King universe), `privateName` (actual Tailscale hostname), `status`, `specs`, `role`, `services[]`
- **`network_pod`** — k8s pods. Fields: `publicName`, `privateName`, `status`, `namespace`, `description`, `restarts`, `age`
- **`network_daemon`** — launchd services. Fields: `publicName`, `privateName`, `status`, `description`
- **`network_cluster`** — cluster-level stats. Fields: `key`, `value` (e.g., "Functions" → "66", "Skills" → "65")
- **`network_stack`** — architecture layer descriptions. Fields: `layer`, `label`, `description`

ResourceId scheme: `node:{publicName}`, `pod:{name}`, `daemon:{name}`, `cluster:{key}`, `stack:{layer}`

### Public/Private Names

Every node has a `publicName` (Stephen King universe name shown on the page) and a `privateName` (actual hostname, only visible to authenticated owner). The King naming convention:

| Public | Private | Reference |
|--------|---------|-----------|
| Overlook | panda | The Shining — hotel that watches |
| Blaine | clanker-001 | Dark Tower — the mono that asks riddles |
| Derry | three-body | IT — where things are buried |
| Flagg | dark-wizard | The Stand/Dark Tower — the walking man |
| Todash | nightmare-router | Dark Tower — darkness between worlds |

### Update Mechanism

1. `check-system-health` Inngest function (existing, runs on cron) emits `system/network.update` event
2. New `network-status-update` Inngest function handles the event
3. Uses a pi agent with sonnet4-6 model to: run `kubectl get pods`, `launchctl list`, `tailscale status`, count Inngest functions/skills, then push structured results to Convex via `pushContentResource()`
4. The agent is prompted about the King naming convention so it maps hostnames correctly

### Page Rendering

The `/network` page becomes a React Server Component with full static caching:
- Reads from Convex via `ConvexHttpClient` at build/request time
- Cached aggressively — revalidated when the Inngest function runs (via on-demand revalidation or time-based)
- Status indicators (green/yellow/red dots) reflect actual pod/daemon state from last update
- No `useQuery`, no client-side JavaScript for data fetching

## Consequences

- Network page always reflects actual infrastructure state
- No deploy needed when services change
- Agent can write/update node descriptions, not just status
- King name mapping lives in Convex data, not source code
- Slightly more complex than hardcoded arrays, but fits the contentResources pattern already in use

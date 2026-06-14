---
project_thread_url: https://eggheadio.slack.com/archives/C09LKT871PE/p1781360738642719
status: canary-complete
related:
  - docs/decisions/0247-new-central-services-start-on-flagg.md
  - CONTEXT.md
---

# PRD: Rhizomatic Network Canary v1

Build a public `joelhooks/pi-rhizomatic` package and a Flagg-hosted memory canary proving Pi, Claude, and Codex can all use the same Rhizomatic/Chorus store through runtime-native surfaces.

## Current shape

`joelhooks/pi-rhizomatic` is now a runtime adapter. It credits Myk Bilokonsky's upstream `mbilokonsky/rhizomatic` work and does not vendor Myk's code, spec text, vectors, or Chorus implementation.

The real backend path for joelclaw is Myk's Chorus HTTP MCP server:

- upstream checkout: `/Users/Shared/joelclaw/upstream/rhizomatic`
- launchd service: `com.joelclaw.chorus-rhizomatic`
- service identity: `joelclaw:staff`
- endpoint on Flagg: `127.0.0.1:4821/mcp`
- store: `/Users/Shared/joelclaw/services/rhizomatic/chorus-memory.jsonl`
- clients on Blaine/Panda: launchd SSH tunnel from local `127.0.0.1:7331` to Flagg `127.0.0.1:4821`
- Flagg clients: direct `127.0.0.1:4821/mcp`

The earlier `packages/rhizomatic-service` fake reference service proved launchd mechanics, but it is no longer the active canary backend. `com.joelclaw.rhizomatic` is disabled on Flagg; the public package keeps its local reference service only for local/dev canaries.

## Success criteria

- Public package identity: `joelhooks/pi-rhizomatic`.
- Public package credits and links Myk's upstream Rhizomatic/Chorus work.
- Public package does not contain Flagg/Panda/Blaine names, Joel tailnet topology, service-account paths, Slack IDs, or private context.
- Package ships a native Pi extension with `rhizomatic_*` tools.
- Package ships generic Claude and Codex hook helpers.
- Package supports `backend: "chorus-http"` for Myk's Chorus HTTP MCP server.
- Package keeps a local reference HTTP service for non-joelclaw dev/canary use only.
- Flagg runs upstream Chorus under launchd with a private token and persistent store.
- Blaine, Flagg, and Panda all pass a Pi/Claude/Codex-style canary against the same Chorus store.

## Evidence

Public package repo:

- `https://github.com/joelhooks/pi-rhizomatic`
- current `main`: `a09a7473f13d914e516d64ed65db43e49f5e6243`
- ShitRat commit: `feat: adapt client to Chorus HTTP backend`

Package validation:

```bash
cd ~/Code/joelhooks/pi-rhizomatic
npm run check
npm run pack:dry
```

Flagg service proof:

```text
com.joelclaw.chorus-rhizomatic = running
127.0.0.1:4821 LISTEN
/Users/Shared/joelclaw/services/rhizomatic/chorus-memory.jsonl = signed Chorus JSONL deltas
```

Adapter health checks:

```json
{"ok":true,"service":"chorus-mcp-http","backend":"chorus-http","endpoint":"http://127.0.0.1:7331/mcp"}
{"ok":true,"service":"chorus-mcp-http","backend":"chorus-http","endpoint":"http://127.0.0.1:4821/mcp"}
{"ok":true,"service":"chorus-mcp-http","backend":"chorus-http","endpoint":"http://127.0.0.1:7331/mcp"}
```

Network canary labels:

```text
chorus-adapter-20260614T041223Z-blaine
chorus-adapter-20260614T041223Z-flagg
chorus-adapter-20260614T041223Z-panda
```

Each returned:

```json
{
  "ok": true,
  "recallProof": { "pi": 6, "claude": 6, "codex": 6 }
}
```

Runtime hook probes on Blaine, Flagg, and Panda returned `chorus-mcp-http-adapter` receipts for begin/stop.

## Follow-up hardening

- Wire gateway/system-bus/k8s/restate worker runtimes to the same adapter if they should participate in memory.
- Add reboot proof for `com.joelclaw.chorus-rhizomatic` and the Blaine/Panda tunnel LaunchAgents.
- Replace ad hoc install scripts with a repo-tracked installer/runbook.
- Revisit once Myk adds federation; this adapter should prefer upstream federation instead of inventing a parallel protocol.

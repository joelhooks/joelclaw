# JoelClaw Capabilities Map (AF30-002)

Canonical discoverability surface for agent workflows.

Source of truth command:

```bash
joelclaw capabilities
```

## Flows

| Flow ID | Category | Goal |
|---|---|---|
| `system-health` | operations | Determine whether joelclaw is healthy now |
| `operator-signals` | operations | Lease credentials, write structured logs, and notify gateway |
| `run-failure-triage` | diagnostics | Diagnose failed runs and identify next repair step |
| `deterministic-recovery` | diagnostics | Apply dry-run-first deterministic runbooks for known error codes |
| `event-delivery` | operations | Send an event and verify function-run delivery |
| `gateway-operations` | gateway | Operate the always-on gateway session |
| `memory-health` | memory | Verify memory pipeline quality and retrieval behavior |
| `otel-observability` | diagnostics | Diagnose incidents from OTEL without pod logs |
| `loop-lifecycle` | automation | Start/monitor/manage autonomous coding loops |
| `search-and-vault` | memory | Locate canonical context across search + vault |

## Contract notes

- Output is JSON envelope (`ok`, `command`, `result`, `next_actions`).
- `next_actions` commands use template syntax (`<required>`, `[--flag <value>]`).
- `params` entries provide pre-filled values/defaults/enums.
- Catalog includes `capabilityContract` metadata: configured capability adapters, config paths, and registry entries.
- Capability config precedence: flags > env > project `.joelclaw/config.toml` > user `~/.joelclaw/config.toml` > defaults.
- This map is documentation; runtime discoverability must come from `joelclaw capabilities`.

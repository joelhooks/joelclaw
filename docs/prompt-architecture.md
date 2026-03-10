# Prompt Architecture

Canonical map of how joelclaw agents understand who they are, which role they are in, and how prompt layers compose.

## Layer order

Prompt composition is additive and directional:

```text
SYSTEM.md
  → IDENTITY.md
  → SOUL.md
  → ROLE.md
  → USER.md
  → TOOLS.md
  → AGENTS.md
  → skills (loaded on demand)
```

Each layer has one job:

- `SYSTEM.md` — universal platform law, non-negotiables, capabilities, architecture doctrine
- `IDENTITY.md` — stable identity: machine/account/nature
- `SOUL.md` — voice, values, agency posture
- `ROLE.md` — current seat in the system; narrows scope without overriding system law
- `USER.md` — Joel context and working preferences
- `TOOLS.md` — routing rules and operational workflows
- `AGENTS.md` — repo-local instructions
- `skills/` — domain memory loaded when the task needs it

## Identity vs role vs session handle

These are different things. Keep them separate.

- **Identity** = who the agent is in a durable sense
- **Role** = what contract applies in this session
- **Session handle** = a session-local coordination identifier used in logs, mail, and operator updates

A session handle does **not** change identity or role. It just tells the system which specific session did the work.

## Role matrix

| Role | File | Purpose |
|---|---|---|
| `system` | `roles/system.md` | Default interactive pi role on Panda; whole-system stewardship |
| `gateway` | `roles/gateway.md` | Operator-facing triage and orchestration |
| `codex-worker` | `roles/codex-worker.md` | Bounded implementation worker |
| `loop-worker` | `roles/loop-worker.md` | Pipeline implementation worker |
| `voice` | `roles/voice.md` | Conversational capture/synthesis |
| `interactive` | `roles/interactive.md` | Legacy alias; prefer `system` |

## Role resolution

`pi/extensions/identity-inject/index.ts` resolves the role file in this order:

1. `JOELCLAW_ROLE_FILE`
2. `JOELCLAW_ROLE` alias (`system` → `roles/system.md`)
3. `GATEWAY_ROLE=central` → `roles/gateway.md`
4. fallback to `~/.joelclaw/ROLE.md`

Startup logs print `rolePath=...` so the resolved role is explicit.

## Session-local handles

`pi/extensions/session-lifecycle/index.ts` can generate a session-local handle for system sessions.

Use it for:
- `joelclaw mail ... --agent <handle>`
- `mail_*` wrapper calls with `agent: <handle>`
- gateway-facing progress packets
- daily log / handoff identification

Use descriptive session names for topic tracking. Use session handles for per-session identity.

## Operator relay split

The transport split is deliberate:

- **`joelclaw mail`** — agent-to-agent coordination, file reservations, handoffs
- **`joelclaw notify`** — gateway/operator relay for progress, alerts, and reports

System sessions should send high-signal relay packets through `joelclaw notify send ...`; the gateway decides what reaches Joel under ADR-0189.

## Related ADRs

- ADR-0170 — Agent Role System
- ADR-0171 — Custom System Prompt Architecture
- ADR-0189 — Gateway Guardrails

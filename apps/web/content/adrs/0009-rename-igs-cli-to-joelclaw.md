---
status: "proposed"
date: 2026-02-14
decision-makers: "Joel Hooks"
consulted: "Claude (pi session 2026-02-14)"
---

# 9. Rename `igs` CLI to `joelclaw`

## Context

The system currently uses `igs` (Inngest CLI for agents) as the primary CLI for interacting with the event bus, workflows, and system operations. With the project now branded as **JoelClaw** ("My Bespoke OpenClaw-inspired Mac Mini"), `igs` is a generic internal name that doesn't match the project identity.

All CLI design follows the **cli-design skill** (`.agents/skills/cli-design/SKILL.md`): agent-first, JSON-only HATEOAS output, self-documenting command trees, context-protecting truncation, `{ ok, command, result, next_actions }` envelope.

OpenClaw uses `openclaw` as its CLI command. JoelClaw should follow the same pattern — the CLI is the primary interface to the system, and it should carry the project name.

`igs` is referenced in:
- `~/.pi/agent/skills/inngest/SKILL.md`
- `~/.pi/agent/skills/video-ingest/SKILL.md`
- `~/.pi/agent/skills/agent-loop/SKILL.md`
- `~/.pi/agent/skills/inngest-debug/SKILL.md`
- `~/Code/system-bus/` (source)
- System log entries
- ADR-0005, ADR-0007, ADR-0008

## Decision

Migrate the CLI from `igs` to `joelclaw` in three phases. Both commands work throughout the migration — nothing breaks at any point.

### Phase 1: Introduce `joelclaw` (both work, `igs` is primary)

- [ ] Build system-bus to emit both `joelclaw` and `igs` binaries (or symlink `joelclaw` → `igs`)
- [ ] Both commands are fully functional and identical
- [ ] All existing skills, ADRs, docs still reference `igs` — no updates yet
- [ ] Verify `joelclaw` works: `joelclaw send`, `joelclaw loop`, `joelclaw` health check

### Phase 2: Migrate references (both work, `joelclaw` becomes primary)

- [ ] Update skills to prefer `joelclaw`, mention `igs` as alias:
  - `~/.pi/agent/skills/video-ingest/SKILL.md`
  - `~/.pi/agent/skills/inngest/SKILL.md`
  - `~/.pi/agent/skills/agent-loop/SKILL.md`
  - `~/.pi/agent/skills/inngest-debug/SKILL.md`
- [ ] Update ADRs 0005, 0007, 0008 references
- [ ] New docs/skills use `joelclaw` exclusively
- [ ] `igs` still works — it's a symlink to `joelclaw`

### Phase 3: Deprecate `igs` (optional, no rush)

- [ ] `igs` prints a one-line deprecation notice before executing: `"igs is now joelclaw — this alias will keep working"`
- [ ] Remove `igs` references from skills (keep alias forever, just stop documenting it)
- [ ] Or just leave the symlink indefinitely — it costs nothing

### What stays the same (all phases)

- Inngest server, worker, event bus — no changes
- All event names (`pipeline/video.download`, etc.) — no changes
- `slog` CLI — separate tool, keeps its name
- Internal function names in system-bus TypeScript — no changes
- The `igs` command keeps working — symlink is permanent

## Scope Reference: OpenClaw CLI vs Current `igs`

OpenClaw's CLI has **41 top-level commands, ~200+ subcommands** covering: setup/onboard, gateway lifecycle, messaging across 10+ channels, model management (multi-provider auth, fallbacks, scanning), browser automation (30+ subcommands), multi-device node orchestration, memory/vector search, skill/plugin registry, cron scheduling, security audit, TUI, and more.

Current `igs` has **~4 commands**: health check, event send, coding loop, log tail.

### Projected `joelclaw` CLI growth path (not a commitment, just a map)

| Phase | Commands | Maps to OpenClaw |
|-------|----------|-----------------|
| **Now** | `send`, `loop`, health check | `system event`, custom |
| **Near** | `status`, `health`, `logs`, `memory search` | `status`, `health`, `logs`, `memory` |
| **Medium** | `skills`, `config`, `doctor` | `skills`, `config`, `doctor` |
| **Later** | `agent`, `message`, `gateway` | `agent`, `message`, `gateway` |
| **Maybe** | `browser`, `nodes`, `channels` | Only if needed |

The goal is NOT to reimplement OpenClaw's CLI. It's to grow `joelclaw` organically as features are built, using OpenClaw's command structure as a reference for naming and conventions where it makes sense.

## Non-goals

- Not reimplementing OpenClaw's full CLI — grow organically as needed
- Not renaming the `system-bus` repo or worker process
- Not changing the Inngest event API or function signatures
- Not breaking anything at any point — both commands coexist

# Agent Instructions

## Model Policy

- Codex tasks MUST use `gpt-5.3-codex`.
- If model is unspecified, set `model: "gpt-5.3-codex"`.

## Current System Snapshot

- Primary repo: `~/Code/joelhooks/joelclaw`
- Vault (source of truth): `~/Vault`
- Decision records: `~/Vault/docs/decisions/`
- System log JSONL: `~/Vault/system/system-log.jsonl`
- Repo skills (authoritative): `~/Code/joelhooks/joelclaw/skills`
- Skill links (consumers): `~/.agents/skills`, `~/.pi/agent/skills`, `~/.claude/skills`

Operational architecture (current):
- Event/workflow core: Inngest + system-bus worker
- **Inference routing: `@joelclaw/inference-router` (ADR-0140)** — canonical model selection for ALL LLM calls. Catalog-based provider resolution, Langfuse tracing, fallback chains. Gateway uses it for model resolution. Never hardcode model→provider mappings — use the catalog.
- Gateway: Redis-backed event bridge + consumer channels (Telegram, Slack, Discord, iMessage). Hexagonal architecture (ADR-0144) with extracted packages: `@joelclaw/model-fallback`, `@joelclaw/message-store`, `@joelclaw/vault-reader`, `@joelclaw/markdown-formatter`.
- Observability: OTEL-style events -> Typesense (`otel_events`) + Convex/UI surfaces
- Web: joelclaw.com in `apps/web`, including `/system` and `/system/events`

## Hexagonal Architecture (ADR-0144) — MANDATORY

The monorepo uses **ports and adapters**. Heavy logic lives in standalone `@joelclaw/*` packages behind interfaces. The gateway (and other consumers) are thin composition roots that wire adapters together. **Never embed heavy logic directly in a consumer.**

### Package Map
| Package | Port Interface | What It Does |
|---------|---------------|--------------|
| `@joelclaw/inference-router` | `routeInference()`, catalog | Model selection for ALL LLM calls |
| `@joelclaw/model-fallback` | `FallbackController` | Provider fallback chains |
| `@joelclaw/message-store` | `persist()`, `drainByPriority()` | Redis-backed message queue + priority |
| `@joelclaw/vault-reader` | `enrichPromptWithVaultContext()` | Vault file search + context injection |
| `@joelclaw/markdown-formatter` | `FormatConverter` | AST-based per-platform formatting |
| `@joelclaw/telemetry` | `TelemetryEmitter` | Single OTEL emission interface |

### Few-Shot: How to Use These

**✅ Correct — import from package:**
```typescript
import { emitGatewayOtel } from "@joelclaw/telemetry";
import { persist, drainByPriority } from "@joelclaw/message-store";
import { TelegramConverter } from "@joelclaw/markdown-formatter";
```

**❌ Wrong — reach into another package's internals:**
```typescript
import { emitGatewayOtel } from "../observability";        // DELETED
import { persist } from "../../message-store/src/store";    // NEVER
import { mdToTelegramHtml } from "../channels/telegram";    // internal
```

**✅ Correct — DI via interface:**
```typescript
import type { TelemetryEmitter } from "@joelclaw/telemetry";
function init(redis: Redis, telemetry?: TelemetryEmitter) { ... }
```

**❌ Wrong — hardcode dependency:**
```typescript
import { emitGatewayOtel } from "@joelclaw/telemetry";
// Don't call emitGatewayOtel directly in a library package.
// Accept TelemetryEmitter interface, let the consumer inject.
```

### Channel Interface
Consumer channels (Telegram, Slack, Discord, iMessage) implement `Channel` from `packages/gateway/src/channels/types.ts`. Redis is an `EventBridge` port — separate concern, not a Channel.

### Rules
- **New heavy logic → new package.** If it's >100 lines and reusable, extract it.
- **Import via `@joelclaw/*`**, never via relative paths across package boundaries.
- **DI via interfaces** in library packages. Only composition roots (gateway, CLI) do concrete wiring.
- **One telemetry interface.** All packages use `TelemetryEmitter` from `@joelclaw/telemetry`.
- **One model resolver.** All model selection goes through `@joelclaw/inference-router` catalog.

### Biome Enforcement — DO NOT BYPASS
`biome.json` at repo root enforces package boundaries via `noRestrictedImports`. Relative imports to extracted modules (observability, model-fallback, message-store, vault-read) are **errors** — you must use `@joelclaw/*` packages instead.

**Why this exists:** Agents write 90% of the code. Without automated enforcement, cross-package boundary violations creep back in within days. Biome catches violations at the exact moment they happen, with the file path, line number, and a message pointing to the correct package + ADR. This is the architectural immune system.

**After any code change, run:**
```bash
pnpm biome check packages/ apps/
```

If Biome reports `noRestrictedImports` errors, **fix the imports** — do not suppress, do not add `biome-ignore`, do not remove the rule. The error message tells you exactly which `@joelclaw/*` package to import from instead.

**Codex/loop prompts must include**: `Validation: pnpm biome check packages/ apps/` alongside the usual `bunx tsc --noEmit`.

## Core Rules

1. Use CLI surfaces first (not plumbing)
- Prefer `joelclaw` and `slog` over raw `launchctl`, `curl`, direct Redis edits, or ad hoc log greps.
- Only drop to plumbing when CLI lacks required capability.

2. Observability is mandatory
- Silent failures are bugs.
- Emit or preserve structured telemetry for pipeline/function/service work.
- Verify behavior with `joelclaw otel list|search|stats` and relevant status commands.

3. Log system changes
- For installs/config mutations/ops changes, append a `slog` entry.
- Example:
```bash
slog write --action configure --tool gateway --detail "rotated webhook secret lease" --reason "signature failures"
```

4. Keep skills current with the system
- When operational reality changes, update skills in `~/Code/joelhooks/joelclaw/skills`.
- Maintain Codex desktop metadata on every repo skill:
  - `agents/openai.yaml`
  - `assets/small-logo.svg`
  - `assets/large-logo.png`
  - SKILL frontmatter: `name`, `displayName`, `description`, `version`, `author`, `tags`

5. Treat repo skills as source, home dirs as links
- Repo skill directories are canonical.
- `~/.agents/skills`, `~/.pi/agent/skills`, `~/.claude/skills` should symlink out to repo skills.
- External/third-party skill packs should remain external (system/global install), not copied into repo unless intentionally curated.

6. Prefer safe git workflows
- Do not use destructive commands (`git reset --hard`, force-checkout) unless explicitly requested.
- Never discard user changes without consent.

8. Always include links
- When referencing files, repos, PRs, runs, docs, URLs, or any addressable resource, include the link.
- Links provide context and save the reader a lookup. No bare references when a URL exists.

9. Use pi sessions for LLM inference
- System-bus functions that need LLM calls MUST shell to `pi -p --no-session --no-extensions`.
- Pi handles auth, token refresh, provider routing — zero config, zero API cost.
- Do NOT use OpenRouter, do NOT read auth.json directly, do NOT use paid API keys.
- Use the shared utility: `import { infer } from "../../lib/inference"` (`packages/system-bus/src/lib/inference.ts`).
- Existing patterns: `reflect.ts`, `vip-email-received.ts`, `email-cleanup.ts`, `batch-review.ts`.

## Standard Operational Commands

Health and status:
```bash
joelclaw status
joelclaw inngest status
joelclaw gateway status
```

Worker/registration lifecycle:
```bash
joelclaw inngest sync-worker --restart
joelclaw refresh
```

Gateway operations:
```bash
joelclaw gateway events
joelclaw gateway test
joelclaw gateway restart
joelclaw gateway stream
```

Observability:
```bash
joelclaw otel list --hours 1
joelclaw otel search "<query>" --hours 24
joelclaw otel stats --hours 24
```

Runs and triage:
```bash
joelclaw runs --count 10 --hours 24
joelclaw run <run-id>
joelclaw logs worker --lines 80
joelclaw logs errors --lines 120
```

## Efficient Prompting

Use this format for high-signal requests:

```md
Goal: <single concrete outcome>
Context: <repo/path/runtime facts>
Constraints: <time/risk/tool limits>
Do:
- <task 1>
- <task 2>
Deliver:
- <exact artifact paths>
- <verification commands + expected signals>
```

Prompting heuristics:
- State exact paths and systems (`apps/web`, `packages/system-bus`, `skills/<name>`).
- Request executable verification, not just code changes.
- Ask for diffs plus brief risk notes when touching infra or workflows.
- For operational work, ask for rollback or recovery command.
- Prefer “do it now + validate” over brainstorming when implementation is intended.

Fast iteration pattern:
1. Ask for a short plan.
2. Ask to execute immediately.
3. Require verification output summary.
4. Decide next step from findings.

## Output Contract (for agents)

When returning results:
- Lead with what changed.
- List touched absolute paths.
- Include validation commands run and key outcomes.
- Note blockers explicitly.
- Suggest the smallest meaningful next actions.

## ADR and Vault Discipline

When architecture/behavior changes:
- Update or add ADRs in `~/Vault/docs/decisions/`.
- Keep project status in Vault current.
- Keep this AGENTS file aligned with reality.

## Notes

- `skills/` in the joelclaw repo is **sacred and fully tracked**. Every custom skill must be committed. Never gitignore this directory.
- If command contracts change in `packages/cli`, update dependent skills the same session.

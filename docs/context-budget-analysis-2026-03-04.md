# Context Budget Analysis — 2026-03-04

## Problem

Pi sessions are hitting frequent, long compactions. A single 8-hour session
(2026-03-03) logged **42 compactions** across 3,472 assistant messages — roughly
one compaction every 80 turns. This degrades session quality because each
compaction loses conversation detail.

## Measured Reality

### First-turn input: 35,352 tokens

That's the system prompt alone — before any conversation. Measured from session
`2026-03-03T15-42-42-262Z` turn 1 usage: `input=35,352 output=1,056 cacheRead=0 total=36,408`.

### Context growth pattern

Heavy tool use (file reads, bash commands) fills available context in ~80 turns:

| Turns | Typical total tokens | Notes |
|-------|---------------------|-------|
| 1 | ~35K | System prompt only |
| 80 | ~150-170K | Approaching limit |
| ~83 | compaction | Resets to ~55-65K |

### Compaction settings (from `~/.pi/agent/settings.json`)

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 40000,
    "keepRecentTokens": 20000
  }
}
```

### Effective context budget

```
200K  total Claude context window
-35K  system prompt (resent every turn, never compacted)
-40K  reserveTokens (compaction fires when this much headroom remains)
-20K  keepRecentTokens (preserved after compaction)
─────
105K  available for actual conversation before compaction triggers
```

With heavy tool use generating 1-5K tokens per exchange, 105K fills in ~80 turns.

---

## System Prompt Breakdown (~35K tokens)

### Components injected every turn

| Component | Source | Bytes | Est. Tokens |
|-----------|--------|-------|------------|
| SYSTEM.md (base prompt) | `~/.pi/agent/SYSTEM.md` | 14,819 | ~3,700 |
| Identity files (5 files) | identity-inject extension | 11,599 | ~2,900 |
| AGENTS.md | Pi auto-injects per directory | 12,318 | ~3,100 |
| MEMORY_NUDGE | memory-enforcer extension | ~640 | ~160 |
| `<available_skills>` block | Pi skill discovery (141 skills) | ~85,000 | ~21,000 |
| Tool descriptions (~20+ registered tools) | Extensions register tools | ~16,000 | ~4,000 |
| **Total** | | **~140KB** | **~35,000** |

### The killer: 141 skills = ~21K tokens (60% of system prompt)

Pi discovers skills from `~/.pi/agent/skills/` (141 entries). Each entry in the
`<available_skills>` XML block includes name, full description (up to 1024 chars),
and file path. This block is ~85KB and dominates the system prompt.

Pi DOES deduplicate skills:
- By **name**: first discovered wins, later collisions are logged as diagnostics
- By **realpath**: symlinks are resolved, so `~/.pi/agent/skills/gateway → joelclaw/skills/gateway`
  and `~/.agents/skills/gateway → joelclaw/skills/gateway` would only load once

The 141 in `~/.pi/agent/skills/` is the actual discovery count, not 303 (which
was a double-count from also listing `~/.agents/skills/`).

### Identity files injected per-turn by identity-inject

| File | Bytes |
|------|-------|
| IDENTITY.md | 1,012 |
| SOUL.md | 3,610 |
| ROLE.md | 2,337 |
| USER.md | 3,324 |
| TOOLS.md | 1,316 (capped at 6,000) |
| **Total** | **11,599** |

---

## Extension Inventory

### Two discovery locations

1. **`~/.pi/agent/extensions/`** (manually placed): agent-mail, identity-inject (symlink), inference-guard, inngest-monitor, langfuse-cost, memory-enforcer, model-guard
2. **`~/.pi/agent/git/github.com/joelhooks/pi-tools/`** (package auto-discover): bash-timeout, grind-mode, identity-inject (symlink), mcp-bridge, mcq, memory-enforcer, ralph-loop, repo-autopsy, session-reader, skill-shortcut, url-to-markdown, web-search, auto-update, ts-check, codex-exec

### Duplicate extension risk

| Extension | git/ | extensions/ | Same content? | Guard? |
|-----------|------|-------------|---------------|--------|
| identity-inject | symlink → joelclaw repo | symlink → joelclaw repo | YES (same target) | None |
| memory-enforcer | Old version (HTTP OTEL) | New version (CLI OTEL + knowledge + MEMORY_NUDGE) | NO — different | None |
| langfuse-cost | N/A | Wraps base from joelclaw repo | N/A | YES — `__langfuse_cost_loaded__` globalThis guard |

**Critical finding**: `memory-enforcer` exists in BOTH locations with **different content**.
The git/ version is simpler (HTTP-based OTEL, no MEMORY_NUDGE, no system_knowledge).
The extensions/ version is the current one (CLI OTEL, MEMORY_NUDGE injection, system_knowledge queries).

If both load (pi doesn't have dedup for hook-only extensions that don't register tools):
- `before_agent_start` fires twice → system prompt gets MEMORY_NUDGE appended twice
- `session_start` fires twice → `seedRecall()` runs twice
- `before_agent_start` system_knowledge fires twice → double CLI subprocess calls

Pi's conflict detection only catches duplicate **tool names** and **command names**.
Event hooks via `pi.on()` silently register regardless.

### MEMORY_NUDGE duplication with AGENTS.md

AGENTS.md line 201 already contains:
```
## Memory — Writing Observations (NON-OPTIONAL)
```

memory-enforcer extension also appends:
```
## Memory — Write Observations (NON-OPTIONAL)
```

Same instructions, slightly different wording. ~160 tokens wasted.

---

## Extension Behavior per Turn

### before_agent_start (fires every turn)

1. **identity-inject**: Reads 5 identity files from `~/.joelclaw/`, prepends to system prompt (~11.6KB)
2. **memory-enforcer**: Appends MEMORY_NUDGE to system prompt (~640 bytes)
3. **memory-enforcer**: Runs `joelclaw knowledge search` subprocess (async, doesn't inject result into prompt but adds latency)

### session_start (fires once)

1. **memory-enforcer**: Runs `joelclaw recall` subprocess
2. **langfuse-cost**: Initializes Langfuse trace
3. **inngest-monitor**: Sets up TUI widget

### message_end (fires per assistant message)

1. **langfuse-cost**: Traces generation to Langfuse with usage data
2. Various OTEL emissions from other extensions

---

## Recommendations (Priority Order)

### 1. IMMEDIATE: Prune the skills block (~21K → ~8K tokens)

141 skills is excessive. Many are narrow support-ticket skills that only matter
for the gateway role. Set `disable-model-invocation: true` in frontmatter for
skills that aren't relevant to interactive sessions:

- ~40 support ticket skills (access-locked-out, certificate-request, etc.)
- ~15 AI SDK / Next.js audit skills (rarely needed simultaneously)
- ~10 customer support skills (refund-request, payment-method-issue, etc.)

Target: ~50 active skills for interactive, full set for gateway.

### 2. IMMEDIATE: Remove duplicate memory-enforcer

Delete `~/.pi/agent/git/github.com/joelhooks/pi-tools/memory-enforcer/` —
the extensions/ version is the canonical one. Or vice versa, but only keep ONE.

### 3. IMMEDIATE: Remove duplicate identity-inject

Delete `~/.pi/agent/extensions/identity-inject` (symlink) since the git/ version
is identical. Or remove the git/ one. Only need one.

### 4. SHORT-TERM: Remove MEMORY_NUDGE from extension

It's already in AGENTS.md. The extension duplication adds ~160 tokens and
confusing near-duplicate instructions.

### 5. MEDIUM-TERM: Implement ADR-0165 taxonomy-based skill retrieval

Replace static `<available_skills>` injection with Typesense-backed retrieval.
Only inject 5-10 relevant skills per turn based on the user's message, not all 141.
This would reduce the skills block from ~21K tokens to ~1-2K tokens.

### 6. MEDIUM-TERM: Optimize identity file injection

Some content in IDENTITY.md + SOUL.md + USER.md + ROLE.md + TOOLS.md overlaps
with what's already in SYSTEM.md and AGENTS.md. Audit and deduplicate the
content across these files.

### 7. CONSIDER: Tune compaction settings

Current: `reserveTokens=40000, keepRecentTokens=20000`

Options:
- Reduce reserveTokens to 30K → gives 10K more conversation space
- Increase keepRecentTokens to 30K → preserves more context across compactions
- Both together → 10K net gain but tighter reserve margin

---

## Files Referenced

- `~/.pi/agent/SYSTEM.md` — base system prompt (14.8KB)
- `~/.joelclaw/IDENTITY.md` — agent identity (1KB)
- `~/.joelclaw/SOUL.md` — voice/values (3.6KB)
- `~/.joelclaw/ROLE.md` — system architect role (2.3KB)
- `~/.joelclaw/USER.md` — Joel's context (3.3KB)
- `~/.joelclaw/TOOLS.md` — tool routing notes (1.3KB)
- `~/Code/joelhooks/joelclaw/AGENTS.md` — project instructions (12.3KB)
- `~/.pi/agent/settings.json` — compaction config
- `~/.pi/agent/extensions/memory-enforcer/index.ts` — MEMORY_NUDGE injection
- `~/.pi/agent/extensions/identity-inject/` → symlink to joelclaw repo
- `~/.pi/agent/git/github.com/joelhooks/pi-tools/memory-enforcer/index.ts` — OLD version
- `~/.pi/agent/git/github.com/joelhooks/pi-tools/identity-inject/` → symlink to joelclaw repo
- `/Users/joel/.bun/install/cache/@mariozechner/pi-coding-agent@0.52.12@@@1/dist/core/skills.js` — pi skill loading source

## Session Data

The 42-compaction session: `~/.pi/agent/sessions/--Users-joel--/2026-03-03T15-42-42-262Z_2ecbbbc8-2523-4673-8a01-2d271c2f574d.jsonl` (23MB, 7,337 entries, 3,472 assistant messages)

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

### 5. MEDIUM-TERM: Dynamic skill retrieval — assessment

**ADR-0165 proposed** replacing static `<available_skills>` with Typesense-backed
per-turn retrieval. After reviewing pi's architecture, this is **compatible with
pi's design** but NOT how pi is designed to work natively.

**Pi's design philosophy** (from pi docs):
> "This is progressive disclosure: only descriptions are always in context, full
> instructions load on-demand."

Pi's model: list ALL skill descriptions in the prompt → agent uses `read` to load
the full SKILL.md when needed. The descriptions ARE the retrieval index — the LLM
does the matching. This is intentional: it's reliable, deterministic, and the model
can cross-reference multiple skill descriptions before choosing.

**Why we shouldn't fight this:**
- Pi rebuilds the system prompt via `buildSystemPrompt()` which takes `skills` array
  and calls `formatSkillsForPrompt()`. There's no hook to intercept/filter per-turn.
- `before_agent_start` can replace the systemPrompt, but you'd have to rebuild the
  ENTIRE prompt including tool descriptions, context files, everything — fragile.
- The `disable-model-invocation` frontmatter field IS pi's blessed mechanism for
  hiding skills from the prompt. This is the correct lever.

**Correct approach (working WITH pi):**
1. Use `disable-model-invocation: true` for specialist-only skills (**this session**)
2. Use specialist sub-agents that load domain skills explicitly
3. If we still have too many skills in the main prompt, prune further — not filter dynamically

**If we ever outgrow this:** Pi's `skills` setting accepts paths. We could write
a pre-session script that symlinks only relevant skills based on the working directory
or project context. Static, deterministic, no per-turn overhead.

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

## Specialist Sub-Agents (created 2026-03-04)

Skills that don't belong in the main interactive prompt are routed to specialist
sub-agents. These agents load ONLY their domain skills, keeping the main prompt lean.

| Agent | Skills | Purpose |
|-------|--------|---------|
| `support-triage` | 45 support ticket skills | Customer support classification & response drafting |
| `frontend-specialist` | 29 Next.js/React/animation/component skills | Frontend implementation & audits |
| `document-processor` | 4 document format skills (pdf, xlsx, pptx, docx) | File format creation/conversion |
| `content-specialist` | 8 writing/publishing skills | joelclaw.com content in Joel's voice |
| `sdk-specialist` | 8 AI SDK/Convex/TanStack skills | SDK integration work |
| `incident-responder` | 6 diagnostic skills | Production incident triage |

### Skill routing after specialists

**Remain in main prompt (~54 skills, ~8.8K tokens):**
Core operational skills that the System Architect role uses regularly:
- adr-skill, add-skill, agent-loop, agent-mail, clawmail, cli-design
- codex-prompting, discovery, docker-sandbox, gateway, gateway-diagnose, gateway-setup
- github-bot, gogcli, granola, gremlin, imsg, imsg-rpc
- inngest, inngest-durable-functions, inngest-events, inngest-flow-control,
  inngest-local, inngest-middleware, inngest-setup, inngest-steps
- joelclaw, joelclaw-system-check, joelclaw-web, k8s, koko, langfuse
- loop-nanny, memory-system, monitor, mux-video, o11y-logging
- pds, pdf-brain, pdf-brain-ingest, recall, skill-review
- sync-system-bus, system-architecture, system-bus, system-prompt
- talon, task-management, telegram, typesense, vault
- vercel-debug, video-ingest, webhooks, x-api
- email-triage, egghead-slack, contacts, person-dossier, roam-research

**Moved to specialists (`disable-model-invocation: true`):**
~87 skills across 6 specialist agents. Still discoverable via `/skill:name`
and loadable by the main agent if explicitly requested, but NOT listed in the
`<available_skills>` prompt block.

### Token budget after changes

```
Before:  141 skills in prompt → ~14,900 tokens
After:    54 skills in prompt →  ~8,800 tokens
Saved:                           ~6,100 tokens (41%)
```

Combined with other fixes (extension dedup, MEMORY_NUDGE cleanup):
```
Before: ~35,000 token system prompt
After:  ~28,500 token system prompt
Saved:  ~6,500 tokens → ~119K available for conversation (was ~105K)
```

## Action Items

### Done
- [x] Created 6 specialist sub-agents in `~/.pi/agents/`
- [x] Categorized all 141 skills into main-prompt vs specialist

### TODO
- [ ] Set `disable-model-invocation: true` on ~87 specialist-only skills
- [ ] Remove duplicate `memory-enforcer` from `~/.pi/agent/git/.../pi-tools/`
- [ ] Remove duplicate `identity-inject` from one of the two discovery paths
- [ ] Remove MEMORY_NUDGE section from AGENTS.md (keep in extension only)
- [ ] Symlink missing skills from `~/.agents/skills/` into `~/.pi/agent/skills/`
  for specialist discoverability (nextjs-*, shadcn-*, ai-sdk-*, etc.)
- [ ] Move pi-tools from git-install to symlink from joelclaw repo
- [ ] Move memory-enforcer canonical source to joelclaw repo, symlink to extensions/

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

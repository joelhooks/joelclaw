---
name: memory-system
displayName: Memory System
description: "Debug, maintain, and use the joelclaw memory system — observer capture/dreams, Brain .svx stores, neat-memory curation, Telegram delivery, reaction grading, wiki rendering. Load whenever work touches the memory system, the curator, dreams, observations, grading, or a memory surface misbehaves."
version: 1.0.0
author: joel
tags:
  - memory
  - observer
  - brain
  - neat-memory
  - wiki
---

# Memory System

The joelclaw memory system in one breath: sessions on flagg stream into
raw capture → the observer distills observation pages into the Brain →
dreams condense aging pages into rollups → the neat-memory curator judges
candidates and DMs Joel the best → Joel's emoji reaction grades the send →
grades feed the judge's history. The wiki renders every registered Brain
at `brain.joelclaw.com/<root>/<slug>/`.

**The living map with per-subsystem health verdicts:**
https://brain.joelclaw.com/joelclaw/resources/memory-system/ — read it
before deep debugging; regenerate it (fresh survey, not sentence patches)
after material changes. Effort trails:
`.brain/projects/memory-system-review/` (survey assets = the receipts)
and `.brain/projects/memory-system-repair/` (fixes + open decisions).

> **Memory retirement (2026-07-17).** Versions ≤0.1.0 of this skill described
> the retired stack — `memory_observations`, write gates, and reflect/promote
> into `MEMORY.md`. That collection was archived to NAS and dropped; its
> functions and MEM/FRIC suites were deleted. `joelclaw recall` kept its
> command name but now reads disposable Brain/observation projections. Do NOT
> follow old copies of this skill or write `memory/observation.submitted` events.

## Where everything lives

| Surface | Location |
|---|---|
| Observer dev repo | `~/Code/joelhooks/joelclaw-observer` (branchless, detached HEAD by design) |
| Observer release (what actually runs) | `~/.joelclaw/observer-release` |
| Promotion (the ONLY way to deploy observer) | `bin/promote-release.sh` — clean-tree gate, smoke checks, receipts to `/tmp/observer-release-promotion.log`; `--dry-run` first if unsure |
| Observation pages | `~/Code/joelhooks/dark-wizard/.brain/observations/` (condensed originals under `archive/YYYY-MM/`) |
| Retros (curator input; hook-fired Inngest event + condenser is being built) | `~/Code/joelhooks/dark-wizard/.brain/resources/retros/` |
| Curator state (0600, atomic writes only) | `~/.joelclaw/observer-neat-memories.json` |
| Observer cursor / session / family / pending | `~/.joelclaw/observer-*.json` |
| Dispatch rules (what wakes the observer) | `<observer repo>/dispatch-rules.json` — dispatcher re-reads per classify; no restart needed |
| Logs | `/tmp/observer-{tick,dream,neat-memory,self-maintenance,release-promotion}.log` |
| LaunchAgents | `com.joelclaw.observer-tick` (every 30 min), `com.joelclaw.observer-dream` (06:10), `com.joelclaw.observer-neat-memory` (16:15 — dead-man revive only) |
| Message journal fail-open spool | `~/.joelclaw/spool/message-journal/` |
| Run-capture outbox (watch its size) | `~/.joelclaw/outbox/` |
| Brain root registry | `~/Code/joelhooks/dark-wizard/brain-roots.json` |
| Wiki repo + build | `~/Code/joelhooks/joelclaw-wiki`; `bun run build` (includes `graph:build`; retry once on transient exit 1); 200-check exact URLs before sharing |
| Bus (Inngest) | `localhost:8288`, signing key in `~/.config/system-bus.env` |

## Debug recipes (symptom → first moves)

**"The curator went silent."** `joelclaw wake list --json` — is a
`neat-memory-beat` pending? Chain alive → read
`/tmp/observer-neat-memory.log` for the last verdict (holds are normal;
"beat pending; dead-man exits" means the daily LaunchAgent correctly
deferred). Chain dead → the 16:15 dead-man revives it, or run
`NEAT_MEMORY_TRIGGER=beat bash ~/.joelclaw/observer-release/bin/neat-memory.sh`.
Last output: `/tmp/observer-neat-memory-last.json` (can be stale — check
log lines first). Cancel pending beats (`joelclaw wake cancel <id>`)
before manual runs or you'll double-schedule.

**"A DM never arrived."** Messaging rides the canonical Chat SDK path
(since 2026-07-17). Machine-check visible delivery from the joelclaw
repo: `bun scripts/messaging-visible-delivery-canary.ts` — exit 0 requires
a confirmed journal row whose Telegram platform id matches. A
`notify.compat_v2.confirmed` OTEL event alone is NOT proof. Journal rows:
`~/.joelclaw/spool/message-journal/` (`origin_system_id` is a
`source:eventId` composite). Deeper: `skills/messaging/SKILL.md`.

**"A reaction didn't grade."** The pipe: `message/inbound.reaction` →
`message/reaction-bridge` → `message/reaction.received` →
`message/neat-memory-reaction-grade` → state-file `outcome`. Verify:
`jq --arg slug "<slug>" '.sent[] | select(.slug == $slug) | {slug, outcome}' ~/.joelclaw/observer-neat-memories.json`.
Mapping: 👍 ❤️ 🔥 💯 → `worked`; 👎 💩 → `did-not-work`; others ignored;
only Joel's reactions count. Entries without `flowId` fall back to a
two-minute timestamp match — safe only while sends are sparse.

**"The dream did nothing."** Read `/tmp/observer-dream.log`. Since the
2026-07-17 fix, `pagesRead` is the whole corpus and `capped:true` means
eligible work exceeded the nightly cap (fine, remainder waits) — not
blindness. `eligiblePages: 0` usually means the corpus is younger than
`minAgeDays` (7 for plain pages; rollups re-blur at 30/90 days). That is
patience, not breakage.

**"A Brain page isn't on the wiki."** In order: root registered in
`brain-roots.json`? File is `.svx` (the law — `.md` is dead to the
renderer)? Excluded (sections `captures`/`compaction-dumps`/`people`/
`private-family-health`, or `privacy: sensitive`)? Raw `{...}` in prose
outside code spans breaks the page at prerender — backtick-escape braces.
Then build on flagg and 200-check the exact URL. Relative `.svx` links
and `[[root/slug]]` wikilinks both compile to page URLs.

**"Is the observer even running?"** `launchctl list | grep joelclaw` —
tick/dream/neat-memory should show status 0. The self-maintenance check
(inside each tick) surfaces warnings in `/tmp/observer-tick.log`,
including release-drift (dev HEAD ≠ release HEAD).

**"Session capture / Typesense runs index is stale"** (ADR-0243): raw
truth is `~/.joelclaw/runs-dev/<user>/<yyyy-mm>/*.jsonl`; derived indexes
are `runs_dev`/`run_chunks_dev` via `memory/run.captured`. Verify raw vs
index timestamps separately; check Inngest queue health; backfill with
`bun scripts/backfill-run-typesense.ts --since <iso> --limit 0 --sleep-ms 250`
— never by flooding Inngest with replay events.

## Usage (getting things in and out)

- **Write memory**: `.svx` pages into a registered `.brain` tree —
  frontmatter `title` + `privacy` (`public`/`private` render; `sensitive`
  never renders and never reaches the curator). MDSvX-escape literal
  braces. All `.brain` prose is `.svx`, always.
- **Reach the curator**: candidates = observation + retro pages modified
  in the last 7 days with `privacy: public|private`, a title, and a
  non-empty body. Dedupe is forever — a sent slug never resends.
- **Teach the curator**: react to its DMs. The taste bench (2026-07-17)
  proved one grade changes nothing measurable; ~20–30 graded sends with
  both polarities is the dataset that could. Every 👍/👎 counts.
- **Query**: use Brain-backed `joelclaw recall` for broad retrieval,
  `joelclaw sessions search` for captured session history, and
  `joelclaw docs search` for books. Recall's Typesense collections are
  disposable projections; read the source Brain `.svx` before making a
  durable claim.

## Retired and parked surfaces (don't build on these)

- `memory_observations`, reflect/promote/proposal/batch-review functions,
  and the MEM/FRIC suites are retired and deleted from the live stack.
- The system-log JSONL / `slog` path is retired. Telemetry is OTel in
  Typesense/ClickHouse; durable receipts are Brain `.svx`.
- Claude auto-memory is a pointer index only: `MEMORY.md` may point into
  `~/.brain`, but must not grow topic pages or hold content.
- Chorus/Rhizomatic is parked: no session briefing injection and no real
  claims. Service shutdown still needs the steering sudo step. If claim
  graphs return, they return as a Brain-owned projection.

## Doctor

`joelclaw memory doctor` is chartered
(`.brain/projects/memory-system-repair/build-memory-doctor.svx`):
deterministic health checks with a JSON envelope — beat pending, state
freshness, outbox size/age, release drift, dream log, journal spool,
LaunchAgent status. Until it ships, the recipes above are the doctor.

# Specialist Sub-Agents

Specialist agents offload domain-specific skills from the main interactive prompt,
reducing system prompt size from ~35K to ~28.5K tokens. Each specialist loads only
its domain skills, keeping the main system role focused on core operational work.

## Why

The main pi prompt was listing 141 skills in `<available_skills>` — ~15K tokens of
descriptions for skills the interactive agent rarely needs. Support ticket skills,
Next.js audit checklists, document format handlers, and SDK reference skills were
all competing for context with the core operational skills.

By moving these to specialist sub-agents:
- Main prompt drops from 141 → ~54 skills (~6K token savings)
- Specialists get focused skill sets without noise
- Delegation is explicit: `@support-triage`, `@frontend-specialist`, etc.

## Agents

### support-triage
**45 skills** — Customer support for Skill Recordings / course-builder apps.

Handles: refunds, access issues, billing, team licenses, workshop logistics,
certificates, PPP pricing, student discounts, all support ticket categories.

Use when: Gateway receives a support email/message, or Joel says "handle this ticket".

### frontend-specialist
**29 skills** — Next.js, React, animations, component libraries, UI audits.

Handles: Next.js subsystems (routing, forms, data, metadata, config, rendering,
caching, testing), shadcn/geistcn components, Framer Motion, performance/security
audits, composition patterns.

Use when: Building or auditing frontend code, component library work, animation
implementation, Next.js version upgrades.

### document-processor
**4 skills** — PDF, XLSX, PPTX, DOCX file operations.

Handles: Creating, reading, editing, converting document formats. Spreadsheet
formulas, slide decks, Word documents, PDF extraction/OCR.

Use when: Any document file needs to be created, read, or transformed.

### content-specialist
**8 skills** — Content creation and publishing for joelclaw.com.

Handles: Writing in Joel's voice, Convex publishing pipeline, video notes,
Obsidian vault content, Remotion video generation, code block syntax highlighting.

Use when: Writing blog posts, publishing content, converting vault notes to site content.

### sdk-specialist
**8 skills** — Vercel AI SDK and Convex development.

Handles: AI SDK text generation/streaming/tools/React hooks, Convex queries/mutations/
actions/schemas/realtime, TanStack Start integration.

Use when: Implementing AI features with Vercel AI SDK, building Convex backends,
gremlin-cms development.

### incident-responder
**6 skills** — Production incident diagnosis and response.

Handles: Course-builder Axiom forensics, Vercel deploy debugging, k8s pod triage,
gateway diagnosis, loop diagnosis, system health checks.

Use when: Something is broken in production. Fast triage, not perfection.

## Delegation Patterns

### From interactive pi (System)

```
# Delegate to specialist
@support-triage Handle this refund request from [customer]
@frontend-specialist Audit the joelclaw.com homepage for performance
@document-processor Convert this PDF to Excel
```

### From gateway

The gateway can route messages directly to specialists based on classification.
Support emails → `support-triage`. Content requests → `content-specialist`.

### As chain steps

```
# Scout → specialist chain
@scout Analyze the Next.js codebase
@frontend-specialist Implement the changes from the scout's findings
```

## Skill Visibility

Skills assigned to specialists have `disable-model-invocation: true` in their
SKILL.md frontmatter. This means:
- NOT listed in the main `<available_skills>` prompt block
- Still loadable via `/skill:name` if explicitly requested
- Fully available when the specialist agent runs (specialists use `skills:` config)

## Skill Usage Auditing

The `skill-tracker` extension (`pi/extensions/skill-tracker/`) emits OTEL events
every time a SKILL.md is read during a pi session. This replaces vibes-based
pruning with data-driven decisions.

### Query skill usage

```bash
# Last 7 days of skill reads
joelclaw otel search "skill.read" --hours 168

# Aggregate stats (which skills are hot)
joelclaw otel stats --hours 720

# Find zero-usage skills (candidates for sidelining)
# Compare visible skills list against otel search results
```

### Audit cadence

Run a skill usage audit monthly. The process:
1. Query OTEL for `skill.read` events over the past 30 days
2. Compare against the visible skills list (skills without `disable-model-invocation`)
3. Skills with 0 reads → candidates for `disable-model-invocation: true`
4. Skills with high reads that are hidden → candidates for promotion back to visible
5. Update specialist agent skill lists accordingly

### Moving skills between visible and specialist

To sideline a skill:
```yaml
# Add to SKILL.md frontmatter
disable-model-invocation: true
```

To promote a specialist skill back to visible:
```yaml
# Remove from SKILL.md frontmatter
# disable-model-invocation: true
```

The skill remains loadable via `/skill:name` regardless of visibility.

## Files

Agent definitions: `~/.pi/agents/<name>.md`
Skill inventory: `~/Code/joelhooks/joelclaw/skills/`
Skill tracker: `pi/extensions/skill-tracker/index.ts`
Analysis: `docs/context-budget-analysis-2026-03-04.md`

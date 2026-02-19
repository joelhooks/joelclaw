---
status: deferred
date: 2026-02-16
decision-makers: Joel
consulted: mattpocock/course-video-manager (reference implementation)
tags:
  - adr
  - video
  - pipeline
  - content
---

# ADR-0027: Video Content Pipeline Expansion — Clip Segmentation + Content Repurposing

## Context and Problem Statement

joelclaw's video pipeline currently handles **ingest only**: download → transcribe → enrich vault note. The output is a single vault note with a wall-of-text transcript and an AI-generated summary. There's no structure below the video level, no way to extract segments, and no way to repurpose the content into different formats (articles, newsletters, YouTube metadata, social posts).

Matt Pocock's [course-video-manager](https://github.com/mattpocock/course-video-manager) demonstrates a more complete video content workflow: clip-level editing, speech/silence detection, multiple AI prompt modes for different output formats, and DaVinci Resolve integration. While Matt's tool is purpose-built for course production, several ideas translate well to joelclaw's broader use cases (talks, podcasts, meetings, interviews).

**Trigger**: The existing pipeline produces vault notes that are useful for reference but don't feed into content creation. Joel creates content for joelclaw.com and the video archive is an untapped source for articles, newsletters, and social posts.

## Decision Drivers

- Pipeline must remain **event-driven via Inngest** — composable, durable, observable
- Output stays in **Vault as markdown** — no new databases for content (Redis for state only)
- Must work for **multiple video types**: talks, podcasts, meetings, screen recordings, interviews — not just courses
- **Cherry-pick ideas**, don't port Matt's architecture — his Drizzle/Postgres clip schema is too heavy for vault-native workflows
- New capabilities should **chain from existing events** (`pipeline/transcript.processed`, `content/summarized`)

## Considered Options

### Option A: Clip segmentation + content repurposing (both)
Add silence-based clip detection to the transcription step, store segment metadata in vault frontmatter, and add new Inngest functions for different content output modes.

### Option B: Content repurposing only (no clips)
Add prompt-mode Inngest functions that take existing transcripts and produce different formats. Skip clip segmentation entirely.

### Option C: Full clip editor (Matt's model)
Build a clip-level editing UI with database-backed clips, sections, reordering. Full video editor experience.

## Decision

**Option A** — Both clip segmentation and content repurposing, kept vault-native.

Option B leaves transcripts as unstructured walls of text, which limits the quality of repurposed content. Option C is over-engineered for the use case — we're not building a video editor, we're building a content pipeline.

## Architecture

### 1. Clip Segmentation (new Inngest function)

**Event**: `pipeline/segments.requested` (emitted by `transcript-process` after creating vault note)

**What it does**:
- Takes the transcript with timestamps (already produced by mlx-whisper)
- Detects segment boundaries using silence gaps (configurable threshold, default 3+ seconds)
- Groups segments into logical sections using an LLM pass (topic shifts, speaker changes)
- Writes segment metadata back into the vault note as structured YAML frontmatter + inline section markers

**Vault note structure** (enhanced):
```markdown
---
type: video
segments:
  - id: seg-01
    title: "Introduction"
    start: "00:00"
    end: "02:34"
    summary: "Speaker introduces the problem space"
  - id: seg-02
    title: "Architecture Overview"
    start: "02:34"
    end: "08:12"
    summary: "Three-layer architecture for agent memory"
tags:
  - video
  - segmented
---

# Video Title

## Segments

### Introduction (00:00–02:34)
> Transcript text for this segment...

### Architecture Overview (02:34–08:12)
> Transcript text for this segment...
```

**Key difference from Matt's model**: Segments live in the vault note itself, not in a database. No clip reordering, no drag-and-drop editing. The structure is for **consumption and repurposing**, not editing.

**Inspiration credit**: Matt Pocock's `use-speech-detector.ts` silence detection (−33dB threshold, 800ms silence = boundary) and `clip-state-reducer.ts` clip sectioning model.

### 2. Content Repurposing (new Inngest functions)

A family of functions triggered by `content/repurpose.requested`, each producing a different output format. All consume the same input: vault note path + optional segment filter.

| Function ID | Event | Output | Vault Location |
|---|---|---|---|
| `content-article` | `content/article.requested` | Long-form article draft | `Vault/Drafts/articles/{slug}.md` |
| `content-newsletter` | `content/newsletter.requested` | Newsletter-format summary | `Vault/Drafts/newsletters/{slug}.md` |
| `content-youtube-meta` | `content/youtube-meta.requested` | Title + description + chapters | Appended to source vault note |
| `content-social` | `content/social.requested` | Thread-style social posts | `Vault/Drafts/social/{slug}.md` |
| `content-highlights` | `content/highlights.requested` | Key quotes + clips list | Appended to source vault note |

**Each function**:
1. Reads the vault note (transcript + segments + enrichment)
2. Applies a specialized prompt template (inspired by Matt's `app/prompts/` directory — 13 modes)
3. Uses the `joel-writing-style` skill for voice consistency
4. Writes output to vault
5. Emits `content/{type}.created` completion event

**Prompt templates** are stored as markdown files in `packages/system-bus/src/prompts/` — not hardcoded in function bodies. This makes them editable without code changes and versionable independently.

**Inspiration credit**: Matt Pocock's `text-writing-agent.ts` multi-mode architecture and `app/prompts/` directory structure.

### 3. Event Chain (expanded)

```
pipeline/video.requested
  → video-download
    → pipeline/transcript.requested
      → transcript-process
        → pipeline/transcript.processed
          → content-summarize (existing)
          → pipeline/segments.requested (NEW)
            → content-segment
              → pipeline/segments.created
        → content/summarize.requested (existing)
          → content-summarize
            → content/summarized

# On-demand repurposing (triggered manually or by future automation)
content/article.requested     → content-article     → content/article.created
content/newsletter.requested  → content-newsletter   → content/newsletter.created
content/youtube-meta.requested → content-youtube-meta → content/youtube-meta.created
content/social.requested      → content-social       → content/social.created
content/highlights.requested  → content-highlights    → content/highlights.created
```

### 4. What We're NOT Doing (Non-Goals)

- **No clip database** — segments are vault-native YAML, not Drizzle/Postgres rows
- **No video editor UI** — no React clip timeline, no drag-and-drop reordering
- **No OBS integration** — we're processing recorded/downloaded video, not live recording
- **No DaVinci Resolve export** — interesting but premature; revisit when video editing workflow is established
- **No silence detection at the audio level** — we use timestamp gaps in the whisper transcript, not raw audio analysis. Simpler, good enough for segmentation (not editing)
- **No course structure hierarchy** — repos/versions/sections/lessons is Matt's model for TotalTypeScript. joelclaw videos are standalone content, organized by vault tags and links

## Consequences

### Positive
- Every ingested video becomes a **content source** that can produce 5+ output formats
- Segmented transcripts are **more useful for search** (ADR-0024 taxonomy chunks can align with segments)
- Prompt templates are **editable markdown**, not code — can iterate on voice/format without deploys
- Event-driven repurposing means you can trigger `content/article.requested` for any past video, not just new ones

### Negative
- Segment detection quality depends on whisper timestamp accuracy (known to drift on long videos)
- More Inngest functions = more worker concurrency pressure (but concurrency: 1 on each is fine)
- Vault notes get longer with inline segments — may need collapsible sections

### Follow-up Tasks
- [ ] Create `content-segment` Inngest function
- [ ] Create prompt template directory structure in `packages/system-bus/src/prompts/`
- [ ] Create `content-article` Inngest function as first repurposing mode
- [ ] Create `content-newsletter` function
- [ ] Create `content-youtube-meta` function
- [ ] Create `content-social` function
- [ ] Create `content-highlights` function
- [ ] Update `transcript-process` to emit `pipeline/segments.requested`
- [ ] Add `Vault/Drafts/` directory structure (articles, newsletters, social)
- [ ] Test segment detection on 3+ existing transcripts (short talk, long podcast, meeting)
- [ ] Update video-ingest skill to document new event chain

## Implementation Plan

### Phase 1: Clip Segmentation
1. Create `packages/system-bus/src/inngest/functions/content-segment.ts`
2. Segment detection: parse whisper segments from vault note, group by silence gaps (>3s between segment end/start)
3. LLM pass: send grouped segments to model for section titling and summary
4. Write back to vault note: add `segments` to frontmatter, restructure transcript body with section headers
5. Emit `pipeline/segments.created`
6. Wire into `transcript-process` emit step

### Phase 2: First Repurposing Mode (Article)
1. Create `packages/system-bus/src/prompts/article.md` template
2. Create `packages/system-bus/src/inngest/functions/content-article.ts`
3. Read vault note, apply prompt with joel-writing-style, write to `Vault/Drafts/articles/`
4. Test on 2-3 existing video notes

### Phase 3: Remaining Modes
1. Newsletter, YouTube meta, social, highlights — one function each
2. Each follows the same pattern: read note → apply prompt → write output → emit event

### Verification
- [ ] `pipeline/segments.requested` event triggers segment detection on new transcripts
- [ ] Vault notes contain `segments` frontmatter after processing
- [ ] `content/article.requested` produces a draft article in `Vault/Drafts/articles/`
- [ ] Each repurposing function works on both new and existing vault video notes
- [ ] All events follow past-tense naming convention (ADR-0019)
- [ ] Prompt templates are standalone `.md` files, not inline strings

## More Information

### Prior Art
- **mattpocock/course-video-manager** — clip editing, multi-mode AI writing, DaVinci Resolve export. Purpose-built for TotalTypeScript course production. Ideas cherry-picked; architecture not ported. Credit: clip segmentation concept, multi-mode prompt architecture, style guide approach.
- **joelclaw video-ingest pipeline** — existing download → transcribe → summarize chain (ADR-0019 event naming)
- **joel-writing-style skill** — voice consistency for all generated content

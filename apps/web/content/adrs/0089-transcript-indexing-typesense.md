---
status: shipped
date: 2026-02-21
deciders: joel
---

# ADR-0089: Transcript Indexing in Typesense

## Context

JoelClaw processes two distinct types of transcripts:

1. **Video transcripts** — YouTube videos, podcast episodes, conference talks. Long-form (30min–6hrs), speaker turns, chapter markers. Produced by the video-ingest pipeline (yt-dlp → mlx-whisper). Stored as JSON with timestamped segments.

2. **Meeting transcripts** — Granola meeting notes. Shorter (15min–1hr), multi-party, action-item heavy, tied to specific dates/people/decisions. Arrive via mcporter MCP (`get_meeting_transcript`).

Currently these transcripts exist as flat files — vault notes get a summary but the raw transcript text is not searchable. With Typesense auto-embedding (ADR-0082), we can make every segment of every transcript semantically searchable without external API calls.

## Decision

Create a `transcripts` Typesense collection with chunked, auto-embedded transcript segments. One collection, `type` discriminator (`video` | `meeting`), speaker-turn chunking.

### Collection Schema

```
transcripts:
  fields:
    - name: chunk_id        # {source_id}:{chunk_index}
      type: string
    - name: source_id       # video slug or meeting ID
      type: string
      facet: true
    - name: type            # "video" | "meeting"
      type: string
      facet: true
    - name: title           # video title or meeting title
      type: string
    - name: speaker         # speaker name when available
      type: string
      facet: true
      optional: true
    - name: text            # the chunk text
      type: string
    - name: start_seconds   # timestamp offset in source
      type: float32
      optional: true
    - name: end_seconds
      type: float32
      optional: true
    - name: chapter         # chapter/topic label if available
      type: string
      optional: true
      facet: true
    - name: source_url      # YouTube URL, Granola link
      type: string
      optional: true
    - name: channel         # "Lex Fridman", "team standup", etc.
      type: string
      facet: true
      optional: true
    - name: source_date     # publication/meeting date
      type: int64
    - name: embedding       # auto-embedded from text field
      type: float[]
      embed:
        from: [text]
        model_config:
          model_name: ts/all-MiniLM-L12-v2
          indexing_prefix: ""
          query_prefix: ""
  default_sorting_field: source_date
```

### Chunking Strategy

- **Video transcripts**: Group consecutive segments by speaker turn. If a single turn exceeds ~500 tokens, split at sentence boundaries with 1-sentence overlap. Attach chapter markers from source metadata when available (e.g., Lex Fridman timestamps).
- **Meeting transcripts**: Chunk by speaker turn. Granola already provides structured speaker-attributed text. Shorter segments can be merged if under ~100 tokens.
- **Metadata**: Every chunk carries `source_id`, `title`, `speaker`, `start_seconds`, `chapter`, `source_url`, `channel`, `source_date` — enough to deep-link back to the exact moment.

### Pipeline Integration

1. **Video path**: `transcript-process.ts` already produces `{ text, segments[] }`. Add a post-processing step that chunks segments by speaker turn and indexes to Typesense. Also dual-write to Convex `contentResources` with type `transcript_chunk`.

2. **Meeting path**: New Inngest function `meeting-transcript-index` triggered by `meeting/transcript.fetched`. Chunks Granola output by speaker turn and indexes.

3. **Web-fetched transcripts**: New event `transcript/web.fetched` for transcripts grabbed from the web (like the Lex Fridman transcript page). Parser extracts speaker turns from HTML structure.

4. **CLI**: `joelclaw ingest-transcript <url>` for manual transcript ingest from web pages.

### Search UX

- Typesense ⌘K search includes `transcripts` collection for authenticated users
- Results show: speaker, text snippet, chapter, timestamp link
- Click navigates to `/transcripts/{source_id}?t={start_seconds}` or deep-links to YouTube timestamp

## Consequences

- Every video and meeting transcript becomes semantically searchable
- "What did Peter say about self-modifying software?" returns the exact segment
- "What did we decide about NAS migration?" returns the meeting chunk
- Auto-embedding stays local (ONNX model, no API calls per ADR-0082)
- Storage estimate: ~50 videos × ~200 chunks = 10k docs; ~100 meetings × ~30 chunks = 3k docs. Well within Typesense capacity.
- Dual-write to Convex enables real-time transcript browsing on joelclaw.com

## Alternatives Considered

- **Full-text only (no embedding)**: Loses semantic search — can't find concepts by meaning
- **Embed entire transcripts**: Too long for meaningful vector similarity. Chunking is required.
- **Separate collections per type**: Unnecessary complexity. Type facet handles filtering.

## Implementation Update (2026-02-23)

- Added explicit event contract `meeting/transcript.fetched` in the Inngest client schema.
- Added durable function `meeting-transcript-index` (idempotent on `meetingId`) to index Granola transcripts into `transcripts`.
- Updated `meeting-analyze` to emit `meeting/transcript.fetched` after transcript retrieval and to persist transcript cache in warm tier for index fanout reliability.
- Added dedicated scheduler `granola-check-cron` (hourly) and removed Granola polling from the generic heartbeat fan-out list.
- Wired `voice/call.completed` to write to `voice_transcripts` in Typesense, so LiveKit voice transcripts are searchable.
- Extended CLI and web search surfaces to include `transcripts`, while keeping `voice_transcripts` as a distinct collection.

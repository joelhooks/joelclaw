---
name: media-transcription
displayName: Media Transcription (badass-media)
description: "Run, monitor, cancel, and resume the durable media transcription pipeline (media-transcription-pipeline-v2) for raw meeting media on /Volumes/badass-media. Use when the user asks to transcribe a meeting or media file from the NAS, check transcription progress, cancel a transcription, resume a failed/partial run, or debug ASR/diarization actors. Flagg-host-only execution."
version: 1.0.0
author: Joel Hooks
tags:
  - media
  - transcription
  - whisper
  - diarization
  - inngest
---

# Media Transcription

Durable, event-driven transcription of raw meeting media on the NAS. Inngest
orchestrates; MLX Whisper (chunked ASR) and pyannote (whole-file diarization)
run as **detached local actor processes** — no Inngest step ever holds a
request open across inference. Built 2026-07-11 after the v1 monolith died to
request-bound 2h timeouts and Whisper hallucination loops (design receipt:
`.brain/projects/transcription-pipeline-v2-2026-07-11.svx`).

## Where it runs (hard constraints)

- **Flagg host worker only** (`hostFunctionDefinitions`, launchd
  `com.joel.system-bus-worker`). Needs the direct NFS mount
  `/Volumes/badass-media` and the rig checkout.
- Local inference implementation: `~/Code/joelhooks/transcript-rig`
  (public repo `joelhooks/transcript-rig`; override path with
  `TRANSCRIPT_RIG_ROOT`). Raw media on the NAS is immutable — the pipeline
  only writes derived artifacts.
- From any other fleet machine: send the event (Inngest routes it to flagg's
  worker) or SSH to flagg to inspect on-disk state.

## Start a transcription

```bash
joelclaw send media/transcription.requested -d '{
  "requestId": "req-'$(uuidgen | tr 'A-Z' 'a-z')'",
  "sourcePath": "/Volumes/badass-media/joel/meetings/<meeting-dir>"
}'
```

- `requestId` is the idempotency key — **always mint a fresh one**; a reused
  id is silently deduped. Optional flags: `"publish": false`, `"index": false`
  (both default true).
- `sourcePath` must be under `/Volumes/badass-media/` or the run fails
  NonRetriable.

## Monitor

- `joelclaw event <event-id>` → run id; `joelclaw run <run-id>` for step
  trace. Orchestrator steps keep `NN-` prefixes for the pi `job-monitor`
  widget (`packages/pi-extensions/inngest-monitor`).
- Progress events: `media/transcription.chunk.completed` (per chunk, with
  index/total/cached), terminal `media/transcription.completed` or `.failed`.
- On-disk truth (flagg): `<rig>/.transcript-rig-work/<artifactId>/`
  - `orchestration/plan.v1.json` — chunk plan (requestId, tracks, chunk ids)
  - `orchestration/actors/<chunkId>/status.v1.json` — actor heartbeat/state
  - `orchestration/actors/<chunkId>/actor.log` — inference stdout/stderr
  - `state.v1.json` — rig stage (staged → transcribed → … → complete)
  - `editorial/transcript.{md,txt,srt,vtt,tsv}` — final outputs
- Published result: `<sourcePath>/derived/transcripts/current.v1.json`
  pointer + artifact directory.

## Cancel

```bash
joelclaw send media/transcription.cancelled -d '{"requestId": "<the-request-id>"}'
```

Cancels all runs (cancelOn) AND triggers `transcription-cleanup-v1`, which
SIGTERM→10s→SIGKILLs live actor process groups (identity-verified via ps —
PID reuse safe) and writes `orchestration/cancelled.v1.json`, which blocks
new actor spawns. Optionally include `artifactId` to skip the plan scan.

## Resume / re-drive

Re-send `media/transcription.requested` with a **fresh requestId** and the
same sourcePath. Everything valid on disk is adopted, nothing recomputes:

- Whole-track `raw/asr/<sourceId>/asr.json` passing the repetition screen ⇒
  track done. A repetitive one is quarantined (`.rejected-<ts>`) and the
  track re-chunks.
- Existing chunk WAV layouts (`raw/chunked/<sourceId>/chunks/NNN.wav`) are
  adopted; offsets recomputed from ffprobe. Valid chunk `out/<i>/asr.json` ⇒
  cached, no actor spawned.
- Diarization `raw/diarization/<sourceId>.jsonl` (first line parses) ⇒
  cached.
- Remove `orchestration/cancelled.v1.json` first if the artifact was
  previously cancelled.

## Failure modes (typed, in actor status / run errors)

| Error | Meaning | Action |
|---|---|---|
| `repetitive_output: …` | Whisper hallucination loop survived collapse (decode mostly padding) | Retries respawn actors; deterministic loops usually pass after collapse-then-screen. Inspect the chunk WAV — genuinely silent/broken audio fails honestly |
| `inference_required: …` | A fast rig stage (`resume --no-inference`) found a missing claim check | Inference didn't complete/adopt; check chunk statuses |
| `cancelled_by_signal` | Actor's child died to un-initiated SIGTERM/SIGKILL (group kill, operator, or Bun's in-process signal-dispatch race) | Expected during cancel/reap; standalone occurrences mean someone killed processes manually |
| `actor stalled` | Heartbeat stale >3m | Watchdog killed + retried automatically |
| `chunk_result_missing` | Aggregation found no valid chunk output | Chunk failed all retries; see its actor.log |
| `mount_unavailable` | NFS mount down | `media/transcription.blocked` emitted; remount and re-drive |

## Design invariants (don't regress these)

- ASR outputs are parsed with `parseAsrJson` (mlx_whisper emits bare `NaN`).
- Repetition screening is collapse-then-screen (`screenWithCollapse`):
  consecutive-duplicate segments collapse to one; >50% collapsed ⇒ failed
  decode. Aggregation persists the collapsed form.
- ASR actors run `--condition-on-previous-text False
  --hallucination-silence-threshold 2`; diarization uses MPS
  (`TRANSCRIPT_RIG_DIARIZE_DEVICE=cpu` to opt out).
- `waitForEvent` results are verified in code against the spawned actorId —
  the dev-mode Inngest server leaks foreign events past match expressions.
- Known dev-server gap: concurrency keys (`transcription-gpu` limit 1) are
  not enforced; expect parallel whispers until the Inngest server is
  upgraded.

Code: `packages/system-bus/src/transcription/` +
`packages/system-bus/src/inngest/functions/{media-transcription-pipeline,transcription-asr-chunk,transcription-diarize,transcription-cleanup}.ts`.

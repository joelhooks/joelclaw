---
name: wzrrd-video
displayName: wzrrd Video
description: "Publish videos to wzrrd.sh watch pages from anywhere in the fleet. Covers the joelclaw publish event on flagg, the wzrrd CLI upload door, status/trace/revoke, Pro entitlements, and debugging. Use when publishing a video, checking encode/transcription progress, embedding video in Brain notes, or debugging the video pipeline."
version: 1.0.0
author: joel
tags:
  - video
  - wzrrd
  - cloudflare
  - media
---

# wzrrd video

Videos publish to `https://wzrrd.sh/v/<slug>` — player, transcript on the page, subtitles in
six languages (en/es/pt/fr/de/ja) generated automatically. The pipeline is fully
Cloudflare-native (R2 originals → Stream encode → durable Workflow → Deepgram + Workers AI);
flagg is just a client. Unlisted by default: the unguessable URL is the share link.

## Publish from flagg (the joelclaw door)

```bash
joelclaw send video/publish.requested -d '{"path":"/abs/file.mp4","title":"...","actor":"<who>"}'
```

`video/publish.completed` arrives with `watchUrl` in ~20s (upload handoff only — encoding and
transcription continue in the cloud; `workflowStatusHint` points at the status command).
Files over 5 GiB are rejected toward `sourceUrl` mode.

## Publish from any machine (the CLI door)

```bash
wzrrd video upload ./clip.mp4 --title "..."       # Pro session required
```

Install/update: `curl -fsSL https://wzrrd.sh/install.sh | bash` (v0.5.0+ has video verbs).
Pro discovery for agents: `wzrrd video status probe` → `video_not_found` means you're Pro;
a 403 "Pro feature" means ask Joel. Full agent instructions ship in the public
`wzrrd-publish` skill (also served at `https://wzrrd.sh/.well-known/agent-skills/`).

## Observe / manage

```bash
wzrrd video status <slug>      # Workflow phase history
wzrrd video trace <slug>       # Analytics Engine wide events (cloud side)
joelclaw video trace <slug>    # ClickHouse handoff forensics (flagg side)
wzrrd video transcribe <slug> [--force]
wzrrd video revoke <slug>      # page 404s; Stream copy + R2 original deleted
```

Debugging lore (read before rabbit-holing):
`~/Code/joelhooks/wzrrd-sh-cli/.brain/resources/video-pipeline-debugging-lore.svx`.

## Brain notes

`<VideoPlayer playbackId="..." title="..." />` renders in any `.svx` (pi-notes standard
component; captions ride the Mux asset natively for legacy videos).

## Retired: the Mux/Garage pipeline

The local pipeline (Mux direct upload, Garage archive, webhook correlate) was retired
2026-07-15 — see `skills/mux-video` tombstone. Pre-retirement Mux videos keep playing.
Effort history: `~/Code/joelhooks/wzrrd-sh-cli/.brain/projects/cloud-video-default/`.

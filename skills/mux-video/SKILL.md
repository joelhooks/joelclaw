---
name: mux-video
displayName: Mux Video
description: "RETIRED 2026-07-15 — the Mux pipeline was replaced by wzrrd-video (fully Cloudflare-native). Use skills/wzrrd-video instead. Kept for historical Mux asset management only. Covers direct uploads, API asset management, webhook event flow, playback embedding, and the Mux CLI. Use when uploading video, creating assets, checking encoding status, embedding playback, or handling Mux webhook events."
version: 0.1.0
author: joel
tags:
  - video
  - mux
  - media
  - webhooks
---

# mux-video (RETIRED)

**This pipeline was retired 2026-07-15.** Video publishing is now fully Cloudflare-native
through wzrrd — see `skills/wzrrd-video/SKILL.md`. Existing Mux assets keep playing; use the
Mux API directly (credentials in agent-secrets: `mux_token_id`/`mux_token_secret`) only for
managing those historical assets. The Mux webhook registration at hooks.joelclaw.com is
vestigial (events verify and are dropped).

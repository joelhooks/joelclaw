# Agent Comms Gateway replay plugin

This directory is the production-shaped seed from the replay prototype.

- `agents/` and `prompts/` hold Fable's judgment and voice.
- `server/` exposes replay-only MCP tools over stdio.
- `scripts/run-replay.mjs` reads one day from the real journal spool, invokes Pi for inference, validates receipts, and writes private Brain data.
- `scripts/render-review.mjs` generates the Brain review surface.

The spool adapter is throwaway glue. The `readDayPage()` contract matches the stream seam's future independent paginated time read. Production replaces that adapter with `readSince(recordedAt, limit, cursor)` and adds append/readback tools.

This prototype never sends messages and never mutates the gateway, stream, or journal.

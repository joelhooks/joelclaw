# Judgment

Use the smallest interruption that preserves truth.

Deliver when Joel must act, asked for the result, or needs a terminal receipt.

Aggregate duplicate, superseded, related, routine intermediate, and machine-only chatter when one message preserves the useful facts. Use a slow digest aggregate for facts Joel may need later. Use `drop` only when Joel should never hear the event. Never drop an actionable failure because another message looks similar.

Escalate only for immediate safety, active production loss, a time-critical blocked decision, or a call Joel explicitly requested. The shared incident latch owns quiet windows and attempt caps.

Fan out when more evidence or work is needed. Do not block on the worker. Append the task ID and require the result to return through the stream.

Route inbound events one rung at a time. A live-pane failure does not authorize revive. A revive failure does not authorize a bus event. Write a fresh decision for each next move.

Every external input event must appear in exactly one decision receipt before its cursor advances. Gateway-owned outputs advance mechanically. Reasons name evidence, not hidden scores.

Closed aggregates are immutable. A straggler starts a successor with `follows`. Schedule a dumb deadline for every open or extended aggregate.

A rewrite must stand alone. Keep source-backed facts only. If evidence is incomplete, say what is unknown.

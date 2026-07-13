# VISION — the voice agent autonomy charter

What the automation around the JoelClaw voice agent may do on its own, where
Joel is in the loop, and how those lines move. Decided in the
call-tuning-loop grilling, 2026-07-13 (Joel + steering session). The
call-tuning retro, the canaries, and every future automation on this surface
answer to this document.

## Autonomy tiers

**Autonomous — no human gate:**
- Tuning text on the allowlist: `public-openers.txt`, `GREETING_FLAVORS`,
  tool docstrings and tool-result instruction headers.
- Judging and analyzing calls; writing scores, taxonomy tags, caller cards.
- Canary probes, synthetic calls, paging, auto-restart on verified failure.
- Filing proposals, receipts, and brief lines.

**Gated — Joel approves before it lands:**
- Persona instruction blocks (both lines). Character is Joel's, not the
  optimizer's.
- Config knobs: endpointing delays, interruption thresholds, VAD settings.
- Model swaps (`llm.model`) and anything on the inference path.
- New tools, tool permission changes, anything touching the private line's
  grants.
- Carrier/channel settings, spend, publication-boundary changes.
- shitrat-brain wiki pages belong to the public-brain gardener (PR-gated),
  not this loop — one gardener per garden.

**Forbidden — never autonomous, no ladder up:**
- The quarantine invariants (untrusted words never touch the memory pipeline).
- The disclosure line. The caller allowlist. Fail-closed behavior.
- Publishing anything across the privacy boundary.
- Code changes beyond the allowlisted text surfaces.

## Receipt contract

Every auto-applied tuning is its own commit — never batched:
`retro(auto): <surface> — <one-line reason> [calls: N, taxonomy: <tag>]`.
Revert is always one clean `git revert`. Each morning's Bugle carries a
"Tuning receipts" item: what changed, why, which calls drove it. No
real-time notifies for routine tunings.

## Guardrails (all four, mechanical)

1. Compile/parse checks pass; disclosure enforcement survives.
2. Banned-content grep on anything caller-facing.
3. Max two auto-tunings per retro — a morning wanting five files a proposal.
4. Post-apply synthetic call must answer; failure auto-reverts and converts
   the change to a gated proposal.

## The promotion ladder

A gated surface earns auto-apply after ten clean auto-applies on lower
surfaces plus one explicit sign-off from Joel. Any auto-revert, or Joel
manually reverting a tuning, demotes its surface back behind the gate.
Trust is a written track record, revocable.

## Intelligence escalation

The loop's own reasoning (judge, retro, proposal drafting) runs on the cheap
default path. It may escalate model/effort — up to **pi with
gpt-5.6-rol:xhigh** — when warranted: conflicting receipts, judge low
confidence or disagreement, a proposal touching a gated surface, or an
incident retro. Escalation is itself logged in the receipt (which tier ran,
why). Escalating intelligence never escalates *authority*: a smarter judge
still can't cross a gate.

## Always Joel

Rubric changes, ladder promotions, scope/finish-line moves, and anything the
loop flags NEEDS-JOEL. The loop proposes; Joel disposes.

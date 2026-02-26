---
type: discovery
source: "https://www.youtube.com/watch?v=IOiZatlZtGU"
discovered: "2026-02-26"
tags: [video, type-theory, linear-logic, session-types, functional-programming]
relevance: "Phil Wadler's Strange Loop talk on the Curry-Howard correspondence — propositions are types, proofs are programs, and this wasn't invented but discovered"
---

# Propositions as Types — Phil Wadler at Strange Loop

Wadler's most-watched talk (75,000+ views). Covers the full arc: Hilbert's program, Gödel's incompleteness, Church's lambda calculus, Gentzen's natural deduction, and the discovery that these independent lines of work were secretly the same thing. Types in programming correspond to propositions in logic. Programs correspond to proofs. Evaluation corresponds to proof simplification.

The "discovered not invented" framing is the philosophical core. Church and Gentzen independently created isomorphic systems in the 1930s without knowing about each other's work. This happened again with de Bruijn, Howard, and Curry decades later. Wadler argues this means the correspondence is a fundamental property of the universe, not an artifact of human design.

The talk builds to polymorphic lambda calculus (System F / second-order logic) and hints at where linear logic extends the correspondence to concurrent systems — the topic of his "Propositions as Sessions" paper. This talk is the accessible on-ramp; the paper is the formal destination.

Companion to the [research article](/propositions-as-sessions-armstrong-wadler) connecting this to Koko and BEAM evaluation.

Recommended by Sean Grove.

---
type: discovery
source: "https://www.youtube.com/watch?v=zi0rHwfiX1Q"
discovered: "2026-02-26"
tags: [video, erlang, testing, property-based-testing, quickcheck]
relevance: "John Hughes on property-based testing with QuickCheck — state machine models for testing stateful APIs, shrinking to minimal failing cases, finding race conditions in Erlang distributed systems"
---

# Testing the Hard Stuff and Staying Sane

<YouTube id="zi0rHwfiX1Q" />

John Hughes (co-inventor of QuickCheck) at Clojure/West 2014. The core argument: you can't test enough by hand because bugs hide in feature interactions (quadratic), three-way interactions (cubic), and race conditions (unbounded). The answer: don't write tests, generate them.

The talk walks through property-based testing of stateful systems using state machine models — define a model, generate random sequences of API calls, check postconditions against the model, then shrink to a minimal failing example. Hughes demonstrates finding bugs in C circular buffers, Erlang process registries, and AUTOSAR automotive software where Volvo's existing test suite missed critical race conditions.

The race condition testing is the highlight. QuickCheck generates concurrent test sequences and systematically explores interleavings. For Volvo's AUTOSAR basic software, this found bugs that had survived extensive manual testing — the kind of bugs that only surface when three operations happen in a specific order under specific timing.

Directly relevant to Koko's shadow executor (ADR-0118) — property-based testing could validate that TypeScript and Elixir implementations produce equivalent results across generated input sequences, not just hand-picked examples.

Recommended by Sean Grove.

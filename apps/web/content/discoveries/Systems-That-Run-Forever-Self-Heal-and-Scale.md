---
type: discovery
source: "https://www.youtube.com/watch?v=cNICGEwmXLU"
discovered: "2026-02-26"
tags: [video, erlang, beam, fault-tolerance, distributed-systems, architecture]
relevance: "Joe Armstrong's Lambda Jam 2013 talk — the six rules for systems that never go down, why fault tolerance implies scalability, and Erlang's architectural primitives"
---

# Systems That Run Forever, Self-Heal and Scale

Joe Armstrong at Lambda Jam 2013. The definitive talk on Erlang's architectural philosophy, distilled to six rules for building systems that never go down:

1. **Isolation** — processes share nothing, communicate only through messages
2. **Concurrency** — the world is concurrent, model it that way
3. **Failure detection** — you must know when something dies (links)
4. **Fault identification** — you must know *why* it died
5. **Live code upgrade** — fix bugs without stopping the system
6. **Stable storage** — survive total failure with persistent state

Armstrong's key insight: **fault tolerance implies scalability**. If your system can survive a node dying, it can also survive adding a node. The same architectural properties that give you reliability give you horizontal scaling for free.

He shows appreciation for Elixir and Dave Thomas's early work bringing Erlang's ideas to a new audience. José Valim himself recommended the talk to the Elixir community.

This is the runtime half of the Armstrong/Wadler convergence explored in the [research article](/propositions-as-sessions-armstrong-wadler). Armstrong built the system that self-heals; Wadler proved you can prevent certain failures from happening in the first place.

Recommended by Sean Grove.

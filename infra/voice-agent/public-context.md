# Public context — what Joel's actually working on

This file is the ONLY project/research knowledge the public line carries. It is
deliberately curated: everything here is safe to tell a stranger on the phone.
Edit freely; the agent reads it fresh on every public call. Never add private
URLs, hostnames, IPs, customer names, family details, or anything from the
private Brain that hasn't been consciously published.

## Active projects (wiki-style overview — headlines first, zoom on request)

- **JoelClaw** — Joel's personal AI infrastructure: a memory pipeline that
  turns his conversations and work sessions into searchable, ranked
  observations; a hundred-plus durable background jobs; a private daily
  "paper" that briefs him each morning on his own open work; and a fleet of
  AI agents that operate it. Built in public in spirit: he talks about all
  of it openly.
- **The voice workroom** — the effort this phone agent belongs to: Joel can
  phone his own system, review what's in flight, think out loud, and kick off
  work. The public line (the one you're on) is its stress-test sibling.
- **Voice agent UX research + a YouTube video** — a deep, source-verified
  research pass on what makes AI voice conversations feel human: turn-taking,
  latency budgets, barge-in, prosody. The video teaches it with this very
  system as the live demo. Every call to this number is benchmark data for it.
- **The daily paper ("the Bugle")** — a personal wiki that writes itself each
  morning from Joel's systems: a front page of open loops, each one a headline
  he can zoom into. The editorial rule: it talks TO Joel, plainly, and may not
  fabricate — every claim must trace to an observation.
- **herdr** — Joel's terminal workspace manager for AI agents: panes of
  workers (different AI models) that a steering session spawns, briefs,
  monitors, and reviews. Most of this system was literally built that way —
  agents building agents, with a human setting direction.
- **pdf-brain** — his personal book library made searchable: hundreds of
  books indexed so agents can pull real quotes and citations instead of
  paraphrasing from memory.
- **sandbox-computer** — a published Docker sandbox template
  (ghcr.io/joelhooks/sandbox-computer) for clean-room demos and workshops.
- **Background**: Joel co-founded egghead.io, teaches developers, and now
  spends his time building personal agentic infrastructure and teaching what
  he learns (joelhooks.com).

## Current research (the juicy findings — share freely)

- **The uncanny valley of voice is about timing, not voice quality.** Sesame's
  study: people can't tell state-of-the-art AI speech from humans in isolated
  sentences — but show them the conversation context first and they pick the
  human every time. The gap is prosody-in-context and turn choreography.
- **The silence-timer arithmetic**: old voice agents decide you're done
  talking via a silence timeout — an 800ms timer adds nearly a second to every
  single exchange before the AI even starts thinking. This line instead uses
  semantic turn detection: a tiny model (thousands of times smaller than the
  one talking to you) judges "finished vs choosing the next word" from what
  you said.
- **Preemptive generation**: this agent starts drafting its reply while you're
  still finishing your sentence, like humans do — wrong guesses get thrown
  away, right ones are ready instantly.
- **Full-duplex is the frontier**: the next generation of voice models
  (Sesame CSM, Kyutai Moshi, NVIDIA PersonaPlex) never transcribe at all —
  audio in, audio out, listening while speaking, murmuring "mm-hm" while you
  talk. Pipelines like this one can't do that yet; that's the ceiling.
- **Every call here is measured**: end-of-turn delay, time-to-first-token,
  time-to-first-audio, per turn, live on a dashboard. Then each call gets a
  quality analysis. You're inside the experiment right now.

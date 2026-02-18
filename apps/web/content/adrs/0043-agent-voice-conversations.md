---
status: proposed
date: 2026-02-18
decision-makers: joel
tags:
  - voice
  - identity
  - telegram
  - conversations
  - elevenlabs
  - agent-identity
supersedes:
related:
  - "0042-telegram-rich-replies-and-outbound-media"
  - "0041-first-class-media-from-channels"
  - "0038-embedded-pi-gateway-daemon"
---

# ADR-0043: Agent Voice Conversations — Morning Calls, Retrospectives, and Mobile Interviews

## Context

ADR-0042 covers TTS as an output mode — the agent synthesizes speech for Telegram voice messages. But the real value is **bidirectional voice conversation** as a first-class interaction pattern.

Three use cases drive this:

**Morning call.** The agent calls Joel (or sends a Telegram voice thread) at a configured time. Runs through: calendar, overnight events, pending decisions, priorities for the day. Joel responds verbally while making coffee. The agent captures decisions and updates the system.

**Retrospective.** End of day or end of week. The agent reviews what happened: completed work, open items, decisions made, things that drifted. Asks reflective questions. Joel answers. Results in: updated vault notes, project status, new tasks, captured insights.

**MCQ as interview.** The same quick-choice pattern used in pi sessions, but spoken. The agent asks "I've got three options for the media pipeline. Option one: implement inbound download first. Option two: start with outbound voice. Option three: do reply threading. What feels right?" Joel answers while driving/walking. No screen needed.

All three require:
- Agent-initiated conversations (not just responding to messages)
- Real-time STT → think → TTS loop
- Low enough latency to feel conversational (~1-3 seconds)
- Graceful interruption (Joel can cut in)
- Structured output from freeform conversation (decisions, tasks, notes — not just chat)

## Decision

Build agent voice conversations as an Inngest-orchestrated capability that uses ElevenLabs for both STT and TTS, with the LLM layer being Claude (same as gateway).

### Architecture: Two Modes

**Mode 1: Asynchronous voice thread (Telegram)**

The simpler mode. Agent sends voice messages, Joel responds with voice messages. Not real-time — each turn has natural latency (seconds to minutes).

```
Agent cron trigger (e.g., 7:30am) →
  Inngest function: morning-briefing →
    Step 1: Gather context (calendar, tasks, overnight events, slog tail)
    Step 2: Generate briefing text via Claude
    Step 3: Synthesize voice via ElevenLabs TTS
    Step 4: Send as Telegram voice message (sendVoice)
    Step 5: Wait for Joel's response (step.waitForEvent)
    Step 6: Transcribe Joel's voice reply (STT)
    Step 7: Process response, extract decisions/tasks
    Step 8: Continue conversation or close out
```

This is implementable today with existing infrastructure. The Inngest `step.waitForEvent` pattern already handles the async wait. Voice messages flow through the existing Telegram channel.

**Mode 2: Real-time voice call (ElevenLabs Agents / WebSocket)**

Full duplex conversation. Sub-second latency. Interruption handling. The "phone call from your agent" experience.

ElevenLabs Agents platform provides this:
- WebSocket API: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id={id}`
- STT (Scribe v2 Realtime): ~150ms latency, 90+ languages
- TTS (Flash v2.5): ~75ms latency
- Bring your own LLM (Claude via server integration)
- Turn detection, interruption handling built-in
- Telegram, phone (Twilio), and web clients

**Cost comparison:**

| Mode | Cost per minute | Latency | Infrastructure |
|------|----------------|---------|----------------|
| Async Telegram | ~$0.01 (TTS only, STT local via mlx-whisper) | Seconds-minutes per turn | Existing |
| ElevenLabs Agents | ~$0.088 (Business tier, + LLM cost) | 1-3 seconds | WebSocket client |
| OpenAI Realtime | ~$0.15 (audio in + audio out) | <1 second | WebSocket client |

### Conversation Types

**Morning briefing** (async or real-time):
```
Agent: "Morning. You've got three things on the calendar today.
  The dentist at 2, a deploy window at 4, and you blocked 
  an hour for the media pipeline work. Overnight, two PRs 
  merged and the memory pipeline processed 126 observations.
  One decision needs your input — the NAS partitioning 
  scheme. Time-first or identity-first?"

Joel: "Time first. What's the deploy?"

Agent: "The Telegram media download wiring from yesterday. 
  Tests pass, worker's running 22 functions. Want me to 
  merge and deploy, or hold for review?"

Joel: "Ship it."

Agent: [updates task status, triggers deploy, notes decision]
```

**Retrospective** (weekly, async or real-time):
```
Agent: "This week: 4 ADRs written, media pipeline operational 
  through NAS archive, the Inngest articles are fixed and 
  deployed. The voice work is designed but not started.
  What felt good this week?"

Joel: "The ADR velocity. Having those as reference docs 
  instead of just decisions changes how the agents work."

Agent: "Noted. What dragged?"

Joel: "The worker sync issue. Subtree model is friction."

Agent: [captures reflection, updates project notes, flags 
  worker sync for improvement]
```

**MCQ interview** (mobile, real-time preferred):
```
Agent: "I need to know where to focus next on the media 
  pipeline. Three options. One: wire up the Telegram 
  download handlers — photos and voice. Two: implement 
  reply threading so responses go to the right message. 
  Three: start on outbound media so I can send you 
  files back. What sounds right?"

Joel: "Downloads first. That's the blocking thing."

Agent: "Got it. Phase one, inbound media. I'll work on 
  that. Anything else before I go?"

Joel: "Nah, that's good."

Agent: [updates priorities, queues implementation work]
```

### Structured Output from Conversations

The critical difference between voice chat and voice *conversation* is that the latter produces artifacts. Every conversation should yield:

- **Decisions** → logged to vault, referenced in ADRs
- **Tasks** → added to project index or Inngest events
- **Reflections** → captured in daily notes
- **Priority changes** → updated in project status
- **Configuration** → voice settings, schedule adjustments

The agent uses a structured extraction step after each conversation:

```typescript
// Post-conversation processing
const artifacts = await step.run("extract-artifacts", async () => {
  const prompt = `Extract structured artifacts from this conversation:
    ${transcript}
    
    Return JSON with:
    - decisions: [{summary, context, confidence}]
    - tasks: [{description, project, priority}]  
    - reflections: [{insight, category}]
    - priority_changes: [{item, from, to, reason}]`;
  
  return await claude.generate(prompt);
});

// Write artifacts to vault
await step.run("persist-artifacts", async () => {
  for (const decision of artifacts.decisions) {
    await appendToDaily(decision);
  }
  for (const task of artifacts.tasks) {
    await emitEvent("task/created", task);
  }
});
```

### Voice Identity (from ADR-0042)

Each agent's voice is part of its identity. The refinement happens naturally during these conversations — Joel hears the voice, gives feedback, the agent adjusts.

```yaml
# Agent identity config
voice:
  provider: elevenlabs
  voiceId: "abc123"
  model: eleven_flash_v2_5       # low latency for conversations
  settings:
    stability: 0.6
    similarityBoost: 0.75
    style: 0.2
    speed: 1.05
  conversation:
    auto: scheduled              # morning + retro on schedule
    morningBriefing: "07:30"     # PT
    weeklyRetro: "friday:17:00"  # PT
    interruptible: true
    maxDuration: 300             # 5 minutes
  fallback:
    provider: edge
    voice: "en-US-GuyNeural"
```

### Implementation Path

**Phase 1: Async voice thread via Telegram** (uses existing infra)
- Inngest cron function: `morning-briefing` at configured time
- Gathers context: `gog cal today`, `slog tail`, pending decisions, calendar
- Claude generates briefing
- ElevenLabs TTS → Telegram `sendVoice`
- `step.waitForEvent("telegram/voice.received")` for Joel's response
- mlx-whisper transcription (local, free) or ElevenLabs Scribe ($0.22/hr)
- Artifact extraction + vault writes

**Phase 2: MCQ as spoken interview**
- Same async pattern but multi-turn
- Agent presents options verbally
- Joel responds with choice + context
- Agent adapts next question based on answer (same adaptive flow as MCQ tool)
- Conversation ends when decisions are captured

**Phase 3: Real-time via ElevenLabs Agents**
- Create ElevenLabs Agent with joelclaw's voice
- Configure Claude as LLM backend (server integration)
- WebSocket client in gateway daemon
- Telegram voice chat or phone call trigger
- Full duplex with interruption handling
- Sub-3-second turn latency

**Phase 4: Proactive conversations**
- Agent detects when a conversation would be useful (not just scheduled)
- "You've been heads-down for 4 hours. Quick check-in?"
- Context-aware triggers: stale decisions, blocked tasks, missed calendar items
- Notification via Telegram, escalation to voice if no text response

## Consequences

- **The agent becomes a conversational partner**, not just a text responder. Morning briefings and retros create natural checkpoints.
- **Mobile-first interaction.** Voice works while driving, walking, cooking. No screen needed for decisions.
- **Structured output from informal input.** Freeform speech → decisions, tasks, reflections. The agent does the extraction work.
- **Cost:** Phase 1 is nearly free (mlx-whisper local STT + ElevenLabs Starter $5/mo TTS). Phase 3 adds ~$0.09/min for real-time.
- **Privacy:** STT can stay local (mlx-whisper). TTS requires cloud (ElevenLabs/OpenAI). Real-time mode sends audio to ElevenLabs.
- **Voice refinement is ongoing.** Each conversation is an opportunity to adjust. "Slower." "Warmer." "Less pause between sentences."

## Credits

- ElevenLabs — Agents platform, Scribe v2 Realtime STT, Flash v2.5 TTS, voice cloning
- OpenClaw `src/tts/` — provider cascade pattern, auto modes, text summarization
- Inngest — `step.waitForEvent` for async conversation turns, cron triggers for scheduled conversations
- ADR-0042 — Telegram media and voice identity foundation

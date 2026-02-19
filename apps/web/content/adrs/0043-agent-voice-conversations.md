---
status: accepted
date: 2026-02-19
decision-makers: joel
tags:
  - voice
  - livekit
  - webrtc
  - conversations
  - elevenlabs
  - agent-identity
supersedes:
related:
  - "0042-telegram-rich-replies-and-outbound-media"
  - "0041-first-class-media-from-channels"
  - "0038-embedded-pi-gateway-daemon"
  - "0029-replace-docker-desktop-with-colima"
---

# ADR-0043: Agent Voice Conversations via Self-Hosted LiveKit

## Context

The agent needs **bidirectional voice conversation** — not just TTS output, but real-time spoken dialogue. Three use cases drive this:

**Morning call.** The agent runs through calendar, overnight events, pending decisions, priorities. Joel responds verbally while making coffee. Decisions get captured.

**Retrospective.** End of day/week. Agent reviews completed work, open items, drift. Asks reflective questions. Results in vault notes, updated status, captured insights.

**MCQ as interview.** Spoken multiple-choice while driving/walking. No screen needed for decisions.

All three require: agent-initiated conversations, real-time STT → LLM → TTS, low latency (~1-3s), graceful interruption, and structured output from freeform speech.

### Why LiveKit over ElevenLabs Agents WebSocket

The original design (proposed Feb 18) used ElevenLabs Agents platform — a managed WebSocket API for real-time voice. After research, LiveKit Agents framework is better for this system:

| Dimension | ElevenLabs Agents | LiveKit Agents |
|-----------|------------------|----------------|
| Transport | WebSocket (audio frames) | WebRTC (native browser/mobile) |
| Architecture | Managed service | Self-hosted, Apache 2.0 |
| STT | ElevenLabs Scribe only | Any plugin (Deepgram, Whisper, etc.) |
| LLM | Bring-your-own via server webhook | Plugin architecture, direct SDK |
| TTS | ElevenLabs only | Any plugin (ElevenLabs, OpenAI, etc.) |
| Turn detection | Built-in, no control | Silero VAD + configurable pipeline |
| Tool use | Limited | `@function_tool` decorator, full async |
| Cost | ~$0.088/min + LLM | Self-hosted server = free, pay only for STT/LLM/TTS |
| Privacy | Audio to ElevenLabs | Audio stays on infra, only API calls to providers |

The clincher: LiveKit's `@function_tool` lets the voice agent call joelclaw system tools mid-conversation. "Check my calendar" → `gog cal today` → spoken response. ElevenLabs Agents can't do that without a separate webhook server.

## Decision

**Self-host LiveKit server on the existing Talos k8s cluster. Build voice agents using the LiveKit Agents Python framework with pluggable STT/LLM/TTS.**

### Architecture

```
┌─────── Client (phone/laptop on Tailscale) ───────┐
│  Browser → agents-playground.livekit.io           │
│  or: native app, Telegram voice, SIP/phone        │
│  WebRTC audio ←→ LiveKit server                   │
└──────────────────────┬────────────────────────────┘
                       │ WebRTC (UDP/TCP)
                       ▼
┌─────── Mac Mini (panda) ─────────────────────────┐
│  Caddy WSS proxy (panda.tail7af24.ts.net:7443)   │
│      ↓                                            │
│  LiveKit Server v1.9.0 (k8s, port 7880/7881)     │
│      ↓ dispatches job                             │
│  Voice Agent (Python, host process)               │
│  ├─ Deepgram STT (ears)                           │
│  ├─ Claude Sonnet 4.6 via OpenRouter (brain)      │
│  ├─ ElevenLabs TTS (mouth)                        │
│  ├─ Silero VAD (turn detection)                   │
│  └─ @function_tool → joelclaw tooling             │
│      ↓ system actions                             │
│  Inngest (event bus) / Redis / Vault / etc.       │
└───────────────────────────────────────────────────┘
```

### Proven Pipeline (Spike, Feb 19 2026)

Every component verified working end-to-end:

| Component | Provider | Status | Notes |
|-----------|----------|--------|-------|
| Media server | LiveKit v1.9.0 | ✅ Running | Helm chart, k8s joelclaw namespace, hostNetwork |
| STT | Deepgram | ✅ Working | Transcribed "What can you help me with today?" ~180ms delay |
| LLM | Claude Sonnet 4.6 via OpenRouter | ✅ Working | "Hi there! Hope you're having a wonderful day!" |
| TTS | ElevenLabs | ✅ Working | 6 audio chunks, played out to room |
| VAD | Silero | ✅ Working | Turn detection with live mic (file-based audio has timing issues, expected) |
| WSS proxy | Caddy over Tailscale | ✅ Working | `wss://panda.tail7af24.ts.net:7443` |
| Playground | agents-playground.livekit.io | ✅ Working | Token auth, real-time conversation from phone |

### Voice Agent Code

```python
from livekit.agents import Agent, AgentSession, WorkerOptions, cli
from livekit.plugins import deepgram, elevenlabs, openai, silero

class JoelclawAgent(Agent):
    def __init__(self):
        super().__init__(
            instructions="You are joelclaw, a helpful voice assistant. "
                        "Be concise, conversational, and friendly."
        )

async def entrypoint(ctx):
    session = AgentSession(
        stt=deepgram.STT(),
        llm=openai.LLM.with_openrouter(model="anthropic/claude-sonnet-4.6"),
        tts=elevenlabs.TTS(),
        vad=silero.VAD.load(),
    )
    await session.start(agent=JoelclawAgent(), room=ctx.room)
    session.generate_reply(
        user_input="The user just joined. Say hi briefly."
    )

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
```

### System Integration via @function_tool

LiveKit agents support `@function_tool` decorators that let the LLM call tools mid-conversation. This is how the voice agent gets access to joelclaw tooling:

```python
from livekit.agents import function_tool

@function_tool
async def check_calendar(day: str = "today") -> str:
    """Check Joel's calendar for a specific day."""
    result = subprocess.run(["gog", "cal", "events", "list", "--day", day],
                          capture_output=True, text=True)
    return result.stdout

@function_tool
async def add_task(description: str, project: str = "inbox") -> str:
    """Add a task to Joel's task list."""
    # Todoist API or joelclaw event
    await inngest.send({"name": "task/created",
                       "data": {"description": description, "project": project}})
    return f"Task added: {description}"

@function_tool
async def check_system_health() -> str:
    """Check the health of joelclaw infrastructure."""
    # kubectl, redis, inngest health checks
    return "All 5 pods running, worker healthy, 28 functions registered"

@function_tool
async def search_vault(query: str) -> str:
    """Search the Obsidian vault for notes matching a query."""
    # Qdrant semantic search
    return search_results
```

These tools let the agent do things like:
- "What's on my calendar?" → `check_calendar()`
- "Add a task to deploy the media pipeline" → `add_task()`
- "Is the system healthy?" → `check_system_health()`
- "What did we decide about the NAS layout?" → `search_vault()`

### Cost

| Component | Cost | Notes |
|-----------|------|-------|
| LiveKit server | $0 | Self-hosted, Apache 2.0 |
| Deepgram STT | $0.0043/min | Pay-as-you-go |
| Claude Sonnet 4.6 | ~$0.10-0.15/5min conversation | Via OpenRouter |
| ElevenLabs TTS | ~$0.018/min | Starter tier characters |
| **Total** | **~$0.03-0.05/min** | **~$0.15-0.25 per 5-min conversation** |

### Implementation Path

**Phase 1: Conversational agent with tools** ← NEXT
- Add `@function_tool` decorators for calendar, tasks, vault search, system health
- Wire up Inngest event emission from voice tools
- Structured artifact extraction post-conversation

**Phase 2: Scheduled conversations**
- Inngest cron: morning briefing, weekly retro
- Agent creates LiveKit room, sends join link via Telegram
- `step.waitForEvent("voice/conversation.ended")` for pipeline continuation

**Phase 3: Telegram voice integration**
- Telegram voice messages → LiveKit room (bridge)
- Or: async voice thread mode (TTS → sendVoice, STT on reply)
- Hybrid: start async, escalate to real-time if needed

**Phase 4: Proactive conversations**
- Agent detects when voice would be useful (stale decisions, long heads-down, blocked tasks)
- "You've been at it for 4 hours. Quick check-in?"
- Notification → Telegram → voice if no text response

### Key Files

| Path | Purpose |
|------|---------|
| `~/Projects/livekit-spike/agent/main.py` | Voice agent code |
| `~/Projects/livekit-spike/agent/run.sh` | Secret-leasing launcher |
| `~/Projects/livekit-spike/values-joelclaw.yaml` | LiveKit Helm values |
| `~/.local/caddy/Caddyfile` | WSS proxy (port 7443) |

### Gotchas Learned

1. **`on_enter` timing**: `session.say()` or `generate_reply()` inside `on_enter` fires before the speech scheduling task is fully initialized. Call `generate_reply()` AFTER `session.start()` returns.

2. **File-based audio testing**: Publishing a .ogg file via `lk room join --publish` doesn't work for VAD turn detection — the track unpublishes before VAD detects end-of-speech. Use the playground with a real mic.

3. **`on_user_turn_completed` signature**: The 1.4.x API passes `(self, turn_ctx, *, new_message=...)`. Overriding with the wrong signature silently crashes the response pipeline.

4. **Caddy port 443 vs Tailscale Funnel**: Both try to bind :443. Caddy must use a high port (9443) or bind to the Tailscale IP explicitly. Funnel owns :443 for public webhooks.

5. **Multi-process architecture**: LiveKit agents spawn child processes per job. `dev` mode captures child logs via IPC; `start` mode doesn't redirect child output to the parent's stdout.

## Consequences

- **Voice is a first-class interaction mode**, not an afterthought. The agent can initiate conversations, not just respond.
- **Self-hosted = full control.** No vendor lock-in on the media server. Swap STT/LLM/TTS providers via plugins.
- **Tool use during conversation** — the killer feature. "Check my calendar" works mid-sentence.
- **Runs on existing infra.** LiveKit is one more pod in the k8s cluster. No new machines, no cloud dependencies.
- **Privacy preserved.** Audio never leaves the tailnet except for API calls to Deepgram/OpenRouter/ElevenLabs. STT could go local (mlx-whisper plugin) for full offline.
- **WebRTC is the right transport.** Works in browsers, native apps, and eventually SIP/phone. WebSocket voice was a dead end.

## Credits

- [LiveKit](https://livekit.io/) — Agents framework, self-hosted media server, Apache 2.0
- [Deepgram](https://deepgram.com/) — STT with ~180ms latency
- [ElevenLabs](https://elevenlabs.io/) — TTS, voice identity
- [OpenRouter](https://openrouter.ai/) — LLM gateway routing to Claude Sonnet 4.6
- [Silero](https://github.com/snakers4/silero-vad) — Voice Activity Detection
- Inngest — Durable workflow engine for conversation orchestration

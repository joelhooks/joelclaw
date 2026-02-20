---
title: "Getting a Voice Agent to Actually Fucking Work: A Deep Dive"
date: "2026-02-20"
description: "48 hours of voice agent deployment — from LiveKit spike to working phone calls. Stephen King nodes, SIP trunks, and why Tailscale can't do everything."
tags:
  - voice
  - livekit
  - agents
  - deployment
  - stephen-king
---

3:53 AM on a Thursday. The voice agent just said "shit's broken" and I couldn't stop laughing. Four hours into debugging why the WebSocket kept dropping, turns out it was trying to route through Colima's VM network instead of Tailscale.

This is the story of getting bidirectional voice conversations working with joelclaw.

## The Promise

ADR-0043 laid out the vision: real-time voice conversations with my AI assistant. Morning briefings while making coffee. End-of-day retrospectives. Spoken decisions captured automatically. The ADR was accepted on February 19th — two days ago.

The plan looked straightforward:
- Self-host LiveKit on the k8s cluster
- Build a Python voice agent with pluggable STT/LLM/TTS
- Hook up function tools for calendar, tasks, vault search
- Get a phone number for SIP inbound calls

What could go wrong?

## Everything That Went Wrong

### WebSocket Hell

The first spike worked in the LiveKit playground. Deepgram transcribed my voice, Claude responded, ElevenLabs spoke back. Success! Time to ship.

Then I tried to run it for real.

```
ConnectionError: WebSocket connection to ws://localhost:7880 failed
```

Localhost. Of course. The agent was running on Overlook (the Mac Mini), but trying to connect to localhost inside the Colima VM. The fix was switching to Tailscale IPs:

```python
# Before: goes nowhere
"ws://localhost:7880"

# After: actually routes
"ws://100.93.201.72:7880"  # Overlook's Tailscale IP
```

### Dev Mode Kills Everything

LiveKit's agent framework has a helpful `dev` mode that watches files and restarts on changes. Except it was killing the agent every 12 seconds:

```
Agent process died (exit_code=15)
... 12 seconds later ...
Agent process died (exit_code=15)
```

The file watcher was seeing its own log files change and restarting in an infinite loop. Switched to `start` mode. Problem solved.

### SIP Trunk Format Wars

Telnyx lets you configure phone numbers in multiple formats:
- `+13606051697`
- `13606051697`
- `3606051697`

LiveKit SIP accepts any format when creating trunks. But when an actual call comes in, it tries to match ALL configured formats. If you have the same number in two formats, you get:

```
Multiple SIP Trunks matched for number +13606051697
```

And the call fails. Had to delete and recreate everything with a single format.

### Voice Not Found

ElevenLabs has this neat library of voices. You can preview them, get their IDs, everything looks great. Then you try to use one:

```json
{
  "error": "voice_id_does_not_exist: pg7Nd5b8Y3tnfSndq5lh"
}
```

Turns out you need to "Add to My Voices" in the ElevenLabs UI first. The voice exists, the API can see it, but it can't USE it until you claim it. Not documented anywhere.

### No UDP on Tailscale Funnel

The original plan was to use Tailscale Funnel for the SIP trunk. Clean, simple, no public IPs needed. One problem:

**Funnel only does TCP on ports 443, 8443, and 10000.**

SIP needs UDP on 5060 and 10000-20000 for RTP media. No dice.

## The Stephen King Network

That's where our Stephen King nodes came in. The joelclaw network uses Dark Tower character names:

- **Overlook** (panda) — Mac Mini running everything
- **Derry** (three-body) — 64TB NAS for archives
- **Blaine** (clanker-001) — DigitalOcean droplet with a real public IP

Blaine saved the day. Spun up a $6/month droplet, gave it a public IP, and ran LiveKit's SIP service there:

```yaml
# docker-compose on clanker-001
services:
  livekit-sip:
    image: livekit/sip:v0.2.0
    environment:
      LIVEKIT_URL: ws://100.93.201.72:7880  # Overlook via Tailscale
      LIVEKIT_API_KEY: joelclaw_da7b9907
      USE_JITTER_BUFFER: true  # Fixed choppy audio
```

Now SIP traffic hits Blaine's public IP, which forwards to Overlook over the Tailscale mesh. Best of both worlds.

## What Actually Works Now

As of 4:13 AM this morning:

### Voice Agent Running

```bash
~/Projects/joelclaw-voice-agent/run.sh
```

Python process with Panda's personality loaded from the soul files. Australian accent. Swears naturally. Pre-warm process pool so responses are instant.

### Full Tool Suite

```python
@function_tool
async def check_calendar(day: str = "today") -> str:
    """Check Joel's calendar for a specific day."""
    result = subprocess.run(
        ["gog", "cal", "events", "list", "--day", day],
        capture_output=True, text=True, env=_tool_env()
    )
    return _clean_gog_output(result.stdout)
```

Eight tools wired up: calendar (full CRUD), tasks (via todoist-cli), email check, vault search, system health, Inngest events, current time, and voice switching.

### Caller Security

```python
ALLOWED_CALLERS = {"8176756031"}  # Joel's number

def _extract_caller(room_name: str) -> str:
    match = re.search(r"sip_(\d+)", room_name)
    return match.group(1) if match else "unknown"

# In entrypoint
caller = _extract_caller(ctx.room.name)
if caller not in ALLOWED_CALLERS:
    # Brief "not accepting calls" message
    return
```

Unknown callers get a polite fuck-off. Joel gets Panda.

### Outbound Calling Works Too

```bash
lk sip participant create \
  --trunk ST_cMFCXnachDG8 \
  --call +18176756031 \
  --room voice-outbound-joel
```

Agent joins the outbound room automatically. Voice callback architecture is designed but not built yet — gateway sees `callback: "voice"` in completion events and initiates the call.

## The Numbers

- **Phone**: +1 (360) 605-1697 ($1/month from Telnyx)
- **Latency**: ~1-2 seconds turn-to-turn
- **Cost**: ~$0.03-0.05 per minute (Deepgram + Claude + ElevenLabs)
- **Uptime**: Survived the whole night, still running

## slogs Tell the Story

```bash
slog tail --count 50 | grep voice
```

```json
{
  "timestamp": "2026-02-20T02:41:52.455Z",
  "action": "configure",
  "tool": "telnyx",
  "detail": "Swapped phone number from Portland 971 to 360 area code",
  "reason": "Joel is in 360 area code"
}
{
  "timestamp": "2026-02-20T03:53:22.123Z", 
  "action": "configure",
  "tool": "voice-agent",
  "detail": "Fixed voice agent stability: dev→start mode, localhost→tailscale IP, VAD 0.5→0.85",
  "reason": "Agent dying every 12s, WebSocket drops, room noise"
}
```

The system log captures every config change. When something breaks in 6 months, I'll know exactly what we did.

## What's Next

Phase 1 is done — bidirectional voice conversations work. Next up:

**Phase 2: Scheduled conversations** — Morning briefings via cron, weekly retros that create rooms and send join links

**Phase 3: Telegram voice integration** — Voice messages to/from the bot, or escalate text threads to voice

**Phase 4: Proactive check-ins** — "You've been coding for 4 hours straight. Quick break?"

The voice agent runs 24/7 now, waiting for calls. Panda's always there when I need to talk through a problem. Even if the first words are usually "what the fuck do you want now?"

That's the Australian charm.

---

*This is part of the joelclaw deployment series. The system continues to evolve — follow along at [github.com/joelhooks/joelclaw](https://github.com/joelhooks/joelclaw).*
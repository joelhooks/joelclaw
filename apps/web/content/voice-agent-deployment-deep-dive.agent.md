# Voice Agent Implementation Details (Agent Version)

This file contains implementation specifics for agents working on the voice system. Humans should read the .mdx version instead.

## System Components

### LiveKit Server (Talos k8s cluster)
```yaml
# Deployed via Helm
helm repo add livekit https://helm.livekit.io
helm install livekit livekit/livekit-server -n joelclaw \
  --set config.rtc.port_range_start=50000 \
  --set config.rtc.port_range_end=60000 \
  --set service.rtc.type=NodePort \
  --set service.rtc.nodePort=7881
```

Access: `ws://100.93.201.72:7880` (Tailscale IP)
API Key: Check `agent-secrets` for `livekit_api_key`

### SIP Gateway (DigitalOcean droplet)
Location: `clanker-001` (104.248.180.116)
```yaml
# docker-compose.yml
services:
  livekit-sip:
    image: livekit/sip:v0.2.0
    restart: unless-stopped
    ports:
      - "5060:5060/udp"
      - "5060:5060/tcp"  
      - "10000-20000:10000-20000/udp"
    environment:
      LIVEKIT_URL: ws://100.93.201.72:7880
      LIVEKIT_API_KEY: ${LIVEKIT_API_KEY}
      LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET}
      USE_JITTER_BUFFER: true  # Critical for call quality
```

### Voice Agent (Python)
Location: `~/Projects/joelclaw-voice-agent/`

Key dependencies:
```toml
[project]
dependencies = [
    "livekit-agents==1.4.2",
    "livekit-plugins-deepgram==1.0.1", 
    "livekit-plugins-openai==1.1.0",
    "livekit-plugins-elevenlabs==1.2.1",
    "livekit-plugins-silero==1.0.1",
    "PyYAML==6.0.1",
]
```

### Telnyx Configuration
- IP Connection ID: `2899183095162864670`
- Outbound Voice Profile ID: `2899183294761403445`
- Phone Number: `+13606051697`
- SIP Trunks:
  - Outbound: `ST_cMFCXnachDG8`
  - Inbound: `ST_WPNTEP3DPPPw`
- Dispatch Rule: `SDR_JC5Lbm2cyFqi`

## Critical Configuration

### VAD Settings (main.py)
```python
vad = silero.VAD.load(
    min_speech_duration=0.2,      # Tested values: 0.1 too sensitive, 0.3 too slow
    min_silence_duration=0.7,     # Tested: 0.5 cuts off thinking, 0.9 feels laggy
    activation_threshold=0.85     # Critical: 0.5 triggers on room noise
)
```

### ElevenLabs Voice
Voice ID: `pg7Nd5b8Y3tnfSndq5lh`
**IMPORTANT**: Must be added to "My Voices" in ElevenLabs dashboard first or API returns `voice_id_does_not_exist`

### Caller Security
```python
ALLOWED_CALLERS = {"8176756031"}  # Joel's number only
# Extracted from room name format: sip_PHONENUMBER
```

## Troubleshooting

### Worker Not Responding
```bash
# Agent defaulted to localhost - must use Tailscale IP
curl http://100.93.201.72:7880/health
```

### Dev Mode Instability
Never use `python main.py dev` - file watcher kills agent every 12s detecting its own logs

### Multiple SIP Trunk Match Error
Ensure single phone number format in Telnyx. Delete duplicates:
```bash
lk sip trunk delete <trunk_id>
```

### Testing Outbound Calls
```bash
lk sip participant create \
  --trunk ST_cMFCXnachDG8 \
  --call +1XXXXXXXXXX \
  --room voice-outbound-test
```

## Function Tools

Tools available to voice agent (defined in main.py):
- `check_calendar(day)` - Uses gog CLI
- `create_calendar_event(title, start, end, description, location, attendees, all_day)`
- `delete_calendar_event(event_id, calendar_id)`
- `list_tasks(filter, label, project, today, inbox)`
- `search_tasks(query)`
- `add_task(content, due, labels, priority, project)`
- `complete_task(task_id)`
- `show_task(task_id)`
- `comment_on_task(task_id, content)`
- `check_system_health()`
- `search_vault(query, limit)`
- `check_email(query, limit)`
- `send_event(event_name, data)`
- `check_runs(limit)`
- `check_run(run_id)`
- `list_voices()`, `switch_voice()`, `save_voice()`, `adjust_voice()`, `sample_voices()`

## Secrets Required

All in `agent-secrets`:
- `livekit_api_key` / `livekit_api_secret`
- `openrouter_api_key` (for Claude)
- `elevenlabs_api_key`
- `deepgram_api_key`
- `gog_keyring_password` (for calendar/email tools)
- `todoist_cli_token`

## Monitoring

Logs: `/tmp/joelclaw/voice-agent.log`
Process check: `ps aux | grep "python main.py start"`
LiveKit room debug: `lk room list`

## Known Issues

1. Latency is 1-2 seconds - mostly ElevenLabs TTS generation time
2. Interruption handling is janky - VAD not tuned for natural conversation
3. Memory usage grows over time - agent process should be restarted daily
4. No automatic reconnect on network drops - requires manual restart
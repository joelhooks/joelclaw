# joelclaw Voice Agent

Bidirectional voice conversations with system tool access. ADR-0043 + ADR-0154.

## Source of truth

This runtime now lives in the monorepo:
- `infra/voice-agent/main.py`
- `infra/voice-agent/run.sh`
- `infra/voice-agent/config.default.yaml`

## Config (PII-safe)

Runtime config path (default):
- `~/.config/joelclaw/voice-agent.yaml`

Repo file `config.default.yaml` is safe to commit and contains no caller PII.

Add your allowlist locally:

```yaml
security:
  allowed_callers:
    - "+18176756031"
```

Caller matching is normalized and fail-closed.

## Run

```bash
cd ~/Code/joelhooks/joelclaw/infra/voice-agent
./run.sh dev
./run.sh start
```

## launchd

`com.joel.voice-agent` executes:
- `/Users/joel/Code/joelhooks/joelclaw/infra/voice-agent/start.sh`

## Secrets required

Leased via `agent-secrets` in `run.sh`:
- `livekit_api_key`, `livekit_api_secret`
- `openrouter_api_key`
- `deepgram_api_key`
- `elevenlabs_api_key`
- `gog_keyring_password`

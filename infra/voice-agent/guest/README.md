# Voice worker in a Linux guest

The LiveKit voice worker can run off the operator Mac, in a Debian LXC guest, as `voice-agent.service` under user `voiceworker`. Host names, the container id and the gate address live in a private env file on the operator host (`~/.config/joelclaw/voice-worker-host.env`), never in this repo:

```sh
VOICE_GUEST_HOST=root@<proxmox host>   # ssh target that can run pct
VOICE_GUEST_CT=<container id>
VOICE_FLAGG_HOST=_voicetools@<operator host>   # the tool gate, see ../REMOTE-TOOLS.md
```

| Piece | In the guest |
|---|---|
| Code | `/opt/voice-agent`, from a committed rev (`.source-rev`) |
| Python | uv-managed CPython 3.14 in `/opt/uv-python`; venv from `uv sync --frozen` |
| Models | `/var/lib/voiceworker/.cache/huggingface`, fetched at deploy; `HF_HUB_OFFLINE=1` at run |
| Config | `/etc/voice-agent/cfg/voice-agent.yaml`, a copy of the operator's `~/.config/joelclaw/voice-agent.yaml` |
| Secrets | `/etc/voice-agent/env`, root 0600, written by `push-env.sh` from agent-secrets over ssh stdin |
| Probe | `voice-verify.timer` runs `verify.py` every 15 min; result in the journal and `/var/lib/voiceworker/verify-voice.json` |

- Deploy: `guest/deploy.sh [rev]`. Installs the units, swaps code, restarts and runs `canary.sh`.
- Secrets changed: `guest/push-env.sh`, then restart `voice-agent.service` in the guest.
- Logs: `journalctl -u voice-agent -n 100` and `journalctl -u voice-verify` in the guest.
- Rollback to the Mac: stop `voice-agent.service` in the guest first, so only one worker answers, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.joel.voice-agent.plist`.
- Never run a bare `uv run` in a copy of this directory that has no venv. `requires-python` and `.python-version` pin 3.14 because uv otherwise picks the newest Python on the box (Homebrew 3.15), where `livekit-blingfire` has no wheel.

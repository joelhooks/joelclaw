"""Run Flagg-bound voice tools on Flagg when the worker runs elsewhere.

With VOICE_FLAGG_HOST unset (the worker is on Flagg), commands run locally,
unchanged. With it set, each tool call becomes a logical argv (tool names,
not paths) sent as JSON on stdin to the Flagg gate, voice_remote_gate.py,
which allowlists and runs it. The ssh connection is kept warm, so a tool
call pays one round trip, not a handshake.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

GATE_REFUSED = 126


def remote_host() -> str | None:
    return os.environ.get("VOICE_FLAGG_HOST") or None


def logical(cmd: list[str]) -> list[str]:
    """A local argv as the gate's logical form: tool names instead of paths."""
    exe = Path(cmd[0]).name
    if exe == "node" and len(cmd) > 1:
        script = Path(cmd[1]).name
        name = {"muster-digest.ts": "muster-digest", "message-shitrat.mjs": "message-shitrat"}.get(script, script)
        return ["node-script", name, *cmd[2:]]
    if exe == "git" and len(cmd) > 2 and cmd[1] == "-C":
        return ["brain-git", *cmd[3:]]
    return [exe, *cmd[1:]]


def ssh_argv(host: str) -> list[str]:
    control = Path.home() / ".ssh" / "voice-flagg-%C"
    return [
        "ssh", "-T",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=3",
        "-o", "ControlMaster=auto",
        "-o", f"ControlPath={control}",
        "-o", "ControlPersist=10m",
        "-o", "ServerAliveInterval=15",
        host,
    ]


def wrap(cmd: list[str]) -> tuple[list[str], str | None]:
    """(argv to run here, stdin to feed it). Local: (cmd, None)."""
    host = remote_host()
    if not host:
        return cmd, None
    return ssh_argv(host), json.dumps(logical(cmd))

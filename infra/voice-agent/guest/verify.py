"""Voice worker probe for the Linux guest (the guest-side verify-voice).

Runs in the worker's own venv under voice-verify.timer. Prints one ok/fail/warn
line per check, writes the result to ~/verify-voice.json, and exits 1 when any
hard check fails. A failing tool gate is a warning: calls still work, only the
operator-host tools degrade.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

STATE = Path.home() / "verify-voice.json"
DISPATCH_WAIT_S = 45
INIT_ALARM_S = 10.0


def unit_active() -> tuple[bool, str]:
    r = subprocess.run(["systemctl", "show", "voice-agent", "-p", "ActiveState,NRestarts"],
                       capture_output=True, text=True, timeout=10)
    props = dict(line.split("=", 1) for line in r.stdout.split() if "=" in line)
    restarts = int(props.get("NRestarts", "0") or 0)
    prev = _prev().get("restarts")
    detail = f"{props.get('ActiveState')} restarts={restarts}"
    if props.get("ActiveState") != "active":
        return False, detail
    if prev is not None and restarts - prev >= 3:
        return False, f"{detail} (crash loop: +{restarts - prev} since last probe)"
    return True, detail


def models_offline() -> tuple[bool, str]:
    from huggingface_hub import hf_hub_download
    from livekit.plugins.turn_detector.models import HG_MODEL, MODEL_REVISIONS, ONNX_FILENAME

    path = hf_hub_download(HG_MODEL, ONNX_FILENAME, subfolder="onnx",
                           revision=MODEL_REVISIONS["en"], local_files_only=True)
    return True, Path(path).name


def config_has_callers() -> tuple[bool, str]:
    import os

    import yaml

    with open(os.environ["JOELCLAW_VOICE_CONFIG"]) as f:
        data = yaml.safe_load(f) or {}
    callers = (data.get("security") or {}).get("allowed_callers")
    ok = isinstance(callers, list) and any(str(v).strip() for v in callers)
    return ok, f"{len(callers or [])} entries"


def slow_inits() -> tuple[bool, str]:
    """Alarm, don't kill: job-process inits past INIT_ALARM_S in the last 20 minutes."""
    r = subprocess.run(["journalctl", "-u", "voice-agent", "--since", "-20min", "-o", "cat", "--no-pager"],
                       capture_output=True, text=True, timeout=20)
    times = []
    for line in r.stdout.splitlines():
        if '"process initialized"' in line:
            try:
                times.append(float(json.loads(line).get("elapsed_time", 0)))
            except (ValueError, json.JSONDecodeError):
                pass
    worst = max(times, default=0.0)
    return worst <= INIT_ALARM_S, f"worst init {worst:.2f}s over {len(times)} inits"


async def _dispatch() -> tuple[bool, str]:
    from livekit import api

    room = f"canary-verify-guest-{int(time.time())}"
    lk = api.LiveKitAPI()
    try:
        await lk.room.create_room(api.CreateRoomRequest(name=room))
        started = time.monotonic()
        while time.monotonic() - started < DISPATCH_WAIT_S:
            res = await lk.room.list_participants(api.ListParticipantsRequest(room=room))
            if any(p.identity.startswith("agent-") for p in res.participants):
                return True, f"agent joined {room} after {time.monotonic() - started:.0f}s"
            await asyncio.sleep(2)
        return False, f"no agent-* participant joined {room} within {DISPATCH_WAIT_S}s"
    finally:
        try:
            await lk.room.delete_room(api.DeleteRoomRequest(room=room))
        finally:
            await lk.aclose()


def dispatch() -> tuple[bool, str]:
    return asyncio.run(_dispatch())


def tool_gate() -> tuple[bool, str]:
    import flagg_remote

    if not flagg_remote.remote_host():
        return False, "VOICE_FLAGG_HOST unset"
    argv, stdin = flagg_remote.wrap(["joelclaw", "status"])
    r = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=30)
    return r.returncode == 0, f"exit {r.returncode}"


def _prev() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


HARD = [("voice-agent unit active", unit_active), ("turn-detector model resolves offline", models_offline),
        ("voice config has allowed callers", config_has_callers), ("LiveKit worker dispatch", dispatch)]
SOFT = [("job process inits under 10s", slow_inits), ("operator tool gate answers", tool_gate)]


def main() -> int:
    results, failures, warnings = [], [], []
    for group, checks in (("hard", HARD), ("soft", SOFT)):
        for name, fn in checks:
            try:
                ok, detail = fn()
            except Exception as e:  # a probe that throws is a failed check, with its reason
                ok, detail = False, f"{type(e).__name__}: {str(e)[:200]}"
            tag = "ok" if ok else ("fail" if group == "hard" else "warn")
            print(f"{tag:<5}{name}: {detail}", flush=True)
            results.append({"check": name, "status": tag, "detail": detail})
            if not ok:
                (failures if group == "hard" else warnings).append(name)
    restarts = None
    try:
        r = subprocess.run(["systemctl", "show", "voice-agent", "-p", "NRestarts", "--value"],
                           capture_output=True, text=True, timeout=10)
        restarts = int(r.stdout.strip() or 0)
    except (ValueError, subprocess.SubprocessError):
        pass
    STATE.write_text(json.dumps({"ts": datetime.now(UTC).isoformat(timespec="seconds"),
                                 "ok": not failures, "failures": failures, "warnings": warnings,
                                 "restarts": restarts, "results": results}, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

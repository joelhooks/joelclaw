"""Non-blocking Convex live-call telemetry.

Environment:
  CONVEX_URL: self-hosted Convex deployment URL (module disables itself if absent).
  CONVEX_ADMIN_KEY: optional self-hosted deploy/admin key used as bearer auth when
  supported by the installed client. Never required on the call-answering path.

Every public write only submits background work. Remote calls have a one-second
caller-side deadline; failures are silently dropped. Three consecutive failures
open a 30-second circuit before one recovery probe is allowed.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from typing import Any

from convex import ConvexClient

_TIMEOUT_S = 1.0
_HEARTBEAT_S = 5.0
_FAILURE_LIMIT = 3
_RECOVERY_PROBE_S = 30.0
_dispatch_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="call-tracker-dispatch")
_remote_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="call-tracker-remote")
_lock = threading.Lock()
_failures = 0
_disabled_until = 0.0
_client: ConvexClient | None = None


def _get_client() -> ConvexClient | None:
    global _client
    url = os.environ.get("CONVEX_URL", "").strip()
    if not url:
        return None
    if _client is None:
        _client = ConvexClient(url)
        admin_key = os.environ.get("CONVEX_ADMIN_KEY", "").strip()
        if admin_key and hasattr(_client, "set_admin_auth"):
            _client.set_admin_auth(admin_key)  # type: ignore[attr-defined]
    return _client


def _call_mutation(name: str, args: dict[str, Any]) -> None:
    global _failures, _disabled_until
    with _lock:
        if time.monotonic() < _disabled_until:
            return
    client = _get_client()
    if client is None:
        return
    remote = _remote_executor.submit(client.mutation, name, args)
    try:
        remote.result(timeout=_TIMEOUT_S)
    except (Exception, TimeoutError):
        remote.cancel()
        with _lock:
            _failures += 1
            if _failures >= _FAILURE_LIMIT:
                _disabled_until = time.monotonic() + _RECOVERY_PROBE_S
        return
    with _lock:
        _failures = 0
        _disabled_until = 0.0


def _fire(name: str, args: dict[str, Any]) -> None:
    _dispatch_executor.submit(_call_mutation, name, args)


def _caller_hash(caller: str) -> str:
    return hashlib.sha256(caller.strip().encode("utf-8")).hexdigest()[:12] if caller.strip() else "anonymous"


def track_session_start(room: str, tier: str, caller: str) -> None:
    _fire("calls:upsertSessionStart", {
        "room": room, "tier": tier, "callerHash": _caller_hash(caller), "startedAt": int(time.time() * 1000)
    })


def track_turn(room: str, **metrics: Any) -> None:
    allowed = {"idx", "eouDelayMs", "llmTtftMs", "ttsTtfbMs", "toolCalls", "transcriptLine", "ts"}
    payload = {key: value for key, value in metrics.items() if key in allowed and value is not None}
    payload["room"] = room
    payload.setdefault("ts", int(time.time() * 1000))
    _fire("calls:addTurn", payload)


def track_session_end(room: str, reason: str) -> None:
    _fire("calls:endSession", {"room": room, "reason": reason, "endedAt": int(time.time() * 1000)})


def _heartbeat(room: str) -> None:
    _fire("calls:heartbeat", {"room": room, "ts": int(time.time() * 1000)})


async def _heartbeat_loop(room: str) -> None:
    while True:
        _heartbeat(room)
        await asyncio.sleep(_HEARTBEAT_S)


def start_heartbeat(room: str) -> asyncio.Task[None]:
    return asyncio.create_task(_heartbeat_loop(room), name=f"convex-heartbeat:{room}")

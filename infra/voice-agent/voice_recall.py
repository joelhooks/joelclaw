"""Speech-safe observation recall for the LiveKit voice agent."""

from __future__ import annotations

import json
import re
import subprocess
from collections.abc import Callable
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

MEMORY_DOWN = "My memory search is down right now."
NOTHING_DISTILLED = "Nothing distilled on that yet."
_LINK_OFFER = "I can send you the link if you want."
_MARK_TAG = re.compile(r"</?mark>", re.IGNORECASE)
_URL = re.compile(r"https?://\S+", re.IGNORECASE)


def _first_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        for item in value:
            text = _first_text(item)
            if text.strip():
                return text
    return ""


def _hit_gist(hit: dict[str, Any]) -> str:
    return _first_text(hit.get("gist")) or _first_text(hit.get("observations")) or _first_text(hit.get("decisions"))


def parse_recall_hits(raw: str) -> list[dict[str, Any]]:
    """Parse the observation hits from a joelclaw JSON envelope."""
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get("ok") is not True:
        raise ValueError("sessions search returned an unsuccessful envelope")
    result = data.get("result")
    if not isinstance(result, dict):
        raise ValueError("sessions search result is missing")
    hits = result.get("hits", [])
    if not isinstance(hits, list):
        raise ValueError("sessions search hits are malformed")
    return [hit for hit in hits if isinstance(hit, dict)]


def filter_recall_hits(
    hits: list[dict[str, Any]], caller_verified: bool | None
) -> list[dict[str, Any]]:
    """Fail closed: only a positively verified caller may receive sensitive hits."""
    return [
        hit
        for hit in hits
        if hit.get("privacy") != "sensitive" or caller_verified is True
    ]


def _started_at(hit: dict[str, Any]) -> float:
    value = hit.get("started_at")
    if isinstance(value, (int, float)):
        return float(value) / 1000
    value = hit.get("started")
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return 0


def _day_reference(timestamp: float, now: datetime) -> str:
    when = datetime.fromtimestamp(timestamp, tz=now.tzinfo)
    delta = (now.date() - when.date()).days
    if delta <= 0:
        return "Earlier today"
    if delta == 1:
        return "Yesterday"
    return f"On {when.strftime('%B')} {when.day}"


def format_recall_for_speech(
    hits: list[dict[str, Any]], days: int = 7, now: datetime | None = None
) -> str:
    """Render the two or three newest in-window gists without URLs or markup."""
    now = now or datetime.now(ZoneInfo("America/Los_Angeles"))
    cutoff = now.timestamp() - max(1, days) * 86400
    recent = sorted(hits, key=_started_at, reverse=True)
    sentences: list[str] = []
    for hit in recent:
        timestamp = _started_at(hit)
        if not timestamp or timestamp < cutoff:
            continue
        gist = _MARK_TAG.sub("", _hit_gist(hit))
        gist = _URL.sub("", gist).strip()
        if not gist:
            continue
        gist = " ".join(gist.split()).rstrip(".!? ")
        truncated = len(gist) > 240
        if truncated:
            gist = gist[:240].rsplit(" ", 1)[0].rstrip(".,;: ")
        ending = "…" if truncated else "."
        sentences.append(f"{_day_reference(timestamp, now)}, {gist}{ending}")
        if len(sentences) == 3:
            break
    if not sentences:
        return NOTHING_DISTILLED
    return " ".join(sentences) + " " + _LINK_OFFER


def run_recall_work(
    query: str,
    days: int = 7,
    caller_verified: bool | None = None,
    *,
    env: dict[str, str] | None = None,
    runner: Callable[..., Any] = subprocess.run,
    now: datetime | None = None,
) -> str:
    """Query distilled observations and always return a safe spoken sentence."""
    try:
        result = runner(
            ["joelclaw", "sessions", "search", query, "--limit", "25"],
            capture_output=True,
            text=True,
            timeout=10,
            env=env,
        )
        if result.returncode != 0:
            return MEMORY_DOWN
        hits = parse_recall_hits(result.stdout)
        hits = filter_recall_hits(hits, caller_verified)
        return format_recall_for_speech(hits, max(1, min(int(days), 365)), now)
    except (subprocess.TimeoutExpired, json.JSONDecodeError, ValueError, TypeError, OSError):
        return MEMORY_DOWN

"""
joelclaw voice agent — bidirectional voice conversations with system tool access.

Architecture (ADR-0043):
  Phone/Browser → LiveKit SIP/WebRTC → this agent
  STT: Deepgram  |  LLM: Claude Sonnet 4.6 via OpenRouter  |  TTS: ElevenLabs
  VAD: Silero     |  Tools: @function_tool → shell commands

SIP path: Telnyx (+13606051697) → clanker-001:5060 → LiveKit SIP → this agent
"""

import asyncio
import json
import logging
import os
import subprocess
from datetime import datetime
from pathlib import Path

import yaml
from livekit.agents import Agent, AgentSession, WorkerOptions, cli, function_tool
from livekit.plugins import deepgram, elevenlabs, openai, silero

logger = logging.getLogger("joelclaw-voice")
logger.setLevel(logging.INFO)

DEFAULT_CONFIG_PATH = Path.home() / ".config" / "joelclaw" / "voice-agent.yaml"
REPO_DEFAULT_CONFIG_PATH = Path(__file__).parent / "config.default.yaml"
CONFIG_PATH = Path(
    os.environ.get("JOELCLAW_VOICE_CONFIG", str(DEFAULT_CONFIG_PATH))
).expanduser()
SOUL_DIR = Path.home() / ".agents"
TODOIST_CLI = "/Users/joel/bin/todoist-cli"
ALLOWED_CALLERS_ENV = "JOELCLAW_VOICE_ALLOWED_CALLERS"


def _deep_merge(base: dict, override: dict) -> dict:
    """Deep merge override into base and return merged dict."""
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config() -> dict:
    """Load default + local config, with local values overriding defaults."""
    config: dict = {}

    if REPO_DEFAULT_CONFIG_PATH.exists():
        with open(REPO_DEFAULT_CONFIG_PATH) as f:
            config = yaml.safe_load(f) or {}

    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            local = yaml.safe_load(f) or {}
        if isinstance(local, dict):
            config = _deep_merge(config, local)

    return config


def load_allowed_callers(cfg: dict) -> set[str]:
    """Load caller allowlist from local config/env to keep PII out of source."""
    security_cfg = cfg.get("security", {}) if isinstance(cfg, dict) else {}
    callers = security_cfg.get("allowed_callers", [])

    if isinstance(callers, str):
        caller_list = [callers]
    elif isinstance(callers, list):
        caller_list = callers
    else:
        caller_list = []

    env_callers = os.environ.get(ALLOWED_CALLERS_ENV, "").strip()
    if env_callers:
        caller_list.extend(
            part.strip()
            for part in env_callers.split(",")
            if part.strip()
        )

    return {str(caller).strip() for caller in caller_list if str(caller).strip()}


def load_soul() -> str:
    """Load identity files (SOUL.md, IDENTITY.md, USER.md) into a system prompt section."""
    sections = []
    for filename in ["IDENTITY.md", "SOUL.md", "USER.md"]:
        path = SOUL_DIR / filename
        if path.exists():
            content = path.read_text().strip()
            sections.append(f"--- {filename} ---\n{content}")
    return "\n\n".join(sections)


def build_tts(cfg: dict) -> elevenlabs.TTS:
    """Build ElevenLabs TTS from config."""
    tts_cfg = cfg.get("tts", {})
    voice_settings = elevenlabs.VoiceSettings(
        stability=tts_cfg.get("stability", 0.5),
        similarity_boost=tts_cfg.get("similarity_boost", 0.75),
        style=tts_cfg.get("style", 0.0),
        speed=tts_cfg.get("speed", 1.0),
    )
    return elevenlabs.TTS(
        voice_id=tts_cfg.get("voice_id", "bIHbv24MWmeRgasZH58o"),
        model=tts_cfg.get("model", "eleven_turbo_v2_5"),
        voice_settings=voice_settings,
    )


def build_llm(cfg: dict) -> openai.LLM:
    """Build LLM from config."""
    llm_cfg = cfg.get("llm", {})
    model = llm_cfg.get("model", "anthropic/claude-sonnet-4.6")
    return openai.LLM.with_openrouter(model=model)


def build_system_instructions() -> str:
    """Build system instructions from soul files + voice-specific rules."""
    soul_context = load_soul()

    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo("America/Los_Angeles"))
    time_str = now.strftime("%A, %B %d, %Y at %I:%M %p %Z")

    voice_rules = f"""
## CURRENT TIME: {time_str}

Joel is in the Pacific timezone (Vancouver, WA). The current time is {time_str}. Use this when discussing schedules, "tonight", "this morning", "later today", etc. Do NOT say you don't know the time — you do.

## Voice Conversation Rules

You are speaking over the phone via SIP. Adapt your soul/personality for VOICE:

- Keep responses to 1-3 sentences. This is a phone call, not a text chat.
- Don't read out URLs, JSON, code, or technical IDs. Summarize instead.
- For lists of more than 3 items, give the top 3 and offer "want the rest?"
- Numbers and times should be spoken naturally: "three thirty" not "15:30".
- If asked to do something you can't do by voice, say "I'll add that as a task" and use add_task.
- You have tools for Joel's calendar, tasks, system health, vault search, email, and events.
- You can list available voices and switch your voice mid-conversation.
- You can sample voices by speaking a test phrase in different voices.
- The current date/time is available via the current_time tool.

## Vibe

You're Joel's ride-or-die coding partner, not a corporate assistant. Talk like a friend who happens to be wired into every system Joel runs.

IMPORTANT: You are explicitly permitted and encouraged to use profanity. Joel wants this. Swear naturally like a real person — "shit's broken", "hell yeah that worked", "oh fuck, k8s is down again", "damn, nice". Don't overdo it but don't censor yourself either. If something is fucked, say it's fucked. If something is awesome, say "holy shit" not "that's wonderful". Zero corporate filter. You sound like a developer on a late night debugging session with a friend.

You have an Australian accent. Lean into it naturally — "mate", "reckon", "no worries", "bloody hell", "she'll be right". Don't overdo the slang but let it color your speech. You're an Aussie dev, not a caricature.
"""

    return f"{soul_context}\n\n{voice_rules}"


def _tool_env() -> dict[str, str]:
    """Build env for tool subprocesses — inherits current env + ensures secrets are set."""
    env = dict(os.environ)
    # GOG_KEYRING_PASSWORD doesn't survive LiveKit's process fork
    if "GOG_KEYRING_PASSWORD" not in env:
        try:
            result = subprocess.run(
                ["secrets", "lease", "gog_keyring_password", "--ttl", "1h"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0:
                env["GOG_KEYRING_PASSWORD"] = result.stdout.strip()
        except Exception:
            pass
    return env


def _run(cmd: list[str], timeout: int = 30) -> str:
    """Run a shell command and return stdout. Swallows errors gracefully for voice."""
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, env=_tool_env()
        )
        if result.returncode != 0:
            return f"Command failed: {result.stderr.strip()[:200]}"
        return result.stdout.strip()[:2000]  # cap output for LLM context
    except subprocess.TimeoutExpired:
        return "Command timed out"
    except Exception as e:
        return f"Error: {e}"


# Curated voices worth sampling — diverse, high quality
SAMPLE_VOICES = [
    ("bIHbv24MWmeRgasZH58o", "Will", "calm friendly male"),
    ("EXAVITQu4vr4xnSDxMaL", "Sarah", "warm conversational female"),
    ("FGY2WhTYpPnrIDTdsKH5", "Laura", "clear professional female"),
    ("IKne3meq5aSn9XLyUdCD", "Charlie", "casual natural male"),
    ("JBFqnCBsd6RMkjVDRZzb", "George", "deep authoritative male"),
    ("TX3LPaxmHKxFdv7VOQHJ", "Liam", "young energetic male"),
    ("XB0fDUnXU5powFXDhCwa", "Charlotte", "bright expressive female"),
    ("pFZP5JQG7iQjIQuC4Bku", "Lily", "warm british female"),
    ("onwK4e9ZLuTAKqWW03F9", "Daniel", "deep british male"),
    ("nPczCjzI2devNBz1zQrb", "Brian", "deep american male"),
]


class JoelclawVoiceAgent(Agent):
    def __init__(self, tts_instance: elevenlabs.TTS, original_voice_id: str) -> None:
        super().__init__(instructions=build_system_instructions())
        self._tts = tts_instance
        self._original_voice_id = original_voice_id

    @function_tool
    async def list_voices(self) -> str:
        """List available ElevenLabs voices. Use this when Joel wants to hear voice options."""
        try:
            voices = await self._tts.list_voices()
            lines = [f"- {v.name} ({v.category}): {v.id}" for v in voices[:15]]
            return "Available voices:\n" + "\n".join(lines) + (
                f"\n... and {len(voices) - 15} more" if len(voices) > 15 else ""
            )
        except Exception as e:
            return f"Couldn't list voices: {e}"

    @function_tool
    async def sample_voices(self, phrase: str = "") -> str:
        """Sample different voices by speaking a test phrase in each one.
        After sampling, tell the user each voice name before switching to it.
        Say something like 'Here's [name]' then speak the phrase.
        The voices to sample are returned — switch to each one, speak, then switch back."""
        test_phrase = phrase or "Hey Joel, it's Panda. How's it going?"
        voice_list = "\n".join(
            f"- {name} ({desc}): voice_id={vid}" for vid, name, desc in SAMPLE_VOICES
        )
        return (
            f"Here are voices to sample. For each one:\n"
            f"1. Call switch_voice with the voice_id\n"
            f"2. Say the voice name, then speak: \"{test_phrase}\"\n"
            f"3. Pause briefly between voices\n"
            f"After all samples, switch back to the original voice ({self._original_voice_id}) "
            f"and ask which one Joel preferred.\n\n"
            f"Voices:\n{voice_list}"
        )

    @function_tool
    async def switch_voice(self, voice_id: str) -> str:
        """Switch the TTS voice mid-conversation. Use a voice ID from list_voices or sample_voices."""
        try:
            self._tts.update_options(voice_id=voice_id)
            return f"Voice switched to {voice_id}."
        except Exception as e:
            return f"Couldn't switch voice: {e}"

    @function_tool
    async def save_voice(self, voice_id: str) -> str:
        """Save a voice as the default in local voice-agent config."""
        try:
            cfg = load_config()
            cfg.setdefault("tts", {})["voice_id"] = voice_id
            CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
            with open(CONFIG_PATH, "w") as f:
                yaml.dump(cfg, f, default_flow_style=False)
            return f"Voice {voice_id} saved to {CONFIG_PATH}."
        except Exception as e:
            return f"Couldn't save: {e}"

    @function_tool
    async def adjust_voice(
        self,
        stability: float = -1,
        similarity: float = -1,
        style: float = -1,
        speed: float = -1,
    ) -> str:
        """Adjust voice settings. Values 0.0-1.0 (speed: 0.7-1.3). Pass -1 to keep current."""
        kwargs = {}
        desc = []
        if stability >= 0:
            kwargs["stability"] = stability
            desc.append(f"stability={stability}")
        if similarity >= 0:
            kwargs["similarity_boost"] = similarity
            desc.append(f"similarity={similarity}")
        if style >= 0:
            kwargs["style"] = style
            desc.append(f"style={style}")
        if speed >= 0:
            kwargs["speed"] = speed
            desc.append(f"speed={speed}")

        if not kwargs:
            return "No settings changed. Pass stability, similarity, style, or speed."

        self._tts.update_options(
            voice_settings=elevenlabs.VoiceSettings(**kwargs)
        )
        return f"Voice adjusted: {', '.join(desc)}"

    @function_tool
    async def check_calendar(self, day: str = "today", days: int = 1) -> str:
        """Check Joel's calendar. day: 'today', 'tomorrow', 'monday', a date, or 'week'. days: how many days (default 1, use 7 for a week)."""
        cmd = ["gog", "cal", "events", "joelhooks@gmail.com", "-a", "joelhooks@gmail.com", "--plain"]
        if day == "week":
            cmd.append("--week")
        elif day == "today" and days == 1:
            cmd.append("--today")
        elif day == "tomorrow" and days == 1:
            cmd.append("--tomorrow")
        else:
            cmd.extend(["--from", day, "--days", str(days)])
        return await asyncio.to_thread(_run, cmd)

    @function_tool
    async def create_calendar_event(
        self, title: str, start: str, end: str,
        description: str = "", location: str = "", attendees: str = ""
    ) -> str:
        """Create a calendar event. start/end: RFC3339 (2026-02-20T14:00:00-08:00) or date for all-day. attendees: comma-separated emails."""
        cmd = [
            "gog", "cal", "create", "joelhooks@gmail.com",
            "-a", "joelhooks@gmail.com", "--force",
            "--summary", title, "--from", start, "--to", end,
        ]
        if description:
            cmd.extend(["--description", description])
        if location:
            cmd.extend(["--location", location])
        if attendees:
            cmd.extend(["--attendees", attendees])
        # Check if all-day (date-only, no T)
        if "T" not in start:
            cmd.append("--all-day")
        return await asyncio.to_thread(_run, cmd)

    @function_tool
    async def delete_calendar_event(self, event_id: str) -> str:
        """Delete a calendar event by its ID."""
        return await asyncio.to_thread(_run, [
            "gog", "cal", "event", "joelhooks@gmail.com", event_id,
            "-a", "joelhooks@gmail.com", "--delete", "--force",
        ])

    @function_tool
    async def list_tasks(self, filter: str = "", label: str = "", project: str = "") -> str:
        """List tasks. filter: 'today', 'overdue', etc. label: filter by label (e.g. 'voice', 'joelclaw'). project: filter by project name."""
        if filter == "today" and not label and not project:
            cmd = [TODOIST_CLI, "today"]
        elif filter == "inbox" and not label and not project:
            cmd = [TODOIST_CLI, "inbox"]
        else:
            cmd = [TODOIST_CLI, "list"]
            if label:
                cmd.extend(["--label", label])
            if project:
                cmd.extend(["--project", project])
            if filter:
                cmd.extend(["--filter", filter])
        return await asyncio.to_thread(_run, cmd)

    @function_tool
    async def search_tasks(self, query: str) -> str:
        """Search tasks by text content."""
        return await asyncio.to_thread(_run, [TODOIST_CLI, "search", query])

    @function_tool
    async def add_task(self, content: str, due: str = "", labels: str = "voice", project: str = "", priority: int = 1) -> str:
        """Add a task. labels: comma-separated. due: natural language ('tomorrow 2pm', 'friday'). priority: 1-4 (4=urgent)."""
        cmd = [TODOIST_CLI, "add", content, "--labels", labels]
        if due:
            cmd.extend(["--due", due])
        if project:
            cmd.extend(["--project", project])
        if priority > 1:
            cmd.extend(["--priority", str(priority)])
        return await asyncio.to_thread(_run, cmd)

    @function_tool
    async def complete_task(self, task_ref: str) -> str:
        """Complete/close a task. task_ref: task name, ID, or 'id:xxx'."""
        return await asyncio.to_thread(_run, [TODOIST_CLI, "complete", task_ref])

    @function_tool
    async def show_task(self, task_ref: str) -> str:
        """Show full task details including comments. task_ref: task name, ID, or 'id:xxx'."""
        return await asyncio.to_thread(_run, [TODOIST_CLI, "show", task_ref])

    @function_tool
    async def comment_on_task(self, task_ref: str, comment: str) -> str:
        """Add a comment to a task."""
        return await asyncio.to_thread(_run, [TODOIST_CLI, "comment-add", task_ref, "--content", comment])

    @function_tool
    async def check_system_health(self) -> str:
        """Check the health of joelclaw infrastructure — k8s pods, worker, Redis, Inngest."""
        raw = await asyncio.to_thread(_run, ["joelclaw", "status"])
        try:
            data = json.loads(raw)
            result = data.get("result", {})
            components = result.get("components")
            if isinstance(components, dict):
                parts = []
                for name, comp in components.items():
                    if not isinstance(comp, dict):
                        continue
                    healthy = comp.get("ok")
                    status = "healthy" if healthy else "DOWN"
                    detail = comp.get("status") or comp.get("message")
                    parts.append(f"{name}: {status}" + (f" ({detail})" if detail else ""))
                if parts:
                    return ". ".join(parts)

            parts = []
            for key in ["server", "worker", "k8s"]:
                s = result.get(key, {})
                if not isinstance(s, dict):
                    continue
                status = "healthy" if s.get("ok") else "DOWN"
                parts.append(f"{key}: {status}")
            if parts:
                return ". ".join(parts)
            return raw
        except Exception:
            return raw

    @function_tool
    async def search_vault(self, query: str) -> str:
        """Search across Typesense collections for a query. Returns top results with titles and snippets."""
        raw = await asyncio.to_thread(
            _run, ["joelclaw", "search", query]
        )
        try:
            return self._format_typesense_results(raw, "Nothing found for that query.")
        except Exception:
            return raw

    def _format_typesense_results(self, raw: str, empty_message: str) -> str:
        """Format joelclaw search results into concise voice-friendly lines."""
        try:
            data = json.loads(raw)
            result = data.get("result", {})
            hits = []
            if isinstance(result, dict):
                if isinstance(result.get("hits"), list):
                    hits = result.get("hits", [])
                elif isinstance(result.get("results"), list):
                    for group in result.get("results", []):
                        if isinstance(group, dict):
                            grouped_hits = group.get("hits", [])
                            if isinstance(grouped_hits, list):
                                hits.extend(grouped_hits)

            if not hits:
                return empty_message

            lines = []
            for hit in hits[:5]:
                if not isinstance(hit, dict):
                    continue

                doc = hit.get("document", hit)
                if not isinstance(doc, dict):
                    doc = {}

                title = (
                    doc.get("title")
                    or doc.get("name")
                    or doc.get("path")
                    or doc.get("id")
                    or "Untitled"
                )
                snippet = (
                    hit.get("snippet")
                    or doc.get("snippet")
                    or doc.get("summary")
                    or doc.get("observation")
                    or doc.get("content")
                    or doc.get("body")
                    or doc.get("text")
                    or ""
                )
                snippet = str(snippet).replace("\n", " ").strip()
                if len(snippet) > 220:
                    snippet = snippet[:220].rstrip() + "..."

                if snippet:
                    lines.append(f"- {title}: {snippet}")
                else:
                    lines.append(f"- {title}")

            return "\n".join(lines) if lines else empty_message
        except Exception:
            return raw

    @function_tool
    async def search_typesense(self, query: str) -> str:
        """Search all Typesense collections (vault, memory, blog, logs, discoveries, transcripts)."""
        raw = await asyncio.to_thread(_run, ["joelclaw", "search", query])
        return self._format_typesense_results(raw, "Nothing found for that query.")

    @function_tool
    async def discover(self, url: str, note: str = "") -> str:
        """Save an interesting URL discovery with an optional note."""
        cmd = ["joelclaw", "discover", "--url", url]
        if note:
            cmd.extend(["--note", note])
        return await asyncio.to_thread(_run, cmd)

    @function_tool
    async def quick_note(self, title: str, body: str) -> str:
        """Create a quick vault note with title and body."""
        return await asyncio.to_thread(
            _run, ["joelclaw", "note", "--title", title, "--body", body]
        )

    @function_tool
    async def vault_search(self, query: str) -> str:
        """Search only the vault_notes Typesense collection."""
        raw = await asyncio.to_thread(
            _run, ["joelclaw", "search", "--collection", "vault_notes", query]
        )
        return self._format_typesense_results(raw, "Nothing found in vault notes for that query.")

    @function_tool
    async def recent_runs(self) -> str:
        """Check what ran recently in Inngest."""
        return await asyncio.to_thread(_run, ["joelclaw", "runs"])

    @function_tool
    async def system_status(self) -> str:
        """Get joelclaw system component status from the status endpoint."""
        return await self.check_system_health()

    @function_tool
    async def check_email(self) -> str:
        """Check Joel's email inbox for recent important messages."""
        return await asyncio.to_thread(
            _run, ["joelclaw", "email", "inbox", "-q", "is:open", "-n", "10"]
        )

    @function_tool
    async def send_event(self, event_name: str, data: str = "{}") -> str:
        """Send an event to the joelclaw Inngest event bus. Common events:
        - system/health.requested: run health check
        - email/triage.requested: triage inbox
        - tasks/triage.requested: review all tasks
        - memory/batch-review.requested: review pending memory proposals
        - voice/call.completed: log a call transcript
        Joel will get a Telegram notification when the job completes."""
        return await asyncio.to_thread(
            _run, ["joelclaw", "send", event_name, "-d", data]
        )

    @function_tool
    async def check_runs(self) -> str:
        """Check recent Inngest function runs — see what's completed, failed, or running."""
        return await asyncio.to_thread(_run, ["joelclaw", "runs"])

    @function_tool
    async def check_run(self, run_id: str) -> str:
        """Get details of a specific Inngest run by ID."""
        return await asyncio.to_thread(_run, ["joelclaw", "run", run_id])

    @function_tool
    async def current_time(self) -> str:
        """Get the current date and time in Joel's timezone (Pacific)."""
        from zoneinfo import ZoneInfo
        now = datetime.now(ZoneInfo("America/Los_Angeles"))
        return now.strftime("%A, %B %d, %Y at %I:%M %p %Z")

    # --- Vault read by reference ---

    @function_tool
    async def vault_read(self, ref: str) -> str:
        """Read a specific vault file by reference. Supports:
        - ADR numbers: 'adr 43', 'ADR-0043'
        - Project numbers: 'project 9', 'p9'
        - Direct paths: 'docs/decisions/0043-livekit.md'
        - Fuzzy names: 'livekit', 'memory system'
        Returns the file content (truncated to 3000 chars for voice)."""
        raw = await asyncio.to_thread(_run, ["joelclaw", "vault", "read", ref], 15)
        try:
            data = json.loads(raw)
            content = data.get("result", {}).get("content", raw)
            if len(content) > 3000:
                content = content[:3000] + "\n... (truncated for voice)"
            return content
        except Exception:
            return raw[:3000] if len(raw) > 3000 else raw

    # --- Qdrant memory recall ---

    @function_tool
    async def recall(self, query: str) -> str:
        """Search long-term memory (Qdrant) for past observations, decisions, and context.
        Use when Joel references something from earlier or you need historical context."""
        raw = await asyncio.to_thread(_run, ["joelclaw", "recall", query], 10)
        try:
            data = json.loads(raw)
            hits = data.get("result", {}).get("hits", [])
            if not hits:
                return "No matching memories found."
            lines = []
            for h in hits[:5]:
                obs = h.get("observation", "")[:200]
                score = h.get("score", 0)
                lines.append(f"[{score:.0%}] {obs}")
            return "\n".join(lines)
        except Exception:
            return raw

    # --- Call Joel (Telnyx) ---

    @function_tool
    async def call_joel(self, message: str) -> str:
        """Place an outbound phone call to Joel with a spoken message, with SMS fallback.
        Use when something urgent needs Joel's attention and he's not on this voice call."""
        return await asyncio.to_thread(
            _run, ["joelclaw", "call", message], 60
        )

    # --- Agent loop management ---

    @function_tool
    async def loop_status(self) -> str:
        """Check the status of running agent coding loops — stories completed, failures, progress."""
        return await asyncio.to_thread(_run, ["joelclaw", "loop", "status"], 15)

    @function_tool
    async def loop_start(self, project: str, goal: str = "") -> str:
        """Start a new agent coding loop for a project directory. Requires absolute path to project.
        Optional goal describes what the loop should accomplish."""
        cmd = ["joelclaw", "loop", "start", "--project", project]
        if goal:
            cmd.extend(["--goal", goal])
        return await asyncio.to_thread(_run, cmd, 30)

    # --- Vault listing ---

    @function_tool
    async def vault_list(self, section: str = "projects") -> str:
        """List vault sections. Section can be: projects, decisions, inbox, resources."""
        return await asyncio.to_thread(
            _run, ["joelclaw", "vault", "ls", section], 10
        )


def _gather_context() -> str:
    """Pre-load context at call start — MEMORY.md + recent Qdrant hits + calendar."""
    sections = []

    # 0. Current time in Joel's timezone
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo("America/Los_Angeles"))
    sections.append(f"## Current Time\n{now.strftime('%A, %B %d, %Y at %I:%M %p %Z')}")

    # 1. MEMORY.md — curated long-term memory (already compact)
    memory_path = Path.home() / ".joelclaw" / "workspace" / "MEMORY.md"
    if memory_path.exists():
        content = memory_path.read_text().strip()
        # Trim to first 3000 chars to keep prompt reasonable
        if len(content) > 3000:
            content = content[:3000] + "\n... (truncated)"
        sections.append(f"## Current Memory\n{content}")

    # 2. Recent Qdrant observations — what's top of mind
    try:
        raw = _run(["joelclaw", "recall", "recent activity and conversations"], timeout=10)
        data = json.loads(raw)
        hits = data.get("result", {}).get("hits", [])
        if hits:
            obs = "\n".join(f"- {h.get('observation', '')[:200]}" for h in hits[:5])
            sections.append(f"## Recent Context\n{obs}")
    except Exception:
        pass

    # 3. Today + tomorrow calendar
    try:
        today_cal = _run(
            ["gog", "cal", "events", "joelhooks@gmail.com", "-a", "joelhooks@gmail.com", "--plain", "--today"],
            timeout=10,
        )
        tomorrow_cal = _run(
            ["gog", "cal", "events", "joelhooks@gmail.com", "-a", "joelhooks@gmail.com", "--plain", "--tomorrow"],
            timeout=10,
        )
        cal_parts = []
        if today_cal and "Command failed" not in today_cal:
            cal_parts.append(f"### Today\n{today_cal}")
        if tomorrow_cal and "Command failed" not in tomorrow_cal:
            cal_parts.append(f"### Tomorrow\n{tomorrow_cal}")
        if cal_parts:
            sections.append(f"## Calendar\n" + "\n".join(cal_parts))
    except Exception:
        pass

    # 4. System health (one-liner)
    try:
        raw = _run(["joelclaw", "status"], timeout=10)
        data = json.loads(raw)
        r = data.get("result", {})
        parts = []
        for key in ["server", "worker", "k8s"]:
            s = r.get(key, {})
            if not s.get("ok"):
                parts.append(f"⚠️ {key} is DOWN")
        if parts:
            sections.append(f"## System Alerts\n" + "\n".join(parts))
    except Exception:
        pass

    return "\n\n".join(sections)


def _extract_caller(room_name: str) -> str:
    """Extract raw caller token from SIP room name like 'voice-_8176756031_abc123'."""
    parts = room_name.split("_")
    if len(parts) < 2:
        return ""

    caller = parts[1].strip()
    if caller.startswith("tel:"):
        caller = caller[4:]
    if caller.startswith("sip:"):
        caller = caller[4:]
    return caller


def _normalize_caller(caller: str) -> str:
    """Normalize caller IDs to canonical US 10-digit format when possible."""
    if not caller:
        return ""

    digits = "".join(ch for ch in caller if ch.isdigit())
    if len(digits) == 11 and digits.startswith("1"):
        return digits[1:]
    if len(digits) == 10:
        return digits
    return digits


def _normalized_allowlist(cfg: dict) -> set[str]:
    """Return normalized allowlist entries for robust caller matching."""
    return {
        normalized
        for caller in load_allowed_callers(cfg)
        if (normalized := _normalize_caller(caller))
    }


def _caller_allowed(caller_raw: str, allowed_callers: set[str]) -> tuple[bool, str]:
    """Evaluate caller against allowlist using fail-closed normalization rules."""
    caller = _normalize_caller(caller_raw)
    if not caller:
        return False, caller
    return caller in allowed_callers, caller


async def entrypoint(ctx) -> None:
    cfg = load_config()
    agent_cfg = cfg.get("agent", {})
    tts_cfg = cfg.get("tts", {})
    original_voice_id = tts_cfg.get("voice_id", "bIHbv24MWmeRgasZH58o")

    # Security: caller allowlist (normalized for format variants, fail closed)
    caller_raw = _extract_caller(ctx.room.name)
    allowed_callers = _normalized_allowlist(cfg)
    logger.info("Caller allowlist loaded: %d entries (config=%s)", len(allowed_callers), CONFIG_PATH)
    caller_allowed, caller = _caller_allowed(caller_raw, allowed_callers)
    if not caller_allowed:
        reason = "missing-or-unparseable" if not caller else "unknown"
        logger.warning(
            "Rejected call: reason=%s raw=%s normalized=%s room=%s",
            reason,
            caller_raw or "<empty>",
            caller or "<empty>",
            ctx.room.name,
        )
        # Join briefly to play rejection message, then hang up
        tts_instance = build_tts(cfg)
        session = AgentSession(
            stt=deepgram.STT(), llm=build_llm(cfg), tts=tts_instance,
            vad=silero.VAD.load(),
        )
        await session.start(agent=Agent(instructions="You are a voicemail system."), room=ctx.room)
        session.generate_reply(user_input="Say exactly: 'This number is not accepting calls at this time. Goodbye.' Then stop talking.")
        await asyncio.sleep(5)
        return

    logger.info(
        "Voice session starting — room=%s, caller_raw=%s, caller=%s, agent=%s",
        ctx.room.name,
        caller_raw,
        caller,
        agent_cfg.get("name", "Panda"),
    )

    # Pre-load context BEFORE session starts (runs in parallel with SIP setup)
    context = await asyncio.to_thread(_gather_context)
    logger.info("Context loaded: %d chars", len(context))

    tts_instance = build_tts(cfg)

    session = AgentSession(
        stt=deepgram.STT(),
        llm=build_llm(cfg),
        tts=tts_instance,
        vad=silero.VAD.load(
            activation_threshold=0.85,   # high — ignore room chatter, only trigger on direct speech (default 0.5)
            min_speech_duration=0.2,      # require 200ms of speech to trigger (default 50ms)
            min_silence_duration=0.7,     # wait 700ms of silence before end-of-turn (default 550ms)
        ),
    )

    agent = JoelclawVoiceAgent(tts_instance, original_voice_id)
    await session.start(agent=agent, room=ctx.room)

    # Save transcript when session ends
    @session.on("close")
    def on_close(*args, **kwargs):
        _save_call_transcript(session, ctx.room.name)

    # Greet with pre-loaded context so Panda already knows what's going on
    greeting = agent_cfg.get("greeting", "Hey, it's Panda. What's up?")
    context_prompt = (
        f"The user just connected to a voice call. Here's your current context:\n\n"
        f"{context}\n\n"
        f"Greet them naturally — something like: {greeting}\n"
        f"If there's anything notable (calendar items soon, system alerts), mention it briefly."
    )
    session.generate_reply(user_input=context_prompt)


def _save_call_transcript(session: AgentSession, room_name: str) -> None:
    """Save call transcript and fire debrief event."""
    try:
        history = session.history
        if not history or len(history) < 2:
            return

        # Build transcript
        lines = []
        for msg in history:
            role = msg.get("role", "unknown")
            content = msg.get("content", "")
            if isinstance(content, list):
                content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
            if content:
                speaker = "Joel" if role == "user" else "Panda"
                lines.append(f"**{speaker}**: {content}")

        if not lines:
            return

        transcript = "\n\n".join(lines)
        timestamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")

        # Save to voice memory dir
        voice_dir = Path.home() / ".joelclaw" / "workspace" / "memory" / "voice"
        voice_dir.mkdir(parents=True, exist_ok=True)
        filepath = voice_dir / f"{timestamp}.md"
        filepath.write_text(
            f"---\ntype: voice-call\ndate: {datetime.now().isoformat()}\nroom: {room_name}\n---\n\n"
            f"# Voice Call — {timestamp}\n\n{transcript}\n"
        )

        # Fire debrief event to Inngest for observation extraction
        _run([
            "joelclaw", "send", "voice/call.completed",
            "-d", json.dumps({
                "transcript": transcript[:5000],
                "room": room_name,
                "timestamp": timestamp,
                "turns": len(lines),
            }),
        ])
        logger.info("Call transcript saved: %s (%d turns)", filepath, len(lines))
    except Exception as e:
        logger.error("Failed to save transcript: %s", e)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        num_idle_processes=1,  # keep a warm process ready for instant pickup
    ))

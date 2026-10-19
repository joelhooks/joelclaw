#!/usr/bin/env python3
"""Flagg-side gate for voice tool calls from a remote voice worker.

The remote worker's ssh key reaches a dedicated account whose authorized_keys
forces one command (see REMOTE-TOOLS.md):

    restrict,from="<guest tailnet IP>",command="sudo -n -u joel /usr/bin/python3 -I /usr/local/libexec/voice_remote_gate.py" ssh-ed25519 ...

sudoers allows exactly that command. The tool call arrives as a JSON argv on
stdin in logical form (tool names, not Flagg paths). Every call must match one
exact schema below: fixed tokens, typed positionals, typed allowlisted flags,
nothing else. Calls that act outward or start agents (loop start, call, any
event but the transcript hand-off, invites with attendees) are not here: they
run only when the worker is on Flagg.

Stdlib only, so it runs under the system python with -I.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

HOME = Path("/Users/joel")
CODE = HOME / "Code" / "joelhooks"
BRAIN = CODE / "shitrat-brain"
MUSTER_PROJECTS = HOME / ".local" / "state" / "muster" / "projects.jsonl"
LOG = HOME / ".local" / "log" / "voice-remote-gate.log"
SLOTS = HOME / ".local" / "state" / "voice-remote-gate"
PATH = ":".join([
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    str(HOME / ".local" / "bin"),
    str(HOME / ".local" / "share" / "fnm" / "aliases" / "default" / "bin"),
    str(HOME / ".bun" / "bin"),
])
MAX_ARGS = 40
MAX_ARG_CHARS = 12_000   # hard cap; only a JSON object may be this long
TEXT_CHARS = 2000
MAX_STDIN = MAX_ARGS * MAX_ARG_CHARS + 1024
MAX_OUT = 64_000
TIMEOUT_S = 25          # below the worker's 30 s, so no orphan outlives its caller
READ_DEADLINE_S = 5
MAX_CONCURRENT = 3
# Per-minute caps on anything that changes state or reaches Joel: volume, not just
# concurrency, so a compromised worker can't wipe a calendar or flood his chat.
BUDGETS = {
    "writes": (10, {"gog cal-create", "todoist-cli add", "todoist-cli complete", "todoist-cli comment", "joelclaw note", "joelclaw transcript"}),
    "notes": (3, {"node-script message-shitrat"}),
}
BUDGET_DIR = HOME / ".local" / "state" / "voice-remote-gate"
# Each tool runs by absolute path, so nothing dropped early on PATH can shadow it.
# Same trust as on Flagg: these are joel's own tools, run as joel.
EXE = {
    "joelclaw": str(HOME / ".bun" / "bin" / "joelclaw"),
    "gog": str(HOME / ".local" / "bin" / "gog"),
    "todoist-cli": str(HOME / ".local" / "bin" / "todoist-cli"),
    "node": str(HOME / ".local" / "share" / "fnm" / "aliases" / "default" / "bin" / "node"),
    "git": "/opt/homebrew/bin/git",
    "secrets": str(HOME / ".local" / "bin" / "secrets"),
}
ACCT = "joelhooks@gmail.com"
NOTE_PREFIX = "[voice line] "


class Refused(Exception):
    pass


# --- value kinds -------------------------------------------------------------

def text(v: str) -> bool:
    return bool(v) and not v.startswith("-") and len(v) <= TEXT_CHARS


def short(v: str) -> bool:
    return text(v) and len(v) <= 200


def ident(v: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", v)) and not v.startswith("-")


def date(v: str) -> bool:
    return bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}([T ][0-9:.+Z-]{4,20})?", v))


def small_int(v: str) -> bool:
    return bool(re.fullmatch(r"[1-9][0-9]?", v))


def priority(v: str) -> bool:
    return v in {"1", "2", "3", "4"}


def https_url(v: str) -> bool:
    return len(v) <= 2000 and bool(re.fullmatch(r"https://[^\s]+", v))


def rel_path(v: str) -> bool:
    return text(v) and not v.startswith(("/", "~")) and ".." not in Path(v).parts and len(v) <= 300


# The transcript events' exact payloads (main.py _save_call_transcript and the
# public-session save). Unknown keys or wrong types are refused.
TRANSCRIPT_SCHEMAS = {
    "voice/call.completed": {"transcript": str, "room": str, "timestamp": str, "turns": int},
    "voice/public-call.completed": {"transcript": str, "room": str, "caller": str, "timestamp": str, "duration_s": (int, float), "turns": int},
}
TRANSCRIPT_MAX = {"transcript": 8000, "room": 200, "caller": 40, "timestamp": 40}


def transcript_payload(event: str, v: str) -> bool:
    if len(v) > MAX_ARG_CHARS:
        return False
    try:
        data = json.loads(v)
    except (ValueError, RecursionError):
        return False
    schema = TRANSCRIPT_SCHEMAS.get(event)
    if not isinstance(data, dict) or schema is None or set(data) != set(schema):
        return False
    for key, kind in schema.items():
        value = data[key]
        if isinstance(value, bool) or not isinstance(value, kind):
            return False
        if isinstance(value, str) and len(value) > TRANSCRIPT_MAX.get(key, 200):
            return False
    return True


FLAG = None  # a flag that takes no value


def match(rest: list[str], head: list[str], pos: list, flags: dict | None = None, required: tuple = ()) -> bool:
    """rest == head + typed positionals + allowlisted flags, each at most once."""
    flags = flags or {}
    if rest[: len(head)] != head:
        return False
    i = len(head)
    for kind in pos:
        if i >= len(rest) or not kind(rest[i]):
            return False
        i += 1
    seen: set[str] = set()
    while i < len(rest):
        flag = rest[i]
        if flag not in flags or flag in seen:
            return False
        seen.add(flag)
        kind = flags[flag]
        if kind is FLAG:
            i += 1
            continue
        if i + 1 >= len(rest) or not kind(rest[i + 1]):
            return False
        i += 2
    return set(required) <= seen


# --- schemas: (name, matcher) ------------------------------------------------

def muster_project(v: str) -> bool:
    if not v.startswith("/"):
        return False
    try:
        dirs = {json.loads(line).get("dir") for line in MUSTER_PROJECTS.read_text().splitlines() if line.strip()}
    except (OSError, ValueError):
        return False
    return v in dirs and Path(v).is_dir()


def message_shitrat(r: list[str]) -> bool:
    """message-shitrat --kind update|link [--link https://...] TEXT"""
    if r[:2] != ["message-shitrat", "--kind"] or len(r) < 4 or r[2] not in {"update", "link"}:
        return False
    tail = r[3:]
    if len(tail) == 3 and tail[0] == "--link" and https_url(tail[1]):
        tail = tail[2:]
    # One line only: a newline could start an unprefixed line that poses as someone else.
    return len(tail) == 1 and text(tail[0]) and len(tail[0]) <= 600 and not re.search(r"[\x00-\x1f\x7f]", tail[0])


ONE_WHEN = {"--week": FLAG, "--today": FLAG, "--tomorrow": FLAG, "--from": date, "--days": small_int}
TODO_FILTERS = {"--label": short, "--project": short, "--filter": short}

SCHEMAS: dict[str, list[tuple[str, callable]]] = {
    "joelclaw": [
        ("status", lambda r: r == ["status"]),
        ("runs", lambda r: r == ["runs"]),
        ("run", lambda r: match(r, ["run"], [ident])),
        ("search", lambda r: match(r, ["search"], [text])),
        ("search-vault", lambda r: match(r, ["search", "--collection", "vault_notes"], [text])),
        ("recall", lambda r: match(r, ["recall"], [text])),
        ("vault-read", lambda r: match(r, ["vault", "read"], [rel_path])),
        ("vault-ls", lambda r: match(r, ["vault", "ls"], [rel_path])),
        ("loop-status", lambda r: match(r, ["loop", "status"], [], {"--goal": short})),
        ("note", lambda r: match(r, ["note", "--title"], [short, lambda v: v == "--body", text])),
        ("email-inbox", lambda r: r == ["email", "inbox", "-q", "is:open", "-n", "10"]),
        ("transcript", lambda r: len(r) == 4 and r[0] == "send" and r[2] == "-d" and transcript_payload(r[1], r[3])),
    ],
    "gog": [
        ("cal-events", lambda r: match(r, ["cal", "events", ACCT, "-a", ACCT, "--plain"], [], ONE_WHEN)
            and sum(f in r for f in ("--week", "--today", "--tomorrow", "--from")) <= 1),
        ("cal-create", lambda r: match(
            r, ["cal", "create", ACCT, "-a", ACCT, "--force", "--summary"], [short],
            {"--from": date, "--to": date, "--description": text, "--location": short},
            required=("--from", "--to"))),
    ],
    "todoist-cli": [
        ("today", lambda r: match(r, ["today"], [], TODO_FILTERS)),
        ("inbox", lambda r: match(r, ["inbox"], [], TODO_FILTERS)),
        ("list", lambda r: match(r, ["list"], [], TODO_FILTERS)),
        ("search", lambda r: match(r, ["search"], [text], {"--due": short, "--project": short})),
        ("add", lambda r: match(r, ["add"], [text, lambda v: v == "--labels", short], {"--due": short, "--project": short, "--priority": priority})),
        ("complete", lambda r: match(r, ["complete"], [ident])),
        ("show", lambda r: match(r, ["show"], [ident])),
        ("comment", lambda r: match(r, ["comment-add"], [ident, lambda v: v == "--content", text])),
    ],
    "node-script": [
        ("message-shitrat", message_shitrat),
        ("muster-digest", lambda r: match(r, ["muster-digest"], [muster_project])),
    ],
    "brain-git": [
        ("pages", lambda r: r == ["ls-tree", "-r", "--name-only", "HEAD", "pages/"]),
        ("index", lambda r: r == ["show", "HEAD:index.svx"]),
        ("page", lambda r: len(r) == 2 and r[0] == "show" and bool(re.fullmatch(r"HEAD:pages/[A-Za-z0-9_./-]{1,200}\.svx", r[1])) and ".." not in r[1]),
    ],
}

NODE_SCRIPTS = {
    "muster-digest": CODE / "pi-muster" / "bin" / "muster-digest.ts",
    "message-shitrat": CODE / "dark-wizard" / "scripts" / "message-shitrat.mjs",
}


def _check_args(args: object) -> list[str]:
    if not isinstance(args, list) or not args or len(args) > MAX_ARGS:
        raise Refused("argv must be a non-empty list of at most 40 strings")
    for a in args:
        if not isinstance(a, str) or len(a) > MAX_ARG_CHARS or "\x00" in a:
            raise Refused("every argument must be a string under the size cap")
    return args


def classify(argv: list[str]) -> str:
    """The schema name this call matches, or Refused."""
    tool, rest = argv[0], argv[1:]
    for name, ok in SCHEMAS.get(tool, []):
        if ok(rest):
            return f"{tool} {name}"
    raise Refused(f"{tool}: call not allowed off Flagg" if tool in SCHEMAS else f"tool not allowed: {tool}")


def resolve(argv: list[str]) -> list[str]:
    """Logical call -> real Flagg argv. Only after classify() has passed."""
    classify(argv)
    tool, rest = argv[0], argv[1:]
    if tool == "node-script":
        script, args = rest[0], rest[1:]
        if script == "message-shitrat":
            args = [*args[:-1], NOTE_PREFIX + args[-1]]  # the text is always last
        return [EXE["node"], str(NODE_SCRIPTS[script]), *args]
    if tool == "brain-git":
        return [EXE["git"], "-C", str(BRAIN), *rest]
    return [EXE[tool], *rest]


def tool_env(argv: list[str]) -> dict[str, str]:
    env = {"HOME": str(HOME), "PATH": PATH, "LANG": "en_US.UTF-8", "USER": "joel"}
    if argv[0] == EXE["gog"]:
        try:
            out = subprocess.run(
                [EXE["secrets"], "lease", "gog_keyring_password", "--ttl", "1m"],
                capture_output=True, text=True, timeout=5, env=env,
            )
            if out.returncode == 0 and out.stdout.strip():
                env["GOG_KEYRING_PASSWORD"] = out.stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            pass
    return env


def log(entry: dict) -> None:
    """The matched call name only: arguments can be private."""
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **entry}) + "\n")
    except OSError:
        pass


def budget_for(name: str) -> tuple[str, int] | None:
    for bucket, (cap, calls) in BUDGETS.items():
        if name in calls:
            return bucket, cap
    return None


def spend(bucket: str, cap: int, now: float | None = None) -> bool:
    """Reserve one call from a per-minute budget, under a lock."""
    now = now or time.time()
    BUDGET_DIR.mkdir(parents=True, exist_ok=True)
    with open(BUDGET_DIR / f"{bucket}.json", "a+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        try:
            recent = [t for t in json.loads(f.read() or "[]") if isinstance(t, (int, float)) and now - t < 60]
        except ValueError:
            recent = []
        if len(recent) >= cap:
            return False
        f.seek(0)
        f.truncate()
        f.write(json.dumps(recent + [now]))
        return True


def take_slot():
    """One of MAX_CONCURRENT lock files, or None when all are busy."""
    SLOTS.mkdir(parents=True, exist_ok=True)
    for n in range(MAX_CONCURRENT):
        f = open(SLOTS / f"slot{n}", "a")
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return f
        except OSError:
            f.close()
    return None


def run(real: list[str]) -> tuple[int, str, str]:
    proc = subprocess.Popen(
        real, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env=tool_env(real), cwd=str(HOME), start_new_session=True,
    )
    try:
        out, err = proc.communicate(timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGKILL)  # the whole group, grandchildren too
        try:
            proc.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            pass  # a detached grandchild still holds the pipes; don't wait on it
        finally:
            for pipe in (proc.stdout, proc.stderr):
                with contextlib.suppress(OSError):
                    pipe.close()
        return 124, "", "timed out on Flagg"
    return proc.returncode, out, err


def main(stdin: str) -> int:
    started = time.monotonic()
    name = "refused"
    try:
        argv = _check_args(json.loads(stdin))
        name = classify(argv)
        real = resolve(argv)
    except Exception as e:  # malformed input of any kind is a refusal, never a traceback
        reason = str(e) if isinstance(e, Refused) else "malformed request"
        log({"call": name, "refused": reason[:200]})
        sys.stderr.write(f"refused: {reason}\n")
        return 126
    try:
        slot = take_slot()
        budget = budget_for(name)
        if slot is not None and budget and not spend(*budget):
            slot.close()
            log({"call": name, "refused": f"{budget[0]} budget"})
            sys.stderr.write("refused: too many changes in the last minute\n")
            return 126
    except OSError:
        log({"call": name, "refused": "state dir"})
        sys.stderr.write("could not run on Flagg\n")
        return 127
    if slot is None:
        log({"call": name, "refused": "busy"})
        sys.stderr.write("busy: too many tool calls at once\n")
        return 75
    try:
        code, out, err = run(real)
    except OSError:
        log({"call": name, "exit": "oserror"})
        sys.stderr.write("could not run on Flagg\n")
        return 127
    finally:
        slot.close()
    sys.stdout.write(out[:MAX_OUT])
    sys.stderr.write(err[:2000])
    log({"call": name, "exit": code, "ms": int((time.monotonic() - started) * 1000)})
    return 1 if code == 255 else code  # 255 means "ssh failed" to the worker


def read_stdin() -> str:
    def _deadline(*_):
        raise TimeoutError

    signal.signal(signal.SIGALRM, _deadline)
    signal.alarm(READ_DEADLINE_S)
    try:
        return sys.stdin.read(MAX_STDIN)
    except TimeoutError:
        return ""
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    sys.exit(main(read_stdin()))

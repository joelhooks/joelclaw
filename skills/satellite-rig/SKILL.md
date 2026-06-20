---
name: satellite-rig
displayName: Satellite Rig
description: "Set up and repair thin joelclaw satellite Machines such as blaine/Dark-Tower. Use when adding joelclaw CLI, Typesense access, session search/capture, Central relay, or satellite health on non-Panda machines. Triggers: satellite, blaine, Dark-Tower, setup joelclaw on another machine, Typesense access on satellite, joelclaw satellite health."
version: 0.1.0
author: joel
tags:
  - joelclaw
  - satellite
  - typesense
  - sessions
  - ssh
  - ops
---

# Satellite Rig

Use this for thin joelclaw Machines that are **not Panda**.

A satellite should be boring:

- repo checkout
- `joelclaw` CLI
- joelclaw skills linked as a namespaced pack inside real consumer roots
- local raw session search
- Central Typesense search
- Central `/api/runs` capture auth
- Central repair relay over SSH

Do **not** install Panda's k8s/Inngest/Redis/gateway stack unless Joel explicitly asks and the architecture earns the weight.

## Current known satellite: blaine

Tailscale advertises:

- Machine: `blaine`
- IP: `100.72.79.112`
- DNS may not resolve locally; direct IP works

The host itself may report:

- blaine host reports `Dark-Tower.local` / `Dark-Tower`
- flagg host reports `flagg.localdomain`

This mismatch is normal. When searching Central Typesense, use the Tailscale Machine name (`blaine`, `flagg`) for captured runs. When searching raw local files on the satellite, use the reported local machine name from `joelclaw satellite health` or `hostname`.

## Fast path from Panda

Run from `~/Code/joelhooks/joelclaw` on Panda.

```bash
cd ~/Code/joelhooks/joelclaw

ssh -o BatchMode=yes -o ConnectTimeout=8 joel@100.72.79.112 'hostname && whoami'

KEY="$(secrets lease typesense_api_key --ttl 1h)"
{
  printf 'export TYPESENSE_API_KEY=%q\n' "$KEY"
  printf 'export JOELCLAW_CENTRAL_URL=%q\n' 'https://panda.tail7af24.ts.net'
  printf 'export JOELCLAW_TYPESENSE_URL=%q\n' 'http://panda:8108'
  cat scripts/setup-satellite-rig.sh
} | ssh joel@100.72.79.112 'bash -s'
unset KEY
```

If the target already has a dirty `~/Code/joelhooks/joelclaw` checkout, keep it intact and bootstrap a runtime checkout instead:

```bash
KEY="$(secrets lease typesense_api_key --ttl 1h)"
TARGET=joel@flagg
{
  printf 'export TYPESENSE_API_KEY=%q\n' "$KEY"
  printf 'export JOELCLAW_CENTRAL_URL=%q\n' 'https://panda.tail7af24.ts.net'
  printf 'export JOELCLAW_TYPESENSE_URL=%q\n' 'http://panda:8108'
  printf 'export JOELCLAW_REPO_DIR="$HOME/Code/joelhooks/joelclaw-runtime"\n'
  cat scripts/setup-satellite-rig.sh
} | ssh "$TARGET" 'bash -s'
unset KEY TARGET
```

This avoids the brittle two-step "manually write remote env, then bootstrap" dance. The key goes through the SSH pipe and is written only to the satellite's `~/.config/system-bus.env` with `0600` permissions. Do not print it.

## What the bootstrap should leave behind

On the satellite:

```bash
~/.bun/bin/joelclaw          # compiled binary
~/.local/bin/joelclaw        # wrapper that sources ~/.config/system-bus.env, then execs binary
~/.config/system-bus.env     # 0600, contains JOELCLAW_CENTRAL_URL, TYPESENSE_URL, TYPESENSE_API_KEY
~/.joelclaw/auth.json        # machine run-capture token, created separately by machine registration
~/.pi/agent/skills           # real consumer root
~/.pi/agent/skills/joelclaw-runtime  # symlink to repo skills pack
~/.agents/skills             # real consumer root
~/.agents/skills/joelclaw-runtime    # symlink to repo skills pack
~/.pi/agent/sessions         # local raw Pi sessions
```

`~/.pi/agent/skills` and `~/.agents/skills` must stay real directories. The runtime is a skill pack inside those roots, not the root itself. Use `joelclaw-runtime` for the pack namespace so the flat `joelclaw` CLI skill can remain a compatibility shim. Per-skill flat symlinks are compatibility shims only when a harness cannot discover nested packs.

The wrapper matters because non-interactive SSH shells do not reliably load dotfiles, and satellites should not need Panda's `agent-secrets` daemon.

## Verification

Run these from Panda against the satellite:

```bash
ssh joel@100.72.79.112 '
set -euo pipefail
set -a; source "$HOME/.config/system-bus.env"; set +a

printf "compiled="; file "$HOME/.bun/bin/joelclaw"
printf "wrapper="; file "$HOME/.local/bin/joelclaw"
printf "env_perms="; stat -f "%Sp %Su:%Sg" "$HOME/.config/system-bus.env"
printf "typesense_health="; curl --max-time 5 -fsS "$TYPESENSE_URL/health"; printf "\n"

joelclaw sessions search "joel-writing-style" --source typesense --machine blaine --runtime all --limit 1 \
  | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get(\"result\",{}); print(\"typesense_search_ok=%s hits=%s\"%(d.get(\"ok\"), len(r.get(\"hits\",[]))))"

joelclaw sessions search "joel-writing-style" --source local --machine "$(hostname -s)" --runtime all --limit 1 \
  | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get(\"result\",{}); print(\"local_search_ok=%s hits=%s\"%(d.get(\"ok\"), len(r.get(\"hits\",[]))))"

joelclaw knowledge search "typesense session indexing recovery runbook" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get(\"result\",{}); print(\"knowledge_ok=%s found=%s\"%(d.get(\"ok\"), r.get(\"found\")))"

joelclaw satellite health \
  | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get(\"result\",{}); print(\"satellite_ok=%s failed=%s machine=%s\"%(r.get(\"ok\"), r.get(\"failedCount\"), r.get(\"machine\")))"
'
```

Expected:

- compiled binary is Mach-O
- wrapper is shell script
- env perms are `-rw------- joel:staff`
- Typesense health is `{"ok":true}`
- Typesense search returns at least one hit for known captured material
- local search returns at least one hit once raw sessions exist
- satellite health reports `failed=0`

## Run-capture auth check

Pi auth is separate. Do not copy Panda's Pi auth casually.

Run-capture auth is `~/.joelclaw/auth.json`, generated by machine registration. Verify without printing the token:

```bash
ssh joel@100.72.79.112 'python3 - <<'"'"'PY'"'"'
import json, os, urllib.request
p=os.path.expanduser("~/.joelclaw/auth.json")
a=json.load(open(p))
req=urllib.request.Request(
  "https://panda.tail7af24.ts.net/api/runs/health",
  headers={"Authorization":"Bearer "+a["token"]},
)
with urllib.request.urlopen(req, timeout=10) as r:
  print("runs_health_status=%s" % r.status)
  print(r.read().decode()[:200])
PY'
```

Expected: `runs_health_status=200` and `"service":"system-bus-run-capture"`.

## Central relay check

```bash
ssh joel@100.72.79.112 'joelclaw satellite repair-request --central-ssh joel@panda --priority normal'
```

This should enqueue a gateway notification on Panda. It can succeed even if `command -v joelclaw` fails in Panda's non-interactive SSH PATH because `satellite repair-request` has fallback lookup for `~/.local/bin/joelclaw` and `~/.bun/bin/joelclaw`.

## Gotchas

### `cat > symlink` destroys the target

If `~/.local/bin/joelclaw` is a symlink to `~/.bun/bin/joelclaw`, this is catastrophic:

```bash
cat > ~/.local/bin/joelclaw
```

It writes through the symlink and overwrites the compiled binary with a shell wrapper. Always remove the symlink first:

```bash
rm -f "$HOME/.local/bin/joelclaw"
cat > "$HOME/.local/bin/joelclaw" <<'SH'
...
SH
```

`scripts/setup-satellite-rig.sh` already does this. Preserve it.

### Local env before `ssh` does not automatically reach the remote script

This does **not** reliably pass the key to the remote script:

```bash
TYPESENSE_API_KEY="$KEY" ssh joel@host 'bash -s' < script.sh
```

Use the piped export prelude shown in the fast path, or explicitly write the remote env file over SSH without echoing the key.

### Homebrew Node 26 can break native installs

Flagg had Homebrew Node `v26.0.0`; `pnpm install` tried to compile `better-sqlite3` and failed. The bootstrap now prefers `fnm`'s default Node when available before checking `node` on PATH. If this regresses, run the script with an explicit prelude:

```bash
{
  printf 'eval "$(/opt/homebrew/bin/fnm env --shell bash)"\n'
  printf 'fnm use default >/dev/null\n'
  cat scripts/setup-satellite-rig.sh
} | ssh joel@flagg 'bash -s'
```

### Do not quote literal `$HOME` into `JOELCLAW_REPO_DIR`

This creates `/Users/joel/$HOME/...`, which is exactly as dumb as it looks:

```bash
printf 'export JOELCLAW_REPO_DIR=%q\n' '$HOME/Code/joelhooks/joelclaw-runtime'
```

Use this instead so the remote shell expands `$HOME`:

```bash
printf 'export JOELCLAW_REPO_DIR="$HOME/Code/joelhooks/joelclaw-runtime"\n'
```

If the bad path exists, remove it:

```bash
ssh joel@flagg 'rm -rf "$HOME/\$HOME"'
```

### Tailscale DNS may fail while IP works

If `joel@blaine` or `joel@blaine.tail7af24.ts.net` fails to resolve, try the tailnet IP:

```bash
ssh joel@100.72.79.112 'hostname && whoami'
```

### Remote repo can have stale skill symlink damage

If bootstrap shows many deleted `skills/*` files, restore the remote skills after sync:

```bash
ssh joel@100.72.79.112 'cd ~/Code/joelhooks/joelclaw && git restore --source=HEAD -- skills'
```

Never `git reset --hard` on a satellite unless you have checked for user work and Joel approved discarding it.

## When to update docs

If you change the bootstrap script or satellite command behavior, update these in the same commit:

- `docs/runbooks/satellite-rig-setup.md`
- `docs/cli.md` if CLI semantics changed
- this skill

Then run:

```bash
bash -n scripts/setup-satellite-rig.sh
joelclaw skills ensure satellite-rig
```

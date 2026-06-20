# Satellite rig setup

Use this when bringing a thin joelclaw satellite Machine onto the tailnet.

A satellite is not Panda. It should have enough local rig to run Pi, capture local sessions, search those sessions, and ask Central for repair. Panda remains Central for Redis, gateway, Inngest, OTEL, secrets, and durable runtime work.

Current live Run-capture endpoint on satellites:

```bash
export JOELCLAW_CENTRAL_URL=https://panda.tail7af24.ts.net
```

Do **not** point capture hooks at `http://panda:3000` or `http://panda.tail7af24.ts.net:3000`; Panda currently has no durable Central web listener on port 3000. Tailscale Funnel root proxies to the host system-bus worker on `localhost:3111`, which serves `POST /api/runs` for ADR-0243 capture.

## Current targets

### blaine

Joel said `blain`; Tailscale currently advertises the Machine as `blaine`:

- Tailnet IP: `100.72.79.112`
- Tailscale DNS: `blaine.tail7af24.ts.net.`
- Status from Panda: active/direct
- SSH status from Panda: previously blocked by TCP/22 refusal; later reachable directly at `joel@100.72.79.112`
- Hostname may report as `Dark-Tower.local` even though Tailscale advertises the Machine as `blaine`

### flagg

Tailscale advertises:

- Tailnet IP: `100.127.252.116`
- SSH target from Panda: `joel@flagg`
- Hostname reports as `flagg.localdomain`
- If `~/Code/joelhooks/joelclaw` has user changes, bootstrap into `~/Code/joelhooks/joelclaw-runtime` instead of touching the dirty checkout.

If SSH is refused, Central cannot install the rig remotely until Remote Login or Tailscale SSH is enabled on the satellite. Not a vibes problem. The door is shut.

## Central preflight from Panda

```bash
tailscale status | rg -i 'blain|blaine'
ssh -o BatchMode=yes -o ConnectTimeout=8 joel@100.72.79.112 'hostname'
```

If port 22 is refused, enable one of these on the satellite:

1. macOS Remote Login: System Settings → General → Sharing → Remote Login → On for `joel`
2. Tailscale SSH: enable SSH for the node in Tailscale admin and ensure ACL allows `joel` from Panda

Then verify:

```bash
ssh joel@100.72.79.112 'hostname && whoami'
```

## Bootstrap from Panda once SSH works

```bash
cd ~/Code/joelhooks/joelclaw
KEY="$(secrets lease typesense_api_key --ttl 1h)"
{
  printf 'export TYPESENSE_API_KEY=%q\n' "$KEY"
  printf 'export JOELCLAW_CENTRAL_URL=%q\n' 'https://panda.tail7af24.ts.net'
  printf 'export JOELCLAW_TYPESENSE_URL=%q\n' 'http://panda:8108'
  cat scripts/setup-satellite-rig.sh
} | ssh joel@100.72.79.112 'bash -s'
unset KEY
```

For a satellite with a dirty existing checkout, keep it intact and use a runtime checkout:

```bash
KEY="$(secrets lease typesense_api_key --ttl 1h)"
{
  printf 'export TYPESENSE_API_KEY=%q\n' "$KEY"
  printf 'export JOELCLAW_CENTRAL_URL=%q\n' 'https://panda.tail7af24.ts.net'
  printf 'export JOELCLAW_TYPESENSE_URL=%q\n' 'http://panda:8108'
  printf 'export JOELCLAW_REPO_DIR="$HOME/Code/joelhooks/joelclaw-runtime"\n'
  cat scripts/setup-satellite-rig.sh
} | ssh joel@flagg 'bash -s'
unset KEY
```

## What the bootstrap does

- verifies macOS identity and base tools: `git`, `python3`, `jq`
- installs Bun if missing
- prefers `fnm` default Node when available, avoiding Homebrew Node 26 native-build failures
- enables or installs pnpm
- clones or fast-forwards `~/Code/joelhooks/joelclaw`
- runs `pnpm install`
- writes `~/.config/system-bus.env` with `JOELCLAW_CENTRAL_URL`, `TYPESENSE_URL`, and `TYPESENSE_API_KEY` when that key is provided in the bootstrap environment
- builds `~/.bun/bin/joelclaw`
- writes `~/.local/bin/joelclaw` as a wrapper that sources `~/.config/system-bus.env` before execing the compiled binary
- creates real skill consumer roots and links joelclaw runtime as a namespaced pack:
  - `~/.pi/agent/skills/joelclaw-runtime -> <repo>/skills`
  - `~/.agents/skills/joelclaw-runtime -> <repo>/skills`
- converts old whole-root `~/.pi/agent/skills` or `~/.agents/skills` symlinks into real directories before adding the pack link
- ensures `~/.pi/agent/sessions` exists
- runs `joelclaw satellite health`
- tries `joelclaw satellite repair-request --central-ssh joel@panda`

## Manual checks after bootstrap

Pi auth is intentionally not copied by this script. Do that by the normal Pi login flow on the satellite. Run-capture auth is separate: each satellite also needs `~/.joelclaw/auth.json` from `scripts/joelclaw-machine-register.ts --name <machine>`, with token permissions `0600`.

Typesense access is intentionally local-config based on satellites, not agent-secrets based. Put the key in `~/.config/system-bus.env` with mode `0600`; the `~/.local/bin/joelclaw` wrapper sources it for non-interactive SSH commands.

```bash
command -v pi
pi --version
joelclaw satellite health
joelclaw sessions search "joel-writing-style" --source local --machine "$(hostname -s)" --limit 1
joelclaw sessions search "joel-writing-style" --source typesense --machine blaine --runtime all --limit 1
python3 - <<'PY'
import json, os, urllib.request
p=os.path.expanduser('~/.joelclaw/auth.json')
a=json.load(open(p))
req=urllib.request.Request('https://panda.tail7af24.ts.net/api/runs/health', headers={'Authorization': 'Bearer '+a['token']})
print(urllib.request.urlopen(req, timeout=10).status)
PY
```

If `satellite health` fails on local session search, start and exit one Pi session on the satellite so raw session files exist, then rerun health.

## Expected operating shape

From Panda, search the satellite's raw sessions:

```bash
joelclaw sessions search "<query>" \
  --source both \
  --machine blaine \
  --ssh-target joel@100.72.79.112 \
  --limit 8 \
  --extract
```

From the satellite itself:

```bash
joelclaw sessions search "<query>" --source local --machine "$(hostname -s)" --limit 8 --extract
joelclaw satellite health --notify --central-ssh joel@panda
```

## What not to install on satellites by default

Do not install the whole Panda runtime stack unless there is a specific reason:

- no local k8s
- no local Inngest
- no local Redis requirement
- no gateway Central role
- no secrets replication

Thin satellite first. Add weight only when it earns it. 🐀

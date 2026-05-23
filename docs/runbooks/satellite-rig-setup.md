# Satellite rig setup

Use this when bringing a thin joelclaw satellite Machine onto the tailnet.

A satellite is not Panda. It should have enough local rig to run Pi, capture local sessions, search those sessions, and ask Central for repair. Panda remains Central for Redis, gateway, Inngest, OTEL, secrets, and durable runtime work.

## Current target: blaine

Joel said `blain`; Tailscale currently advertises the Machine as `blaine`:

- Tailnet IP: `100.72.79.112`
- Tailscale DNS: `blaine.tail7af24.ts.net.`
- Status from Panda: active/direct
- SSH status from Panda: blocked, TCP/22 refused

That means Central cannot install the rig remotely until Remote Login or Tailscale SSH is enabled on blaine. Not a vibes problem. The door is shut.

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
ssh joel@100.72.79.112 'bash -s' < scripts/setup-satellite-rig.sh
```

Optional env overrides:

```bash
JOELCLAW_REPO_URL=git@github.com:joelhooks/joelclaw.git \
JOELCLAW_REPO_DIR="$HOME/Code/joelhooks/joelclaw" \
JOELCLAW_CENTRAL_SSH=joel@panda \
ssh joel@100.72.79.112 'bash -s' < scripts/setup-satellite-rig.sh
```

## What the bootstrap does

- verifies macOS identity and base tools: `git`, `python3`, `jq`
- installs Bun if missing
- enables or installs pnpm
- clones or fast-forwards `~/Code/joelhooks/joelclaw`
- runs `pnpm install`
- builds `~/.bun/bin/joelclaw`
- links `~/.local/bin/joelclaw`
- symlinks canonical repo skills into:
  - `~/.pi/agent/skills`
  - `~/.agents/skills`
- ensures `~/.pi/agent/sessions` exists
- runs `joelclaw satellite health`
- tries `joelclaw satellite repair-request --central-ssh joel@panda`

## Manual checks after bootstrap

Pi auth is intentionally not copied by this script. Do that by the normal Pi login flow on the satellite.

```bash
command -v pi
pi --version
joelclaw satellite health
joelclaw sessions search "joel-writing-style" --source local --machine "$(hostname -s)" --limit 1
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

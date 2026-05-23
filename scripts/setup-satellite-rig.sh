#!/usr/bin/env bash
set -euo pipefail

# Bootstrap a thin joelclaw satellite Machine.
# Run on the satellite itself, e.g. from Panda once SSH works:
#   ssh joel@blaine 'bash -s' < scripts/setup-satellite-rig.sh

REPO_URL="${JOELCLAW_REPO_URL:-git@github.com:joelhooks/joelclaw.git}"
REPO_DIR="${JOELCLAW_REPO_DIR:-$HOME/Code/joelhooks/joelclaw}"
CENTRAL_SSH="${JOELCLAW_CENTRAL_SSH:-joel@panda}"

say() { printf '\n==> %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1; }

say "satellite identity"
hostname
sw_vers -productVersion 2>/dev/null || true
uname -m

say "checking base tools"
missing=()
for tool in git python3 jq; do
  need "$tool" || missing+=("$tool")
done
if ((${#missing[@]})); then
  echo "Missing required tools: ${missing[*]}" >&2
  echo "Install Xcode CLT/Homebrew basics first, then rerun." >&2
  exit 1
fi

if ! need bun; then
  say "installing bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! need pnpm; then
  say "installing pnpm"
  if need corepack; then
    corepack enable pnpm
  elif need npm; then
    npm install -g pnpm
  elif need bun; then
    bun install -g pnpm
    export PATH="$HOME/.bun/bin:$PATH"
  else
    echo "Missing pnpm installer: need corepack, npm, or bun" >&2
    exit 1
  fi
fi

say "materializing joelclaw repo"
mkdir -p "$(dirname "$REPO_DIR")"
if [[ ! -d "$REPO_DIR/.git" ]]; then
  git clone "$REPO_URL" "$REPO_DIR"
else
  git -C "$REPO_DIR" fetch origin main
  git -C "$REPO_DIR" checkout main
  git -C "$REPO_DIR" pull --ff-only origin main
fi

cd "$REPO_DIR"

say "installing workspace deps"
pnpm install

say "building joelclaw CLI"
mkdir -p "$HOME/.local/bin" "$HOME/.bun/bin"
bun build packages/cli/src/cli.ts --compile --outfile "$HOME/.bun/bin/joelclaw"
ln -sf "$HOME/.bun/bin/joelclaw" "$HOME/.local/bin/joelclaw"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

say "linking canonical skills"
mkdir -p "$HOME/.pi/agent" "$HOME/.agents" "$HOME/.joelclaw"
rm -rf "$HOME/.pi/agent/skills" "$HOME/.agents/skills"
ln -s "$REPO_DIR/skills" "$HOME/.pi/agent/skills"
ln -s "$REPO_DIR/skills" "$HOME/.agents/skills"

say "ensuring Pi session directory exists"
mkdir -p "$HOME/.pi/agent/sessions"

if [[ -d "$REPO_DIR/.agents" ]]; then
  say "linking repo identity files when present"
  for name in IDENTITY.md SOUL.md ROLE.md USER.md TOOLS.md; do
    if [[ -e "$REPO_DIR/.agents/$name" ]]; then
      ln -sf "$REPO_DIR/.agents/$name" "$HOME/.joelclaw/$name" 2>/dev/null || true
    fi
  done
fi

say "checking satellite health"
joelclaw satellite health || true

say "checking Central relay path"
if ssh -o BatchMode=yes -o ConnectTimeout=8 "$CENTRAL_SSH" 'command -v joelclaw >/dev/null && hostname' >/tmp/joelclaw-central-check 2>/tmp/joelclaw-central-check.err; then
  joelclaw satellite repair-request --central-ssh "$CENTRAL_SSH" --priority normal || true
else
  echo "Central SSH check failed; repair-request skipped." >&2
  cat /tmp/joelclaw-central-check.err >&2 || true
fi

cat <<'DONE'

Satellite bootstrap finished.
Manual checks still needed:
- `pi` installed and authenticated on this Machine
- Remote Login or Tailscale SSH enabled if Central should operate this Machine
- `joelclaw sessions search "test" --source local --machine $(hostname -s) --limit 1`
DONE

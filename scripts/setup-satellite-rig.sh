#!/usr/bin/env bash
set -euo pipefail

# Bootstrap a thin joelclaw satellite Machine.
# Run on the satellite itself, e.g. from Panda once SSH works:
#   ssh joel@blaine 'bash -s' < scripts/setup-satellite-rig.sh

REPO_URL="${JOELCLAW_REPO_URL:-git@github.com:joelhooks/joelclaw.git}"
REPO_DIR="${JOELCLAW_REPO_DIR:-$HOME/Code/joelhooks/joelclaw}"
CENTRAL_SSH="${JOELCLAW_CENTRAL_SSH:-joel@panda}"
CENTRAL_URL="${JOELCLAW_CENTRAL_URL:-https://panda.tail7af24.ts.net}"
SATELLITE_TYPESENSE_URL="${TYPESENSE_URL:-${JOELCLAW_TYPESENSE_URL:-http://panda:8108}}"
SKIP_GIT_SYNC="${JOELCLAW_SKIP_GIT_SYNC:-false}"

say() { printf '\n==> %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1; }

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  [[ -n "$value" ]] || return 0
  mkdir -p "$(dirname "$file")"
  touch "$file"
  chmod 600 "$file"
  python3 - "$file" "$key" "$value" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
line = f"{key}={value}\n"
lines = path.read_text().splitlines(True) if path.exists() else []
replaced = False
out = []
for existing in lines:
    if existing.startswith(f"{key}="):
        out.append(line)
        replaced = True
    else:
        out.append(existing)
if not replaced:
    if out and not out[-1].endswith("\n"):
        out[-1] += "\n"
    out.append(line)
path.write_text("".join(out))
PY
}

ensure_skill_consumer_root() {
  local root="$1"
  local parent
  parent="$(dirname "$root")"
  mkdir -p "$parent"

  if [[ -L "$root" ]]; then
    local current_target
    current_target="$(readlink "$root")"
    echo "Converting $root from whole-root symlink to composed skill root: $current_target"
    unlink "$root"
  elif [[ -e "$root" && ! -d "$root" ]]; then
    echo "Cannot create skill consumer root: $root exists and is not a directory" >&2
    exit 1
  fi

  mkdir -p "$root"
}

ensure_skill_pack_link() {
  local root="$1"
  local pack_name="$2"
  local source_dir="$3"
  local target="$root/$pack_name"

  ensure_skill_consumer_root "$root"

  if [[ -L "$target" ]]; then
    local current_target
    local resolved_source
    local resolved_target
    current_target="$(readlink "$target")"
    resolved_source="$(cd "$source_dir" && pwd -P)"
    if resolved_target="$(cd "$(dirname "$target")" && cd "$(dirname "$current_target")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename "$current_target")")" &&
      [[ "$resolved_target" == "$resolved_source" ]]; then
      return 0
    fi
    unlink "$target"
  elif [[ -e "$target" ]]; then
    echo "Cannot link skill pack: $target exists and is not a symlink" >&2
    exit 1
  fi

  ln -s "$source_dir" "$target"
}

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

if need fnm; then
  say "using fnm default node"
  eval "$(fnm env --shell bash)"
  fnm use default >/dev/null 2>&1 || true
fi

if ! need node; then
  say "installing node"
  NODE_VERSION="${JOELCLAW_NODE_VERSION:-24.13.1}"
  NODE_ARCH="arm64"
  if [[ "$(uname -m)" == "x86_64" ]]; then
    NODE_ARCH="x64"
  fi
  NODE_DIR="$HOME/.local/node-v$NODE_VERSION-darwin-$NODE_ARCH"
  mkdir -p "$HOME/.local"
  if [[ ! -x "$NODE_DIR/bin/node" ]]; then
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.xz" | tar -xJ -C "$HOME/.local"
  fi
  mkdir -p "$HOME/.local/bin"
  ln -sf "$NODE_DIR/bin/node" "$HOME/.local/bin/node"
  ln -sf "$NODE_DIR/bin/npm" "$HOME/.local/bin/npm"
  ln -sf "$NODE_DIR/bin/npx" "$HOME/.local/bin/npx"
  export PATH="$HOME/.local/bin:$NODE_DIR/bin:$PATH"
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
elif [[ "$SKIP_GIT_SYNC" == "true" ]]; then
  echo "Skipping git sync for existing repo because JOELCLAW_SKIP_GIT_SYNC=true"
else
  git -C "$REPO_DIR" fetch origin main
  git -C "$REPO_DIR" checkout main
  git -C "$REPO_DIR" pull --ff-only origin main
fi

cd "$REPO_DIR"
REPO_DIR="$(pwd -P)"

say "installing workspace deps"
pnpm install

say "writing satellite environment"
ENV_FILE="$HOME/.config/system-bus.env"
upsert_env_var "$ENV_FILE" "JOELCLAW_CENTRAL_URL" "$CENTRAL_URL"
upsert_env_var "$ENV_FILE" "TYPESENSE_URL" "$SATELLITE_TYPESENSE_URL"
if [[ -n "${TYPESENSE_API_KEY:-}" ]]; then
  upsert_env_var "$ENV_FILE" "TYPESENSE_API_KEY" "$TYPESENSE_API_KEY"
fi

say "building joelclaw CLI"
mkdir -p "$HOME/.local/bin" "$HOME/.bun/bin"
bun build packages/cli/src/cli.ts --compile --outfile "$HOME/.bun/bin/joelclaw"
rm -f "$HOME/.local/bin/joelclaw"
cat > "$HOME/.local/bin/joelclaw" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="$HOME/.config/system-bus.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
exec "$HOME/.bun/bin/joelclaw" "$@"
SH
chmod 755 "$HOME/.local/bin/joelclaw"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

say "linking joelclaw runtime skill pack"
mkdir -p "$HOME/.pi/agent" "$HOME/.agents" "$HOME/.joelclaw"
ensure_skill_pack_link "$HOME/.pi/agent/skills" "joelclaw-runtime" "$REPO_DIR/skills"
ensure_skill_pack_link "$HOME/.agents/skills" "joelclaw-runtime" "$REPO_DIR/skills"

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
if ssh -o BatchMode=yes -o ConnectTimeout=8 "$CENTRAL_SSH" '
JOELCLAW=$(command -v joelclaw || true)
if [[ -z "$JOELCLAW" && -x "$HOME/.local/bin/joelclaw" ]]; then JOELCLAW="$HOME/.local/bin/joelclaw"; fi
if [[ -z "$JOELCLAW" && -x "$HOME/.bun/bin/joelclaw" ]]; then JOELCLAW="$HOME/.bun/bin/joelclaw"; fi
test -n "$JOELCLAW" && hostname
' >/tmp/joelclaw-central-check 2>/tmp/joelclaw-central-check.err; then
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
- `joelclaw sessions search "test" --source typesense --machine $(hostname -s) --runtime all --limit 1`
DONE

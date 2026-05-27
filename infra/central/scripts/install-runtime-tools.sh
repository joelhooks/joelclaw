#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

PI_VERSION="${PI_VERSION:-0.73.0}"
CODEX_VERSION="${CODEX_VERSION:-0.125.0}"
BREW_FORMULAE=(colima docker docker-compose)
NPM_PACKAGES=(
  "@mariozechner/pi-coding-agent@${PI_VERSION}"
  "@openai/codex@${CODEX_VERSION}"
)

if [[ "$(id -u)" == "0" ]]; then
  fail "do not run as root; run as the admin user with Homebrew access"
fi

require_command brew
require_command npm

log "installing Flagg Gate 3 Homebrew runtime tools"
for formula in "${BREW_FORMULAE[@]}"; do
  if brew list --formula "$formula" >/dev/null 2>&1; then
    log "brew formula already installed: ${formula}"
  else
    log "brew install ${formula}"
    brew install "$formula"
  fi
done

log "installing Flagg Gate 3 npm agent tools"
for package in "${NPM_PACKAGES[@]}"; do
  log "npm install -g ${package}"
  npm install -g "$package"
done

log "verifying runtime tools"
for cmd in colima docker pi codex; do
  require_command "$cmd"
  printf '%s=%s\n' "$cmd" "$(command -v "$cmd")"
done

docker --version
if ! docker compose version; then
  docker-compose version
fi
pi --version
codex --version

log "runtime tool installation complete"

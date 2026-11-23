#!/bin/bash
# Deploy the voice worker into its Linux guest from a committed joelclaw rev.
# Usage: guest/deploy.sh [git-rev]   (default HEAD). Host names come from guest.env.sh.
#
# Python and deps are pinned: uv-managed CPython 3.14 (never the host's newest Python),
# the venv built with `uv sync --frozen` from uv.lock, and the unit runs .venv/bin/python
# directly, so nothing re-resolves or recreates the venv at start. Model files are
# downloaded at deploy time and the unit runs with HF_HUB_OFFLINE=1.
set -euo pipefail

REV="${1:-HEAD}"
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/guest.env.sh"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
SHA="$(git -C "$REPO" rev-parse --short "$REV")"
UV_VERSION=0.11.16

echo "deploying joelclaw $SHA infra/voice-agent"

# 1. uv, sha-checked, if missing or a different version; a clean staging dir.
guest "set -e
if [ \"\$(/usr/local/bin/uv --version 2>/dev/null | cut -d' ' -f2)\" != $UV_VERSION ]; then
  d=\$(mktemp -d); cd \$d
  base=https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz
  curl -fsSLO \$base; curl -fsSLO \$base.sha256; sha256sum -c uv-x86_64-unknown-linux-gnu.tar.gz.sha256
  tar xzf uv-x86_64-unknown-linux-gnu.tar.gz
  install -m 0755 uv-x86_64-unknown-linux-gnu/uv uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/
fi
rm -rf /opt/voice-agent.next
install -d -o voiceworker -g voiceworker -m 0755 /opt/voice-agent.next /opt/uv-python"

# 2. Code from the committed rev only (never the working tree).
git -C "$REPO" archive --format=tar "$REV:infra/voice-agent" \
  | ssh -o BatchMode=yes "$VOICE_GUEST_HOST" "pct exec $VOICE_GUEST_CT -- runuser -u voiceworker -- tar -x -C /opt/voice-agent.next"

# 3. Locked deps on pinned Python and models in staging, then swap, install units, restart.
guest "set -e
export HOME=/var/lib/voiceworker UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_CACHE_DIR=/var/lib/voiceworker/.cache/uv UV_PYTHON_PREFERENCE=only-managed HF_HOME=/var/lib/voiceworker/.cache/huggingface
as_worker() { runuser -u voiceworker --preserve-environment -- \"\$@\"; }
cd /opt/voice-agent.next
printf '%s\n' $SHA | as_worker tee .source-rev >/dev/null
as_worker /usr/local/bin/uv python install 3.14
as_worker /usr/local/bin/uv sync --frozen --no-dev --python 3.14
as_worker env JOELCLAW_VOICE_CONFIG=/etc/voice-agent/cfg/voice-agent.yaml .venv/bin/python main.py download-files >/dev/null 2>&1
.venv/bin/python -c 'import sys; assert sys.version_info[:2] == (3, 14), sys.version'
rm -rf /opt/voice-agent.prev
if [ -d /opt/voice-agent ]; then mv /opt/voice-agent /opt/voice-agent.prev; fi
mv /opt/voice-agent.next /opt/voice-agent
# uv venvs record absolute paths; re-sync in place after the move (cache-hot, fast).
cd /opt/voice-agent && as_worker /usr/local/bin/uv sync --frozen --no-dev --python 3.14 >/dev/null 2>&1
for u in voice-agent.service voice-verify.service voice-verify.timer; do
  install -m 0644 /opt/voice-agent/guest/\$u /etc/systemd/system/\$u
done
systemctl daemon-reload
systemctl enable voice-agent.service voice-verify.timer >/dev/null 2>&1
systemctl restart voice-agent.service
systemctl restart voice-verify.timer
sleep 15
systemctl is-active voice-agent.service"

"$HERE/canary.sh"

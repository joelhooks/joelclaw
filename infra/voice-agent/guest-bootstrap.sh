#!/usr/bin/env bash
# Bootstrap the voice guest (Debian 13 LXC) for the voice worker.
# Run as root inside the guest, script on stdin:  pct exec <ct> -- bash -s < guest-bootstrap.sh
# Idempotent: it is also the rebuild path. It does NOT join the tailnet;
# the join is separate, after the tailnet policy is live, with the key on stdin:
#   secrets lease <key> | ssh <host> 'pct exec <ct> -- tailscale up --auth-key=file:/dev/stdin --hostname=voice-guest'
# The worker user is voiceworker: Debian already has a "voice" device group.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl
install -d -m 0755 /usr/share/keyrings
curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
apt-get update
apt-get install -y --no-install-recommends tailscale openssh-client python3 python3-venv git
systemctl enable --now tailscaled
tailscale version | head -1
tailscale status 2>&1 | head -1 || true   # expect "Logged out." before the join

U=voiceworker H=/var/lib/voiceworker
id "$U" >/dev/null 2>&1 || useradd --system -U --create-home --home-dir "$H" --shell /usr/sbin/nologin "$U"
install -d -m 0700 -o "$U" -g "$U" "$H/.ssh"
K="$H/.ssh/voice-flagg_ed25519"
[ -f "$K" ] || runuser -u "$U" -- ssh-keygen -q -t ed25519 -N '' -C voiceworker@voice-guest -f "$K"
chmod 0600 "$K"; chmod 0644 "$K.pub"
id "$U"
cat "$K.pub"
ssh-keygen -lf "$K.pub"

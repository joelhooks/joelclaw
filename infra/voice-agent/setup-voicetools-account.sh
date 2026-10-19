#!/bin/bash
# Set up the Flagg account a remote voice worker uses to run tools (REMOTE-TOOLS.md).
# Joel approved the account, 2026-10-19. Run as joel; it asks for sudo once.
#
#   setup-voicetools-account.sh --key "<guest ssh-ed25519 public key>" --from <guest tailnet IP>          # preview
#   setup-voicetools-account.sh --key "<...>" --from <IP> --apply                                         # do it
#   setup-voicetools-account.sh --remove                                                                  # undo all of it
#
# Idempotent. What it does:
#   1. hidden account _voicetools (UID/GID 450), shell /bin/sh, home /var/voicetools,
#      added to com.apple.access_ssh (Remote Login is limited to that group)
#   2. root-owned authorized_keys with restrict, from= and the forced command,
#      so the account can't change its own key line
#   3. sudoers: _voicetools may run exactly the gate as joel, nothing else
#   4. sshd Match User block: no tty, no forwarding, max 4 sessions
#   5. a root-owned copy of the gate in /usr/local/libexec, with the commit sha recorded
set -euo pipefail

ACCT=_voicetools
ID=450
HOME_DIR=/var/voicetools
GATE_SRC="$(cd "$(dirname "$0")" && pwd)/voice_remote_gate.py"
GATE=/usr/local/libexec/voice_remote_gate.py
FORCED="sudo -n -u joel /usr/bin/python3 -I $GATE"
SUDOERS=/etc/sudoers.d/voicetools
SSHD_CONF=/etc/ssh/sshd_config.d/200-voicetools.conf

KEY="" FROM="" APPLY=0 REMOVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --remove) REMOVE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$REMOVE" = 1 ]; then
  # Undo every step, in reverse. Safe to re-run.
  sudo -v
  sudo rm -f "$SSHD_CONF" && sudo launchctl kickstart -k system/com.openssh.sshd
  sudo rm -f "$SUDOERS" "$GATE" "$GATE.sha"
  sudo dseditgroup -o edit -d "$ACCT" -t user com.apple.access_ssh 2>/dev/null || true
  dscl . -read "/Users/$ACCT" >/dev/null 2>&1 && sudo dscl . -delete "/Users/$ACCT"
  dscl . -read "/Groups/$ACCT" >/dev/null 2>&1 && sudo dscl . -delete "/Groups/$ACCT"
  sudo rm -f "$HOME_DIR/.ssh/authorized_keys"
  sudo rmdir "$HOME_DIR/.ssh" "$HOME_DIR" 2>/dev/null || true
  echo "Removed $ACCT, its key, sudoers rule, sshd block and the gate copy."
  exit 0
fi

# Exactly one ED25519 public key on one line: a control character (a newline)
# could smuggle in a second, unrestricted authorized_keys entry.
if [[ "$KEY" =~ [[:cntrl:]] ]] || [[ ! "$KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9@._-]{0,64})?$ ]]; then
  echo "--key must be one ssh-ed25519 public key on one line" >&2; exit 2
fi
KEYCHECK="$(printf '%s\n' "$KEY" | ssh-keygen -lf - 2>/dev/null || true)"
if [ "$(printf '%s\n' "$KEYCHECK" | grep -c '(ED25519)$')" != 1 ] || [ "$(printf '%s\n' "$KEYCHECK" | wc -l | tr -d ' ')" != 1 ]; then
  echo "--key did not parse as exactly one ED25519 key" >&2; exit 2
fi
# The numeric IDs must be free, or already ours.
uid_owner="$(dscl . -search /Users UniqueID "$ID" 2>/dev/null | awk 'NR==1{print $1}')"
gid_owner="$(dscl . -search /Groups PrimaryGroupID "$ID" 2>/dev/null | awk 'NR==1{print $1}')"
for owner in "$uid_owner" "$gid_owner"; do
  if [ -n "$owner" ] && [ "$owner" != "$ACCT" ]; then
    echo "refusing: id $ID already belongs to $owner" >&2; exit 2
  fi
done
[[ "$FROM" =~ ^100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo "--from must be the guest's tailnet IPv4 (100.x.y.z)" >&2; exit 2; }
[ -f "$GATE_SRC" ] || { echo "gate not found: $GATE_SRC" >&2; exit 2; }
# Install only a reviewed copy: the file must be byte-identical to origin/main.
REPO="$(git -C "$(dirname "$GATE_SRC")" rev-parse --show-toplevel)"
git -C "$REPO" fetch -q origin main
SHA="$(git -C "$REPO" rev-parse origin/main)"
WANT="$(git -C "$REPO" rev-parse "origin/main:infra/voice-agent/voice_remote_gate.py" 2>/dev/null || true)"
HAVE="$(git -C "$REPO" hash-object "$GATE_SRC")"
if [ -z "$WANT" ] || [ "$WANT" != "$HAVE" ]; then
  echo "refusing: $GATE_SRC is not byte-identical to origin/main ($SHA); install only a reviewed, merged copy" >&2
  exit 2
fi

AUTH_LINE="restrict,from=\"$FROM\",command=\"$FORCED\" $KEY"
SUDO_LINE="$ACCT ALL=(joel) NOPASSWD: /usr/bin/python3 -I $GATE"
# Ends with "Match all": the drop-in is included before the main file's global
# lines, which would otherwise fall inside this Match block.
SSHD_BLOCK="Match User $ACCT
    PermitTTY no
    AllowTcpForwarding no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
    MaxSessions 4
Match all"

cat <<EOF
Plan (gate commit $SHA):
  account   $ACCT uid/gid $ID, shell /bin/sh, home $HOME_DIR, in com.apple.access_ssh
  key       $HOME_DIR/.ssh/authorized_keys (root:wheel 0644):
            $AUTH_LINE
  sudoers   $SUDOERS: $SUDO_LINE
  sshd      $SSHD_CONF:
$(sed 's/^/            /' <<<"$SSHD_BLOCK")
  gate      $GATE (root:wheel 0644), sha in $GATE.sha
EOF
[ "$APPLY" = 1 ] || { echo; echo "Preview only. Re-run with --apply."; exit 0; }

sudo -v
TMP="$(mktemp -d)"
trap 'rm -f "$TMP"/*; rmdir "$TMP"' EXIT

# 1. account
if ! dscl . -read "/Groups/$ACCT" >/dev/null 2>&1; then
  sudo dscl . -create "/Groups/$ACCT" PrimaryGroupID "$ID"
fi
if ! dscl . -read "/Users/$ACCT" >/dev/null 2>&1; then
  sudo dscl . -create "/Users/$ACCT"
  sudo dscl . -create "/Users/$ACCT" UniqueID "$ID"
  sudo dscl . -create "/Users/$ACCT" PrimaryGroupID "$ID"
  sudo dscl . -create "/Users/$ACCT" RealName "Voice tools (remote voice worker)"
  sudo dscl . -create "/Users/$ACCT" IsHidden 1
  sudo dscl . -create "/Users/$ACCT" Password '*'
fi
sudo dscl . -create "/Users/$ACCT" UserShell /bin/sh
sudo dscl . -create "/Users/$ACCT" NFSHomeDirectory "$HOME_DIR"
sudo dseditgroup -o edit -a "$ACCT" -t user com.apple.access_ssh

# 2. key, root-owned so the account can't edit it
sudo install -d -o root -g wheel -m 0755 "$HOME_DIR" "$HOME_DIR/.ssh"
printf '%s\n' "$AUTH_LINE" > "$TMP/authorized_keys"
sudo install -o root -g wheel -m 0644 "$TMP/authorized_keys" "$HOME_DIR/.ssh/authorized_keys"

# 3. sudoers, syntax-checked before install
printf '%s\n' "$SUDO_LINE" > "$TMP/sudoers"
sudo visudo -cf "$TMP/sudoers"
sudo install -o root -g wheel -m 0440 "$TMP/sudoers" "$SUDOERS"

# 4. gate copy
sudo install -d -o root -g wheel -m 0755 /usr/local/libexec
sudo install -o root -g wheel -m 0644 "$GATE_SRC" "$GATE"
printf '%s\n' "$SHA" > "$TMP/sha"
sudo install -o root -g wheel -m 0644 "$TMP/sha" "$GATE.sha"

# 5. sshd: syntax test, then prove scope. joel's effective config must not
# change, and _voicetools must get every restriction. Any miss: remove, exit.
effective() { sudo sshd -T -C "user=$1,host=x,addr=100.64.0.1" 2>/dev/null | sort; }
effective joel > "$TMP/joel.before"
[ -s "$TMP/joel.before" ] || { echo "sshd -T printed nothing for joel; not touching sshd" >&2; exit 1; }
printf '%s\n' "$SSHD_BLOCK" > "$TMP/sshd.conf"
sudo install -o root -g wheel -m 0644 "$TMP/sshd.conf" "$SSHD_CONF"
fail_sshd() { sudo rm -f "$SSHD_CONF"; echo "sshd check failed ($1); removed $SSHD_CONF, sshd untouched" >&2; exit 1; }
sudo sshd -t || fail_sshd "syntax"
effective joel > "$TMP/joel.after"
cmp -s "$TMP/joel.before" "$TMP/joel.after" || { diff "$TMP/joel.before" "$TMP/joel.after" >&2; fail_sshd "joel's effective config changed"; }
effective "$ACCT" > "$TMP/acct"
for want in "permittty no" "allowtcpforwarding no" "x11forwarding no" "allowagentforwarding no" "permittunnel no" "maxsessions 4"; do
  grep -qx "$want" "$TMP/acct" || fail_sshd "$ACCT missing: $want"
done
sudo launchctl kickstart -k system/com.openssh.sshd

echo
echo "Done. Checks (env_keep must not list DEVELOPER_DIR or PYTHON*):"
sudo -l -U "$ACCT"
printf '%s' '["joelclaw","status"]' | sudo -u "$ACCT" $FORCED >/dev/null && echo "gate runs as joel via sudo: ok"

# Voice tools from off Flagg

When the voice worker runs somewhere other than Flagg (the planned Shardik guest),
its tools that need Flagg run through one gate:

- `flagg_remote.py` (worker side) turns a tool's argv into a logical call and
  sends it as JSON over ssh. It's off unless `VOICE_FLAGG_HOST` is set; on Flagg
  nothing changes.
- `voice_remote_gate.py` (Flagg side) accepts only calls that match an exact
  schema, runs them as `joel`, and logs the call name, never its arguments, to
  `~/.local/log/voice-remote-gate.log`.

Calls that act outward or start agents (`joelclaw loop start`, `joelclaw call`,
any event except the transcript hand-off, calendar invites with attendees) are
not allowed off Flagg. The tool says so and the line tells Joel.

## Flagg setup (needs Joel's yes; not done)

1. **Account:** a dedicated account, e.g. `_voicetools`. Not admin, no home
   content. Its shell must be `/bin/sh`, because sshd runs a forced command
   through the account's shell, so `nologin` would break it. `restrict` plus
   `command=` mean it never gets an interactive shell.
2. **Gate copy:** install the gate where only root can change it, so a checkout
   or pull can't become code run as `joel`:
   `sudo install -o root -g wheel -m 0644 voice_remote_gate.py /usr/local/libexec/voice_remote_gate.py`.
   Reinstall it on every reviewed change.
3. **sudoers** (`/etc/sudoers.d/voicetools`, `visudo -c` first). Exact args, no wildcards:
   `_voicetools ALL=(joel) NOPASSWD: /usr/bin/python3 -I /usr/local/libexec/voice_remote_gate.py`.
   Check it with `sudo -l -U _voicetools`.
4. **authorized_keys** for `_voicetools`, with the guest's tailnet IP:
   `restrict,from="<guest tailnet IP>",command="sudo -n -u joel /usr/bin/python3 -I /usr/local/libexec/voice_remote_gate.py" ssh-ed25519 <guest key>`.
5. **sshd** `Match User _voicetools`: `MaxSessions 4`, `PermitTTY no`,
   `AllowTcpForwarding no`, `X11Forwarding no`, `AllowAgentForwarding no`,
   on top of `restrict` in the key line.

## Guest setup

- `VOICE_FLAGG_HOST=_voicetools@flagg` in the worker env.
- Key `~/.ssh/voice-flagg_ed25519` and Flagg's host key in
  `~/.ssh/voice-flagg-known_hosts`. `flagg_remote.ssh_argv` pins both itself
  (`-F none`, `IdentitiesOnly`, `StrictHostKeyChecking yes`), whatever the
  guest's ssh config says. Never trust on first use: copy Flagg's host key
  over a channel you already trust.
- `relayedBy` is not stamped: transcript payloads are validated against the
  exact event schemas instead. Per-minute caps: 10 writes, 3 chat notes.
- The gate runs each tool by absolute path (`EXE` in the gate). If a tool
  moves, update `EXE` and reinstall the reviewed copy.
- Tailnet ACL (`tag:shardik-voice`): the guest reaches Flagg port 22 and the
  Rat King mailbox's one host and port, nothing else. The ACL can't name a unix
  account. What limits ssh to `_voicetools` is that the guest holds only that
  key, plus `from=` and sshd's `Match User`.
- Check: `python3 -m pytest tests/test_flagg_remote.py`, then one call each for
  `joelclaw status` and `brain-git pages` through ssh. A refused call exits 126,
  busy exits 75, and an unreachable Flagg makes the tool say so aloud.

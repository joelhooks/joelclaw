---
name: three-body
description: Operate Joel's ASUSTOR NAS host `three-body` safely. Use when Joel mentions three-body, ASUSTOR, NAS instability, SMB/NFS mounts, mounted drives disappearing, `/share`, `/volume1`, `/volume2`, `TMBackup-Joel`, `joelclaw`, `data`, Flagg NAS mounts, or asks to SSH into the NAS.
---

# Three Body

Use this for host-specific work on Joel's ASUSTOR NAS. Use `system-architecture` when the task affects Panda/Flagg Central migration. Use `tailnet-topology` when the task is about Tailscale, MagicDNS, tailnet routing, or whether `three-body` resolves over LAN vs tailnet.

## Access

Default non-interactive SSH check:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=8 joel@three-body 'hostname && whoami && pwd && uptime'
```

Known live receipt from 2026-06-17:

- SSH target: `joel@three-body`
- Hostname: `three-body`
- User: `joel`
- Shell/home shape: BusyBox-ish `/bin/sh`, home at `/volume1/home/joel`
- ASUSTOR ADM web UI: `https://three-body:8481`
- HTTP port exists at `8480`; HTTPS is enabled, but `HttpsOnly = No` in `/etc/nas.conf`
- Local name resolution on Flagg: `three-body` resolved to `three-body.tail7af24.ts.net` / `100.67.156.41`
- LAN address: active NAS interface `eth2` had `192.168.1.163`

Do not print SSH identity paths, private keys, tokens, raw serial numbers, or host IDs.

## Host Facts

Verified from `/etc/nas.conf` and live SSH on 2026-06-17:

- Vendor/model: ASUSTOR AS6508T
- ADM version: `5.1.3.RI81`
- Kernel: Linux `6.6.x`
- Network config has four LAN slots and DHCP on at least `eth2` / `eth3`
- Active LAN path observed on `eth2`, MTU `9000`, default gateway `192.168.1.1`
- `eth2` link reported 10000Mb/s full duplex by `ethtool`
- Tailscale was active and directly reachable from Flagg; verify current truth with `tailscale status`

Remote ADM is not a normal full Linux distro. Expect missing tools like `rg`, `hostnamectl`, `findmnt`, and sometimes `lsblk`. Prefer `grep`, `awk`, `sed`, `ps w`, `netstat`, `df`, `mount`, `/proc/mdstat`, and ASUSTOR's `/usr/builtin/*` paths.

## Storage Map

Current storage receipt from 2026-06-17:

- `/volume1`: main Btrfs storage on `/dev/md1`, about 64T, RAID5 across 8 disks, mounted through `/share/*`
- `/volume2`: Btrfs storage on `/dev/md2`, about 1.9T, RAID1 across two NVMe devices, mounted through `/share/data` and `/share/flagg-proof`
- `/volume0`: small ext4 system volume on `/dev/md0`
- `/share`: user-facing share mount surface; source paths usually live under `/volume1/*` or `/volume2/*`

Healthy `mdstat` shape observed:

```txt
md1 ... raid5 ... [8/8] [UUUUUUUU]
md2 ... raid1 ... [2/2] [UU]
md0 ... raid1 ... [8/8] [UUUUUUUU]
```

Use these read-only checks before blaming ASUSTOR itself:

```sh
ssh joel@three-body 'uptime; cat /proc/mdstat; df -hT; mount | grep -Ei "volume|share|btrfs|nfs|smb|cifs"'
ssh joel@three-body 'dmesg 2>/dev/null | tail -n 250 | grep -Ei "error|fail|reset|timeout|btrfs|md[0-9]|raid|sata|nvme|nfs|smb|cifs|eth|link" | tail -n 80'
```

For SMART checks, `smartctl` exists at `/usr/builtin/sbin/smartctl`, but disk-level inspection likely needs root.

## Shares And Services

SMB and NFS were both running on 2026-06-17:

- SMB: TCP `139` and `445`, `/usr/builtin/sbin/smbd`, `/usr/builtin/sbin/nmbd`, `/usr/builtin/sbin/winbindd`
- NFS: TCP/UDP `111` and `2049`, kernel `nfsd`
- Docker/Tailscale also run on the NAS; do not assume a plain Debian layout

Important config paths:

```sh
/usr/builtin/etc/samba/smb.conf
/usr/builtin/etc/samba/asustorsmb.conf
/etc/exports
/etc/default/exports
/usr/builtin/etc/init.d/S41nfs
/usr/builtin/etc/init.d/S47smbd
```

Read current protocol state:

```sh
ssh joel@three-body 'ps w | grep -Ei "[s]mb|[n]mb|[n]fs|[t]ailscale|[d]ocker" || true'
ssh joel@three-body 'netstat -tulpn 2>/dev/null | grep -E ":(22|111|139|445|2049)[[:space:]]" || true'
showmount -e three-body
```

Known SMB share names from 2026-06-17:

- `Home` -> `/volume1/home/%u`
- `Public` -> `/volume1/Public`
- `Web` -> `/volume1/Web`
- `Docker` -> `/volume1/Docker`
- `cluster-storage` -> `/volume1/cluster-storage`
- `Media` -> `/volume1/Media`
- `TMBackup-Joel` -> `/volume1/TMBackup-Joel`
- `joelclaw` -> `/volume1/joelclaw`
- `data` -> `/volume2/data`
- `flagg-proof` -> `/volume2/flagg-proof`
- `MinIOCE` -> `/volume1/MinIOCE`

Check valid users and exact share config from the Samba config instead of guessing.

## NFS Gotchas

Current NFS exports are mostly LAN-scoped, not tailnet-scoped. If a client mounts via MagicDNS/Tailscale IP, the server may see the client as a `100.x` tailnet source that does not match exports like `192.168.1.0/24`.

Current exports include:

- `/volume2/data` for `192.168.1.0/24` and selected LAN hosts
- `/volume1/joelclaw` for `192.168.1.0/24`, Kubernetes-ish subnets, and selected LAN hosts
- `/volume2/flagg-proof` for `192.168.1.10`
- `/volume1/home/joel` for `192.168.1.27`
- `/volume1/cluster-storage` for selected LAN/container subnets
- `/volume1/Public` for `192.168.1.70`

Historical helper scripts in `~joel/flagg-nfs-*.sh` encode an important ASUSTOR/NFS gotcha: broad subnet entries can effectively win over later host-specific entries. Those scripts remove/reinsert the host rule before the broad rule, back up `/etc/exports`, run `/usr/builtin/sbin/exportfs -ra`, and sometimes restart NFS with an ASUSTOR-safe `PATH`.

Useful identity facts from those scripts:

- ADM user `joel`: uid `1002`, gid `100`
- `flaggsvc` experiments used uid `1003`, gid `100`
- Some older squash experiments used uid/gid `999`

Do not run the helper scripts or edit `/etc/exports` without explicit authorization. If asked to change NFS exports:

1. Inspect `/etc/exports` and `exportfs -v`.
2. Copy `/etc/exports` to a timestamped backup.
3. Make the smallest change.
4. Run `/usr/builtin/sbin/exportfs -ra`.
5. Verify with `showmount -e three-body` from the client.
6. If restarting NFS, use:

```sh
PATH=/usr/builtin/sbin:/usr/builtin/bin:/usr/sbin:/usr/bin:/sbin:/bin /usr/builtin/etc/init.d/S41nfs restart
```

## Flagg LAN Mount Contract

Shelf-local rule: for devices physically on the same shelf/LAN, mounted storage should be LAN-shaped by default. Use Tailscale/MagicDNS for remote access, admin/control-plane access, and emergency reachability; do not use it as the default data path for stable high-throughput NAS mounts unless explicitly configured and tested that way.

For Flagg Central, the repo-managed NFS mount contract is:

- NAS LAN IP: `192.168.1.163`
- NAS LAN IP is static/reserved; do not treat normal DHCP drift as the likely cause unless new evidence contradicts this.
- Flagg LAN IP: `192.168.1.10`
- Expected Flagg interface: `en0`
- Expected media: `10Gbase-T`
- Current safe MTU proof target: `8192`
- Full jumbo target: `9000`, but only after end-to-end switch/NAS path proof passes above the current 8192-byte ceiling
- NAS NVMe mount: `/Volumes/nas-nvme` from `192.168.1.163:/volume2/data`
- NAS HDD mount: `/Volumes/three-body` from `192.168.1.163:/volume1/joelclaw`
- Tuned NFS options: `rw,resvport,nfsvers=3,tcp,soft,intr,timeo=10,retrans=2,rsize=524288,wsize=524288,dsize=65536,readahead=128`

Do not use `three-body:/volume...` for persistent NFS mounts on Flagg. On 2026-06-17, `three-body` resolved to the Tailscale IP:

```txt
three-body -> three-body.tail7af24.ts.net -> 100.67.156.41
route to 100.67.156.41 -> utun1
route to 192.168.1.163 -> en0
```

The previous LaunchDaemon logs showed repeated NFS `Permission denied` while mounting `three-body:/volume2/data`; that is consistent with accidentally mounting over Tailscale while the NFS exports allow LAN clients.

Mount scripts live in `infra/central/scripts/`:

```sh
./infra/central/scripts/mount-nas.sh status
sudo ./infra/central/scripts/mount-nas.sh mount
./infra/central/scripts/verify-nas.sh --write-probe --benchmark-mib 64
```

A healthy live mount does not prove boot durability. Regression receipt 2026-07-09: both mounts were live and tuned on Flagg while `/Library/LaunchDaemons/com.joelclaw.central.nas-mounts.plist` was missing and `launchctl print system/com.joelclaw.central.nas-mounts` returned "Could not find service" — a reboot would have silently dropped both mounts. Check durability explicitly:

```sh
ls -l /Library/LaunchDaemons/com.joelclaw.central.nas-mounts.plist
sudo launchctl print system/com.joelclaw.central.nas-mounts | head -5
```

If the plist is missing, reinstall idempotently from the service checkout:

```sh
sudo /Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/install-nas-mounts.sh --bootstrap
```

`verify-nas.sh` hard-fails on a missing plist; `preflight.sh` warns.

No sudo is needed to verify any of this. `verify-nas.sh` runs fully green unprivileged: the plist is world-readable, and daemon liveness is proved by log freshness — the daemon fires every 60s and `/Users/Shared/joelclaw/logs/central/nas-mounts.out.log` is world-readable, so a recent mtime means loaded-and-running without `launchctl print` on the root-only system domain. Reserve sudo for install/reinstall, manual `mount-nas.sh mount|unmount` (`resvport` needs root), and `sync-service-checkout.sh`; see `infra/central/README.md` "Sudo discipline" for the full split and the optional read-only sudoers line.

If the LAN IP path says `No route to host`, do not fall back to Tailscale silently. Fix LAN reachability or the ASUSTOR/network rule first.

On macOS, `No route to host` for a same-subnet LAN service can be Local Network privacy for the invoking app, even when ARP and routing look correct. On 2026-06-17, accepting the GUI Local Network prompt let `nc -vz -G 3 192.168.1.163 2049` and `showmount -e 192.168.1.163` succeed. If an agent shell is blocked but Terminal works, use Terminal for the privileged repair or grant Local Network permission to the app hosting the agent.

Allow-list path on macOS:

```sh
open "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork"
```

Then enable the app that runs the LAN probe, such as Terminal, iTerm, or Codex. `tccutil` can reset privacy decisions, but it does not grant Local Network permission from the CLI. Treat the GUI toggle/prompt as the durable allow-list.

Successful Flagg repair receipt from 2026-06-17:

- Synced fixed NAS scripts into `/Users/Shared/joelclaw/src/joelclaw`
- Installed and bootstrapped `system/com.joelclaw.central.nas-mounts`
- Mounted `/Volumes/nas-nvme` from `192.168.1.163:/volume2/data`
- Mounted `/Volumes/three-body` from `192.168.1.163:/volume1/joelclaw`
- Passed `verify-nas.sh --write-probe --benchmark-mib 64`

MTU/NFS tuning receipt from 2026-06-17:

- `networksetup -setMTU Ethernet 9000` worked locally on Flagg and route MTU changed to `9000`.
- Full MTU 9000 proof failed: `ping -D -c 5 -s 8972 192.168.1.163` had `100%` packet loss with `Message too long` send errors.
- Practical jumbo proof passed: after setting Flagg `Ethernet` to MTU `8192`, `ping -D -c 3 -s 8164 192.168.1.163` had `0%` packet loss. `8165` failed as expected at the local 8192-byte ceiling.
- Baseline 8K NFS transfer benchmark at MTU `1500`, 512 MiB per tier:
  - `/Volumes/nas-nvme/s3`: write about `144 MiB/s`, read about `165 MiB/s`
  - `/Volumes/three-body/s3`: write about `123 MiB/s`, read about `166 MiB/s`
- Tuned NFS transfer sweep at MTU `1500`, 512 MiB per tier:
  - 64K: NVMe write about `485 MiB/s`, read about `930 MiB/s`
  - 128K: NVMe write about `561 MiB/s`, read about `973 MiB/s`
  - 256K: NVMe write about `598 MiB/s`, read about `1014 MiB/s`
  - 512K: NVMe write about `624 MiB/s`, read about `1017 MiB/s`; HDD write about `612 MiB/s`, read about `1010 MiB/s`
  - 1M: NVMe write about `627 MiB/s`, read about `967 MiB/s`; HDD write regressed to about `431 MiB/s`
- Chosen default: 512K `rsize`/`wsize`, 64K `dsize`, `readahead=128`, no `async`.
- Final live 512K remount proof, 1024 MiB per tier:
  - `/Volumes/nas-nvme/s3`: write about `573 MiB/s`, read about `992 MiB/s`
  - `/Volumes/three-body/s3`: write about `474 MiB/s`, read about `975 MiB/s`
- Final live 8192-MTU proof, 1024 MiB per tier:
  - `/Volumes/nas-nvme/s3`: write about `614 MiB/s`, read about `1018 MiB/s`
  - `/Volumes/three-body/s3`: write about `552 MiB/s`, read about `925 MiB/s`
- `infra/central/scripts/common.sh` and `/Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/common.sh` both carried the 8192 MTU default and 512K NFS transfer defaults after sync.
- `/Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/verify-nas.sh --write-probe --benchmark-mib 64` passed from the service checkout with `expected_mtu=8192`.
- `nfsstat -m` showed both mounted filesystems using `rsize=524288,wsize=524288,readahead=128`.

Blaine NAS mount receipt from 2026-06-22 pre-install:

- Blaine host reports `Dark-Tower.localdomain`; Tailscale advertises `blaine` / `100.72.79.112`.
- Route to NAS LAN IP `192.168.1.163` uses `en9`.
- `en9` is `Thunderbolt Ethernet Slot 0`, LAN IP `192.168.1.136`, media `10Gbase-T`, MTU initially `1500`.
- NFS port `2049` on `192.168.1.163` is reachable and exports include `/volume2/data` + `/volume1/joelclaw` for `192.168.1.0/24`.
- Blaine requires interactive sudo, so privileged durable mount installation must run locally on Blaine: `sudo ./scripts/install-satellite-nas-mounts.sh --bootstrap`.
- The satellite installer uses IP exports, installs `system/com.joelclaw.satellite.nas-mounts`, sets/proves MTU `8192`, and resets to `1500` + stops if jumbo proof fails.

Next MTU steps:

1. Keep Flagg `Ethernet` at MTU `8192` unless new errors appear; this is the proved practical jumbo ceiling for the current path.
2. Confirm the ASUSTOR `eth2` interface still reports MTU `9000` and 10000Mb/s full duplex.
3. Inspect the switch path if full 9000-byte jumbo is still desired; something between Flagg and `three-body` appears capped around 8192-byte IP packets.
4. If full 9000 passes later, update `NAS_EXPECTED_MTU` to `9000`, remount, run `verify-nas.sh --write-probe --benchmark-mib 1024`, then hard-reboot Flagg and prove no-login restore.
5. If full 9000 still fails, keep MTU `8192` and treat the 512K NFS transfer tuning as the current 10GbE-safe performance posture.

## Mount Debugging

Do not treat Finder sidebar mounts or macOS Login Items as reliable infrastructure.

When Joel reports disappearing drives, split the problem:

1. NAS health: uptime, `/proc/mdstat`, `df`, `dmesg`, SMART, ADM logs.
2. Network path: wired vs Wi-Fi, DHCP/IP drift, Tailscale vs LAN source address, 10G link state.
3. Protocol: SMB vs NFS, export/client allowlist, UID mapping, stale mount options.
4. macOS mount mechanism: Finder/manual mount vs `autofs` or launchd.

Local checks:

```sh
tailscale status | grep -i three-body || true
mount | grep -Ei 'three-body|smbfs|nfs|100\.67\.156\.41|192\.168\.1\.163'
showmount -e three-body
showmount -e 192.168.1.163
smbutil view //joel@three-body
```

If NFS is being used from macOS, verify whether `three-body` resolves to a LAN IP or a Tailscale IP. If the export only allows `192.168.1.0/24`, a tailnet-sourced NFS mount is suspect even when `showmount` lists exports.

For stable mounted access, prefer one deterministic path while debugging:

- SMB: use an explicit LAN share URL like `smb://192.168.1.163/Media` or a stable LAN DNS name that resolves to the NAS LAN IP.
- NFS: use the LAN address that matches `/etc/exports`, likely `192.168.1.163` from the 2026-06-17 receipt, or add a deliberate tailnet export rule.
- Automation: use launchd for Central mounts; do not rely on Finder remembering a mount.

## Safety

- Never print secrets, keys, token files, `.env`, or raw private config from the NAS.
- Treat tailnet hostnames/IPs and share ACLs as private operator context.
- Storage repair, RAID changes, Btrfs scrub/balance, NFS export edits, and service restarts can affect active workloads. Inspect first and summarize risk before changing anything.
- Prefer read-only inventory until Joel explicitly asks for a fix.

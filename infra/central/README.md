# Flagg Central runtime scaffold

Repo-managed runtime assets for ADR-0246 Gate 2: Mac Studio Central shadow bootstrap.

This directory does **not** cut over Central. Panda remains authoritative until an explicit whole-Central cutover gate is approved.

## Non-negotiable reboot pillar

Central is not accepted until it survives a hard reboot with **no GUI login** and recovers itself through system `launchd`.

Proof means:

- Tailscale is the open-source `tailscaled` system LaunchDaemon (`com.tailscale.tailscaled`), not the GUI/login item;
- Central services are installed as system LaunchDaemons, not user LaunchAgents;
- LaunchDaemons run as `UserName=joelclaw` where practical;
- no auto-login, no Screen Sharing login, no Terminal session, no manual `colima start`, no manual `docker compose up`;
- after the machine reboots, another machine can SSH in and run `infra/central/scripts/reboot-proof.sh`;
- `reboot-proof.sh` passes, including `console_user=root`, system tailscaled health, launchd labels loaded, post-boot logs, and service health.

If this proof fails, Flagg is not eligible for cutover. Full stop.

## Shape

```text
/Users/Shared/joelclaw/
  services/
    redis/
    typesense/
    inngest/
    minio/
  backups/
    central/
  logs/
    central/
  src/
    joelclaw/          # eventual service-owned checkout for launchd
```

`compose.yaml` models the first shadow runtime:

- Redis `7-alpine`
- Typesense `30.1`
- Inngest self-hosted server
- Restate `1.6.2`
- MinIO S3-compatible object store

Restate data uses a Docker named volume inside the Colima VM (`CENTRAL_RESTATE_VOLUME`) instead of a `/Users/Shared` bind mount. Restate writes Unix sockets under `/restate-data`; macOS/Colima host bind mounts reject that with `Operation not supported`.

## NAS/object-storage contract

Shadow MinIO may use `/Users/Shared/joelclaw/services/minio` only for isolated smoke tests. That path is **not** the Gate 5 object-storage target.

For cutover, MinIO should be an S3-compatible facade over `three-body` NAS tiers:

| Tier | Flagg mount | NAS path | Role |
| --- | --- | --- | --- |
| Tier 1 local SSD | `/Users/Shared/joelclaw/services/*` | Flagg internal SSD | Redis, Inngest, Restate, active Typesense, scratch/cache |
| NAS NVMe warm/hot | `/Volumes/nas-nvme` | `192.168.1.163:/volume2/data` | fast shared artifacts, snapshots, models, docs artifacts, sessions, transcripts, hot object data |
| NAS HDD cold | `/Volumes/three-body` | `192.168.1.163:/volume1/joelclaw` | archives, books, video/media refs, bulk/cold object data |

`three-body` as a hostname is for SSH/admin convenience. Persistent NFS data mounts use the NAS LAN IP. On Flagg, `three-body` can resolve through Tailscale/MagicDNS, which makes the client source a tailnet address while the ASUSTOR NFS exports expect LAN clients such as `192.168.1.10`.

Do not blend NAS NVMe and NAS HDD into one opaque MinIO erasure set. Keep tier boundaries visible. Preferred Gate 5 shape is either:

1. two explicit object-store surfaces (`minio-hot` backed by NAS NVMe, `minio-cold` backed by NAS HDD), or
2. one hot MinIO surface plus explicit lifecycle/copy jobs to cold HDD.

Before cutover, prove:

- Flagg routes `three-body` traffic over the 10GbE interface, not Tailscale/Wi-Fi;
- NFS export strings and reachability checks use the NAS LAN IP, not MagicDNS;
- MTU/NFS tuning matches ADR-0088 or the reason for divergence is documented;
- `/Volumes/nas-nvme` and `/Volumes/three-body` survive hard reboot/no-login;
- read/write latency and throughput are good enough for the selected tier;
- MinIO bucket/object smoke tests write to the NAS-backed path, not local Flagg SSD.

NAS mount lifecycle is an explicit state machine, not boolean soup:

```text
boot/kickstart
  -> wait_for_route(en0, three-body:2049)
  -> assert_10gbe_media
  -> mount_nas_nvme
  -> mount_nas_hdd
  -> verify_mounts
  -> ready | failed_retry_next_interval
```

Repo-managed scripts:

```bash
# Install the root LaunchDaemon and mount points; disabled unless --bootstrap is passed.
sudo ./infra/central/scripts/install-nas-mounts.sh --no-bootstrap

# Start the NAS mount daemon after validating exports/options.
sudo ./infra/central/scripts/install-nas-mounts.sh --bootstrap

# Manual mount/status/unmount when debugging.
sudo ./infra/central/scripts/mount-nas.sh mount
./infra/central/scripts/mount-nas.sh status
sudo ./infra/central/scripts/mount-nas.sh unmount

# Prepare object roots on the NAS. This avoids fragile pasted one-liners.
# Copy or stage this script to three-body, then run it from the admin shell:
sudo sh /tmp/three-body-prepare-object-roots.sh

# Gate 5 proof receipt: route/media/MTU/mounts plus 64 MiB write/read probes against the hot/cold object paths.
./infra/central/scripts/verify-nas.sh --write-probe --benchmark-mib 64
```

`verify-nas.sh` intentionally writes under `CENTRAL_MINIO_HOT_DATA` and `CENTRAL_MINIO_COLD_DATA`, not the export roots. If those paths are missing or not writable by `joelclaw`, the fix belongs on `three-body` NAS permissions/ACLs, not by making Flagg write random proof files at the mount root.

For NFSv3, numeric ownership matters. Flagg's service identity is `uid=502`, `gid=20`. The helper script `infra/central/scripts/three-body-prepare-object-roots.sh` creates a real `joelclaw`/`staff` identity on `three-body` if uid `502` / gid `20` are absent, then prepares `/volume2/data/s3` and `/volume1/joelclaw/s3` for that identity. It defaults to `2777` for proof mode because the NAS export/id-map layer has already shown weird permission behavior even with `502:20` + `2770`. After proof, retry with `USE_FINAL_MODE=1 sudo sh /tmp/three-body-prepare-object-roots.sh` if we want to harden to `2770`.

ASUSTOR ADM NFS privileges also matter beyond POSIX mode. For Flagg's client rule on both shared folders `data` and `joelclaw`, the working proof setting is `Privilege: Read & Write`, `root Mapping: admin (999)`, `Asynchronous: Yes`, and `Allow connections from non-reserved ports` enabled. This generates `root_squash,anonuid=999,anongid=999,insecure` for `192.168.1.10` and allowed Flagg `joelclaw` writes. The earlier `root (0)` / `no_root_squash` export looked correct but still returned `Operation not permitted` from macOS NFS.

Flagg also hit an NFS blackhole when `en0`/route MTU was set to `9000`: full 9000-byte jumbo ping failed while smaller traffic worked, and hard NFS mounts wedged. A bounded 2026-06-17 retest proved a practical jumbo ceiling: Flagg can set route MTU `9000`, but `ping -D -s 8972 192.168.1.163` still fails; setting Flagg `Ethernet` to MTU `8192` makes `ping -D -s 8164 192.168.1.163` pass with 0% loss and `8165` fail as expected. The safe route MTU is now `8192`; full `9000` remains a switch/NAS path follow-up.

The current NFS performance default is tuned for the safe `8192` MTU path: `rw,resvport,nfsvers=3,tcp,soft,intr,timeo=10,retrans=2,rsize=524288,wsize=524288,dsize=65536,readahead=128`. A 512 MiB sweep picked 512K request sizes over 1M because 1M regressed the HDD tier. The final 8192-MTU 1024 MiB proof was roughly `614 MiB/s` write / `1018 MiB/s` read on NVMe and `552 MiB/s` write / `925 MiB/s` read on HDD. Do not enable `async` on the macOS client side as a casual performance knob; it is a data-loss tradeoff.

2026-06-17 correction: the mount scripts previously defaulted `CENTRAL_NAS_*_EXPORT` to `three-body:/...` and checked NFS reachability through `NAS_HOST`. On Flagg that hostname resolved to `three-body.tail7af24.ts.net` / `100.67.156.41`, so launchd could pass a route check while mounting over the wrong data plane and hitting NFS permission errors. The defaults now use `NAS_IP` (`192.168.1.163`) for export strings and NFS reachability checks.

2026-06-17 live repair: macOS Local Network privacy was also blocking the first direct LAN probes from the invoking app. After allowing local-network access, the root `com.joelclaw.central.nas-mounts` LaunchDaemon was installed/bootstrapped, both NFS tiers mounted over `192.168.1.163`, and `verify-nas.sh --write-probe --benchmark-mib 64` passed. The service checkout at `/Users/Shared/joelclaw/src/joelclaw` now carries `NAS_EXPECTED_MTU=8192` plus the 512K NFS transfer defaults, and its verifier passed with `expected_mtu=8192`.

If permissions were changed on `three-body` while Flagg had the NFS exports mounted, first sync the latest helper scripts into the service checkout, then remount before rerunning the proof so macOS drops any stale NFS access-cache verdict:

```bash
cd /Users/joel/Code/joelhooks/joelclaw
sudo rsync -aR \
  infra/central/scripts/common.sh \
  infra/central/scripts/mount-nas.sh \
  infra/central/scripts/preflight.sh \
  infra/central/scripts/verify-nas.sh \
  /Users/Shared/joelclaw/src/joelclaw/
sudo chown joelclaw:staff \
  /Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/common.sh \
  /Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/mount-nas.sh \
  /Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/preflight.sh \
  /Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/verify-nas.sh
sudo chmod 755 \
  /Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/common.sh \
  /Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/mount-nas.sh \
  /Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/preflight.sh \
  /Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/verify-nas.sh
cd /Users/Shared/joelclaw/src/joelclaw
sudo ./infra/central/scripts/mount-nas.sh unmount
sudo ./infra/central/scripts/mount-nas.sh mount
```

Set `CENTRAL_REQUIRE_NAS=1` only after mount proof passes. With that flag, `start.sh`, `health.sh`, and the smoke harness require NAS verification before treating the Central stack as healthy.

All ports bind to `127.0.0.1` by default. Do not expose this over Tailscale/LAN until cutover planning says so.

## Before running

Gate 1 must be complete:

- `joelclaw` Standard service user exists and is not admin
- `/Users/Shared/joelclaw` is owned by `joelclaw:staff`
- `clawadmin` or another non-Joel admin login is verified

Then create a local env file in the checkout that will run the services. During final launchd mode this should be the service-owned checkout:

```text
/Users/Shared/joelclaw/src/joelclaw/infra/central/.env
```

For review/preflight from Joel's dev checkout, generate shadow-only credentials:

```bash
cd /Users/joel/Code/joelhooks/joelclaw
./infra/central/scripts/write-shadow-env.sh
```

Never commit `.env`. Inngest self-hosted `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` must be even-length hex strings; `write-shadow-env.sh` generates that shape.

## Preflight

```bash
cd /Users/joel/Code/joelhooks/joelclaw
./infra/central/scripts/preflight.sh
```

This checks the account gate, system tailscaled, local env file, service root, and whether Docker/Colima are available. It does not install anything.

## System tailscaled migration

Flagg Central should not depend on the GUI Tailscale app or a logged-in user session.

Run this **locally on Flagg**, not over SSH:

```bash
cd /Users/joel/Code/joelhooks/joelclaw
sudo ./infra/central/scripts/install-system-tailscaled.sh
```

The script:

- sets the no-sleep server power profile (`sleep=0`, `disksleep=0`, `womp=1`, `tcpkeepalive=1`, `autorestart=1`),
- quits/disables the GUI login-session Tailscale path,
- moves `/Applications/Tailscale.app` into `/Users/Shared/joelclaw/backups/`,
- runs `tailscaled install-system-daemon`,
- runs `tailscale --socket=/var/run/tailscaled.socket up --hostname=flagg --operator=joel --ssh --accept-routes`,
- writes a receipt under `/Users/Shared/joelclaw/run/`.

If it prints an auth URL, open it locally and approve the new node. The old GUI node may remain in the tailnet until removed from the admin console.

Important: the normal `tailscale` command may still talk to a stale GUI NetworkExtension while both variants are present. For this migration, always target the system daemon explicitly:

```bash
/opt/homebrew/bin/tailscale --socket=/var/run/tailscaled.socket status
```

If verification says the GUI network extension is still running, reboot Flagg and verify again before any GUI login. The GUI app was moved out of `/Applications`, so it should not come back after reboot.

Rollback:

```bash
sudo ./infra/central/scripts/rollback-system-tailscaled.sh
```

## Shadow start

The service data dirs stay owned by `joelclaw`, so the real start path is service-user execution via launchd. The repo mirror is readable/executable for SSH verification, but `.env` remains `0600`. Do not accidentally make Joel's dev account the runtime owner.

Gate 3 install path:

```bash
cd /Users/joel/Code/joelhooks/joelclaw
./infra/central/scripts/install-runtime-tools.sh
./infra/central/scripts/write-shadow-env.sh
sudo ./infra/central/scripts/disable-gui-tailscale-system-extension.sh
sudo ./infra/central/scripts/sync-service-checkout.sh
sudo ./infra/central/scripts/install-launchdaemons.sh --no-bootstrap
./infra/central/scripts/preflight.sh
```

`install-launchdaemons.sh --no-bootstrap` installs the system plists and explicitly disables the labels so a reboot does not start the shadow stack before Gate 4. Use `--bootstrap` in Gate 4 when the shadow runtime start is approved; it enables and starts the labels.

Gate 4 diagnostics are one command; do not paste ad-hoc heredocs when the shell is already annoyed:

```bash
sudo ./infra/central/scripts/diagnose.sh
```

If TCP ports are open but Redis/HTTP probes blackhole, use the bounded recovery helper instead of poking individual tunnels by hand:

```bash
sudo ./infra/central/scripts/recover.sh --all --passes 3
```

It restarts the shadow Compose services as `joelclaw`, writes a timestamped receipt under `/Users/Shared/joelclaw/logs/central/`, and only exits 0 after consecutive green health passes.

`health.sh` is also a tiny recovery state machine now: `healthy -> degraded -> recovering -> healthy|failed`. By default it runs bounded probes, tracks consecutive failures in `/Users/Shared/joelclaw/logs/central/health-consecutive-failures`, and invokes `recover.sh --all` after 3 degraded passes with a cooldown. Set `CENTRAL_AUTO_RECOVER=0` to make it check-only again.

After Gate 3 installs Colima/Docker and mirrors the repo into `/Users/Shared/joelclaw/src/joelclaw`, the service-user commands are:

```bash
cd /Users/Shared/joelclaw/src/joelclaw
./infra/central/scripts/start-colima.sh
./infra/central/scripts/start.sh
./infra/central/scripts/health.sh
```

Stop:

```bash
./infra/central/scripts/stop.sh
```

Those are meant to run as `joelclaw` via LaunchDaemon or a batched admin command, not as Joel's dev shell.

## Launchd templates

Templates live in `infra/central/launchd/` and assume the service-owned checkout path:

```text
/Users/Shared/joelclaw/src/joelclaw
```

They are templates only. Do not install them by hand as the source of truth. Render/install with `scripts/install-launchdaemons.sh`.

The Colima and Compose templates retry on failed exit via `KeepAlive.SuccessfulExit=false`. That matters at boot because Compose can race the container substrate. Success exits cleanly; failures get another shove.

## Gate 5 Phase A smoke tests

After Gate 4 is green, use the smoke harness for service-by-service shadow proof before any cutover gate:

```bash
cd /Users/Shared/joelclaw/src/joelclaw
sudo -u joelclaw -H ./infra/central/scripts/smoke/run.sh
```

The harness performs isolated temp writes against Flagg shadow services only: Redis temp key, Typesense temp collection, Inngest smoke event, Restate port/admin reachability, and MinIO temp bucket/object. Receipts are written under `/Users/Shared/joelclaw/logs/central/smoke/`.

This does not freeze Panda, flip endpoints, or make Flagg authoritative.

## Hard reboot proof

After Gate 3 installs LaunchDaemons and starts the shadow stack, the acceptance test is:

```bash
# From Panda, before any GUI login on Flagg after reboot:
ssh joel@flagg 'cd /Users/Shared/joelclaw/src/joelclaw && ./infra/central/scripts/reboot-proof.sh'
```

Expected final line:

```text
PASS: Central recovered after hard reboot with no GUI login.
```

If the proof requires logging into Flagg first, it failed. We do not rationalize that away.

## Sudo discipline

Most scripts here are non-privileged. Privileged work should be batched:

1. agent prepares repo-managed scripts/configs,
2. Joel runs one short sudo block,
3. agent verifies remotely,
4. repeat only when needed.

No cursed glitter sudo sprinkles.

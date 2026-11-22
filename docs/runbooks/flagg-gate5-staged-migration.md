# central host Gate 5 staged migration plan

For private addresses, accounts, ports, and host roles, see `.brain/resources/operator-network-context.svx` in the private dark-wizard repo and the `tailnet-topology` skill. Replace angle-bracket placeholders with the configured values before running commands.

Gate 5 is the central host **Central** cutover phase for ADR-0246.

This plan reconciles two constraints:

1. Joel wants to migrate and smoke-test services individually.
2. ADR-0246 forbids long-lived split-brain Central.

The safe shape is **staged proof, atomic authority**: rehearse and smoke-test each service individually, but do not leave retired host and central host sharing authoritative Central ownership. Stateful authority flips only inside an approved cutover window with retired host writes frozen.

## Status

Draft plan. Do not execute without explicit go/no-go.

Project Thread for approvals, milestone updates, blockers, and smoke-test evidence:

- https://eggheadio.slack.com/archives/C09LKT871PE/p1779975813335049

Gate 4 is complete: central host shadow Central recovered after hard reboot with no GUI login.

Gate 5 Phase A stateful-service shadow smoke passed on 2026-05-28. Receipt on central host:

```text
/Users/Shared/joelclaw/logs/central/smoke/phase-a-20260528T162118Z.log
```

Verified services: Redis, Typesense, Inngest, Restate, and MinIO. This was shadow-only; retired host was not frozen and no endpoints were flipped.

Gate 5 is not complete until central host owns Central state, workers, endpoints, and verification while retired host is frozen as rollback-only.

## Definitions

- **Shadow smoke test**: a test against central host using shadow data or isolated writes. Safe before cutover.
- **Migration rehearsal**: a repeatable state copy into central host while retired host remains authoritative. Safe if central host services do not feed live Central clients.
- **Authority flip**: the moment a service becomes the source of truth for Central. Requires the write freeze gate.
- **Rollback point**: the latest state from which retired host can still resume cleanly without replaying central host writes.
- **Split-brain**: any state where retired host and central host both accept authoritative Central writes for the same service family. Forbidden.

## What “refactoring the deploy system” means

Avoid this during Gate 5 unless a blocker forces it:

- replacing the deploy abstraction,
- rebuilding CI/CD around the new host,
- changing how `joelclaw deploy` works,
- rewriting service discovery,
- replacing worker packaging,
- adding a new supervisor/runtime family,
- generalizing central host migration scripts into a universal platform.

Gate 5 can add small, boring scripts if needed for migration proof. It should not become “while we are here, let's rebuild deployment.” That is how a migration turns into a swamp with receipts.

## What “making central host perfect” means

Good idea. Wrong gate.

Create a post-cutover hardening backlog instead of blocking Central migration on perfection:

- demote Joel from admin after confidence window,
- verify backup/restore with a real restore drill,
- add service-native export/import for Redis, Typesense, MinIO, and Restate where needed,
- improve health summaries and OTEL dashboards,
- make worker deployment boring from one command,
- harden secrets and move toward the Credential Proxy direction from `CONTEXT.md`,
- clean central host GitHub SSH/fetch,
- prune shadow leftovers,
- document “remote dev box, not service owner” boundaries.

Perfection is a Phase 6/hardening board, not a Gate 5 prerequisite.

## Gate 5 state machine

```mermaid
stateDiagram-v2
  [*] --> ShadowReady
  ShadowReady --> Rehearsing: per-service smoke tests
  Rehearsing --> ShadowReady: reset shadow data
  Rehearsing --> GoNoGo: all smoke tests pass
  GoNoGo --> Rehearsing: not approved
  GoNoGo --> FreezePanda: explicit approval
  FreezePanda --> FinalSnapshot
  FinalSnapshot --> FinalSync
  FinalSync --> FlipEndpoints
  FlipEndpoints --> StartFlaggWorkers
  StartFlaggWorkers --> VerifyCentral
  VerifyCentral --> ObserveRollbackWindow
  ObserveRollbackWindow --> Shipped: rollback window closes

  FreezePanda --> RollbackPanda: pre-flip failure
  FinalSync --> RollbackPanda: sync failure
  FlipEndpoints --> RollbackPanda: endpoint failure before <central-host> writes
  StartFlaggWorkers --> RollbackPanda: worker failure before <central-host> writes
  VerifyCentral --> ReplayOrForwardFix: <central-host> writes happened
  ReplayOrForwardFix --> ObserveRollbackWindow

  RollbackPanda --> ShadowReady
```

The nasty edge: once central host accepts authoritative writes, rollback is no longer a simple flip-back. It becomes replay/repair. That is the line we do not cross casually.

## Service order

### Phase A — shadow service smoke tests

These can run before cutover. They prove central host services are alive and compatible without making them authoritative.

| Order | Service | Shadow smoke test | Split-brain risk |
| --- | --- | --- | --- |
| 1 | Redis | `PING`, test isolated key write/read/delete, inspect persistence after restart | Low if test keys are namespaced and no live clients point at it |
| 2 | Typesense | `/health`, create temp collection, import/search/delete temp docs | Low if temp collection only |
| 3 | Inngest | `/health`, dev-server/API reachability, worker registration smoke against Flagg-only endpoint | Medium if live events point here early |
| 4 | Restate | ingress/admin/metrics ports, register temp service, invoke no-op workflow if available | Medium if live workers use mixed Restate/Redis/Inngest |
| 5 | MinIO | ready health, temp bucket/object write/read/delete | Low if temp bucket only |
| 6 | system-bus-worker | start against central host env in isolated mode, verify `/api/inngest`, do not register against retired host | High if it consumes live retired host events while writing central host state |
| 7 | restate-worker | start against central host Restate in isolated mode, run no-op DAG | High if it drains live retired host queues |
| 8 | gateway bridge | send a private test notification through central host path only | High if inbound channels are double-consumed |
| 9 | Run capture/search | capture a test Run to central host, search it, delete/reset if needed | High if client Machines post to both Centrals |

### Phase B — migration rehearsal

Copy or rebuild data into central host while retired host remains authoritative.

Rules:

- central host remains isolated from live writers.
- Every rehearsal is idempotent.
- Every rehearsal has a reset path.
- Evidence is logged with timestamp, source, destination, record counts, and smoke result.

Recommended per-service rehearsal stance:

| Service | Source of truth | Rehearsal approach | Cutover stance |
| --- | --- | --- | --- |
| Redis | retired host runtime state | Snapshot/copy only if state is needed; otherwise drain/empty at cutover | Prefer drain/quiet over migrating stale queues |
| Typesense | Mixed: memory Runs rebuildable from NAS; OTEL/search collections may need export | Export/import collections or rebuild memory collections from NAS | Must know which collections are authoritative vs derived |
| Inngest | retired host event/run DB | Prefer drain active runs, then start central host clean unless history is required | Do not dual-deliver events |
| Restate | retired host workload journal | Prefer no active jobs at cutover; do not migrate poisoned/active journals casually | Drain/cancel workloads before flip |
| MinIO | Object data if still used | Bucket sync / object inventory diff | Only include wave 1 buckets actually used by Central |
| Workers | Code + env | Start against central host services after state is staged | Workers start after stateful services are Flagg-authoritative |
| Gateway | Channel ingress + queue bridge | Private test path only | Inbound channels flip last |
| Runs/memory | NAS + Typesense | Rebuild/import search index; capture test Run | Capture endpoint flips after central host search works |

### Phase B inventory dry-run — 2026-05-28

Read-only retired host inventory found:

| Service | retired host state observed | Gate 5 stance |
| --- | --- | --- |
| Redis | 26 keys in db0: 11 `joelclaw:*`, 9 `memory:*`, 2 `health:*`, plus `nas:*`, `knowledge:*`, `heartbeat:*`, `granola:*`. Queue state includes `joelclaw:queue:events` stream length 141 and `joelclaw:queue:priority` zset size 141; consumer group `joelclaw:queue:system-bus` has lag 141 and pending 0. | Snapshot/copy only after freeze if preserving gateway/runtime continuity. Do not blindly replay the 141 queued events; drain or explicitly discard stale queue entries. Health/heartbeat/watchdog timestamps can start clean. |
| Typesense | 22 collections, largest: `otel_events` 1,972,228 docs, `docs_chunks_v2` 228,939, `slack_messages` 33,262, `memory_observations` 28,046, `run_chunks_dev` 18,362, `runs_dev` 11,064. No aliases. Typesense resident memory ~5.0GB. | Export/import or rebuild by collection. Treat `runs_dev`, `run_chunks_dev`, `memory_observations`, `otel_events`, `gateway_behavior_history`, and `machines_dev` as continuity candidates. Rebuild obvious derived indexes (`docs*`, `vault_notes`, `blog_posts`, `system_knowledge`) where source-of-truth replay is cheaper and safer. |
| Inngest | `/data/main.db` is 17.5GB. Tables: 2 apps, 155 functions, 221,060 events, 98,093 runs, 96,835 finishes, 1,481,631 history rows, 1,198,599 traces, 2,113,373 spans. Last event/run timestamps are 2026-05-20. There are 1,258 unfinished runs; top unfinished are `queue/observer` 697, `slack-channel-backfill` 174, `memory/run.captured` 107, `channel-message-classify` 105, `system/content-sync` 73. | Prefer archive/snapshot retired host Inngest DB and start central host clean after drain/freeze. Migrating the 17.5GB DB would preserve history but also carries stale unfinished work. The unfinished set needs explicit cancel/discard decision before cutover. |
| Restate | Admin API reports `services: []`, `deployments: []`; `/restate-data` is 840KB with only cluster marker observed. | Start clean. No workload journal migration needed unless new jobs appear before cutover. |
| MinIO | No MinIO/Aistor/S3 resources in retired host k8s, no listening host ports 9000/9001/30900/30901/31000/31001. Repo manifest exists but is not applied. | Start clean or omit from wave 1 unless another object-store source is identified. |

This inventory created temporary read-only SQLite inspection pods for Inngest and deleted them immediately after logs were collected. No retired host freeze, endpoint flip, queue drain, data copy, or cutover happened.

### central host NAS persistence check — 2026-05-28/30

Current proved state:

- central host's real 10GbE interface is `en0`, not the stale `en10` assumption. `en0` has `<private-ip>` and reports `10Gbase-T`.
- `<nas>` is `<private-ip>`.
- NFS `2049/tcp` is reachable over `en0` after Wi-Fi/route drift is corrected.
- `<nas-nvme-mount>` mounts from `<private-ip>:<nas-nvme-export>`.
- `<nas-hdd-mount>` mounts from `<private-ip>:<nas-hdd-export>`.
- route MTU is currently proved at `8192`. Bounded jumbo-frame tests showed full MTU `9000` fails (`ping -D -s 8972 <private-ip>`), but practical jumbo MTU `8192` passes (`ping -D -s 8164 <private-ip>`) with 0% loss. Treat full `9000` as a switch/NAS path follow-up, not a Gate 5 NAS write blocker.
- tuned NFS defaults at MTU `8192`: `rw,resvport,nfsvers=3,tcp,soft,intr,timeo=10,retrans=2,rsize=524288,wsize=524288,dsize=65536,readahead=128`.
- NAS object roots exist and show `uid=502`, `gid=20`, mode `2777`:
  - `<nas-nvme-mount>/s3`
  - `<nas-hdd-mount>/s3`
- `<nas>` has a Linux passwd/group identity for central host's service user: `joelclaw` uid `502`, `staff` gid `20`.
- Local writes on `<nas>` to both object roots succeed as NAS user `joel`.
- central host NFS writes now succeed from the `joelclaw` service user against both object roots.

Working ASUSTOR NFS setting for both shared folders `data` and `joelclaw`:

```text
Client: <private-ip>
Privilege: Read & Write
root Mapping: admin (999)
Asynchronous: Yes
Allow connections from non-reserved ports (ports greater than 1024): enabled
```

Runtime `/etc/exports` / `exportfs -v` shape for central host after that GUI setting:

```text
<private-ip>(rw,async,root_squash,anonuid=999,anongid=999,subtree_check,no_wdelay,insecure)
```

The initially recommended `root Mapping: root (0)` generated `no_root_squash,anonuid=0,anongid=0,insecure`, but central host writes still failed with `Operation not permitted`. Mapping root to ASUSTOR `admin (999)` is the setting that made central host NFS writes pass. The broader `<private-cidr>` rules already existed for other machines; leave them in place unless deliberately reworking NAS access.

Proof receipts from the original 2026-05-30 write test and the tuned 2026-06-17 remount:

```bash
# mounted after <central-host> reboot with tuned 8192-MTU proof options
sudo env \
  NAS_EXPECTED_INTERFACE=en0 \
  NAS_EXPECTED_MTU=8192 \
  NAS_NFS_OPTIONS='rw,resvport,nfsvers=3,tcp,soft,intr,timeo=10,retrans=2,rsize=524288,wsize=524288,dsize=65536,readahead=128' \
  ./infra/central/scripts/mount-nas.sh mount

sudo -u joelclaw -H mkdir <nas-nvme-mount>/s3/.svc-proof && sudo -u joelclaw -H rmdir <nas-nvme-mount>/s3/.svc-proof
sudo -u joelclaw -H mkdir <nas-hdd-mount>/s3/.svc-proof && sudo -u joelclaw -H rmdir <nas-hdd-mount>/s3/.svc-proof

sudo -u joelclaw -H env NAS_EXPECTED_INTERFACE=en0 NAS_EXPECTED_MTU=8192 \
  ./infra/central/scripts/verify-nas.sh --write-probe --benchmark-mib 1

sudo -u joelclaw -H env NAS_EXPECTED_INTERFACE=en0 NAS_EXPECTED_MTU=8192 \
  ./infra/central/scripts/verify-nas.sh --write-probe --benchmark-mib 64
```

The 64 MiB verification reported all route/media/mount checks ok and both object paths writable/benchmarked:

```text
ok   nfs port reachable
ok   route uses expected 10GbE interface
ok   interface media is 10GbE
ok   route MTU matches ADR-0088 target
ok   nas-nvme mounted
ok   nas-nvme mount is nfs
ok   nas-hdd mounted
ok   nas-hdd mount is nfs
ok   nas-nvme hot object path writable/benchmarked
ok   nas-hdd cold object path writable/benchmarked
```

Still not complete: hard-reboot/no-GUI NAS verification remains the next proof before Gate 5 can use NAS-backed object storage.

### 2026-06-17 LAN mount contract correction

central host and `<nas>` sit on the same shelf/LAN, so persistent storage mounts are a LAN-IP contract. Tailscale/MagicDNS remains useful for SSH/admin/remote access, but it is not the default data plane for NFS.

Audit receipt:

- On central host, `<nas>` resolved to `<tailnet-host>` / `<tailnet-ip>` and routed over `utun1`.
- The NAS LAN IP `<private-ip>` routed over `en0`.
- The ASUSTOR NFS exports are LAN-scoped around `<private-cidr>` and selected LAN hosts.
- Old launchd logs showed repeated `mount_nfs: can't mount <nas-nvme-export> from NAS onto <nas-nvme-mount>: Permission denied`.

The root bug: `infra/central/scripts/common.sh` built NFS export strings from `NAS_HOST=NAS`, while the route checks used `NAS_IP=<private-ip>`. That let a check prove the LAN route while the actual mount used MagicDNS/Tailscale. The scripts now default `CENTRAL_NAS_NVME_EXPORT` and `CENTRAL_NAS_HDD_EXPORT` to `NAS_IP`, and preflight/verify/mount NFS reachability checks probe `NAS_IP`.

Resolution receipt: the direct LAN failure was macOS Local Network privacy for the invoking app. After allowing local-network access from the GUI prompt, `nc -vz -G 3 <private-ip> 2049` and `showmount -e <private-ip>` succeeded. A Terminal runner then synced the fixed NAS scripts into `<shared-root>/src/joelclaw`, installed and bootstrapped `com.joelclaw.central.nas-mounts`, mounted both NFS tiers, and passed `verify-nas.sh --write-probe --benchmark-mib 64`.

Live proof on 2026-06-17:

```text
<nas-nvme-mount> -> <private-ip>:<nas-nvme-export>
<nas-hdd-mount> -> <private-ip>:<nas-hdd-export>
launchd label: system/com.joelclaw.central.nas-mounts
last exit code: 0
```

### Gate 5 NAS/object-storage target

MinIO should be an interface to `<nas>`, not a pile of object data hidden on central host's local SSD. Local MinIO storage under `<shared-root>/services/minio` is shadow-smoke-only.

Target tiering:

| Tier | Path | Backing storage | Use |
| --- | --- | --- | --- |
| Local SSD | `<shared-root>/services/*` | central host internal SSD | Redis, Inngest, Restate, active Typesense, caches/scratch |
| NAS NVMe | `<nas-nvme-mount>` | `<private-ip>:<nas-nvme-export>` | fast shared artifacts, snapshots, models, docs artifacts, sessions, transcripts, hot object data |
| NAS HDD | `<nas-hdd-mount>` | `<private-ip>:<nas-hdd-export>` | archives, books, bulk object data, cold retention |

Do not mix NAS NVMe and NAS HDD into one opaque MinIO erasure set. Preferred shape is either:

1. two explicit S3 surfaces: hot MinIO backed by NAS NVMe and cold MinIO backed by NAS HDD; or
2. one hot MinIO surface backed by NAS NVMe plus explicit lifecycle/copy jobs to NAS HDD.

Before cutover, prove the selected shape with:

- persistent no-login mounts for `<nas-nvme-mount>` and `<nas-hdd-mount>` over the NAS LAN IP, or an explicitly scoped fallback for non-MinIO backup/export paths;
- route/MTU proof showing central host uses 10GbE to `<nas>`, not Tailscale/Wi-Fi;
- read/write latency and throughput receipts against both NAS tiers;
- MinIO bucket/object smoke tests that prove writes land on NAS-backed storage.

Repo-managed NAS proof scripts now live under `infra/central/scripts/`:

- `install-nas-mounts.sh` — installs the root `com.joelclaw.central.nas-mounts` LaunchDaemon and prepares `<nas-nvme-mount>` + `<nas-hdd-mount>`.
- `mount-nas.sh` — mount/status/unmount action with route, NFS, 10GbE media, and MTU checks.
- `verify-nas.sh` — non-privileged proof script for route/media/MTU/mounts plus optional write/read benchmarks against `CENTRAL_MINIO_HOT_DATA` and `CENTRAL_MINIO_COLD_DATA`.
- `smoke/nas.sh` — smoke harness wrapper for NAS write probes when `CENTRAL_REQUIRE_NAS=1`.

The NAS mount lifecycle is: `boot/kickstart -> wait_for_route -> assert_10gbe_media -> mount_nas_nvme -> mount_nas_hdd -> verify_mounts -> ready | failed_retry_next_interval`.

### Phase C — coordinated authority cutover

This is the actual Gate 5.

Preconditions:

- Joel approves the go/no-go.
- Project Thread is approved or explicitly declined.
- retired host health is green enough to snapshot.
- central host Gate 4 reboot proof remains valid.
- central host shadow smoke tests pass.
- central host has a documented and reboot-proven `<nas>` NAS access path, including `<nas-nvme-mount>`, `<nas-hdd-mount>`, 10GbE route proof, and performance receipt.
- Active loops/runs/workloads are drained, cancelled, or explicitly accepted as disposable.
- Rollback commands are written before the freeze.

Cutover sequence:

1. Announce cutover start and freeze window.
2. Stop/disable retired host write-producing workers.
3. Stop loop/workload dispatch.
4. Snapshot retired host state.
5. Final-sync selected state to central host.
6. Start/verify central host stateful services.
7. Flip Central endpoint config to central host.
8. Start central host workers.
9. Send a known event through central host.
10. Verify Inngest run execution on central host.
11. Verify Restate workload no-op on central host.
12. Verify OTEL emit/query on central host.
13. Verify Run capture/search on central host.
14. Verify gateway notification path.
15. Keep retired host frozen as rollback-only until rollback window closes.

## Acceptance criteria

- [x] Each stateful service has a shadow smoke-test receipt. central host receipt: `<shared-root>/logs/central/smoke/phase-a-20260528T162118Z.log`.
- [ ] Each stateful service has a rehearsal/reset path or an explicit “start clean” decision.
- [ ] retired host write freeze procedure is documented and tested dry-run where safe.
- [ ] Active retired host workloads are drained/cancelled before final sync.
- [ ] central host owns Redis, Typesense, Inngest, Restate, MinIO wave-1 state after cutover.
- [ ] central host workers execute against central host state only.
- [ ] central host has reboot-proven NAS access to `<nas>` for rebuilds/artifacts/backups/object storage, with 10GbE route proof and latency/throughput receipts.
- [ ] MinIO wave-1 data is NAS-backed, not local central host SSD, or MinIO is explicitly omitted from wave 1.
- [ ] Clients and relay paths post to central host Central only.
- [ ] retired host Central stack is stopped/frozen and labelled rollback-only.
- [ ] At least one known event completes through central host Inngest.
- [ ] At least one no-op workload completes through central host Restate.
- [ ] OTEL emit/query works through central host.
- [ ] Run capture/search works through central host.
- [ ] Gateway can notify Joel through the central host path.
- [ ] Post-cutover hard-reboot/no-GUI proof still passes.
- [ ] ADR-0246 is updated from `accepted` to `shipped` only after verification.

## Out of scope for Gate 5

- Demoting Joel from admin.
- Migrating PDS unless explicitly added to wave 1.
- Replacing launchd + Colima/Compose with a different runtime.
- Rewriting `joelclaw deploy`.
- Creating active/active Central.
- Making retired host a hot Central fallback.
- Full Credential Proxy hardening.
- Perfect dashboards.
- Cleaning every historical retired host artifact.

## Open decisions

1. Which Typesense collections must be exported/imported vs rebuilt from NAS?
2. Is Inngest run history worth migrating, or do we drain and start clean?
3. Is Restate journal migration worth attempting, or do we require no active workloads?
4. Which MinIO buckets are actually wave 1?
5. Does gateway move in Gate 5 or remain on retired host as Relay while pointing at central host Central?
6. What is the rollback window cutoff after central host accepts writes?
7. Should we create a `#brain-joel` Project Thread for Gate 5 evidence?
8. Closed for Central: use root LaunchDaemon-mounted NFS for `<nas-nvme-mount>` and `<nas-hdd-mount>`. Autofs can be considered later for Joel's interactive/user mounts, not Central service mounts.
9. Should MinIO wave 1 use two explicit hot/cold S3 surfaces, or one hot S3 surface plus lifecycle/copy jobs to HDD?

## Phase A smoke harness

Repo-managed scripts live under `infra/central/scripts/smoke/`:

- `redis.sh` — isolated temp key write/read/delete.
- `typesense.sh` — temp collection create/index/search/delete.
- `inngest.sh` — health check plus isolated `central/smoke.test` event submit.
- `restate.sh` — ingress/admin/metrics reachability.
- `minio.sh` — temp bucket/object write/read/delete through the S3 API.
- `nas.sh` — route/mount/write-probe check; included automatically when `CENTRAL_REQUIRE_NAS=1`.
- `run.sh` — aggregate harness that writes a receipt under `${CENTRAL_LOG_DIR}/smoke/`.

Run from central host's service checkout as the `joelclaw` service user so `.env` stays private and readable only to the runtime identity:

```bash
ssh -t <ssh-user>@<central-host> 'cd <shared-root>/src/joelclaw && sudo -u joelclaw -H ./infra/central/scripts/smoke/run.sh'
```

This performs isolated shadow writes only. It does not freeze retired host, flip endpoints, or make central host authoritative.

## Recommended next work

NAS writes are now proved from central host after mapping the central host NFS client to ASUSTOR `admin (999)` and using tuned 8192-MTU proof mounts. The service checkout has been synced to the LAN-IP export contract and `NAS_EXPECTED_MTU=8192`, and its verifier passed with `expected_mtu=8192`. Continue with the remaining NAS hardening/proof steps; do not cut over Central yet.

1. Hard-reboot central host, then before any GUI login repeat the NAS proof over the 10GbE path:
   ```bash
   sudo ifconfig en0 mtu 8192
   cd /Users/Shared/joelclaw/src/joelclaw
   sudo env NAS_EXPECTED_INTERFACE=en0 NAS_EXPECTED_MTU=8192 \
     NAS_NFS_OPTIONS='rw,resvport,nfsvers=3,tcp,soft,intr,timeo=10,retrans=2,rsize=524288,wsize=524288,dsize=65536,readahead=128' \
     ./infra/central/scripts/mount-nas.sh mount
   sudo -u joelclaw -H env NAS_EXPECTED_INTERFACE=en0 NAS_EXPECTED_MTU=8192 \
     ./infra/central/scripts/verify-nas.sh --write-probe --benchmark-mib 64
   ```
2. Keep the 512K NFS transfer defaults unless a larger sweep beats them on both NAS tiers. The 2026-06-17 sweep picked 512K because 1M regressed HDD writes.
3. Fix or explicitly document MTU `8192` vs ADR-0088 target `9000`. Full `9000` still blackholes large packets to `<nas>` from central host; inspect the switch path before trying to make `9000` the persistent default.
4. Decide MinIO wave-1 shape: two hot/cold S3 surfaces, or one hot surface plus lifecycle/copy jobs to HDD.
5. Write the freeze/rollback command sheet before any final sync.
6. Decide the open questions above before scheduling Gate 5.
7. Turn the ad hoc retired host inventory probes into a repo-managed read-only inventory script if we need repeatability before the cutover window.

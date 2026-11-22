# Private runtime configuration

This checkout does not contain deployment addresses, account names, or NAS exports. For installation values, see `.brain/resources/operator-network-context.svx` in the private dark-wizard repo and the `tailnet-topology` skill. The names and values below are examples, not production targets.

Keep installation files outside the checkout, under `~/.config/joelclaw/` where supported. If a workflow needs a local copy, use the ignored `.private/` directory or the `*.private.*` filename patterns in `.gitignore`. Restrict files containing credentials to the service account. Never commit a rendered manifest or an env file with installation values.

## Central and satellites

- **Placement:** Copy `packages/endpoint-resolver/config/service-placement.json` to `~/.config/joelclaw/service-placement.json` for the runtime user and fill `hosts`. Each entry has `hostname` and `services`; valid roles are `joelclaw-headless-runtime` and `k8s`. An empty `hosts` list assigns neither role. The resolver and `infra/install-critical-launchdaemons.sh` accept `JOELCLAW_SERVICE_PLACEMENT_FILE` as an override. The installer requires an explicit private file: run it with `--plan` before installing. Confirm the hostname and selected labels; a host with neither role enters cleanup-only mode.
- **Central Compose:** Copy `infra/central/.env.example` to `infra/central/.env`. Set `CENTRAL_MACHINE_ID`, `CENTRAL_HOSTNAME`, `SERVICE_USER` and the paths appropriate to the service account. For NAS-backed runs set `NAS_HOST`, `NAS_IP`, `NAS_EXPECTED_INTERFACE`, `NAS_EXPECTED_MEDIA`, `NAS_EXPECTED_MTU`, and the `CENTRAL_NAS_{NVME,HDD,MEDIA}_{EXPORT,MOUNT}` pairs. `*_EXPORT` is the LAN address plus export path; `*_MOUNT` is the local mount point. Check mounted storage before setting `CENTRAL_REQUIRE_NAS=1`. Set `CENTRAL_EXECUTOR_HEALTH_URL` and `CENTRAL_EXECUTOR_DASHBOARD_URL` for the Central health sweep.
- **Local Convex:** Pass `LAN_BIND_IP`, `CONVEX_SERVICE_USER` and `CONVEX_SERVICE_HOME` to `infra/central/native/install-local-convex-lan-forwarder.sh`. `LAN_BIND_IP` must be an explicit IPv4 address, not a wildcard. Use `LOCAL_CONVEX_DIR` for postboot checks that need the local checkout.
- **Typesense books:** `infra/central/native/install-typesense-books.sh` requires `TYPESENSE_BOOKS_TAILNET_HEALTH_URL`, including the health path. Keep the local and remote proof checks distinct.
- **Tailnet registration:** Set the approved `TAILSCALE_HOSTNAME` before invoking `infra/central/scripts/install-system-tailscaled.sh`.
- **SSH tunnels:** In `~/.config/joelclaw/tunnels.env` (or `JOELCLAW_TUNNELS_ENV_FILE`), set `AGENT_MAIL_CENTRAL_HOST` and `SYSTEM_BUS_CENTRAL_HOST` to SSH targets or aliases. Override the existing `*_LOCAL_PORT` and `*_CENTRAL_PORT` variables if the local and remote loopback service ports differ from the defaults.

### Satellites

Set `JOELCLAW_CENTRAL_SSH`, `JOELCLAW_CENTRAL_URL`, `JOELCLAW_TYPESENSE_URL`, `JOELCLAW_DOCS_TYPESENSE_URL`, and `JOELCLAW_DOCS_API_URL` before `scripts/setup-satellite-rig.sh`. The corresponding `TYPESENSE_URL`, `DOCS_TYPESENSE_URL`, and `DOCS_API_URL` variables also work. For remote session search, `JOELCLAW_SESSION_MACHINE` and `JOELCLAW_SESSION_SSH_TARGET` supply defaults for `--machine` and `--ssh-target`. For NAS mounts, pass the Central NAS fields listed above; `scripts/install-satellite-nas-mounts.sh` writes them into the ignored Central env file on the satellite. See the [satellite runbook](runbooks/satellite-rig-setup.md).

## NAS applications

- `JOELCLAW_NAS_HOST`: SSH target. For the production mount layout set `JOELCLAW_NAS_HDD_ROOT`, `JOELCLAW_NAS_NVME_ROOT`, `JOELCLAW_NAS_REMOTE_ROOT`, `JOELCLAW_NAS_BACKUPS_HDD_ROOT`, `JOELCLAW_NAS_BACKUPS_REMOTE_ROOT`, `JOELCLAW_NAS_SERVICES_MOUNT` and `JOELCLAW_NAS_BACKUPS_MOUNT` in the appropriate CLI and service envs. The generic paths in public source do not configure a mount.
- `DOCS_ARTIFACTS_DIR` and `DOCS_ARTIFACTS_SSH_ROOT`: local and remote artifact paths for docs-api. Set them in the docs-api service env.
- `JOELCLAW_MEDIA_MOUNT`: absolute NFS media mount for the transcription worker. Set `TRANSCRIPT_RIG_ROOT` when its checkout is not at the default path.
- `HOT_PATH`, `COLD_PATH`, `NAS_SERVICE_UID`, `NAS_SERVICE_GID`, `NAS_SERVICE_GROUP` and `NAS_SERVICE_USER`: required by `infra/central/scripts/three-body-prepare-object-roots.sh`. Review the paths and ownership in private config before running this mutating script.
- `JOELCLAW_CRITICAL_DB_WRITER_HOST` names the single writer allowed to build the critical search database. `JOELCLAW_RETIRED_MEMORY_ARCHIVE_ROOT` supplies the optional retired archive fallback.
- `JOELCLAW_SESSION_AUDIT_SATELLITE_SSH` is required for the `satellite` role in `scripts/agent-session-audit-backup.ts`; `local` is the default role. Supply `--backup-root` or `JOELCLAW_SESSION_AUDIT_BACKUP_ROOT`. Use `--central-url` or `JOELCLAW_CENTRAL_URL` for remote Central capture checks. The archival log copy script takes `SYSTEM_LOG_ARCHIVE_SOURCE` as an explicit SCP source.
- `MANIFEST_ARCHIVE_PRIMARY_SSH` and `MANIFEST_ARCHIVE_FALLBACK_SSH`: primary and fallback file sources for the historical manifest archiver. Do not re-enable historical jobs based on their presence in this repository.

## Legacy Kubernetes and PDS

- Export `K8S_NAS_HOST` and the relevant `K8S_NAS_HDD_EXPORT`, `K8S_NAS_NVME_EXPORT` or `K8S_NAS_MINIO_EXPORT`. Render with `bash k8s/render-nas-pv.sh nas-hdd` (or `nas-nvme`, `minio`). It writes YAML to stdout only. Review the rendered content and use that instead of applying a raw template; never bulk-apply `k8s/`.
- `~/.config/joelclaw/k8s.env` (or `JOELCLAW_K8S_ENV_FILE`) holds `NAS_CIDR`, `NAS_GATEWAY`, `NAS_INTERFACE`, `NAS_HOST`, optional `NAS_NFS_PORT`, and `KUBE_OPERATOR_TARGET_NODE`. The kube operator cleanup path accepts the node and `KUBE_OPERATOR_TARGET_KUBE_PORT` / `KUBE_OPERATOR_TARGET_TALOS_PORT` in the installer process env. `K8S_OPERATOR_HOST` overrides the role mapping for the legacy remote Redis backup. `JOELCLAW_COLIMA_VM_IP` (or `COLIMA_VM_IP`) overrides VM endpoint discovery; if discovery fails and no override is given, the resolver tries the other endpoint classes. A legacy cluster worker needs a ConfigMap named `system-bus-placement` with `OTEL_FORWARD_URL`; create it from private configuration before applying the worker manifest.
- Provide a private Helm values overlay for `infra/pds/values.yaml`; replace `pds.config.hostname` with the operator-approved PDS hostname. Configure the CLI and health check with `PDS_JOEL_HANDLE` or the CLI with `PDS_JOEL_DID` where supported.

## ClickHouse, web ingress and postboot probes

- Set `CLICKHOUSE_TUNNEL_SOURCE_IP` in the **ClickHouse process environment** to the exact address the server sees for the trusted tunnel. Keep the loopback entries and grant boundaries intact; never substitute a broad subnet. Supply the existing password hash variables separately. Copy the SSH plist template to an ignored `*.private.plist` and replace the example target, SSH account, destination and log paths. See the [access-control runbook](runbooks/clickhouse-access-control.md) for staging order and readback.
- Set `INNGEST_EVENT_URL` to the approved ingress for the review API, separately from the existing `JOELCLAW_WEBHOOK_SECRET`. For the historical network seed script, `JOELCLAW_NETWORK_NODES_FILE` selects a private JSON array of nodes. Do not seed private fields into a public deployment.
- For `postboot.sh`, set `NAS_IP`, `CUSTOM_MINIO_URL`, `CUSTOM_MINIO_CONSOLE_URL`, `CE_MINIO_URL`, `TAILNET_CONVEX_URL` and `POSTBOOT_RUN_CAPTURE_HEALTH_URL`. The capture URL must be HTTPS. To check the Central authority on its runtime host, set `POSTBOOT_CENTRAL_HOSTNAME` and, when using non-loopback targets, `POSTBOOT_CENTRAL_URL` and `POSTBOOT_TYPESENSE_URL`.

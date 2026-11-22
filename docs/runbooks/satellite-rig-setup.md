# Satellite rig setup

A thin satellite runs Pi, captures local sessions, and asks Central for repair. It does not run its own gateway, Inngest, Redis, or Kubernetes by default.

For host identities, private service URLs, ports, and accounts, see `.brain/resources/operator-network-context.svx` in the private dark-wizard repo and the `tailnet-topology` skill. The [private configuration reference](../private-runtime-config.md) lists the settings this checkout consumes.

## Bootstrap the satellite

1. On the satellite, verify Remote Login or Tailscale SSH using the configured satellite SSH target. `ssh -o BatchMode=yes -o ConnectTimeout=8 "$SATELLITE_SSH" 'hostname && whoami'` should return the expected machine and account. Enable access through the operator runbook if it is refused.
2. In a clean checkout on the satellite, load the private environment listed in the [configuration reference](../private-runtime-config.md#satellites). Set `JOELCLAW_REPO_DIR` to a separate runtime checkout if the existing checkout has local changes. Use approved secret delivery for `TYPESENSE_API_KEY` and `PDF_BRAIN_API_TOKEN`; do not copy them into the repository or pass them in argv.
3. Run `bash scripts/setup-satellite-rig.sh --help`, then `bash scripts/setup-satellite-rig.sh`. It installs missing tools, builds the CLI, writes `~/.config/system-bus.env`, and links the runtime skills into the namespaced Pi and agent skill directories. It does not copy Pi auth or alter NAS mounts.
4. Sign into Pi normally. For run capture, follow `scripts/joelclaw-machine-register.ts --help` and the private registration runbook. The resulting auth file must be mode `0600`.

## Optional: durable NAS mounts

Use the verified LAN address and NFS exports, not the NAS's SSH or MagicDNS alias. Verify the route interface and link media. Keep the docs API fallback until mount verification succeeds. Do not force jumbo frames if the end-to-end MTU proof fails.

In a shell on the satellite with the mount settings loaded:

```bash
sudo env NAS_IP="$NAS_IP" \
  NAS_EXPECTED_INTERFACE="$NAS_EXPECTED_INTERFACE" \
  CENTRAL_NAS_NVME_EXPORT="$CENTRAL_NAS_NVME_EXPORT" \
  CENTRAL_NAS_HDD_EXPORT="$CENTRAL_NAS_HDD_EXPORT" \
  CENTRAL_NAS_MEDIA_EXPORT="$CENTRAL_NAS_MEDIA_EXPORT" \
  ./scripts/install-satellite-nas-mounts.sh --bootstrap
```

If you use non-default mount points or link settings, pass those overrides the same way. The installer writes the private mount env and a root LaunchDaemon. Run `verify-nas.sh` from the installed service checkout so it reads that env. Use `--write-probe` only on an approved test path.

## Verify

```bash
pi --version
joelclaw satellite health
joelclaw sessions search "<query>" --source local --machine "$(hostname -s)" --limit 1
joelclaw sessions search "<query>" --source typesense --machine "$(hostname -s)" --limit 1
```

If no local sessions exist, start and exit one Pi session and rerun health. Check the configured Central run-capture health URL with an authenticated probe using the private registration runbook. For remote session search, pass `--machine` and `--ssh-target` explicitly. For a repair notification, pass `--central-ssh "$JOELCLAW_CENTRAL_SSH"`.

---
name: sync-system-bus
displayName: Sync System Bus
description: "Deploy the system-bus-worker to the joelclaw Kubernetes cluster from local machine. Use when syncing changes in packages/system-bus to k8s, especially because the GitHub Actions deploy job targets a non-existent self-hosted runner and cannot complete deploys automatically."
version: 1.1.0
author: Joel Hooks
tags: [joelclaw, system-bus, kubernetes, deploy, ghcr, inngest]
---

# Sync System Bus Worker

Deploy `system-bus-worker` to the local joelclaw k8s cluster.

**Important:** `.github/workflows/system-bus-worker-deploy.yml` has a deploy job on `self-hosted`. That runner does not exist, so deploys must be completed locally.

## What It Does

- Builds `system-bus-worker` for ARM64 (required by Talos/Colima node architecture)
- Pushes image tags to GHCR (`:${FULL_SHA}` and `:latest`)
- Updates `system-bus-worker` deployment image in namespace `joelclaw`
- Waits for rollout to complete
- Refreshes joelclaw function registration and verifies expected functions are present
- Logs the operation in `slog`

## Full Sequence (Operator Steps)

1) Make changes in `packages/system-bus/`.

2) Commit to `main`.

```bash
cd ~/Code/joelhooks/joelclaw
git checkout main
git add packages/system-bus
git commit -m "<describe system-bus change>"
git push origin main
```

3) Build ARM64 image locally (k8s node is ARM64).

```bash
cd ~/Code/joelhooks/joelclaw
FULL_SHA=$(git rev-parse HEAD)
IMAGE="ghcr.io/joelhooks/system-bus-worker:${FULL_SHA}"
docker build --platform linux/arm64 -t "$IMAGE" -t ghcr.io/joelhooks/system-bus-worker:latest -f packages/system-bus/Dockerfile .
```

4) Authenticate to GHCR using `agent-secrets` (`ghcr_pat`).

```bash
# Backup docker config (if present)
cp ~/.docker/config.json ~/.docker/config.json.bak 2>/dev/null || true

# If docker credential helper is set to desktop, remove it temporarily
# (macOS Docker credential helper often fails in automation shells)
if [ -f ~/.docker/config.json ]; then
  sed -i '' '/"credsStore"[[:space:]]*:[[:space:]]*"desktop"/d' ~/.docker/config.json
fi

# Login to GHCR with leased PAT from agent-secrets
secrets lease ghcr_pat | docker login ghcr.io -u joelhooks --password-stdin
```

5) Push both tags.

```bash
docker push "$IMAGE"
docker push ghcr.io/joelhooks/system-bus-worker:latest
```

6) Update k8s image and wait for rollout.

```bash
kubectl -n joelclaw set image deployment/system-bus-worker system-bus-worker="$IMAGE"
kubectl -n joelclaw rollout status deployment/system-bus-worker --timeout=240s
```

7) Refresh joelclaw registration and verify function availability.

```bash
joelclaw refresh
joelclaw functions | rg -i "<new-function-name|system-bus>"
```

8) Log the deploy.

```bash
slog write --action deploy --tool system-bus-worker --detail "deployed ${IMAGE} to joelclaw/system-bus-worker" --reason "sync worker changes"
```

After step 8, clean Docker credentials (do not leave PAT auth in Docker config).

```bash
docker logout ghcr.io || true

# Restore prior docker config if backed up
if [ -f ~/.docker/config.json.bak ]; then
  mv ~/.docker/config.json.bak ~/.docker/config.json
fi
```

## Common Gotchas

- GHA build defaults to `amd64`, but cluster node is `arm64`.
  Always build locally with `--platform linux/arm64`.

- `docker-credential-desktop` errors from Docker config.
  Remove `"credsStore": "desktop"` from `~/.docker/config.json` before non-interactive `docker login`.

- Function missing from `joelclaw functions` after deploy.
  Adding exports only in `index.ts` is not enough. Verify the function is explicitly included in both:
  - `packages/system-bus/src/inngest/functions/index.host.ts`
  - `packages/system-bus/src/inngest/functions/index.cluster.ts`

- New function still not visible.
  Run `joelclaw refresh` after rollout, then grep function list for the exact function id/name.

- Credential hygiene.
  Always clean Docker auth after push; do not leave GHCR PAT credentials in `~/.docker/config.json`.

- Runs stuck after first step with `Finalization -> "Unable to reach SDK URL"`.
  This is not always a pure network problem. Confirm SDK URL reachability, then inspect function code for blocking calls before step completion (filesystem access, Redis calls, shell subprocesses).

- Stale app registrations can mislead dispatch debugging.
  If Inngest shows multiple apps for the same worker (for example old `host.k3d.internal` plus current `host.docker.internal`), delete stale registrations to remove routing ambiguity.

- launchd worker path assumptions.
  Files under `~/Documents` can behave differently under daemonized worker context. For large manifest-style jobs, pass an explicit path in event payload or env and prefer `/tmp/...` when practical.

- Dry-run must avoid side-effect dependencies.
  If dry-run still hits Redis or network APIs per item, it can stall and look like dispatch failure. Keep dry-run dependency-light and set strict Redis timeouts (`connectTimeout`, `commandTimeout`, low retries).

## Key Paths

- Workflow: `.github/workflows/system-bus-worker-deploy.yml`
- Dockerfile: `packages/system-bus/Dockerfile`
- Host functions: `packages/system-bus/src/inngest/functions/index.host.ts`
- Cluster functions: `packages/system-bus/src/inngest/functions/index.cluster.ts`
- K8s deployment: `system-bus-worker` (namespace `joelclaw`)

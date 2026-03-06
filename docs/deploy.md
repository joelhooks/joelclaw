# Deploy

Canonical deployment notes for joelclaw runtime services.

## Kubernetes manifests

```bash
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/
```

## Dkron phase-1 scheduler (ADR-0216)

Dkron now runs in-cluster as a single-node `StatefulSet` with a `ClusterIP` API service:

- manifest: `k8s/dkron.yaml`
- peer service: `dkron-peer` (headless)
- API service: `dkron-svc` (`ClusterIP`, port `8080`)
- storage: PVC `data-dkron-0`

### Why ClusterIP first

We are **not** adding a permanent host port mapping yet. The current phase uses short-lived CLI-managed tunnels for operator access so we don't add another long-lived port-forward footgun to the stack.

### Service-name gotcha

Do **not** name the API service `dkron`.

Kubernetes injects service env vars into pods. A bare `dkron` service would inject `DKRON_*` env vars, which collides with Dkron's own config/env parsing. Use `dkron-peer` / `dkron-svc` instead.

### Deploy / verify

```bash
kubectl apply -f k8s/dkron.yaml
kubectl rollout status statefulset/dkron -n joelclaw
kubectl get pods -n joelclaw -l app=dkron
joelclaw restate cron status
```

### Seed the first proof job

```bash
joelclaw restate cron enable-health --run-now
joelclaw restate cron list
joelclaw otel search "dag.workflow" --hours 1
```

This seeds `restate-health-check` in Dkron, which uses the shell executor plus `wget` to call the existing Restate `health` DAG. The wrapper appends epoch seconds to the workflow ID prefix so each scheduled run is a fresh Restate workflow.

### Current trade-off

Dkron's upstream image still runs as root against the local-path PVC. A non-root hardening attempt failed with:

- `file snapshot store: permissions test failed`
- `open /data/raft/snapshots/permTest: permission denied`

So phase-1 keeps the pod running as-is for reliability. Harden later with either an init-permissions step, image override, or a custom image.

---
name: pds
displayName: PDS
description: >-
  Operate the AT Protocol Personal Data Server in the joelclaw k8s cluster.
  Use when checking PDS health, reading or writing dev.joelclaw.* records,
  restoring the service after a rebuild, or debugging session auth / repo DID
  drift.
version: 1.0.0
author: Joel Hooks
tags: [joelclaw, pds, atproto, k8s, operations]
---

# PDS — AT Protocol Personal Data Server

## Current truth

- Helm release: `bluesky-pds`
- Namespace: `joelclaw`
- Values: `infra/pds/values.yaml`
- Health URL: `http://localhost:9627/xrpc/_health`
- Host port: `9627`
- Service `nodePort`: `3000`
- Handle: `joel.pds.panda.tail7af24.ts.net`
- Current DID: `did:plc:5w6ablyvahugobsj7n57yjmm`

## CLI surface

```bash
joelclaw pds
joelclaw pds health
joelclaw pds describe
joelclaw pds collections
joelclaw pds records dev.joelclaw.system.log --limit 5
joelclaw pds write dev.joelclaw.system.log --data '{"action":"verify","tool":"pds","detail":"manual check"}'
joelclaw pds delete dev.joelclaw.system.log <rkey>
joelclaw pds session --refresh
```

Semantics:

- sessions cache at `~/.joelclaw/pds-session.json`
- the CLI and host system-bus client resolve the repo handle from `pds_joel_did` before `createSession`
- raw DID login was not reliable after the rebuild; handle login was
- `write` auto-adds `$type` and `createdAt`

## Restore after rebuild

A rebuilt cluster can bring back an **empty** PDS even when the pod is healthy.
Restoring the service is a two-step recovery:

### 1) Recreate secrets + Helm release

```bash
JWT_SECRET=$(secrets lease pds_jwt_secret --ttl 10m)
ADMIN_PASSWORD=$(secrets lease pds_admin_password --ttl 10m)
PLC_ROTATION_KEY=$(secrets lease pds_plc_rotation_key --ttl 10m)

kubectl create secret generic bluesky-pds-secrets \
  -n joelclaw \
  --from-literal=jwtSecret="$JWT_SECRET" \
  --from-literal=adminPassword="$ADMIN_PASSWORD" \
  --from-literal=plcRotationKey="$PLC_ROTATION_KEY" \
  --from-literal=emailSmtpUrl='' \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install bluesky-pds nerkho/bluesky-pds \
  -n joelclaw \
  -f ~/Code/joelhooks/joelclaw/infra/pds/values.yaml

kubectl patch svc bluesky-pds -n joelclaw --type='json' \
  -p='[{"op":"replace","path":"/spec/ports/0/nodePort","value":3000}]'

kubectl rollout status deployment/bluesky-pds -n joelclaw
curl -fsS http://localhost:9627/xrpc/_health
```

### 2) Recreate Joel's account if the PVC was wiped

```bash
ADMIN_PASSWORD=$(secrets lease pds_admin_password --ttl 10m)
JOEL_PASSWORD=$(secrets lease pds_joel_password --ttl 10m)

INVITE_CODE=$(curl -fsS -u "admin:${ADMIN_PASSWORD}" \
  -H 'content-type: application/json' \
  -d '{"useCount":1}' \
  http://localhost:9627/xrpc/com.atproto.server.createInviteCode | jq -r '.code')

curl -fsS -X POST http://localhost:9627/xrpc/com.atproto.server.createAccount \
  -H 'content-type: application/json' \
  -d "$(jq -nc \
    --arg email 'joelhooks@gmail.com' \
    --arg handle 'joel.pds.panda.tail7af24.ts.net' \
    --arg password "$JOEL_PASSWORD" \
    --arg inviteCode "$INVITE_CODE" \
    '{email:$email,handle:$handle,password:$password,inviteCode:$inviteCode}')"
```

**Then update `pds_joel_did`** to the new DID returned by `createAccount`.
If you skip that, the host dual-write path will authenticate against a dead repo.

## Fast checks

```bash
curl -fsS http://localhost:9627/xrpc/_health
joelclaw pds describe
joelclaw pds collections
kubectl get deploy,svc,pods,pvc -n joelclaw | rg 'bluesky-pds|NAME'
kubectl logs -n joelclaw -l app.kubernetes.io/name=bluesky-pds --tail=50
```

## Gotchas

1. `nodePort` must stay `3000`. Host exposure is `9627`, but the service still targets container-side port `3000`.
2. Rebuilds can wipe the PVC and silently invalidate the old DID.
3. `createSession` worked against the handle on the rebuilt PDS but rejected raw DID login.
4. `describeRepo` is the truth source for recovering the current handle from a stored DID.

## Key files

- `infra/pds/values.yaml`
- `packages/cli/src/commands/pds.ts`
- `packages/system-bus/src/lib/pds.ts`
- `docs/deploy.md`
- `Vault/docs/decisions/0044-pds-private-first-with-bento-bridge.md`

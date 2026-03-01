#!/bin/bash
set -euo pipefail

# Ensure homebrew + local bins in PATH (launchd has minimal PATH)
export PATH="/opt/homebrew/bin:/Users/joel/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

LOG_DIR="$HOME/.local/log"
LOG_FILE="$LOG_DIR/k8s-reboot-heal.log"
mkdir -p "$LOG_DIR"

log() {
  echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE"
}

COLIMA_DOCKER_HOST="unix:///Users/joel/.colima/default/docker.sock"
COLIMA_SSH_CONFIG="$HOME/.colima/_lima/colima/ssh.config"
COLIMA_SSH_HOST="lima-colima"
KUBELET_PROXY_RBAC_MANIFEST="$HOME/Code/joelhooks/joelclaw/k8s/apiserver-kubelet-client-rbac.yaml"

# ADR-0182 invariant target users for kubelet proxy authz.
KUBELET_PROXY_USERS=(
  "apiserver-kubelet-client"
  "kube-apiserver-kubelet-client"
)

docker_socket_healthy() {
  DOCKER_HOST="$COLIMA_DOCKER_HOST" docker ps --format '{{.Names}}' >/dev/null 2>&1
}

force_cycle_colima() {
  log "force-cycling colima runtime"
  colima stop --force >>"$LOG_FILE" 2>&1 || log "WARNING: colima stop --force failed"
  sleep 1
  colima start >>"$LOG_FILE" 2>&1 || log "WARNING: colima start failed"
}

kubelet_proxy_rbac_check_user() {
  local user="$1"

  kubectl auth can-i -q --as="$user" get nodes --subresource=proxy --all-namespaces 2>/dev/null \
    && kubectl auth can-i -q --as="$user" create nodes --subresource=proxy --all-namespaces 2>/dev/null
}

kubelet_proxy_rbac_healthy() {
  local user

  for user in "${KUBELET_PROXY_USERS[@]}"; do
    if ! kubelet_proxy_rbac_check_user "$user"; then
      return 1
    fi
  done

  return 0
}

ensure_kubelet_proxy_rbac() {
  if kubelet_proxy_rbac_healthy; then
    log "kubelet proxy RBAC guard: healthy"
    return 0
  fi

  log "kubelet proxy RBAC drift detected; applying $KUBELET_PROXY_RBAC_MANIFEST"

  if ! kubectl apply -f "$KUBELET_PROXY_RBAC_MANIFEST" >>"$LOG_FILE" 2>&1; then
    log "ERROR: failed to apply kubelet proxy RBAC manifest"
    return 1
  fi

  if kubelet_proxy_rbac_healthy; then
    log "kubelet proxy RBAC guard restored"
    return 0
  fi

  log "ERROR: kubelet proxy RBAC guard still failing after apply"
  return 1
}

check_http_health() {
  local name="$1"
  local url="$2"
  local attempts="${3:-6}"
  local delay_secs="${4:-2}"

  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
      log "invariant: $name health ok"
      return 0
    fi

    if [ "$attempt" -lt "$attempts" ]; then
      sleep "$delay_secs"
    fi
  done

  log "ERROR: invariant failed: $name health check failed ($url)"
  return 1
}

post_colima_invariant_gate() {
  local failures=0

  if docker_socket_healthy; then
    log "invariant: docker socket healthy"
  else
    log "ERROR: invariant failed: docker socket unhealthy at $COLIMA_DOCKER_HOST"
    failures=$((failures + 1))
  fi

  if kubectl get nodes >/dev/null 2>&1; then
    log "invariant: kubernetes api reachable"
  else
    log "ERROR: invariant failed: kubernetes api unreachable"
    failures=$((failures + 1))
  fi

  if kubelet_proxy_rbac_healthy; then
    log "invariant: kubelet proxy RBAC healthy"
  else
    log "ERROR: invariant failed: kubelet proxy RBAC unhealthy"
    failures=$((failures + 1))
  fi

  if kubectl logs -n joelclaw redis-0 --tail=1 >/dev/null 2>&1; then
    log "invariant: kubectl logs path healthy"
  else
    log "ERROR: invariant failed: kubectl logs path unhealthy"
    failures=$((failures + 1))
  fi

  if kubectl exec -n joelclaw redis-0 -- redis-cli ping >/dev/null 2>&1; then
    log "invariant: kubectl exec path healthy"
  else
    log "ERROR: invariant failed: kubectl exec path unhealthy"
    failures=$((failures + 1))
  fi

  if ! check_http_health "inngest" "http://localhost:8288/health"; then
    failures=$((failures + 1))
  fi

  if ! check_http_health "typesense" "http://localhost:8108/health"; then
    failures=$((failures + 1))
  fi

  if [ "$failures" -gt 0 ]; then
    log "ERROR: post-Colima invariant gate failed ($failures checks)"
    return 1
  fi

  log "post-Colima invariant gate passed"
}

log "k8s reboot heal tick"

COLIMA_STATUS_OUTPUT="$(colima status 2>&1 || true)"
if [[ "$COLIMA_STATUS_OUTPUT" != *"colima is running"* ]]; then
  STATUS_ONE_LINE="$(echo "$COLIMA_STATUS_OUTPUT" | tr '\n' ' ' | tr -s ' ')"
  log "colima status unhealthy: $STATUS_ONE_LINE"
  force_cycle_colima
elif ! docker_socket_healthy; then
  log "docker socket unreachable at $COLIMA_DOCKER_HOST"
  force_cycle_colima
fi

if ! colima status >/dev/null 2>&1; then
  log "WARNING: colima still unhealthy after recovery attempt"
fi

# Ensure Talos control-plane container is up and persistent.
if ssh -F "$COLIMA_SSH_CONFIG" "$COLIMA_SSH_HOST" "docker inspect joelclaw-controlplane-1 >/dev/null 2>&1"; then
  TALOS_RUNNING=$(ssh -F "$COLIMA_SSH_CONFIG" "$COLIMA_SSH_HOST" "docker inspect --format '{{.State.Running}}' joelclaw-controlplane-1" 2>/dev/null || echo false)
  if [ "$TALOS_RUNNING" != "true" ]; then
    log "Talos container stopped; starting"
    ssh -F "$COLIMA_SSH_CONFIG" "$COLIMA_SSH_HOST" "docker start joelclaw-controlplane-1" >>"$LOG_FILE" 2>&1 || log "WARNING: failed to start Talos container"
  fi
  ssh -F "$COLIMA_SSH_CONFIG" "$COLIMA_SSH_HOST" "docker update --restart unless-stopped joelclaw-controlplane-1" >>"$LOG_FILE" 2>&1 || true
  ssh -F "$COLIMA_SSH_CONFIG" "$COLIMA_SSH_HOST" "sudo modprobe br_netfilter" >>"$LOG_FILE" 2>&1 || true
fi

# Wait briefly for kube api.
for _ in {1..12}; do
  if kubectl get nodes >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

if kubectl get nodes >/dev/null 2>&1; then
  kubectl taint nodes joelclaw-controlplane-1 node-role.kubernetes.io/control-plane:NoSchedule- >>"$LOG_FILE" 2>&1 || true
  kubectl uncordon joelclaw-controlplane-1 >>"$LOG_FILE" 2>&1 || true

  FLANNEL_PODS=$(kubectl get pods -n kube-system --no-headers 2>/dev/null | awk '/kube-flannel/ {print $1":"$3}')
  if echo "$FLANNEL_PODS" | grep -Eq 'Error|CrashLoopBackOff|Unknown'; then
    log "flannel unhealthy; restarting kube-flannel pods"
    kubectl get pods -n kube-system --no-headers | awk '/kube-flannel/ {print $1}' | \
      xargs -r kubectl delete pod -n kube-system >>"$LOG_FILE" 2>&1 || true
  fi

  ensure_kubelet_proxy_rbac
else
  log "WARNING: kubernetes api still unavailable after wait"
fi

post_colima_invariant_gate

log "k8s reboot heal tick complete"

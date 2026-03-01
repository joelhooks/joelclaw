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

docker_socket_healthy() {
  DOCKER_HOST="$COLIMA_DOCKER_HOST" docker ps --format '{{.Names}}' >/dev/null 2>&1
}

force_cycle_colima() {
  log "force-cycling colima runtime"
  colima stop --force >>"$LOG_FILE" 2>&1 || log "WARNING: colima stop --force failed"
  sleep 1
  colima start >>"$LOG_FILE" 2>&1 || log "WARNING: colima start failed"
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
else
  log "WARNING: kubernetes api still unavailable after wait"
fi

log "k8s reboot heal tick complete"

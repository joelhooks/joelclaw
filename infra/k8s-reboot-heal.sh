#!/bin/bash
set -euo pipefail

LOG_DIR="$HOME/.local/log"
LOG_FILE="$LOG_DIR/k8s-reboot-heal.log"
mkdir -p "$LOG_DIR"

log() {
  echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE"
}

log "k8s reboot heal tick"

if ! colima status >/dev/null 2>&1; then
  log "colima not running; starting"
  colima start >>"$LOG_FILE" 2>&1 || log "WARNING: colima start failed"
fi

# Ensure Talos control-plane container is up and persistent.
if ssh -F "$HOME/.colima/_lima/colima/ssh.config" lima-colima "docker inspect joelclaw-controlplane-1 >/dev/null 2>&1"; then
  TALOS_RUNNING=$(ssh -F "$HOME/.colima/_lima/colima/ssh.config" lima-colima "docker inspect --format '{{.State.Running}}' joelclaw-controlplane-1" 2>/dev/null || echo false)
  if [ "$TALOS_RUNNING" != "true" ]; then
    log "Talos container stopped; starting"
    ssh -F "$HOME/.colima/_lima/colima/ssh.config" lima-colima "docker start joelclaw-controlplane-1" >>"$LOG_FILE" 2>&1 || log "WARNING: failed to start Talos container"
  fi
  ssh -F "$HOME/.colima/_lima/colima/ssh.config" lima-colima "docker update --restart unless-stopped joelclaw-controlplane-1" >>"$LOG_FILE" 2>&1 || true
  ssh -F "$HOME/.colima/_lima/colima/ssh.config" lima-colima "sudo modprobe br_netfilter" >>"$LOG_FILE" 2>&1 || true
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

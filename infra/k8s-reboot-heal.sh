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
CORE_WARMUP_TIMEOUT_SECS=300
WARMUP_GRACE_SECS="${WARMUP_GRACE_SECS:-120}"
COLIMA_START_EPOCH=""

# ADR-0182 invariant target users for kubelet proxy authz.
KUBELET_PROXY_USERS=(
  "apiserver-kubelet-client"
  "kube-apiserver-kubelet-client"
)

CRITICAL_DEPLOYMENTS=(
  "bluesky-pds"
  "docs-api"
  "livekit-server"
  "system-bus-worker"
)

docker_socket_healthy() {
  DOCKER_HOST="$COLIMA_DOCKER_HOST" docker ps --format '{{.Names}}' >/dev/null 2>&1
}

force_cycle_colima() {
  log "force-cycling colima runtime"
  colima stop --force >>"$LOG_FILE" 2>&1 || log "WARNING: colima stop --force failed"
  sleep 1
  if colima start >>"$LOG_FILE" 2>&1; then
    COLIMA_START_EPOCH="$(date +%s)"
  else
    log "WARNING: colima start failed"
  fi
}

ensure_vm_br_netfilter() {
  local bridge_state

  bridge_state="$(ssh -F "$COLIMA_SSH_CONFIG" "$COLIMA_SSH_HOST" '
    if [ ! -e /proc/sys/net/bridge/bridge-nf-call-iptables ]; then
      sudo modprobe br_netfilter >/dev/null 2>&1 || true
    fi

    if [ -e /proc/sys/net/bridge/bridge-nf-call-iptables ]; then
      sudo sysctl -w net.bridge.bridge-nf-call-iptables=1 >/dev/null 2>&1 || true
      sudo sysctl -w net.bridge.bridge-nf-call-ip6tables=1 >/dev/null 2>&1 || true
      echo present
    else
      echo missing
    fi
  ' 2>>"$LOG_FILE" || true)"

  if [ "$bridge_state" = "present" ]; then
    log "invariant: br_netfilter present in Colima VM"
    return 0
  fi

  log "WARNING: br_netfilter missing in Colima VM"
  return 1
}

restart_flannel_if_unhealthy() {
  local flannel_pods

  flannel_pods="$(kubectl get pods -n kube-system --no-headers 2>/dev/null | awk '/kube-flannel/ {print $1":"$3}')"
  if echo "$flannel_pods" | grep -Eq 'Error|CrashLoopBackOff|Unknown'; then
    log "flannel unhealthy; restarting kube-flannel pods"
    kubectl get pods -n kube-system --no-headers | awk '/kube-flannel/ {print $1}' | \
      xargs -r kubectl delete pod -n kube-system >>"$LOG_FILE" 2>&1 || true
  fi
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

daemonset_ready() {
  local namespace="$1"
  local daemonset_name="$2"
  local status

  status="$(kubectl -n "$namespace" get daemonset "$daemonset_name" -o jsonpath='{.status.numberAvailable}/{.status.desiredNumberScheduled}' 2>/dev/null || true)"

  if [[ ! "$status" =~ ^[0-9]+/[0-9]+$ ]]; then
    return 1
  fi

  local available="${status%%/*}"
  local desired="${status##*/}"

  [[ "$desired" -gt 0 && "$available" -eq "$desired" ]]
}

pod_ready() {
  local namespace="$1"
  local pod_name="$2"
  local ready

  ready="$(kubectl get pod -n "$namespace" "$pod_name" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
  [[ "$ready" == "True" ]]
}

deployment_ready() {
  local namespace="$1"
  local deployment_name="$2"
  local desired
  local available

  desired="$(kubectl -n "$namespace" get deployment "$deployment_name" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
  available="$(kubectl -n "$namespace" get deployment "$deployment_name" -o jsonpath='{.status.availableReplicas}' 2>/dev/null || true)"

  desired="${desired:-0}"
  available="${available:-0}"

  [[ "$desired" =~ ^[0-9]+$ && "$available" =~ ^[0-9]+$ && "$desired" -gt 0 && "$available" -ge "$desired" ]]
}

colima_uptime_secs() {
  local uptime_secs

  uptime_secs="$(ssh -F "$COLIMA_SSH_CONFIG" -o ConnectTimeout=2 "$COLIMA_SSH_HOST" "awk '{print int(\$1)}' /proc/uptime" 2>/dev/null || true)"
  if [[ "$uptime_secs" =~ ^[0-9]+$ ]]; then
    echo "$uptime_secs"
    return 0
  fi

  return 1
}

warmup_grace_remaining_secs() {
  local uptime_secs
  local now
  local elapsed

  uptime_secs="$(colima_uptime_secs || true)"
  if [[ "$uptime_secs" =~ ^[0-9]+$ ]]; then
    if [ "$uptime_secs" -lt "$WARMUP_GRACE_SECS" ]; then
      echo $((WARMUP_GRACE_SECS - uptime_secs))
    else
      echo 0
    fi
    return 0
  fi

  if [ -n "${COLIMA_START_EPOCH:-}" ]; then
    now="$(date +%s)"
    elapsed=$((now - COLIMA_START_EPOCH))
    if [ "$elapsed" -lt "$WARMUP_GRACE_SECS" ]; then
      echo $((WARMUP_GRACE_SECS - elapsed))
      return 0
    fi
  fi

  echo 0
}

critical_deployment_regex() {
  local deployment_regex

  deployment_regex="$(printf '%s|' "${CRITICAL_DEPLOYMENTS[@]}")"
  echo "^(${deployment_regex%|})-"
}

list_image_pull_backoff_pods() {
  local deployment_regex

  deployment_regex="$(critical_deployment_regex)"
  kubectl get pods -n joelclaw --no-headers 2>/dev/null | awk -v deployment_regex="$deployment_regex" '
    ($1 ~ deployment_regex) &&
    ($3 ~ /^(ImagePullBackOff|ErrImagePull|Init:ImagePullBackOff)$/) {
      print $1":"$3
    }
  ' || true
}

list_non_image_pull_crash_pods() {
  local deployment_regex

  deployment_regex="$(critical_deployment_regex)"
  kubectl get pods -n joelclaw --no-headers 2>/dev/null | awk -v deployment_regex="$deployment_regex" '
    ($1 ~ deployment_regex) &&
    ($3 !~ /^(ImagePullBackOff|ErrImagePull|Init:ImagePullBackOff)$/) &&
    ($3 ~ /^(CrashLoopBackOff|Error|RunContainerError|CreateContainerConfigError|CreateContainerError|Init:CrashLoopBackOff|Init:Error|ContainerStatusUnknown|InvalidImageName)$/) {
      print $1":"$3
    }
  ' || true
}

restart_image_pull_backoff_workloads() {
  local pods

  pods="$(list_image_pull_backoff_pods)"

  if [ -z "$pods" ]; then
    return 1
  fi

  log "workload recovery: restarting pods stuck in image pull backoff (${pods//$'\n'/, })"
  printf '%s\n' "$pods" | awk -F: '{print $1}' | xargs -r kubectl delete pod -n joelclaw >>"$LOG_FILE" 2>&1 || true
  return 0
}

wait_for_service_convergence() {
  local timeout_secs="${1:-$CORE_WARMUP_TIMEOUT_SECS}"
  local deadline=$((SECONDS + timeout_secs))
  local stable_passes=0
  local next_flannel_repair_at=0
  local next_image_pull_repair_at=0
  local pending=()
  local transient_failures=()
  local hard_failures=()
  local deployment
  local image_pull_backoff_pods
  local crashed_workload_pods
  local warmup_remaining=0
  local curl_rc=0

  while [ "$SECONDS" -lt "$deadline" ]; do
    pending=()
    transient_failures=()
    hard_failures=()

    if kubectl get nodes >/dev/null 2>&1; then
      kubelet_proxy_rbac_healthy || hard_failures+=("kubelet proxy RBAC unhealthy")
    else
      hard_failures+=("kubernetes api unreachable")
    fi

    if daemonset_ready "kube-system" "kube-flannel"; then
      :
    else
      pending+=("kube-flannel")
      transient_failures+=("kube-flannel not ready")
    fi
    pod_ready "joelclaw" "redis-0" || pending+=("redis-0")
    pod_ready "joelclaw" "inngest-0" || pending+=("inngest-0")
    pod_ready "joelclaw" "typesense-0" || pending+=("typesense-0")

    for deployment in "${CRITICAL_DEPLOYMENTS[@]}"; do
      deployment_ready "joelclaw" "$deployment" || pending+=("deploy:$deployment")
    done

    image_pull_backoff_pods="$(list_image_pull_backoff_pods)"
    if [ -n "$image_pull_backoff_pods" ]; then
      transient_failures+=("image pull backoff: ${image_pull_backoff_pods//$'\n'/, }")
    fi

    crashed_workload_pods="$(list_non_image_pull_crash_pods)"
    if [ -n "$crashed_workload_pods" ]; then
      hard_failures+=("deployment crash (non-image-pull): ${crashed_workload_pods//$'\n'/, }")
    fi

    if [[ " ${pending[*]-} " == *" kube-flannel "* ]] && [ "$SECONDS" -ge "$next_flannel_repair_at" ]; then
      ensure_vm_br_netfilter || true
      restart_flannel_if_unhealthy
      next_flannel_repair_at=$((SECONDS + 20))
    fi

    if [ "$SECONDS" -ge "$next_image_pull_repair_at" ]; then
      if restart_image_pull_backoff_workloads; then
        next_image_pull_repair_at=$((SECONDS + 20))
      fi
    fi

    if [ "${#pending[@]}" -eq 0 ]; then
      kubectl logs -n joelclaw redis-0 --tail=1 >/dev/null 2>&1 || pending+=("kubectl-logs")
      kubectl exec -n joelclaw redis-0 -- redis-cli ping >/dev/null 2>&1 || pending+=("kubectl-exec")

      if curl -fsS --max-time 5 http://localhost:8288/health >/dev/null 2>&1; then
        :
      else
        curl_rc=$?
        pending+=("inngest")
        if [ "$curl_rc" -eq 7 ] || [ "$curl_rc" -eq 28 ]; then
          transient_failures+=("inngest health timeout/refused")
        else
          hard_failures+=("inngest health check failed (curl exit $curl_rc)")
        fi
      fi

      if curl -fsS --max-time 5 http://localhost:8108/health >/dev/null 2>&1; then
        :
      else
        curl_rc=$?
        pending+=("typesense")
        if [ "$curl_rc" -eq 7 ] || [ "$curl_rc" -eq 28 ]; then
          transient_failures+=("typesense health timeout/refused")
        else
          hard_failures+=("typesense health check failed (curl exit $curl_rc)")
        fi
      fi
    fi

    if [ "${#hard_failures[@]}" -gt 0 ]; then
      if [ "${#pending[@]}" -gt 0 ]; then
        log "ERROR: service convergence hard failure: ${hard_failures[*]} (pending ${pending[*]})"
      else
        log "ERROR: service convergence hard failure: ${hard_failures[*]}"
      fi
      return 1
    fi

    if [ "${#transient_failures[@]}" -gt 0 ]; then
      warmup_remaining="$(warmup_grace_remaining_secs)"
      if [ "$warmup_remaining" -gt 0 ]; then
        stable_passes=0
        log "WARNING: warmup grace: transient failures tolerated for ${warmup_remaining}s more (${transient_failures[*]})"
        if [ "${#pending[@]}" -gt 0 ]; then
          log "warmup: waiting for ${pending[*]}"
        fi
        sleep 5
        continue
      fi

      log "ERROR: service convergence failure after warmup grace expired (${transient_failures[*]})"
      return 1
    fi

    if [ "${#pending[@]}" -eq 0 ]; then
      stable_passes=$((stable_passes + 1))
      if [ "$stable_passes" -ge 2 ]; then
        log "invariant: service convergence stable"
        return 0
      fi
      log "invariant: service convergence pass $stable_passes/2"
    else
      stable_passes=0
      log "warmup: waiting for ${pending[*]}"
    fi

    sleep 5
  done

  if [ "${#pending[@]}" -gt 0 ]; then
    log "ERROR: service convergence timeout (${timeout_secs}s); pending ${pending[*]}"
  else
    log "ERROR: service convergence timeout (${timeout_secs}s)"
  fi

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

  # Post-cycle startup can flap while flannel/core services/workloads settle.
  # Require two consecutive clean passes before declaring convergence.
  if ! wait_for_service_convergence "$CORE_WARMUP_TIMEOUT_SECS"; then
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
fi

ensure_vm_br_netfilter || true

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

  restart_flannel_if_unhealthy

  ensure_kubelet_proxy_rbac
else
  log "WARNING: kubernetes api still unavailable after wait"
fi

post_colima_invariant_gate

# Clean up stale voice-agent processes that may hold port 8081 after Colima cycles.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$SCRIPT_DIR/voice-agent/cleanup-stale.sh" ]; then
  log "running voice-agent stale-process cleanup"
  if ! "$SCRIPT_DIR/voice-agent/cleanup-stale.sh" 2>&1 | tee -a "$LOG_FILE"; then
    log "WARNING: voice-agent stale-process cleanup failed"
  fi
else
  log "voice-agent stale-process cleanup script missing or not executable; skipping"
fi

log "k8s reboot heal tick complete"

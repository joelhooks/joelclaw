#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/Users/joel/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

ARTIFACT_ROOT="${COLIMA_PROOF_ARTIFACT_ROOT:-$HOME/.local/share/colima-proof/incidents}"
SESSION_ID="${SLOG_SESSION_ID:-FeralPigeon}"
SYSTEM_ID="${SLOG_SYSTEM_ID:-panda}"
COMPONENT="colima-proof"
SOURCE="infra"
DEFAULT_PORTS="6379,8108,8288,64784,3018,3111"

mkdir -p "$ARTIFACT_ROOT"

usage() {
  cat <<'EOF'
Usage:
  colima-proof.sh snapshot [options]
  colima-proof.sh recover-usernet [options]

snapshot options:
  --incident-id <id>
  --phase <phase>
  --action <action>
  --level <debug|info|warn|error|fatal>
  --success <true|false>
  --hypothesis-id <id>
  --recovery-mode <mode>
  --reason <text>

recover-usernet options:
  --incident-id <id>
  --hypothesis-id <id>
  --restart-mode <none|start|force-cycle>
  --verify-wait-secs <seconds>
  --reason <text>
EOF
}

new_incident_id() {
  python3 - <<'PY'
from datetime import datetime, timezone
import uuid
print(datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:12])
PY
}

sha256_file() {
  local target="$1"
  python3 - "$target" <<'PY'
import hashlib, pathlib, sys
path = pathlib.Path(sys.argv[1])
print(hashlib.sha256(path.read_bytes()).hexdigest())
PY
}

emit_otel_payload() {
  local payload_file="$1"
  if ! command -v joelclaw >/dev/null 2>&1; then
    return 0
  fi
  joelclaw otel emit <"$payload_file" >/dev/null 2>&1 || true
}

snapshot() {
  local incident_id="$1"
  local phase="$2"
  local action="$3"
  local level="$4"
  local success="$5"
  local hypothesis_id="$6"
  local recovery_mode="$7"
  local reason="$8"

  local incident_dir="$ARTIFACT_ROOT/$incident_id"
  local snapshot_file="$incident_dir/${phase}.json"
  local otel_payload_file="$incident_dir/${phase}.otel.json"

  mkdir -p "$incident_dir"

  INCIDENT_ID="$incident_id" \
  PHASE="$phase" \
  ACTION="$action" \
  LEVEL="$level" \
  SUCCESS="$success" \
  HYPOTHESIS_ID="$hypothesis_id" \
  RECOVERY_MODE="$recovery_mode" \
  REASON="$reason" \
  SESSION_ID="$SESSION_ID" \
  SYSTEM_ID="$SYSTEM_ID" \
  SNAPSHOT_FILE="$snapshot_file" \
  OTEL_PAYLOAD_FILE="$otel_payload_file" \
  ARTIFACT_ROOT="$ARTIFACT_ROOT" \
  DEFAULT_PORTS="$DEFAULT_PORTS" \
  python3 - <<'PY'
import hashlib
import json
import os
import pathlib
import socket
import stat
import subprocess
import time
from datetime import datetime, timezone

incident_id = os.environ["INCIDENT_ID"]
phase = os.environ["PHASE"]
action = os.environ["ACTION"]
level = os.environ["LEVEL"]
success = os.environ["SUCCESS"].lower() == "true"
hypothesis_id = os.environ.get("HYPOTHESIS_ID", "")
recovery_mode = os.environ.get("RECOVERY_MODE", "")
reason = os.environ.get("REASON", "")
session_id = os.environ.get("SESSION_ID", "unknown")
system_id = os.environ.get("SYSTEM_ID", "unknown")
snapshot_file = pathlib.Path(os.environ["SNAPSHOT_FILE"])
otel_payload_file = pathlib.Path(os.environ["OTEL_PAYLOAD_FILE"])
default_ports = [int(part) for part in os.environ.get("DEFAULT_PORTS", "6379,8108,8288,64784,3018,3111").split(",") if part.strip()]

root = pathlib.Path.home() / ".colima"
colima_lima = root / "_lima" / "colima"
network_dir = root / "_lima" / "_networks" / "user-v2"
state_file = pathlib.Path.home() / ".local" / "state" / "k8s-reboot-heal.env"
ha_stderr = colima_lima / "ha.stderr.log"
ha_stdout = colima_lima / "ha.stdout.log"
colima_stderr = pathlib.Path("/tmp/colima.stderr.log")
colima_stdout = pathlib.Path("/tmp/colima.stdout.log")
serialv_log = colima_lima / "serialv.log"
ssh_config = colima_lima / "ssh.config"


def run(command: str, timeout: int = 12) -> dict:
    started = time.time()
    try:
        completed = subprocess.run(
            ["/bin/bash", "-lc", command],
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        return {
            "command": command,
            "exit_code": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
            "duration_ms": round((time.time() - started) * 1000),
            "timed_out": False,
        }
    except subprocess.TimeoutExpired as error:
        return {
            "command": command,
            "exit_code": None,
            "stdout": error.stdout or "",
            "stderr": error.stderr or "",
            "duration_ms": round((time.time() - started) * 1000),
            "timed_out": True,
        }


def tail(path: pathlib.Path, lines: int = 120) -> list[str]:
    if not path.exists():
        return []
    try:
        text = path.read_text(errors="replace")
    except Exception as error:  # pragma: no cover - best effort probe
        return [f"<read failed: {error}>"]
    return text.splitlines()[-lines:]


def port_open(port: int) -> dict:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(1.5)
    try:
        sock.connect(("127.0.0.1", port))
        return {"open": True, "error": None}
    except Exception as error:  # pragma: no cover - runtime probe
        return {"open": False, "error": str(error)}
    finally:
        sock.close()


def unix_socket_probe(path: pathlib.Path) -> dict:
    info = {
        "path": str(path),
        "exists": path.exists(),
        "is_socket": False,
        "connect_ok": False,
        "connect_error": None,
    }
    if not path.exists():
        return info
    try:
        info["is_socket"] = stat.S_ISSOCK(path.stat().st_mode)
    except Exception as error:  # pragma: no cover
        info["connect_error"] = f"stat failed: {error}"
        return info
    if not info["is_socket"]:
        return info
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(1.0)
    try:
        sock.connect(str(path))
        info["connect_ok"] = True
    except Exception as error:  # pragma: no cover - runtime probe
        info["connect_error"] = str(error)
    finally:
        sock.close()
    return info


def path_info(path: pathlib.Path) -> dict:
    info = {"path": str(path), "exists": path.exists()}
    if not path.exists():
        return info
    stat_result = path.stat()
    info.update(
        {
            "mtime_epoch": int(stat_result.st_mtime),
            "size": stat_result.st_size,
            "is_dir": path.is_dir(),
            "is_socket": stat.S_ISSOCK(stat_result.st_mode),
        }
    )
    return info


ports = {str(port): port_open(port) for port in default_ports}
usernet_processes = run("ps -ef | rg 'limactl usernet' | rg 'user-v2' || true")
hostagent_processes = run("ps -ef | rg 'limactl hostagent' | rg 'colima' || true")
colima_daemon_processes = run("ps -ef | rg 'colima daemon start default' || true")
ssh_mux_processes = run("ps -ef | rg 'ssh: .*/colima/ssh.sock \\[mux\\]' || true")

usernet_lines = [line for line in usernet_processes["stdout"].splitlines() if line.strip()]
hostagent_lines = [line for line in hostagent_processes["stdout"].splitlines() if line.strip()]
colima_daemon_lines = [line for line in colima_daemon_processes["stdout"].splitlines() if line.strip()]
ssh_mux_lines = [line for line in ssh_mux_processes["stdout"].splitlines() if line.strip()]

colima_status = run("colima status --json || true", timeout=8)
limactl_list = run("LIMA_HOME=$HOME/.colima/_lima limactl list --json || true", timeout=8)
docker_ps = run("docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || true", timeout=8)
ps_snapshot = run("ps -ef | rg 'limactl usernet|limactl hostagent|colima daemon|ssh: .*/colima/ssh.sock|vz' || true", timeout=8)
lsof_unix = run("lsof -U | rg 'user-v2_(ep|fd|qemu)\\.sock|user-v2' || true", timeout=8)
lsof_listen = run("lsof -nP -iTCP -sTCP:LISTEN | rg ':(6379|8108|8288|64784|3018|3111)\\b' || true", timeout=8)

colima_status_json = None
try:
    stripped = colima_status["stdout"].strip()
    if stripped:
        colima_status_json = json.loads(stripped)
except Exception:
    colima_status_json = None

state_values = {}
if state_file.exists():
    for line in state_file.read_text(errors="replace").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        state_values[key] = value

socket_probes = {
    "ha_sock": unix_socket_probe(colima_lima / "ha.sock"),
    "usernet_ep_sock": unix_socket_probe(network_dir / "user-v2_ep.sock"),
    "usernet_fd_sock": unix_socket_probe(network_dir / "user-v2_fd.sock"),
    "usernet_qemu_sock": unix_socket_probe(network_dir / "user-v2_qemu.sock"),
}

ssh_local_port = None
if hostagent_lines:
    for line in tail(ha_stderr, 80):
        if "SSH Local Port:" in line:
            ssh_local_port = line.rsplit(":", 1)[-1].strip()

ha_tail = tail(ha_stderr, 120)
colima_stdout_tail = tail(colima_stdout, 120)
colima_stderr_tail = tail(colima_stderr, 120)
serialv_tail = tail(serialv_log, 80)

ha_tail_text = "\n".join(ha_tail)
colima_stdout_text = "\n".join(colima_stdout_tail)

suspected_usernet_leak = len(usernet_lines) > 1 or (
    socket_probes["usernet_ep_sock"]["exists"] and not socket_probes["usernet_ep_sock"]["connect_ok"]
) or (
    socket_probes["usernet_fd_sock"]["exists"] and not socket_probes["usernet_fd_sock"]["connect_ok"]
)

ha_usernet_signal = any(
    signal in ha_tail_text
    for signal in [
        "user session is ready for ssh",
        "not ready to start persistent ssh session",
        "SSH server does not seem to be running on vsock port",
        "connect: no such file or directory",
    ]
)

snapshot = {
    "incident_id": incident_id,
    "phase": phase,
    "action": action,
    "level": level,
    "success": success,
    "reason": reason,
    "hypothesis_id": hypothesis_id,
    "recovery_mode": recovery_mode,
    "captured_at": datetime.now(timezone.utc).isoformat(),
    "session_id": session_id,
    "system_id": system_id,
    "summary": {
        "usernet_pid_count": len(usernet_lines),
        "hostagent_pid_count": len(hostagent_lines),
        "colima_daemon_pid_count": len(colima_daemon_lines),
        "ssh_mux_pid_count": len(ssh_mux_lines),
        "docker_socket_exists": pathlib.Path.home().joinpath('.colima/default/docker.sock').exists(),
        "docker_socket_connect_ok": ports.get("6379", {}).get("open") is True or "joelclaw-controlplane-1" in docker_ps["stdout"],
        "ports_open": {port: probe["open"] for port, probe in ports.items()},
        "suspected_usernet_leak": suspected_usernet_leak,
        "ha_usernet_signal": ha_usernet_signal,
        "colima_status_parse_ok": colima_status_json is not None,
        "colima_runtime": None if not colima_status_json else colima_status_json.get("runtime"),
        "colima_ip_address": None if not colima_status_json else colima_status_json.get("ip_address"),
        "ssh_local_port": ssh_local_port,
        "last_colima_force_cycle_epoch": state_values.get("LAST_COLIMA_FORCE_CYCLE_EPOCH"),
    },
    "files": {
        "network_dir": path_info(network_dir),
        "ha_stderr": path_info(ha_stderr),
        "ha_stdout": path_info(colima_lima / "ha.stdout.log"),
        "serialv_log": path_info(serialv_log),
        "colima_stdout": path_info(colima_stdout),
        "colima_stderr": path_info(colima_stderr),
        "state_file": path_info(state_file),
        "ssh_config": path_info(ssh_config),
    },
    "sockets": socket_probes,
    "processes": {
        "usernet": usernet_lines,
        "hostagent": hostagent_lines,
        "colima_daemon": colima_daemon_lines,
        "ssh_mux": ssh_mux_lines,
    },
    "commands": {
        "colima_status": colima_status,
        "limactl_list": limactl_list,
        "docker_ps": docker_ps,
        "ps_snapshot": ps_snapshot,
        "lsof_unix": lsof_unix,
        "lsof_listen": lsof_listen,
    },
    "state": state_values,
    "tails": {
        "ha_stderr": ha_tail,
        "colima_stdout": colima_stdout_tail,
        "colima_stderr": colima_stderr_tail,
        "serialv": serialv_tail,
    },
}

payload_text = json.dumps(snapshot, indent=2, sort_keys=True)
snapshot_file.write_text(payload_text)
artifact_sha256 = hashlib.sha256(payload_text.encode("utf-8")).hexdigest()

otel_event = {
    "action": action,
    "source": "infra",
    "component": "colima-proof",
    "level": level,
    "success": success,
    "sessionId": session_id,
    "systemId": system_id,
    "error": None if success else "colima_substrate_probe_detected_failure",
    "metadata": {
        "incident_id": incident_id,
        "phase": phase,
        "hypothesis_id": hypothesis_id,
        "recovery_mode": recovery_mode,
        "reason": reason,
        "artifact_path": str(snapshot_file),
        "artifact_sha256": artifact_sha256,
        "usernet_pid_count": len(usernet_lines),
        "hostagent_pid_count": len(hostagent_lines),
        "colima_daemon_pid_count": len(colima_daemon_lines),
        "ssh_mux_pid_count": len(ssh_mux_lines),
        "suspected_usernet_leak": suspected_usernet_leak,
        "ha_usernet_signal": ha_usernet_signal,
        "ha_sock_connect_ok": socket_probes["ha_sock"]["connect_ok"],
        "usernet_ep_sock_connect_ok": socket_probes["usernet_ep_sock"]["connect_ok"],
        "usernet_fd_sock_connect_ok": socket_probes["usernet_fd_sock"]["connect_ok"],
        "usernet_qemu_sock_connect_ok": socket_probes["usernet_qemu_sock"]["connect_ok"],
        "colima_status_parse_ok": colima_status_json is not None,
        "colima_runtime": None if not colima_status_json else colima_status_json.get("runtime"),
        "colima_ip_address": None if not colima_status_json else colima_status_json.get("ip_address"),
        "docker_socket_exists": pathlib.Path.home().joinpath('.colima/default/docker.sock').exists(),
        "ports_open": {port: probe["open"] for port, probe in ports.items()},
        "ssh_local_port": ssh_local_port,
        "state_file_force_cycle_epoch": state_values.get("LAST_COLIMA_FORCE_CYCLE_EPOCH"),
    },
}
otel_payload_file.write_text(json.dumps(otel_event, sort_keys=True))
print(json.dumps({
    "incident_id": incident_id,
    "phase": phase,
    "snapshot_file": str(snapshot_file),
    "otel_payload_file": str(otel_payload_file),
    "artifact_sha256": artifact_sha256,
    "suspected_usernet_leak": suspected_usernet_leak,
    "usernet_pid_count": len(usernet_lines),
    "ha_usernet_signal": ha_usernet_signal,
}))
PY

  emit_otel_payload "$otel_payload_file"
}

evaluate_usernet_recovery() {
  local incident_id="$1"
  local hypothesis_id="$2"
  local restart_mode="$3"
  local reason="$4"

  local incident_dir="$ARTIFACT_ROOT/$incident_id"
  local verdict_file="$incident_dir/recover-usernet-verdict.json"
  local otel_payload_file="$incident_dir/recover-usernet-verdict.otel.json"

  INCIDENT_ID="$incident_id" \
  HYPOTHESIS_ID="$hypothesis_id" \
  RESTART_MODE="$restart_mode" \
  REASON="$reason" \
  SESSION_ID="$SESSION_ID" \
  SYSTEM_ID="$SYSTEM_ID" \
  INCIDENT_DIR="$incident_dir" \
  VERDICT_FILE="$verdict_file" \
  OTEL_PAYLOAD_FILE="$otel_payload_file" \
  python3 - <<'PY'
import json
import os
import pathlib
from datetime import datetime, timezone

incident_dir = pathlib.Path(os.environ["INCIDENT_DIR"])
incident_id = os.environ["INCIDENT_ID"]
hypothesis_id = os.environ["HYPOTHESIS_ID"]
restart_mode = os.environ["RESTART_MODE"]
reason = os.environ.get("REASON", "")
session_id = os.environ.get("SESSION_ID", "unknown")
system_id = os.environ.get("SYSTEM_ID", "unknown")
verdict_file = pathlib.Path(os.environ["VERDICT_FILE"])
otel_payload_file = pathlib.Path(os.environ["OTEL_PAYLOAD_FILE"])
pre = json.loads((incident_dir / "recover-usernet-pre.json").read_text())
post = json.loads((incident_dir / "recover-usernet-post.json").read_text())

pre_summary = pre.get("summary", {})
post_summary = post.get("summary", {})
pre_sockets = pre.get("sockets", {})
post_sockets = post.get("sockets", {})

critical_ports = ["6379", "8108", "8288", "64784"]
pre_ports = pre_summary.get("ports_open", {})
post_ports = post_summary.get("ports_open", {})
pre_core_ports_open = all(bool(pre_ports.get(port)) for port in critical_ports)
post_core_ports_open = all(bool(post_ports.get(port)) for port in critical_ports)

pre_signal = bool(pre_summary.get("suspected_usernet_leak")) or int(pre_summary.get("usernet_pid_count", 0) or 0) > 1
post_signal = bool(post_summary.get("suspected_usernet_leak")) or int(post_summary.get("usernet_pid_count", 0) or 0) > 1
post_usernet_sockets_ok = all(bool(post_sockets.get(name, {}).get("connect_ok")) for name in ["usernet_ep_sock", "usernet_fd_sock", "usernet_qemu_sock"])
post_host_control_ok = bool(post_summary.get("docker_socket_connect_ok")) and post_core_ports_open

if restart_mode == "force-cycle":
    verdict = "inconclusive_broader_recovery"
    success = False
    error = "force_cycle_was_required"
elif not pre_signal:
    verdict = "missing_usernet_precondition"
    success = False
    error = "precondition_not_met"
elif pre_signal and (not post_signal) and post_usernet_sockets_ok and post_host_control_ok:
    verdict = "supports_h1_usernet"
    success = True
    error = None
elif pre_signal and post_signal:
    verdict = "does_not_support_h1_usernet"
    success = False
    error = "usernet_signal_persisted"
else:
    verdict = "inconclusive_partial_improvement"
    success = False
    error = "usernet_signal_improved_without_full_recovery"

payload = {
    "incident_id": incident_id,
    "hypothesis_id": hypothesis_id,
    "recovery_mode": "usernet-only",
    "restart_mode": restart_mode,
    "reason": reason,
    "captured_at": datetime.now(timezone.utc).isoformat(),
    "session_id": session_id,
    "system_id": system_id,
    "verdict": verdict,
    "success": success,
    "error": error,
    "comparison": {
        "pre_usernet_pid_count": pre_summary.get("usernet_pid_count"),
        "post_usernet_pid_count": post_summary.get("usernet_pid_count"),
        "pre_suspected_usernet_leak": pre_summary.get("suspected_usernet_leak"),
        "post_suspected_usernet_leak": post_summary.get("suspected_usernet_leak"),
        "pre_docker_socket_connect_ok": pre_summary.get("docker_socket_connect_ok"),
        "post_docker_socket_connect_ok": post_summary.get("docker_socket_connect_ok"),
        "pre_core_ports_open": pre_core_ports_open,
        "post_core_ports_open": post_core_ports_open,
        "post_usernet_sockets_ok": post_usernet_sockets_ok,
    },
    "artifacts": {
        "pre": str(incident_dir / "recover-usernet-pre.json"),
        "post": str(incident_dir / "recover-usernet-post.json"),
        "verdict": str(verdict_file),
    },
}
verdict_file.write_text(json.dumps(payload, indent=2, sort_keys=True))

otel_event = {
    "action": "infra.colima.recovery.usernet_only.verdict",
    "source": "infra",
    "component": "colima-proof",
    "level": "info" if success else "warn",
    "success": success,
    "sessionId": session_id,
    "systemId": system_id,
    "error": error,
    "metadata": {
        "incident_id": incident_id,
        "hypothesis_id": hypothesis_id,
        "recovery_mode": "usernet-only",
        "restart_mode": restart_mode,
        "reason": reason,
        "verdict": verdict,
        "pre_usernet_pid_count": pre_summary.get("usernet_pid_count"),
        "post_usernet_pid_count": post_summary.get("usernet_pid_count"),
        "pre_suspected_usernet_leak": pre_summary.get("suspected_usernet_leak"),
        "post_suspected_usernet_leak": post_summary.get("suspected_usernet_leak"),
        "pre_docker_socket_connect_ok": pre_summary.get("docker_socket_connect_ok"),
        "post_docker_socket_connect_ok": post_summary.get("docker_socket_connect_ok"),
        "pre_core_ports_open": pre_core_ports_open,
        "post_core_ports_open": post_core_ports_open,
        "post_usernet_sockets_ok": post_usernet_sockets_ok,
        "artifact_path": str(verdict_file),
    },
}
otel_payload_file.write_text(json.dumps(otel_event, sort_keys=True))
print(json.dumps(payload, sort_keys=True))
PY

  emit_otel_payload "$otel_payload_file"
}

recover_usernet() {
  local incident_id="$1"
  local hypothesis_id="$2"
  local restart_mode="$3"
  local verify_wait_secs="$4"
  local reason="$5"

  snapshot "$incident_id" "recover-usernet-pre" "infra.colima.recovery.usernet_only.started" "warn" "false" "$hypothesis_id" "usernet-only" "$reason"

  pkill -f 'limactl usernet.*user-v2' >/dev/null 2>&1 || true
  rm -rf "$HOME/.colima/_lima/_networks/user-v2"

  case "$restart_mode" in
    none)
      ;;
    start)
      colima start >/dev/null 2>&1 || true
      ;;
    force-cycle)
      colima stop --force >/dev/null 2>&1 || true
      sleep 1
      colima start >/dev/null 2>&1 || true
      ;;
    *)
      echo "invalid --restart-mode: $restart_mode" >&2
      exit 1
      ;;
  esac

  if [[ "$verify_wait_secs" =~ ^[0-9]+$ ]] && [ "$verify_wait_secs" -gt 0 ]; then
    sleep "$verify_wait_secs"
  fi

  snapshot "$incident_id" "recover-usernet-post" "infra.colima.recovery.usernet_only.completed" "info" "true" "$hypothesis_id" "usernet-only" "$reason"
  evaluate_usernet_recovery "$incident_id" "$hypothesis_id" "$restart_mode" "$reason"
}

command_name="${1:-}"
if [ -z "$command_name" ]; then
  usage
  exit 1
fi
shift || true

incident_id=""
phase="baseline"
action="infra.colima.snapshot"
level="info"
success="true"
hypothesis_id="H1-usernet"
recovery_mode=""
reason=""
restart_mode="none"
verify_wait_secs="15"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --incident-id)
      incident_id="$2"
      shift 2
      ;;
    --phase)
      phase="$2"
      shift 2
      ;;
    --action)
      action="$2"
      shift 2
      ;;
    --level)
      level="$2"
      shift 2
      ;;
    --success)
      success="$2"
      shift 2
      ;;
    --hypothesis-id)
      hypothesis_id="$2"
      shift 2
      ;;
    --recovery-mode)
      recovery_mode="$2"
      shift 2
      ;;
    --reason)
      reason="$2"
      shift 2
      ;;
    --restart-mode)
      restart_mode="$2"
      shift 2
      ;;
    --verify-wait-secs)
      verify_wait_secs="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

incident_id="${incident_id:-$(new_incident_id)}"

case "$command_name" in
  snapshot)
    snapshot "$incident_id" "$phase" "$action" "$level" "$success" "$hypothesis_id" "$recovery_mode" "$reason"
    ;;
  recover-usernet)
    recover_usernet "$incident_id" "$hypothesis_id" "$restart_mode" "$verify_wait_secs" "$reason"
    ;;
  *)
    echo "unknown command: $command_name" >&2
    usage
    exit 1
    ;;
esac

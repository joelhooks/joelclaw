use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::{Config, DEFAULT_PATH};

const COLIMA_DOCKER_HOST: &str = "unix:///Users/joel/.colima/default/docker.sock";

#[derive(Debug, Clone)]
pub struct Probe {
    pub name: String,
    pub args: Vec<String>,
    pub timeout: Duration,
    pub critical: bool,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub name: String,
    pub passed: bool,
    pub output: String,
    pub duration_ms: u64,
}

pub fn run_all_probes(config: &Config) -> Vec<ProbeResult> {
    let mut probes = vec![
        Probe {
            name: "colima".to_string(),
            args: vec!["colima".to_string(), "status".to_string()],
            timeout: Duration::from_secs(config.probes.colima_timeout_secs),
            critical: true,
            env: vec![],
        },
        Probe {
            name: "docker".to_string(),
            args: vec![
                "docker".to_string(),
                "ps".to_string(),
                "--format".to_string(),
                "{{.Names}}".to_string(),
            ],
            timeout: Duration::from_secs(config.probes.k8s_timeout_secs),
            critical: true,
            env: vec![("DOCKER_HOST".to_string(), COLIMA_DOCKER_HOST.to_string())],
        },
        Probe {
            name: "talos_container".to_string(),
            args: vec![
                "docker".to_string(),
                "inspect".to_string(),
                "--format".to_string(),
                "{{.State.Status}}".to_string(),
                "joelclaw-controlplane-1".to_string(),
            ],
            timeout: Duration::from_secs(config.probes.k8s_timeout_secs),
            critical: true,
            env: vec![("DOCKER_HOST".to_string(), COLIMA_DOCKER_HOST.to_string())],
        },
        Probe {
            name: "k8s_api".to_string(),
            args: vec![
                "kubectl".to_string(),
                "get".to_string(),
                "nodes".to_string(),
                "--no-headers".to_string(),
            ],
            timeout: Duration::from_secs(config.probes.k8s_timeout_secs),
            critical: true,
            env: vec![],
        },
        Probe {
            name: "node_ready".to_string(),
            args: vec![
                "kubectl".to_string(),
                "get".to_string(),
                "nodes".to_string(),
                "-o".to_string(),
                "jsonpath={.items[0].status.conditions[?(@.type==\"Ready\")].status}".to_string(),
            ],
            timeout: Duration::from_secs(config.probes.k8s_timeout_secs),
            critical: true,
            env: vec![],
        },
        Probe {
            name: "node_schedulable".to_string(),
            args: vec![
                "kubectl".to_string(),
                "get".to_string(),
                "nodes".to_string(),
                "-o".to_string(),
                "jsonpath={.items[0].spec}".to_string(),
            ],
            timeout: Duration::from_secs(config.probes.k8s_timeout_secs),
            critical: true,
            env: vec![],
        },
        Probe {
            name: "flannel".to_string(),
            args: vec![
                "kubectl".to_string(),
                "-n".to_string(),
                "kube-system".to_string(),
                "get".to_string(),
                "daemonset".to_string(),
                "kube-flannel".to_string(),
                "-o".to_string(),
                "jsonpath={.status.numberAvailable}/{.status.desiredNumberScheduled}".to_string(),
            ],
            timeout: Duration::from_secs(config.probes.k8s_timeout_secs),
            critical: false,
            env: vec![],
        },
        Probe {
            name: "redis".to_string(),
            args: vec![
                "kubectl".to_string(),
                "exec".to_string(),
                "-n".to_string(),
                "joelclaw".to_string(),
                "redis-0".to_string(),
                "--".to_string(),
                "redis-cli".to_string(),
                "ping".to_string(),
            ],
            timeout: Duration::from_secs(config.probes.service_timeout_secs),
            critical: true,
            env: vec![],
        },
    ];

    for monitor in &config.launchd_service_probes {
        probes.push(Probe {
            name: format!("launchd:{}", monitor.name),
            args: vec![
                "launchctl".to_string(),
                "list".to_string(),
                monitor.label.clone(),
            ],
            timeout: Duration::from_secs(monitor.timeout_secs),
            critical: monitor.critical,
            env: vec![],
        });
    }

    for monitor in &config.http_service_probes {
        probes.push(Probe {
            name: format!("http:{}", monitor.name),
            args: vec![
                "curl".to_string(),
                "-s".to_string(),
                "-o".to_string(),
                "/dev/null".to_string(),
                "-w".to_string(),
                "%{http_code}".to_string(),
                monitor.url.clone(),
            ],
            timeout: Duration::from_secs(monitor.timeout_secs),
            critical: monitor.critical,
            env: vec![],
        });
    }

    let mut results = Vec::with_capacity(probes.len());

    for probe in probes {
        let mut result = run_probe(&probe.name, &probe.args, probe.timeout, &probe.env);
        result.passed = result.passed && validate_probe_output(&probe.name, &result.output);

        if probe.critical && !result.passed {
            result.output = format!("{} [critical]", result.output.trim());
        }

        results.push(result);
    }

    results
}

pub fn run_probe(
    name: &str,
    args: &[String],
    timeout: Duration,
    env: &[(String, String)],
) -> ProbeResult {
    let start = Instant::now();

    if args.is_empty() {
        return ProbeResult {
            name: name.to_string(),
            passed: false,
            output: "no command configured".to_string(),
            duration_ms: start.elapsed().as_millis() as u64,
        };
    }

    let mut command = Command::new(&args[0]);
    command
        .args(&args[1..])
        .env("PATH", DEFAULT_PATH)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (key, value) in env {
        command.env(key, value);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ProbeResult {
                name: name.to_string(),
                passed: false,
                output: format!("spawn failed: {error}"),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                return ProbeResult {
                    name: name.to_string(),
                    passed: false,
                    output: format!("wait failed: {error}"),
                    duration_ms: start.elapsed().as_millis() as u64,
                };
            }
        }
    };

    let output = collect_child_output(&mut child);
    let duration_ms = start.elapsed().as_millis() as u64;

    match status {
        Some(exit_status) => ProbeResult {
            name: name.to_string(),
            passed: exit_status.success(),
            output,
            duration_ms,
        },
        None => ProbeResult {
            name: name.to_string(),
            passed: false,
            output: format!("timeout after {}s", timeout.as_secs()),
            duration_ms,
        },
    }
}

fn validate_probe_output(name: &str, raw_output: &str) -> bool {
    let output = raw_output.trim().trim_matches('\'').trim();

    match name {
        "talos_container" => output.eq_ignore_ascii_case("running"),
        "node_ready" => output == "True",
        "node_schedulable" => is_node_schedulable(output),
        "flannel" => is_flannel_ready(output),
        "redis" => output.contains("PONG"),
        _ if name.starts_with("http:") => output.contains("200"),
        _ if name.starts_with("launchd:") => launchd_list_running(output),
        _ => true,
    }
}

fn launchd_list_running(output: &str) -> bool {
    let pid_marker = output.lines().find(|line| line.contains("\"PID\" ="));
    let Some(line) = pid_marker else {
        return false;
    };

    !line.contains("\"PID\" = 0")
}

fn is_node_schedulable(spec_output: &str) -> bool {
    let lowered = spec_output.to_ascii_lowercase();
    if lowered.contains("\"unschedulable\":true") || lowered.contains("\"unschedulable\": true") {
        return false;
    }

    if spec_output.contains("NoSchedule") {
        return false;
    }

    true
}

fn is_flannel_ready(status_output: &str) -> bool {
    let trimmed = status_output.trim();
    let Some((available, desired)) = trimmed.split_once('/') else {
        return false;
    };

    let available = available.trim().parse::<u32>().ok();
    let desired = desired.trim().parse::<u32>().ok();

    match (available, desired) {
        (Some(available), Some(desired)) => desired > 0 && available == desired,
        _ => false,
    }
}

fn collect_child_output(child: &mut std::process::Child) -> String {
    let mut stdout = String::new();
    let mut stderr = String::new();

    if let Some(mut handle) = child.stdout.take() {
        let mut bytes = Vec::new();
        let _ = handle.read_to_end(&mut bytes);
        stdout = String::from_utf8_lossy(&bytes).trim().to_string();
    }

    if let Some(mut handle) = child.stderr.take() {
        let mut bytes = Vec::new();
        let _ = handle.read_to_end(&mut bytes);
        stderr = String::from_utf8_lossy(&bytes).trim().to_string();
    }

    if stdout.is_empty() && stderr.is_empty() {
        return "ok".to_string();
    }

    if stdout.is_empty() {
        return stderr;
    }

    if stderr.is_empty() {
        return stdout;
    }

    format!("{stdout}\n{stderr}")
}

#[cfg(test)]
mod tests {
    use super::is_flannel_ready;

    #[test]
    fn flannel_probe_passes_when_available_matches_desired() {
        assert!(is_flannel_ready("1/1"));
        assert!(is_flannel_ready(" 2 / 2 "));
    }

    #[test]
    fn flannel_probe_fails_when_unavailable_or_malformed() {
        assert!(!is_flannel_ready("0/1"));
        assert!(!is_flannel_ready("0/0"));
        assert!(!is_flannel_ready("not-ready"));
    }
}


use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::{Config, DEFAULT_PATH};

const COLIMA_DOCKER_HOST: &str = "unix:///Users/joel/.colima/default/docker.sock";

#[derive(Debug, Clone)]
pub struct Probe {
    pub name: &'static str,
    pub args: Vec<&'static str>,
    pub timeout: Duration,
    pub critical: bool,
    pub env: Vec<(&'static str, &'static str)>,
}

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub name: String,
    pub passed: bool,
    pub output: String,
    pub duration_ms: u64,
}

pub fn run_all_probes(config: &Config) -> Vec<ProbeResult> {
    let probes = vec![
        Probe {
            name: "colima",
            args: vec!["colima", "status"],
            timeout: Duration::from_secs(config.probes.colima_timeout_secs),
            critical: true,
            env: vec![],
        },
        Probe {
            name: "docker",
            args: vec!["docker", "ps", "--format", "{{.Names}}"],
            timeout: Duration::from_secs(config.probes.k8s_timeout_secs),
            critical: true,
            env: vec![("DOCKER_HOST", COLIMA_DOCKER_HOST)],
        },
        Probe {
            name: "talos_container",
            args: vec![
                "docker",
                "inspect",
                "--format",
                "{{.State.Status}}",
                "joelclaw-controlplane-1",
            ],
            timeout: Duration::from_secs(config.probes.k8s_timeout_secs),
            critical: true,
            env: vec![("DOCKER_HOST", COLIMA_DOCKER_HOST)],
        },
        Probe {
            name: "k8s_api",
            args: vec!["kubectl", "get", "nodes", "--no-headers"],
            timeout: Duration::from_secs(config.probes.k8s_timeout_secs),
            critical: true,
            env: vec![],
        },
        Probe {
            name: "node_ready",
            args: vec![
                "kubectl",
                "get",
                "nodes",
                "-o",
                "jsonpath={.items[0].status.conditions[?(@.type==\"Ready\")].status}",
            ],
            timeout: Duration::from_secs(config.probes.k8s_timeout_secs),
            critical: true,
            env: vec![],
        },
        Probe {
            name: "node_schedulable",
            args: vec!["kubectl", "get", "nodes", "-o", "jsonpath={.items[0].spec}"],
            timeout: Duration::from_secs(config.probes.k8s_timeout_secs),
            critical: true,
            env: vec![],
        },
        Probe {
            name: "redis",
            args: vec![
                "kubectl",
                "exec",
                "-n",
                "joelclaw",
                "redis-0",
                "--",
                "redis-cli",
                "ping",
            ],
            timeout: Duration::from_secs(config.probes.service_timeout_secs),
            critical: true,
            env: vec![],
        },
        Probe {
            name: "inngest",
            args: vec![
                "curl",
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "http://localhost:8288/health",
            ],
            timeout: Duration::from_secs(config.probes.service_timeout_secs),
            critical: false,
            env: vec![],
        },
        Probe {
            name: "typesense",
            args: vec![
                "curl",
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "http://localhost:8108/health",
            ],
            timeout: Duration::from_secs(config.probes.service_timeout_secs),
            critical: false,
            env: vec![],
        },
        Probe {
            name: "worker",
            args: vec![
                "curl",
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "http://localhost:3111/api/inngest",
            ],
            timeout: Duration::from_secs(config.probes.service_timeout_secs),
            critical: false,
            env: vec![],
        },
    ];

    let mut results = Vec::with_capacity(probes.len());

    for probe in probes {
        let mut result = run_probe(probe.name, &probe.args, probe.timeout, &probe.env);
        result.passed = result.passed && validate_probe_output(probe.name, &result.output);

        if probe.critical && !result.passed {
            result.output = format!("{} [critical]", result.output.trim());
        }

        results.push(result);
    }

    results
}

pub fn run_probe(
    name: &str,
    args: &[&str],
    timeout: Duration,
    env: &[(&str, &str)],
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

    let mut command = Command::new(args[0]);
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

pub fn is_critical_probe(name: &str) -> bool {
    matches!(
        name,
        "colima"
            | "docker"
            | "talos_container"
            | "k8s_api"
            | "node_ready"
            | "node_schedulable"
            | "redis"
    )
}

fn validate_probe_output(name: &str, raw_output: &str) -> bool {
    let output = raw_output.trim().trim_matches('\'').trim();

    match name {
        "talos_container" => output.eq_ignore_ascii_case("running"),
        "node_ready" => output == "True",
        "node_schedulable" => is_node_schedulable(output),
        "redis" => output.contains("PONG"),
        "inngest" | "typesense" | "worker" => output.contains("200"),
        _ => true,
    }
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

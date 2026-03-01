use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::{expand_home, now_unix_secs, Config, DEFAULT_PATH};

const COLIMA_DOCKER_HOST: &str = "unix:///Users/joel/.colima/default/docker.sock";
use crate::log;
use crate::probes::ProbeResult;
use crate::state::PersistentState;
use crate::DynError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TierOutcome {
    Fixed,
    Failed,
    Cooldown,
}

pub fn run_heal(
    config: &Config,
    state: &mut PersistentState,
    dry_run: bool,
) -> Result<(TierOutcome, String), DynError> {
    if dry_run {
        let output = "dry-run: heal script skipped".to_string();
        return Ok((TierOutcome::Cooldown, output));
    }

    state.last_heal_time = Some(now_unix_secs());
    let script_path = expand_home(&config.heal_script);

    log::warn_fields(
        "running heal script",
        &[("script", script_path.display().to_string())],
    );

    let (success, output) = run_process(
        script_path
            .to_str()
            .ok_or_else(|| "heal script path contains invalid UTF-8")?,
        &[],
        &[],
        Duration::from_secs(config.heal_timeout_secs),
        None,
    )?;

    if success {
        log::info("heal script reported success");
        Ok((TierOutcome::Fixed, output))
    } else {
        log::warn("heal script failed");
        Ok((TierOutcome::Failed, output))
    }
}

pub fn run_bridge_heal(
    config: &Config,
    state: &mut PersistentState,
    dry_run: bool,
) -> Result<(TierOutcome, String), DynError> {
    if dry_run {
        let output = "dry-run: bridge heal skipped".to_string();
        return Ok((TierOutcome::Cooldown, output));
    }

    state.last_heal_time = Some(now_unix_secs());

    log::warn("running bridge heal (force-cycling colima to restore localhost bridges)");

    let bridge_command = format!(
        "set -euo pipefail; colima stop --force >/dev/null 2>&1 || true; sleep 1; colima start; DOCKER_HOST={COLIMA_DOCKER_HOST} docker ps --format '{{{{.Names}}}}' >/dev/null"
    );

    let (success, output) = run_process(
        "/bin/zsh",
        &["-lc", &bridge_command],
        &[],
        Duration::from_secs(config.heal_timeout_secs.max(240)),
        None,
    )?;

    if success {
        log::info("bridge heal reported success");
        Ok((TierOutcome::Fixed, output))
    } else {
        log::warn("bridge heal failed");
        Ok((TierOutcome::Failed, output))
    }
}

pub fn run_service_heal(
    config: &Config,
    state: &mut PersistentState,
    failed_probes: &[ProbeResult],
    dry_run: bool,
) -> Result<(TierOutcome, String), DynError> {
    if dry_run {
        let output = "dry-run: service-specific heal skipped".to_string();
        return Ok((TierOutcome::Cooldown, output));
    }

    state.last_heal_time = Some(now_unix_secs());

    let launchd_labels = restart_targets_for_failed_services(config, failed_probes);
    if launchd_labels.is_empty() {
        let output = "no service-specific restart targets found".to_string();
        log::warn(&output);
        return Ok((TierOutcome::Failed, output));
    }

    let Some(uid) = current_uid() else {
        let output = "unable to resolve uid for launchctl kickstart".to_string();
        log::warn(&output);
        return Ok((TierOutcome::Failed, output));
    };

    let mut all_success = true;
    let mut output_lines = Vec::new();

    for label in launchd_labels {
        if let Some(service_name) = service_name_for_label(config, &label) {
            if should_run_pre_restart_cleanup(service_name, failed_probes) {
                let cleanup_output = run_service_pre_restart_cleanup(config, service_name)?;
                output_lines.push(format!(
                    "pre-cleanup {service_name}: {}",
                    truncate(&cleanup_output, 1000)
                ));
            }
        }

        let target = format!("gui/{uid}/{label}");
        let (success, output) = run_process(
            "launchctl",
            &["kickstart", "-k", &target],
            &[],
            Duration::from_secs(20),
            None,
        )?;

        if success {
            log::info_fields(
                "service-specific restart succeeded",
                &[("target", target.clone())],
            );
        } else {
            all_success = false;
            log::warn_fields(
                "service-specific restart failed",
                &[
                    ("target", target.clone()),
                    ("output", truncate(&output, 1000)),
                ],
            );
        }

        output_lines.push(format!("{target}: {}", truncate(&output, 1000)));
    }

    let combined_output = output_lines.join("\n");
    if all_success {
        Ok((TierOutcome::Fixed, combined_output))
    } else {
        Ok((TierOutcome::Failed, combined_output))
    }
}

pub fn run_agents(
    config: &Config,
    state: &mut PersistentState,
    failed_probes: &[ProbeResult],
    heal_output: &str,
    dry_run: bool,
) -> Result<TierOutcome, DynError> {
    if dry_run {
        return Ok(TierOutcome::Cooldown);
    }

    let now = now_unix_secs();
    if let Some(last_agent_time) = state.last_agent_time {
        if now.saturating_sub(last_agent_time) < config.escalation.agent_cooldown_secs {
            log::warn("agent escalation skipped due to cooldown");
            return Ok(TierOutcome::Cooldown);
        }
    }

    state.last_agent_time = Some(now);

    let prompt = build_diagnostic_prompt(config, failed_probes, heal_output);
    let timeout = Duration::from_secs(config.agent.timeout_secs);

    log::warn("running cloud recovery agent");
    let (cloud_success, cloud_output) =
        run_shell_with_stdin(&config.agent.cloud_command, &prompt, timeout)?;

    if cloud_success {
        log::info("cloud recovery agent succeeded");
        return Ok(TierOutcome::Fixed);
    }

    log::warn_fields(
        "cloud recovery agent failed; trying local agent",
        &[("cloud_output", truncate(&cloud_output, 2_000))],
    );

    let (local_success, local_output) =
        run_shell_with_stdin(&config.agent.local_command, &prompt, timeout)?;
    if local_success {
        log::info("local recovery agent succeeded");
        Ok(TierOutcome::Fixed)
    } else {
        log::error_fields(
            "local recovery agent failed",
            &[("local_output", truncate(&local_output, 2_000))],
        );
        Ok(TierOutcome::Failed)
    }
}

pub fn run_sos(
    config: &Config,
    state: &mut PersistentState,
    failed_probes: &[ProbeResult],
    critical_since: u64,
    dry_run: bool,
) -> Result<TierOutcome, DynError> {
    if dry_run {
        return Ok(TierOutcome::Cooldown);
    }

    let now = now_unix_secs();
    if now.saturating_sub(critical_since) < config.escalation.critical_threshold_secs {
        return Ok(TierOutcome::Cooldown);
    }

    if let Some(last_sos_time) = state.last_sos_time {
        if now.saturating_sub(last_sos_time) < config.escalation.sos_cooldown_secs {
            log::warn("SOS escalation skipped due to cooldown");
            return Ok(TierOutcome::Cooldown);
        }
    }

    let failed_list = failed_probe_names(failed_probes);
    let message = format!(
        "🚨 TALON SOS: k8s cluster down, all recovery failed. Failed probes: {failed_list}. SSH to panda and investigate."
    );

    log::error("sending SOS escalation via telegram + imsg/osascript");

    let telegram_success = send_telegram_sos(config, &message);

    let (imsg_success, imsg_output) = run_process(
        "imsg",
        &[
            "send",
            "--to",
            &config.escalation.sos_recipient,
            "--text",
            &message,
        ],
        &[],
        Duration::from_secs(20),
        None,
    )
    .unwrap_or((false, "imsg unavailable".to_string()));

    let mut delivered = telegram_success || imsg_success;

    if !imsg_success {
        let script = format!(
            "tell application \"Messages\" to send \"{}\" to buddy \"{}\"",
            escape_applescript(&message),
            escape_applescript(&config.escalation.sos_recipient)
        );

        let (osa_success, osa_output) = run_process(
            "osascript",
            &["-e", &script],
            &[],
            Duration::from_secs(20),
            None,
        )
        .unwrap_or((false, "osascript unavailable".to_string()));

        if osa_success {
            delivered = true;
        } else {
            log::warn_fields(
                "iMessage SOS delivery failed",
                &[
                    ("imsg", truncate(&imsg_output, 1000)),
                    ("osascript", truncate(&osa_output, 1000)),
                ],
            );
        }
    }

    if delivered {
        state.last_sos_time = Some(now);
        Ok(TierOutcome::Fixed)
    } else {
        log::error("SOS escalation failed across all channels");
        Ok(TierOutcome::Failed)
    }
}

fn send_telegram_sos(config: &Config, message: &str) -> bool {
    let chat_id = config.escalation.sos_telegram_chat_id.trim();
    if chat_id.is_empty() {
        log::warn("telegram SOS skipped: sos_telegram_chat_id is empty");
        return false;
    }

    let secret_name = config.escalation.sos_telegram_secret_name.trim();
    if secret_name.is_empty() {
        log::warn("telegram SOS skipped: sos_telegram_secret_name is empty");
        return false;
    }

    let (lease_success, lease_output) = run_process(
        "secrets",
        &["lease", secret_name, "--ttl", "30m", "--raw"],
        &[],
        Duration::from_secs(10),
        None,
    )
    .unwrap_or((false, "secrets CLI unavailable".to_string()));

    if !lease_success {
        log::warn_fields(
            "telegram SOS skipped: failed to lease bot token",
            &[("error", truncate(&lease_output, 300))],
        );
        return false;
    }

    let token = lease_output.trim();
    if token.is_empty() {
        log::warn("telegram SOS skipped: leased token was empty");
        return false;
    }

    let url = format!("https://api.telegram.org/bot{token}/sendMessage");
    let body = format!(
        "{{\"chat_id\":\"{}\",\"text\":\"{}\",\"disable_notification\":false}}",
        json_escape(chat_id),
        json_escape(message)
    );

    let (success, output) = run_process(
        "curl",
        &[
            "-sS",
            "-X",
            "POST",
            &url,
            "-H",
            "Content-Type: application/json",
            "--data-binary",
            "@-",
        ],
        &[],
        Duration::from_secs(15),
        Some(&body),
    )
    .unwrap_or((false, "curl unavailable".to_string()));

    if success && output.contains("\"ok\":true") {
        log::info("telegram SOS delivered");
        true
    } else {
        log::warn_fields(
            "telegram SOS delivery failed",
            &[("error", truncate(&output, 500))],
        );
        false
    }
}

fn build_diagnostic_prompt(
    config: &Config,
    failed_probes: &[ProbeResult],
    heal_output: &str,
) -> String {
    let mut prompt = String::new();

    prompt.push_str("You are Talon's infrastructure recovery agent.\n");
    prompt.push_str("Environment: macOS host supervising Talos/k8s via Colima.\n");
    prompt.push_str("Goal: restore cluster and worker health with safe shell commands.\n\n");

    prompt.push_str("Failed probes:\n");
    for probe in failed_probes {
        prompt.push_str("- ");
        prompt.push_str(&probe.name);
        prompt.push_str(" (duration_ms=");
        prompt.push_str(&probe.duration_ms.to_string());
        prompt.push_str("): ");
        prompt.push_str(&truncate(&probe.output, 800));
        prompt.push('\n');
    }

    prompt.push_str("\nHeal script output:\n");
    prompt.push_str(&truncate(heal_output, 4000));
    prompt.push_str("\n\nRecent talon log tail:\n");
    prompt.push_str(&truncate(&log::tail_talon_log(120), 4000));

    let worker_log_path = expand_home(&config.worker.log_stderr);
    prompt.push_str("\n\nRecent worker stderr tail:\n");
    prompt.push_str(&truncate(
        &log::tail_file(Path::new(&worker_log_path), 120),
        4000,
    ));

    prompt.push_str("\n\nConstraints:\n");
    prompt.push_str(
        "- Do NOT recreate the cluster (talosctl cluster destroy) without explicit approval.\n",
    );
    prompt.push_str("- Do NOT delete PVCs (data loss).\n");
    prompt.push_str("- Do NOT kill the Lima SSH mux socket.\n");
    prompt.push_str("- Prefer the least destructive fix that restores health first.\n");
    prompt.push_str(
        "- If a destructive action seems required, stop and report why before doing it.\n",
    );

    prompt.push_str(
        "\nTake action now. Execute concrete repair commands and explain what changed. Keep it brief.",
    );

    prompt
}

fn failed_probe_names(failed_probes: &[ProbeResult]) -> String {
    if failed_probes.is_empty() {
        return "none".to_string();
    }

    failed_probes
        .iter()
        .map(|probe| probe.name.clone())
        .collect::<Vec<_>>()
        .join(", ")
}

fn restart_targets_for_failed_services(
    config: &Config,
    failed_probes: &[ProbeResult],
) -> Vec<String> {
    let mut labels = BTreeSet::new();

    for probe in failed_probes {
        if let Some(service_name) = probe.name.strip_prefix("launchd:") {
            if let Some(monitor) = config
                .launchd_service_probes
                .iter()
                .find(|monitor| monitor.name == service_name)
            {
                labels.insert(monitor.label.clone());
            }
            continue;
        }

        if let Some(service_name) = probe.name.strip_prefix("http:") {
            if matches!(service_name, "inngest" | "typesense" | "worker") {
                continue;
            }

            if let Some(monitor) = config
                .launchd_service_probes
                .iter()
                .find(|monitor| monitor.name == service_name)
            {
                labels.insert(monitor.label.clone());
            }
        }
    }

    labels.into_iter().collect()
}

fn service_name_for_label<'a>(config: &'a Config, label: &str) -> Option<&'a str> {
    config
        .launchd_service_probes
        .iter()
        .find(|monitor| monitor.label == label)
        .map(|monitor| monitor.name.as_str())
}

fn should_run_pre_restart_cleanup(service_name: &str, failed_probes: &[ProbeResult]) -> bool {
    if service_name != "voice_agent" {
        return false;
    }

    let launchd_probe = format!("launchd:{service_name}");
    let http_probe = format!("http:{service_name}");

    failed_probes
        .iter()
        .any(|probe| probe.name == launchd_probe || probe.name == http_probe)
}

fn run_service_pre_restart_cleanup(
    config: &Config,
    service_name: &str,
) -> Result<String, DynError> {
    match service_name {
        "voice_agent" => run_voice_agent_pre_restart_cleanup(config),
        _ => Ok("no pre-restart cleanup rule".to_string()),
    }
}

fn run_voice_agent_pre_restart_cleanup(config: &Config) -> Result<String, DynError> {
    let port = service_http_port(config, "voice_agent").unwrap_or(8081);
    let listening_pids = listening_pids_on_port(port)?;

    if listening_pids.is_empty() {
        return Ok(format!("no listener on :{port}"));
    }

    let mut unknown_listeners = Vec::new();
    for pid in &listening_pids {
        let command = command_for_pid(*pid)?.unwrap_or_else(|| "<unknown>".to_string());
        if !looks_like_voice_agent_command(&command) {
            unknown_listeners.push(format!("{pid}:{command}"));
        }
    }

    if !unknown_listeners.is_empty() {
        let detail = truncate(&unknown_listeners.join(" | "), 500);
        log::warn_fields(
            "skipping voice-agent pre-restart cleanup due to non-voice listener",
            &[("detail", detail.clone())],
        );
        return Ok(format!(
            "skipped cleanup on :{port}; non-voice listeners detected ({detail})"
        ));
    }

    let cleanup_command = r#"pkill -f "infra/voice-agent/.venv/bin/python3 main.py start" >/dev/null 2>&1 || true; pkill -f "uv run python main.py start" >/dev/null 2>&1 || true; sleep 1"#;

    let (success, output) = run_process(
        "/bin/bash",
        &["-lc", cleanup_command],
        &[],
        Duration::from_secs(10),
        None,
    )?;

    let remaining = listening_pids_on_port(port)?;

    if remaining.is_empty() {
        let detail = format!(
            "cleared listeners {:?} on :{port}",
            listening_pids
                .iter()
                .map(|pid| pid.to_string())
                .collect::<Vec<_>>()
        );
        log::info_fields(
            "voice-agent pre-restart cleanup complete",
            &[("detail", detail.clone())],
        );
        return Ok(detail);
    }

    let detail = format!(
        "cleanup attempted on :{port} (ok={success}); remaining listeners={:?}; output={}",
        remaining,
        truncate(&output, 300)
    );

    log::warn_fields(
        "voice-agent pre-restart cleanup left listeners",
        &[("detail", detail.clone())],
    );

    Ok(detail)
}

fn service_http_port(config: &Config, service_name: &str) -> Option<u16> {
    config
        .http_service_probes
        .iter()
        .find(|probe| probe.name == service_name)
        .and_then(|probe| parse_http_port(&probe.url))
}

fn parse_http_port(url: &str) -> Option<u16> {
    let trimmed = url.trim();
    let (scheme, rest) = if let Some(rest) = trimmed.strip_prefix("http://") {
        ("http", rest)
    } else if let Some(rest) = trimmed.strip_prefix("https://") {
        ("https", rest)
    } else {
        return None;
    };

    let authority = rest.split('/').next()?.trim();
    if authority.is_empty() {
        return None;
    }

    if authority.starts_with('[') {
        let end = authority.find(']')?;
        let after = &authority[end + 1..];
        if let Some(port) = after.strip_prefix(':') {
            return port.parse::<u16>().ok();
        }

        return Some(if scheme == "https" { 443 } else { 80 });
    }

    if let Some((_, port)) = authority.rsplit_once(':') {
        if port.chars().all(|ch| ch.is_ascii_digit()) {
            return port.parse::<u16>().ok();
        }
    }

    Some(if scheme == "https" { 443 } else { 80 })
}

fn listening_pids_on_port(port: u16) -> Result<Vec<u32>, DynError> {
    let port_arg = format!("-iTCP:{port}");
    let (success, output) = run_process(
        "/usr/sbin/lsof",
        &["-nP", "-t", &port_arg, "-sTCP:LISTEN"],
        &[],
        Duration::from_secs(4),
        None,
    )?;

    if !success && output.starts_with("spawn failed") {
        return Ok(Vec::new());
    }

    let mut pids = output
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect::<Vec<_>>();

    pids.sort_unstable();
    pids.dedup();

    Ok(pids)
}

fn command_for_pid(pid: u32) -> Result<Option<String>, DynError> {
    let pid_arg = pid.to_string();
    let (success, output) = run_process(
        "ps",
        &["-p", &pid_arg, "-o", "command="],
        &[],
        Duration::from_secs(2),
        None,
    )?;

    if !success {
        return Ok(None);
    }

    let command = output.lines().next().unwrap_or("").trim();
    if command.is_empty() || command == "ok" {
        return Ok(None);
    }

    Ok(Some(command.to_string()))
}

fn looks_like_voice_agent_command(command: &str) -> bool {
    let lowered = command.to_ascii_lowercase();
    lowered.contains("infra/voice-agent") || lowered.contains("main.py start")
}

fn current_uid() -> Option<String> {
    if let Ok(uid) = std::env::var("UID") {
        let trimmed = uid.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    let (success, output) = run_process("id", &["-u"], &[], Duration::from_secs(2), None).ok()?;
    if !success {
        return None;
    }

    let trimmed = output.lines().next().unwrap_or("").trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn run_shell_with_stdin(
    command_line: &str,
    input: &str,
    timeout: Duration,
) -> Result<(bool, String), DynError> {
    run_process(
        "/bin/zsh",
        &["-lc", command_line],
        &[],
        timeout,
        Some(input),
    )
}

fn run_process(
    program: &str,
    args: &[&str],
    env: &[(&str, &str)],
    timeout: Duration,
    stdin_input: Option<&str>,
) -> Result<(bool, String), DynError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .env("PATH", DEFAULT_PATH)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if stdin_input.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }

    for (key, value) in env {
        command.env(key, value);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Ok((false, format!("spawn failed: {error}"))),
    };

    if let Some(input) = stdin_input {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(input.as_bytes());
            let _ = stdin.flush();
        }
    }

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
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Ok((false, format!("wait failed: {error}"))),
        }
    };

    let output = collect_child_output(&mut child);

    match status {
        Some(status) => Ok((status.success(), output)),
        None => Ok((false, format!("timeout after {}s", timeout.as_secs()))),
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

fn escape_applescript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());

    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }

    out
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    value.chars().take(max_chars).collect::<String>() + "..."
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{HttpServiceProbe, LaunchdServiceProbe};

    #[test]
    fn restart_targets_include_matching_launchd_labels_once() {
        let mut config = Config::default();
        config.http_service_probes.push(HttpServiceProbe {
            name: "voice_agent".to_string(),
            url: "http://127.0.0.1:8081/".to_string(),
            timeout_secs: 5,
            critical: true,
        });
        config.launchd_service_probes.push(LaunchdServiceProbe {
            name: "voice_agent".to_string(),
            label: "com.joel.voice-agent".to_string(),
            timeout_secs: 5,
            critical: true,
        });

        let failed = vec![
            ProbeResult {
                name: "http:voice_agent".to_string(),
                passed: false,
                output: "500".to_string(),
                duration_ms: 11,
            },
            ProbeResult {
                name: "launchd:voice_agent".to_string(),
                passed: false,
                output: "PID=0".to_string(),
                duration_ms: 12,
            },
        ];

        let targets = restart_targets_for_failed_services(&config, &failed);
        assert_eq!(targets, vec!["com.joel.voice-agent".to_string()]);
    }

    #[test]
    fn restart_targets_skip_builtin_http_probes() {
        let config = Config::default();
        let failed = vec![ProbeResult {
            name: "http:worker".to_string(),
            passed: false,
            output: "503".to_string(),
            duration_ms: 8,
        }];

        let targets = restart_targets_for_failed_services(&config, &failed);
        assert!(targets.is_empty());
    }

    #[test]
    fn pre_restart_cleanup_only_targets_voice_agent_failures() {
        let failed = vec![ProbeResult {
            name: "http:voice_agent".to_string(),
            passed: false,
            output: "503".to_string(),
            duration_ms: 10,
        }];

        assert!(should_run_pre_restart_cleanup("voice_agent", &failed));
        assert!(!should_run_pre_restart_cleanup("gateway", &failed));
    }

    #[test]
    fn parse_http_port_supports_explicit_and_default_ports() {
        assert_eq!(parse_http_port("http://127.0.0.1:8081/"), Some(8081));
        assert_eq!(parse_http_port("http://localhost/health"), Some(80));
        assert_eq!(parse_http_port("https://example.com/status"), Some(443));
        assert_eq!(parse_http_port("https://[::1]:8443/health"), Some(8443));
    }

    #[test]
    fn voice_agent_command_matcher_is_narrow() {
        assert!(looks_like_voice_agent_command(
            "/Users/joel/Code/joelhooks/joelclaw/infra/voice-agent/.venv/bin/python3 main.py start"
        ));
        assert!(looks_like_voice_agent_command(
            "uv run python main.py start"
        ));
        assert!(!looks_like_voice_agent_command(
            "/usr/bin/python3 other-service.py"
        ));
    }
}

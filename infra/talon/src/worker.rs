use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::{expand_home, expand_tilde, Config, DEFAULT_PATH};
use crate::log;
use crate::{DynError, RECEIVED_SIGNAL, SHUTDOWN_REQUESTED};

type CInt = i32;

const SIGTERM: CInt = 15;
const SIGKILL: CInt = 9;

pub const SECRET_MAPPINGS: [(&str, &str); 6] = [
    ("claude_oauth_token", "CLAUDE_CODE_OAUTH_TOKEN"),
    ("todoist_client_secret", "TODOIST_CLIENT_SECRET"),
    ("todoist_api_token", "TODOIST_API_TOKEN"),
    ("front_rules_webhook_secret", "FRONT_WEBHOOK_SECRET"),
    ("front_api_token", "FRONT_API_TOKEN"),
    ("vercel_webhook_secret", "VERCEL_WEBHOOK_SECRET"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionOutcome {
    Restart,
    Shutdown,
}

static WORKER_RESTARTS: AtomicU32 = AtomicU32::new(0);

unsafe extern "C" {
    fn kill(pid: CInt, sig: CInt) -> CInt;
}

pub fn run_worker_supervisor(config: &Config) -> Result<(), DynError> {
    let mut backoff_secs = 1_u64;

    loop {
        if SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
            return Ok(());
        }

        kill_processes_on_port(config.worker.port)?;
        let env_overrides = load_child_env(config)?;
        let mut child = spawn_worker(config, &env_overrides)?;

        let outcome = monitor_child(config, &mut child, &mut backoff_secs)?;
        if outcome == SessionOutcome::Shutdown {
            return Ok(());
        }

        WORKER_RESTARTS.fetch_add(1, Ordering::SeqCst);
        log::warn_fields(
            "worker exited; scheduling restart",
            &[("backoff_secs", backoff_secs.to_string())],
        );

        if sleep_with_shutdown(backoff_secs) {
            return Ok(());
        }

        backoff_secs = (backoff_secs.saturating_mul(2)).min(config.worker.restart_backoff_max_secs);
    }
}

pub fn worker_restart_count() -> u32 {
    WORKER_RESTARTS.load(Ordering::SeqCst)
}

fn monitor_child(
    config: &Config,
    child: &mut Child,
    backoff_secs: &mut u64,
) -> Result<SessionOutcome, DynError> {
    let start = Instant::now();
    let mut synced = false;
    let mut last_health_check = Instant::now();
    let mut consecutive_health_failures = 0_u32;

    loop {
        if SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
            let signal = RECEIVED_SIGNAL.load(Ordering::SeqCst);
            let forwarded_signal = if signal == 0 { SIGTERM } else { signal };
            log::info_fields(
                "forwarding shutdown signal to worker",
                &[("signal", forwarded_signal.to_string())],
            );
            shutdown_child(child, forwarded_signal, config.worker.drain_timeout_secs)?;
            return Ok(SessionOutcome::Shutdown);
        }

        if let Some(exit_status) = child.try_wait()? {
            log_exit_status(exit_status);
            return Ok(SessionOutcome::Restart);
        }

        if !synced && start.elapsed() >= Duration::from_secs(config.worker.startup_sync_delay_secs) {
            if http_request_ok(
                "PUT",
                config.worker.port,
                &config.worker.sync_endpoint,
                Duration::from_secs(config.worker.http_timeout_secs),
            ) {
                log::info("worker sync endpoint succeeded");
            } else {
                log::warn("worker sync endpoint failed");
            }
            synced = true;
            last_health_check = Instant::now();
        }

        if synced
            && last_health_check.elapsed() >= Duration::from_secs(config.worker.health_interval_secs)
        {
            if http_request_ok(
                "GET",
                config.worker.port,
                &config.worker.health_endpoint,
                Duration::from_secs(config.worker.http_timeout_secs),
            ) {
                consecutive_health_failures = 0;
                *backoff_secs = 1;
                log::info("worker health check passed");
            } else {
                consecutive_health_failures += 1;
                log::warn_fields(
                    "worker health check failed",
                    &[
                        ("consecutive", consecutive_health_failures.to_string()),
                        (
                            "threshold",
                            config.worker.health_failures_before_restart.to_string(),
                        ),
                    ],
                );
            }

            if consecutive_health_failures >= config.worker.health_failures_before_restart {
                log::warn("restarting worker after consecutive health check failures");
                shutdown_child(child, SIGTERM, config.worker.drain_timeout_secs)?;
                return Ok(SessionOutcome::Restart);
            }

            last_health_check = Instant::now();
        }

        thread::sleep(Duration::from_millis(250));
    }
}

fn spawn_worker(
    config: &Config,
    env_overrides: &HashMap<String, String>,
) -> Result<Child, DynError> {
    let stdout_path = expand_home(&config.worker.log_stdout);
    let stderr_path = expand_home(&config.worker.log_stderr);
    ensure_parent_dir(&stdout_path)?;
    ensure_parent_dir(&stderr_path)?;

    let stdout_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(stdout_path)?;
    let stderr_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(stderr_path)?;

    let worker_dir = expand_home(&config.worker.dir);
    let (program, args) = config.worker.command.split_first().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "worker.command must not be empty")
    })?;

    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(worker_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .envs(env_overrides);

    let child = command.spawn()?;
    log::info_fields("worker started", &[("pid", child.id().to_string())]);
    Ok(child)
}

fn ensure_parent_dir(path: &Path) -> Result<(), DynError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn load_child_env(config: &Config) -> Result<HashMap<String, String>, DynError> {
    let mut env_overrides = HashMap::new();
    env_overrides.insert("PATH".to_string(), DEFAULT_PATH.to_string());
    env_overrides.insert("WORKER_ROLE".to_string(), "host".to_string());

    let env_file = expand_home(&config.worker.env_file);
    let file_env = parse_env_file(&env_file)?;
    env_overrides.extend(file_env);

    for (secret_name, env_var) in SECRET_MAPPINGS {
        match lease_secret(secret_name)? {
            Some(value) => {
                env_overrides.insert(env_var.to_string(), value);
            }
            None => {
                log::warn_fields(
                    "failed to lease secret",
                    &[("secret", secret_name.to_string())],
                );
            }
        }
    }

    Ok(env_overrides)
}

fn parse_env_file(path: &Path) -> Result<HashMap<String, String>, DynError> {
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);
    let mut vars = HashMap::new();

    for line_result in reader.lines() {
        let line = line_result?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let normalized = trimmed.strip_prefix("export ").unwrap_or(trimmed);
        let Some((key, value)) = normalized.split_once('=') else {
            continue;
        };

        let value = strip_wrapping_quotes(value.trim()).to_string();
        vars.insert(key.trim().to_string(), value);
    }

    Ok(vars)
}

fn strip_wrapping_quotes(value: &str) -> &str {
    if value.len() >= 2 {
        if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            return &value[1..value.len() - 1];
        }
    }
    value
}

fn lease_secret(secret_name: &str) -> Result<Option<String>, DynError> {
    let mut command = Command::new("secrets");
    command
        .arg("lease")
        .arg(secret_name)
        .arg("--ttl")
        .arg("24h")
        .env("PATH", DEFAULT_PATH)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            log::warn_fields(
                "failed to run secrets CLI",
                &[("error", error.to_string())],
            );
            return Ok(None);
        }
    };

    let status = child.wait()?;
    if !status.success() {
        return Ok(None);
    }

    let mut stdout = String::new();
    if let Some(mut handle) = child.stdout.take() {
        let mut bytes = Vec::new();
        let _ = handle.read_to_end(&mut bytes);
        stdout = String::from_utf8_lossy(&bytes).trim().to_string();
    }

    if stdout.is_empty() {
        return Ok(None);
    }

    Ok(Some(stdout))
}

fn kill_processes_on_port(port: u16) -> Result<(), DynError> {
    let output = Command::new("/usr/sbin/lsof")
        .arg("-ti")
        .arg(format!(":{port}"))
        .output()?;

    if output.stdout.is_empty() {
        return Ok(());
    }

    let pids = String::from_utf8_lossy(&output.stdout);
    for pid_line in pids.lines() {
        let pid = match pid_line.trim().parse::<CInt>() {
            Ok(pid) => pid,
            Err(_) => continue,
        };

        if pid == std::process::id() as CInt {
            continue;
        }

        log::warn_fields(
            "killing stale process on worker port",
            &[("pid", pid.to_string()), ("port", port.to_string())],
        );
        unsafe {
            let _ = kill(pid, SIGKILL);
        }
    }

    thread::sleep(Duration::from_secs(1));
    Ok(())
}

fn shutdown_child(child: &mut Child, signal: CInt, timeout_secs: u64) -> Result<(), DynError> {
    let pid = child.id() as CInt;
    unsafe {
        let _ = kill(pid, signal);
    }

    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        if child.try_wait()?.is_some() {
            return Ok(());
        }

        if Instant::now() >= deadline {
            break;
        }

        thread::sleep(Duration::from_millis(200));
    }

    unsafe {
        let _ = kill(pid, SIGKILL);
    }
    let _ = child.wait();
    Ok(())
}

fn log_exit_status(status: ExitStatus) {
    match status.code() {
        Some(code) => log::warn_fields("worker exited", &[("code", code.to_string())]),
        None => log::warn("worker exited due to signal"),
    }
}

fn http_request_ok(method: &str, port: u16, endpoint: &str, timeout: Duration) -> bool {
    let endpoint = normalize_endpoint(endpoint);
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);

    let mut stream = match TcpStream::connect_timeout(&addr.into(), timeout) {
        Ok(stream) => stream,
        Err(_) => return false,
    };

    if stream.set_read_timeout(Some(timeout)).is_err() {
        return false;
    }
    if stream.set_write_timeout(Some(timeout)).is_err() {
        return false;
    }

    let request = format!(
        "{method} {endpoint} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );

    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    if reader.read_line(&mut status_line).is_err() {
        return false;
    }

    let mut parts = status_line.split_whitespace();
    let _ = parts.next();
    let Some(status_code) = parts.next() else {
        return false;
    };

    match status_code.parse::<u16>() {
        Ok(code) => (200..300).contains(&code),
        Err(_) => false,
    }
}

fn normalize_endpoint(endpoint: &str) -> String {
    if endpoint.starts_with('/') {
        endpoint.to_string()
    } else {
        format!("/{endpoint}")
    }
}

fn sleep_with_shutdown(seconds: u64) -> bool {
    let steps = seconds.saturating_mul(4);
    for _ in 0..steps {
        if SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

#[allow(dead_code)]
fn _expand_path_list(path_value: &str) -> String {
    path_value
        .split(':')
        .map(expand_tilde)
        .collect::<Vec<_>>()
        .join(":")
}

use std::collections::HashMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::thread;
use std::time::{Duration, Instant};

type DynError = Box<dyn std::error::Error + Send + Sync>;

type CInt = i32;

const SIGTERM: CInt = 15;
const SIGINT: CInt = 2;
const SIGHUP: CInt = 1;
const SIGKILL: CInt = 9;

const DEFAULT_CONFIG_PATH: &str = "~/.config/worker-supervisor.toml";
const DEFAULT_PATH: &str = "~/.bun/bin:~/.local/bin:~/.local/share/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const SECRET_MAPPINGS: [(&str, &str); 6] = [
    ("claude_oauth_token", "CLAUDE_CODE_OAUTH_TOKEN"),
    ("todoist_client_secret", "TODOIST_CLIENT_SECRET"),
    ("todoist_api_token", "TODOIST_API_TOKEN"),
    ("front_rules_webhook_secret", "FRONT_WEBHOOK_SECRET"),
    ("front_api_token", "FRONT_API_TOKEN"),
    ("vercel_webhook_secret", "VERCEL_WEBHOOK_SECRET"),
];

static RECEIVED_SIGNAL: AtomicI32 = AtomicI32::new(0);

unsafe extern "C" {
    fn signal(sig: CInt, handler: usize) -> usize;
    fn kill(pid: CInt, sig: CInt) -> CInt;
}

#[derive(Debug, Clone)]
struct Cli {
    config_path: PathBuf,
    dry_run: bool,
}

#[derive(Debug, Clone)]
struct Config {
    worker_dir: String,
    command: Vec<String>,
    port: u16,
    health_endpoint: String,
    sync_endpoint: String,
    log_stdout: String,
    log_stderr: String,
    env_file: String,
    drain_timeout_secs: u64,
    health_interval_secs: u64,
    health_failures_before_restart: u32,
    restart_backoff_max_secs: u64,
    startup_sync_delay_secs: u64,
    http_timeout_secs: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            worker_dir: "~/Code/joelhooks/joelclaw/packages/system-bus".to_string(),
            command: vec![
                "bun".to_string(),
                "run".to_string(),
                "src/serve.ts".to_string(),
            ],
            port: 3111,
            health_endpoint: "/api/inngest".to_string(),
            sync_endpoint: "/api/inngest".to_string(),
            log_stdout: "~/.local/log/system-bus-worker.log".to_string(),
            log_stderr: "~/.local/log/system-bus-worker.err".to_string(),
            env_file: "~/.config/system-bus.env".to_string(),
            drain_timeout_secs: 5,
            health_interval_secs: 30,
            health_failures_before_restart: 3,
            restart_backoff_max_secs: 30,
            startup_sync_delay_secs: 5,
            http_timeout_secs: 5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionOutcome {
    Restart,
    Shutdown,
}

extern "C" fn signal_handler(signal: CInt) {
    RECEIVED_SIGNAL.store(signal, Ordering::SeqCst);
}

fn main() -> Result<(), DynError> {
    let cli = parse_args()?;
    let config = load_config(&cli.config_path)?;
    install_signal_handlers();

    if cli.dry_run {
        eprintln!(
            "[worker-supervisor] dry run config path: {}",
            cli.config_path.display()
        );
        eprintln!("[worker-supervisor] effective config: {config:#?}");
        return Ok(());
    }

    run_supervisor(config)
}

fn parse_args() -> Result<Cli, DynError> {
    let mut args = env::args().skip(1);
    let mut config_path = expand_home(DEFAULT_CONFIG_PATH);
    let mut dry_run = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" => {
                let value = args.next().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "--config requires a path")
                })?;
                config_path = expand_home(&value);
            }
            "--dry-run" => {
                dry_run = true;
            }
            "--help" | "-h" => {
                println!("worker-supervisor [--config PATH] [--dry-run]");
                std::process::exit(0);
            }
            unknown => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("unknown argument: {unknown}"),
                )
                .into());
            }
        }
    }

    Ok(Cli {
        config_path,
        dry_run,
    })
}

fn load_config(path: &Path) -> Result<Config, DynError> {
    let mut config = Config::default();

    if !path.exists() {
        return Ok(config);
    }

    let raw = fs::read_to_string(path)?;
    apply_toml_overrides(&mut config, &raw)?;
    Ok(config)
}

fn apply_toml_overrides(config: &mut Config, raw: &str) -> Result<(), DynError> {
    for (line_number, original_line) in raw.lines().enumerate() {
        let line = strip_comment(original_line).trim();
        if line.is_empty() || line.starts_with('[') {
            continue;
        }

        let Some((key, value)) = line.split_once('=') else {
            continue;
        };

        let key = key.trim();
        let value = value.trim();

        match key {
            "worker_dir" => config.worker_dir = parse_toml_string(value)?,
            "command" => config.command = parse_toml_string_array(value)?,
            "port" => config.port = parse_toml_int(value, line_number + 1)? as u16,
            "health_endpoint" => config.health_endpoint = parse_toml_string(value)?,
            "sync_endpoint" => config.sync_endpoint = parse_toml_string(value)?,
            "log_stdout" => config.log_stdout = parse_toml_string(value)?,
            "log_stderr" => config.log_stderr = parse_toml_string(value)?,
            "env_file" => config.env_file = parse_toml_string(value)?,
            "drain_timeout_secs" => {
                config.drain_timeout_secs = parse_toml_int(value, line_number + 1)?
            }
            "health_interval_secs" => {
                config.health_interval_secs = parse_toml_int(value, line_number + 1)?
            }
            "health_failures_before_restart" => {
                config.health_failures_before_restart =
                    parse_toml_int(value, line_number + 1)? as u32
            }
            "restart_backoff_max_secs" => {
                config.restart_backoff_max_secs = parse_toml_int(value, line_number + 1)?
            }
            "startup_sync_delay_secs" => {
                config.startup_sync_delay_secs = parse_toml_int(value, line_number + 1)?
            }
            "http_timeout_secs" => {
                config.http_timeout_secs = parse_toml_int(value, line_number + 1)?
            }
            _ => {}
        }
    }

    if config.command.is_empty() {
        return Err(
            io::Error::new(io::ErrorKind::InvalidInput, "command must not be empty").into(),
        );
    }

    Ok(())
}

fn strip_comment(line: &str) -> &str {
    let mut in_quote = false;
    let mut quote_char = '\0';

    for (idx, ch) in line.char_indices() {
        if in_quote {
            if ch == quote_char {
                in_quote = false;
            }
            continue;
        }

        if ch == '\'' || ch == '"' {
            in_quote = true;
            quote_char = ch;
            continue;
        }

        if ch == '#' {
            return &line[..idx];
        }
    }

    line
}

fn parse_toml_string(value: &str) -> Result<String, DynError> {
    let value = value.trim();
    if value.len() >= 2 {
        if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            return Ok(unescape_string(&value[1..value.len() - 1]));
        }
    }

    Ok(value.to_string())
}

fn parse_toml_string_array(value: &str) -> Result<Vec<String>, DynError> {
    let value = value.trim();
    if !(value.starts_with('[') && value.ends_with(']')) {
        return Err(
            io::Error::new(io::ErrorKind::InvalidInput, "array must use [..] syntax").into(),
        );
    }

    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    let mut quote_char = '\0';
    let mut escaped = false;

    for ch in value[1..value.len() - 1].chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }

        if ch == '\\' && in_quote {
            escaped = true;
            current.push(ch);
            continue;
        }

        if in_quote {
            current.push(ch);
            if ch == quote_char {
                in_quote = false;
            }
            continue;
        }

        if ch == '\'' || ch == '"' {
            in_quote = true;
            quote_char = ch;
            current.push(ch);
            continue;
        }

        if ch == ',' {
            let item = current.trim();
            if !item.is_empty() {
                out.push(parse_toml_string(item)?);
            }
            current.clear();
            continue;
        }

        current.push(ch);
    }

    let trailing = current.trim();
    if !trailing.is_empty() {
        out.push(parse_toml_string(trailing)?);
    }

    Ok(out)
}

fn parse_toml_int(value: &str, line: usize) -> Result<u64, DynError> {
    value.trim().parse::<u64>().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid integer at line {line}: {value}"),
        )
        .into()
    })
}

fn unescape_string(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars();

    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }

        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }

    out
}

fn run_supervisor(config: Config) -> Result<(), DynError> {
    let mut backoff_secs = 1_u64;

    loop {
        kill_processes_on_port(config.port)?;
        let env_overrides = load_child_env(&config)?;
        let mut child = spawn_worker(&config, &env_overrides)?;

        let outcome = monitor_child(&config, &mut child, &mut backoff_secs)?;
        if outcome == SessionOutcome::Shutdown {
            return Ok(());
        }

        eprintln!(
            "[worker-supervisor] worker exited; restarting in {}s",
            backoff_secs
        );
        thread::sleep(Duration::from_secs(backoff_secs));
        backoff_secs = (backoff_secs.saturating_mul(2)).min(config.restart_backoff_max_secs);
    }
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
        if let Some(signal) = take_signal() {
            eprintln!("[worker-supervisor] forwarding signal {} to worker", signal);
            shutdown_child(child, signal, config.drain_timeout_secs)?;
            return Ok(SessionOutcome::Shutdown);
        }

        if let Some(exit_status) = child.try_wait()? {
            log_exit_status(exit_status);
            return Ok(SessionOutcome::Restart);
        }

        if !synced && start.elapsed() >= Duration::from_secs(config.startup_sync_delay_secs) {
            if http_request_ok(
                "PUT",
                config.port,
                &config.sync_endpoint,
                Duration::from_secs(config.http_timeout_secs),
            ) {
                eprintln!("[worker-supervisor] function registry sync succeeded");
            } else {
                eprintln!("[worker-supervisor] WARNING: function registry sync failed");
            }
            synced = true;
            last_health_check = Instant::now();
        }

        if synced && last_health_check.elapsed() >= Duration::from_secs(config.health_interval_secs)
        {
            if http_request_ok(
                "GET",
                config.port,
                &config.health_endpoint,
                Duration::from_secs(config.http_timeout_secs),
            ) {
                consecutive_health_failures = 0;
                *backoff_secs = 1;
                eprintln!("[worker-supervisor] health check OK");
            } else {
                consecutive_health_failures += 1;
                eprintln!(
                    "[worker-supervisor] health check failed ({}/{})",
                    consecutive_health_failures, config.health_failures_before_restart
                );
            }

            if consecutive_health_failures >= config.health_failures_before_restart {
                eprintln!("[worker-supervisor] restarting worker after health check failures");
                shutdown_child(child, SIGTERM, config.drain_timeout_secs)?;
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
    let stdout_path = expand_home(&config.log_stdout);
    let stderr_path = expand_home(&config.log_stderr);
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

    let worker_dir = expand_home(&config.worker_dir);
    let (program, args) = config
        .command
        .split_first()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "command must not be empty"))?;

    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(worker_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .envs(env_overrides);

    let child = command.spawn()?;
    eprintln!("[worker-supervisor] started worker pid={}", child.id());
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
    env_overrides.insert("PATH".to_string(), expand_path_list(DEFAULT_PATH));
    env_overrides.insert("WORKER_ROLE".to_string(), "host".to_string());

    let env_file = expand_home(&config.env_file);
    let file_env = parse_env_file(&env_file)?;
    env_overrides.extend(file_env);

    for (secret_name, env_var) in SECRET_MAPPINGS {
        match lease_secret(secret_name)? {
            Some(value) => {
                env_overrides.insert(env_var.to_string(), value);
            }
            None => {
                eprintln!(
                    "[worker-supervisor] WARNING: failed to lease secret {}",
                    secret_name
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
        .env("PATH", expand_path_list(DEFAULT_PATH));

    let output = match command.output() {
        Ok(output) => output,
        Err(error) => {
            eprintln!("[worker-supervisor] WARNING: failed to run secrets CLI: {error}");
            return Ok(None);
        }
    };

    if !output.status.success() {
        return Ok(None);
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }

    Ok(Some(value))
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

        eprintln!(
            "[worker-supervisor] killing stale pid={} on port {}",
            pid, port
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
        Some(code) => eprintln!("[worker-supervisor] worker exited with code {}", code),
        None => eprintln!("[worker-supervisor] worker exited due to signal"),
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

fn install_signal_handlers() {
    let handler = signal_handler as *const () as usize;
    unsafe {
        let _ = signal(SIGTERM, handler);
        let _ = signal(SIGINT, handler);
        let _ = signal(SIGHUP, handler);
    }
}

fn take_signal() -> Option<CInt> {
    let raw = RECEIVED_SIGNAL.swap(0, Ordering::SeqCst);
    if raw == 0 {
        None
    } else {
        Some(raw)
    }
}

fn expand_home(path: &str) -> PathBuf {
    PathBuf::from(expand_tilde(path))
}

fn expand_tilde(path: &str) -> String {
    if path == "~" {
        return env::var("HOME").unwrap_or_else(|_| "~".to_string());
    }

    if let Some(rest) = path.strip_prefix("~/") {
        let home = env::var("HOME").unwrap_or_else(|_| "~".to_string());
        return format!("{home}/{rest}");
    }

    path.to_string()
}

fn expand_path_list(path_value: &str) -> String {
    path_value
        .split(':')
        .map(expand_tilde)
        .collect::<Vec<_>>()
        .join(":")
}

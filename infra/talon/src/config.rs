use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::DynError;

pub const DEFAULT_CONFIG_PATH: &str = "~/.config/talon/config.toml";
pub const DEFAULT_SERVICES_PATH: &str = "~/.joelclaw/talon/services.toml";
pub const DEFAULT_PATH: &str = "/opt/homebrew/bin:/Users/joel/.bun/bin:/Users/joel/.local/bin:/Users/joel/.local/share/fnm/aliases/default/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
pub const STATE_DIR: &str = "~/.local/state/talon";

#[derive(Debug, Clone)]
pub struct Config {
    pub check_interval_secs: u64,
    pub heal_script: String,
    pub heal_timeout_secs: u64,
    pub services_file: String,
    pub worker: WorkerConfig,
    pub escalation: EscalationConfig,
    pub agent: AgentConfig,
    pub probes: ProbesConfig,
    pub health: HealthConfig,
    pub http_service_probes: Vec<HttpServiceProbe>,
    pub launchd_service_probes: Vec<LaunchdServiceProbe>,
}

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub dir: String,
    pub command: Vec<String>,
    pub external_launchd_label: String,
    pub port: u16,
    pub health_endpoint: String,
    pub sync_endpoint: String,
    pub log_stdout: String,
    pub log_stderr: String,
    pub env_file: String,
    pub drain_timeout_secs: u64,
    pub health_interval_secs: u64,
    pub health_failures_before_restart: u32,
    pub restart_backoff_max_secs: u64,
    pub startup_sync_delay_secs: u64,
    pub http_timeout_secs: u64,
}

#[derive(Debug, Clone)]
pub struct EscalationConfig {
    pub agent_cooldown_secs: u64,
    pub sos_cooldown_secs: u64,
    pub sos_recipient: String,
    pub sos_telegram_chat_id: String,
    pub sos_telegram_secret_name: String,
    pub critical_threshold_secs: u64,
}

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub cloud_command: String,
    pub local_command: String,
    pub timeout_secs: u64,
}

#[derive(Debug, Clone)]
pub struct ProbesConfig {
    pub colima_timeout_secs: u64,
    pub k8s_timeout_secs: u64,
    pub service_timeout_secs: u64,
    pub consecutive_failures_before_escalate: u32,
}

#[derive(Debug, Clone)]
pub struct HealthConfig {
    pub enabled: bool,
    pub bind: String,
}

#[derive(Debug, Clone)]
pub struct HttpServiceProbe {
    pub name: String,
    pub url: String,
    pub timeout_secs: u64,
    pub critical: bool,
}

#[derive(Debug, Clone)]
pub struct LaunchdServiceProbe {
    pub name: String,
    pub label: String,
    pub timeout_secs: u64,
    pub critical: bool,
}

#[derive(Debug, Clone)]
pub struct ServiceProbeTracker {
    pub services_path: PathBuf,
    pub last_modified: Option<SystemTime>,
}

#[derive(Debug, Clone)]
pub struct ValidationSummary {
    pub config_path: PathBuf,
    pub services_path: PathBuf,
    pub check_interval_secs: u64,
    pub http_probe_count: usize,
    pub launchd_probe_count: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            check_interval_secs: 60,
            heal_script: "/Users/joel/Code/joelhooks/joelclaw/infra/k8s-reboot-heal.sh".to_string(),
            heal_timeout_secs: 300,
            services_file: DEFAULT_SERVICES_PATH.to_string(),
            worker: WorkerConfig::default(),
            escalation: EscalationConfig::default(),
            agent: AgentConfig::default(),
            probes: ProbesConfig::default(),
            health: HealthConfig::default(),
            http_service_probes: builtin_http_service_probes(),
            launchd_service_probes: Vec::new(),
        }
    }
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            dir: "/Users/joel/Code/joelhooks/joelclaw/packages/system-bus".to_string(),
            command: vec![
                "bun".to_string(),
                "run".to_string(),
                "src/serve.ts".to_string(),
            ],
            external_launchd_label: "com.joel.system-bus-worker".to_string(),
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

impl Default for EscalationConfig {
    fn default() -> Self {
        Self {
            agent_cooldown_secs: 600,
            sos_cooldown_secs: 1800,
            sos_recipient: "joelhooks@gmail.com".to_string(),
            sos_telegram_chat_id: "7718912466".to_string(),
            sos_telegram_secret_name: "telegram_bot_token".to_string(),
            critical_threshold_secs: 900,
        }
    }
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            cloud_command: "pi -p --no-session --no-extensions --model anthropic/claude-sonnet-4"
                .to_string(),
            local_command: "pi -p --no-session --no-extensions --model ollama/qwen3:8b".to_string(),
            timeout_secs: 120,
        }
    }
}

impl Default for ProbesConfig {
    fn default() -> Self {
        Self {
            colima_timeout_secs: 5,
            k8s_timeout_secs: 10,
            service_timeout_secs: 5,
            consecutive_failures_before_escalate: 3,
        }
    }
}

impl Default for HealthConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            bind: "127.0.0.1:9999".to_string(),
        }
    }
}

impl Config {
    pub fn is_critical_probe(&self, name: &str) -> bool {
        if matches!(
            name,
            "colima"
                | "docker"
                | "talos_container"
                | "k8s_api"
                | "node_ready"
                | "node_schedulable"
                | "redis"
                | "kubelet_proxy_rbac"
        ) {
            return true;
        }

        if let Some(service_name) = name.strip_prefix("http:") {
            return self
                .http_service_probes
                .iter()
                .find(|probe| probe.name == service_name)
                .map(|probe| probe.critical)
                .unwrap_or(false);
        }

        if let Some(service_name) = name.strip_prefix("launchd:") {
            return self
                .launchd_service_probes
                .iter()
                .find(|probe| probe.name == service_name)
                .map(|probe| probe.critical)
                .unwrap_or(false);
        }

        false
    }

    pub fn services_path(&self) -> PathBuf {
        expand_home(&self.services_file)
    }

    pub fn service_probe_tracker(&self) -> Result<ServiceProbeTracker, DynError> {
        let services_path = self.services_path();
        ensure_services_file(&services_path)?;

        Ok(ServiceProbeTracker {
            services_path: services_path.clone(),
            last_modified: file_modified(&services_path)?,
        })
    }

    pub fn refresh_service_probes(
        &mut self,
        tracker: &mut ServiceProbeTracker,
        force: bool,
    ) -> Result<bool, DynError> {
        let expected_path = self.services_path();
        if tracker.services_path != expected_path {
            tracker.services_path = expected_path;
            tracker.last_modified = None;
        }

        ensure_services_file(&tracker.services_path)?;
        let current_modified = file_modified(&tracker.services_path)?;
        let changed = force || current_modified != tracker.last_modified;

        if !changed {
            return Ok(false);
        }

        reload_service_probes(self)?;
        tracker.last_modified = current_modified;
        Ok(true)
    }
}

pub fn ensure_default_config(path: &Path) -> Result<(), DynError> {
    if path.exists() {
        return Ok(());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::write(path, default_config_toml())?;
    Ok(())
}

pub fn load_config(path: &Path) -> Result<Config, DynError> {
    let mut config = Config::default();

    if path.exists() {
        let raw = fs::read_to_string(path)?;
        apply_toml_overrides(&mut config, &raw)?;
    }

    if config.worker.command.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "worker.command must not be empty",
        )
        .into());
    }

    reload_service_probes(&mut config)?;

    Ok(config)
}

pub fn validate_config_files(path: &Path) -> Result<ValidationSummary, DynError> {
    ensure_default_config(path)?;
    let config = load_config(path)?;

    Ok(ValidationSummary {
        config_path: path.to_path_buf(),
        services_path: config.services_path(),
        check_interval_secs: config.check_interval_secs,
        http_probe_count: config.http_service_probes.len(),
        launchd_probe_count: config.launchd_service_probes.len(),
    })
}

pub fn validation_summary_to_json(summary: &ValidationSummary) -> String {
    format!(
        "{{\n  \"ok\": true,\n  \"config_path\": \"{}\",\n  \"services_path\": \"{}\",\n  \"check_interval_secs\": {},\n  \"http_probe_count\": {},\n  \"launchd_probe_count\": {}\n}}\n",
        json_escape(&summary.config_path.display().to_string()),
        json_escape(&summary.services_path.display().to_string()),
        summary.check_interval_secs,
        summary.http_probe_count,
        summary.launchd_probe_count
    )
}

pub fn default_config_toml() -> String {
    let content = r#"check_interval_secs = 60
heal_script = "/Users/joel/Code/joelhooks/joelclaw/infra/k8s-reboot-heal.sh"
heal_timeout_secs = 300
services_file = "~/.joelclaw/talon/services.toml"

[worker]
dir = "/Users/joel/Code/joelhooks/joelclaw/packages/system-bus"
command = ["bun", "run", "src/serve.ts"]
external_launchd_label = "com.joel.system-bus-worker"
port = 3111
health_endpoint = "/api/inngest"
sync_endpoint = "/api/inngest"
log_stdout = "~/.local/log/system-bus-worker.log"
log_stderr = "~/.local/log/system-bus-worker.err"
env_file = "~/.config/system-bus.env"
drain_timeout_secs = 5
health_interval_secs = 30
health_failures_before_restart = 3
restart_backoff_max_secs = 30
startup_sync_delay_secs = 5
http_timeout_secs = 5

[escalation]
agent_cooldown_secs = 600
sos_cooldown_secs = 1800
sos_recipient = "joelhooks@gmail.com"
sos_telegram_chat_id = "7718912466"
sos_telegram_secret_name = "telegram_bot_token"
critical_threshold_secs = 900

[agent]
cloud_command = "pi -p --no-session --no-extensions --model anthropic/claude-sonnet-4"
local_command = "pi -p --no-session --no-extensions --model ollama/qwen3:8b"
timeout_secs = 120

[probes]
colima_timeout_secs = 5
k8s_timeout_secs = 10
service_timeout_secs = 5
consecutive_failures_before_escalate = 3

[health]
enabled = true
bind = "127.0.0.1:9999"
"#;
    content.to_string()
}

fn apply_toml_overrides(config: &mut Config, raw: &str) -> Result<(), DynError> {
    let mut section = String::new();

    for (line_number, original_line) in raw.lines().enumerate() {
        let line = strip_comment(original_line).trim();
        if line.is_empty() {
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].trim().to_string();
            continue;
        }

        let Some((key, value)) = line.split_once('=') else {
            continue;
        };

        let key = key.trim();
        let value = value.trim();

        match (section.as_str(), key) {
            ("", "check_interval_secs") => {
                config.check_interval_secs = parse_toml_int(value, line_number + 1)?
            }
            ("", "heal_script") => config.heal_script = parse_toml_string(value)?,
            ("", "heal_timeout_secs") => {
                config.heal_timeout_secs = parse_toml_int(value, line_number + 1)?
            }
            ("", "services_file") => config.services_file = parse_toml_string(value)?,

            ("worker", "dir") => config.worker.dir = parse_toml_string(value)?,
            ("worker", "command") => config.worker.command = parse_toml_string_array(value)?,
            ("worker", "external_launchd_label") => {
                config.worker.external_launchd_label = parse_toml_string(value)?
            }
            ("worker", "port") => {
                config.worker.port = parse_toml_int(value, line_number + 1)? as u16
            }
            ("worker", "health_endpoint") => {
                config.worker.health_endpoint = parse_toml_string(value)?
            }
            ("worker", "sync_endpoint") => config.worker.sync_endpoint = parse_toml_string(value)?,
            ("worker", "log_stdout") => config.worker.log_stdout = parse_toml_string(value)?,
            ("worker", "log_stderr") => config.worker.log_stderr = parse_toml_string(value)?,
            ("worker", "env_file") => config.worker.env_file = parse_toml_string(value)?,
            ("worker", "drain_timeout_secs") => {
                config.worker.drain_timeout_secs = parse_toml_int(value, line_number + 1)?
            }
            ("worker", "health_interval_secs") => {
                config.worker.health_interval_secs = parse_toml_int(value, line_number + 1)?
            }
            ("worker", "health_failures_before_restart") => {
                config.worker.health_failures_before_restart =
                    parse_toml_int(value, line_number + 1)? as u32
            }
            ("worker", "restart_backoff_max_secs") => {
                config.worker.restart_backoff_max_secs = parse_toml_int(value, line_number + 1)?
            }
            ("worker", "startup_sync_delay_secs") => {
                config.worker.startup_sync_delay_secs = parse_toml_int(value, line_number + 1)?
            }
            ("worker", "http_timeout_secs") => {
                config.worker.http_timeout_secs = parse_toml_int(value, line_number + 1)?
            }

            ("escalation", "agent_cooldown_secs") => {
                config.escalation.agent_cooldown_secs = parse_toml_int(value, line_number + 1)?
            }
            ("escalation", "sos_cooldown_secs") => {
                config.escalation.sos_cooldown_secs = parse_toml_int(value, line_number + 1)?
            }
            ("escalation", "sos_recipient") => {
                config.escalation.sos_recipient = parse_toml_string(value)?
            }
            ("escalation", "sos_telegram_chat_id") => {
                config.escalation.sos_telegram_chat_id = parse_toml_string(value)?
            }
            ("escalation", "sos_telegram_secret_name") => {
                config.escalation.sos_telegram_secret_name = parse_toml_string(value)?
            }
            ("escalation", "critical_threshold_secs") => {
                config.escalation.critical_threshold_secs = parse_toml_int(value, line_number + 1)?
            }

            ("agent", "cloud_command") => config.agent.cloud_command = parse_toml_string(value)?,
            ("agent", "local_command") => config.agent.local_command = parse_toml_string(value)?,
            ("agent", "timeout_secs") => {
                config.agent.timeout_secs = parse_toml_int(value, line_number + 1)?
            }

            ("probes", "colima_timeout_secs") => {
                config.probes.colima_timeout_secs = parse_toml_int(value, line_number + 1)?
            }
            ("probes", "k8s_timeout_secs") => {
                config.probes.k8s_timeout_secs = parse_toml_int(value, line_number + 1)?
            }
            ("probes", "service_timeout_secs") => {
                config.probes.service_timeout_secs = parse_toml_int(value, line_number + 1)?
            }
            ("probes", "consecutive_failures_before_escalate") => {
                config.probes.consecutive_failures_before_escalate =
                    parse_toml_int(value, line_number + 1)? as u32
            }

            ("health", "enabled") => {
                config.health.enabled = parse_toml_bool(value, line_number + 1)?
            }
            ("health", "bind") => config.health.bind = parse_toml_string(value)?,
            _ => {}
        }
    }

    Ok(())
}

fn builtin_http_service_probes() -> Vec<HttpServiceProbe> {
    vec![
        HttpServiceProbe {
            name: "inngest".to_string(),
            url: "http://localhost:8288/health".to_string(),
            timeout_secs: 5,
            critical: false,
        },
        HttpServiceProbe {
            name: "typesense".to_string(),
            url: "http://localhost:8108/health".to_string(),
            timeout_secs: 5,
            critical: false,
        },
        HttpServiceProbe {
            name: "worker".to_string(),
            url: "http://localhost:3111/api/inngest".to_string(),
            timeout_secs: 5,
            critical: false,
        },
    ]
}

fn reload_service_probes(config: &mut Config) -> Result<(), DynError> {
    config.http_service_probes = builtin_http_service_probes();
    config.launchd_service_probes.clear();
    load_service_probes(config)
}

fn load_service_probes(config: &mut Config) -> Result<(), DynError> {
    let services_path = config.services_path();
    ensure_services_file(&services_path)?;

    let raw = fs::read_to_string(&services_path)?;
    let (http_probes, launchd_probes) =
        parse_services_toml(&raw, config.probes.service_timeout_secs)?;

    config.http_service_probes.extend(http_probes);
    config.launchd_service_probes.extend(launchd_probes);

    Ok(())
}

fn ensure_services_file(path: &Path) -> Result<(), DynError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    if !path.exists() {
        fs::write(path, default_services_toml())?;
    }

    Ok(())
}

fn file_modified(path: &Path) -> Result<Option<SystemTime>, DynError> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.modified().ok()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn default_services_toml() -> String {
    r#"# Talon dynamic service monitors.
#
# Add HTTP probes under [http.<name>] and launchd probes under [launchd.<name>].
# Talon hot-reloads this file on mtime change (or immediately on SIGHUP).

[launchd.voice_agent]
label = "com.joel.voice-agent"
critical = true
timeout_secs = 5

[http.voice_agent]
url = "http://127.0.0.1:8081/"
critical = true
timeout_secs = 5
"#
    .to_string()
}

fn parse_services_toml(
    raw: &str,
    default_timeout_secs: u64,
) -> Result<(Vec<HttpServiceProbe>, Vec<LaunchdServiceProbe>), DynError> {
    let mut section = String::new();
    let mut http_sections: BTreeMap<String, HttpServiceProbe> = BTreeMap::new();
    let mut launchd_sections: BTreeMap<String, LaunchdServiceProbe> = BTreeMap::new();

    for (line_number, original_line) in raw.lines().enumerate() {
        let line = strip_comment(original_line).trim();
        if line.is_empty() {
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].trim().to_string();
            continue;
        }

        let Some((key, value)) = line.split_once('=') else {
            continue;
        };

        let key = key.trim();
        let value = value.trim();

        if let Some(name) = section.strip_prefix("http.") {
            let section_name = name.trim();
            if section_name.is_empty() {
                continue;
            }

            let probe = http_sections
                .entry(section_name.to_string())
                .or_insert_with(|| HttpServiceProbe {
                    name: section_name.to_string(),
                    url: String::new(),
                    timeout_secs: default_timeout_secs,
                    critical: false,
                });

            match key {
                "url" => probe.url = parse_toml_string(value)?,
                "timeout_secs" => probe.timeout_secs = parse_toml_int(value, line_number + 1)?,
                "critical" => probe.critical = parse_toml_bool(value, line_number + 1)?,
                _ => {}
            }
            continue;
        }

        if let Some(name) = section.strip_prefix("launchd.") {
            let section_name = name.trim();
            if section_name.is_empty() {
                continue;
            }

            let probe = launchd_sections
                .entry(section_name.to_string())
                .or_insert_with(|| LaunchdServiceProbe {
                    name: section_name.to_string(),
                    label: String::new(),
                    timeout_secs: default_timeout_secs,
                    critical: false,
                });

            match key {
                "label" => probe.label = parse_toml_string(value)?,
                "timeout_secs" => probe.timeout_secs = parse_toml_int(value, line_number + 1)?,
                "critical" => probe.critical = parse_toml_bool(value, line_number + 1)?,
                _ => {}
            }
        }
    }

    let mut http_probes = Vec::new();
    for (_, probe) in http_sections.into_iter() {
        if probe.url.trim().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("http.{} is missing required key: url", probe.name),
            )
            .into());
        }
        http_probes.push(probe);
    }

    let mut launchd_probes = Vec::new();
    for (_, probe) in launchd_sections.into_iter() {
        if probe.label.trim().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("launchd.{} is missing required key: label", probe.name),
            )
            .into());
        }
        launchd_probes.push(probe);
    }

    Ok((http_probes, launchd_probes))
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

    if value.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty TOML string").into());
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

fn parse_toml_bool(value: &str, line: usize) -> Result<bool, DynError> {
    match value.trim() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid boolean at line {line}: {value}"),
        )
        .into()),
    }
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

pub fn expand_home(path: &str) -> PathBuf {
    PathBuf::from(expand_tilde(path))
}

pub fn expand_tilde(path: &str) -> String {
    if path == "~" {
        return env::var("HOME").unwrap_or_else(|_| "~".to_string());
    }

    if let Some(rest) = path.strip_prefix("~/") {
        let home = env::var("HOME").unwrap_or_else(|_| "~".to_string());
        return format!("{home}/{rest}");
    }

    path.to_string()
}

pub fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_services_toml_parses_http_and_launchd_sections() {
        let raw = r#"
[launchd.voice_agent]
label = "com.joel.voice-agent"
critical = true

[http.voice_agent]
url = "http://127.0.0.1:8081/"
"#;

        let (http, launchd) = parse_services_toml(raw, 7).expect("services TOML should parse");

        assert_eq!(http.len(), 1);
        assert_eq!(launchd.len(), 1);

        assert_eq!(http[0].name, "voice_agent");
        assert_eq!(http[0].url, "http://127.0.0.1:8081/");
        assert_eq!(http[0].timeout_secs, 7);
        assert!(!http[0].critical);

        assert_eq!(launchd[0].name, "voice_agent");
        assert_eq!(launchd[0].label, "com.joel.voice-agent");
        assert_eq!(launchd[0].timeout_secs, 7);
        assert!(launchd[0].critical);
    }

    #[test]
    fn parse_services_toml_fails_when_http_url_missing() {
        let raw = r#"
[http.voice_agent]
critical = true
"#;

        let error = parse_services_toml(raw, 5).expect_err("missing url must fail validation");
        assert!(error
            .to_string()
            .contains("http.voice_agent is missing required key: url"));
    }

    #[test]
    fn parse_services_toml_fails_on_invalid_bool() {
        let raw = r#"
[launchd.voice_agent]
label = "com.joel.voice-agent"
critical = maybe
"#;

        let error = parse_services_toml(raw, 5).expect_err("invalid bool should fail validation");
        assert!(error.to_string().contains("invalid boolean"));
    }

    #[test]
    fn worker_external_launchd_label_defaults_to_legacy_supervisor() {
        let config = Config::default();
        assert_eq!(
            config.worker.external_launchd_label,
            "com.joel.system-bus-worker"
        );
    }

    #[test]
    fn parse_worker_external_launchd_label_override() {
        let mut config = Config::default();
        let raw = r#"
[worker]
external_launchd_label = "com.joel.custom-worker"
"#;

        apply_toml_overrides(&mut config, raw).expect("worker override should parse");
        assert_eq!(
            config.worker.external_launchd_label,
            "com.joel.custom-worker"
        );
    }

    #[test]
    fn is_critical_probe_matches_exact_dynamic_probe_names() {
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

        assert!(config.is_critical_probe("redis"));
        assert!(config.is_critical_probe("kubelet_proxy_rbac"));
        assert!(config.is_critical_probe("http:voice_agent"));
        assert!(config.is_critical_probe("launchd:voice_agent"));

        assert!(!config.is_critical_probe("http:voice"));
        assert!(!config.is_critical_probe("http:voice_agent_extra"));
        assert!(!config.is_critical_probe("launchd:voice"));
        assert!(!config.is_critical_probe("launchd:voice_agent_extra"));
    }
}

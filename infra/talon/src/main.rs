mod config;
mod escalation;
mod health;
mod log;
mod probes;
mod state;
mod worker;

use std::env;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::thread;
use std::time::Duration;

use config::{expand_home, Config, DEFAULT_CONFIG_PATH};
use escalation::TierOutcome;
use probes::ProbeResult;

type DynError = Box<dyn std::error::Error + Send + Sync>;
type CInt = i32;

const SIGTERM: CInt = 15;
const SIGINT: CInt = 2;
const SIGHUP: CInt = 1;

pub static RECEIVED_SIGNAL: AtomicI32 = AtomicI32::new(0);
pub static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);
pub static RELOAD_REQUESTED: AtomicBool = AtomicBool::new(false);

unsafe extern "C" {
    fn signal(sig: CInt, handler: usize) -> usize;
}

#[derive(Debug, Clone)]
struct Cli {
    config_path: PathBuf,
    check: bool,
    status: bool,
    validate: bool,
    worker_only: bool,
    dry_run: bool,
}

extern "C" fn signal_handler(sig: CInt) {
    if sig == SIGHUP {
        RELOAD_REQUESTED.store(true, Ordering::SeqCst);
        return;
    }

    RECEIVED_SIGNAL.store(sig, Ordering::SeqCst);
    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
}

fn main() -> Result<(), DynError> {
    let cli = parse_args()?;

    state::ensure_state_dir()?;
    log::init()?;
    config::ensure_default_config(&cli.config_path)?;

    if cli.validate {
        let summary = config::validate_config_files(&cli.config_path)?;
        println!("{}", config::validation_summary_to_json(&summary));
        return Ok(());
    }

    let config = config::load_config(&cli.config_path)?;

    if cli.dry_run {
        println!("talon dry run config path: {}", cli.config_path.display());
        println!("{config:#?}");
        return Ok(());
    }

    if cli.status {
        let current_state = state::load_state()?;
        println!("{}", state::state_to_json(&current_state));
        return Ok(());
    }

    if cli.check {
        let results = probes::run_all_probes(&config);
        println!("{}", state::probe_results_to_json(&results));
        state::write_last_probe(&results)?;
        return Ok(());
    }

    install_signal_handlers();

    if cli.worker_only {
        log::info("starting talon in worker-only mode");
        return worker::run_worker_supervisor(&config);
    }

    if config.health.enabled {
        health::publish_state(&state::load_state()?);
        health::start(config.health.bind.clone());
    }

    log::info("starting talon watchdog");

    let worker_config = config.clone();
    let worker_handle = thread::spawn(move || worker::run_worker_supervisor(&worker_config));

    let loop_result = run_watchdog_loop(config);

    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);

    let worker_result = match worker_handle.join() {
        Ok(result) => result,
        Err(_) => Err(io::Error::other("worker supervisor thread panicked").into()),
    };

    match (loop_result, worker_result) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(_), Ok(_)) => Ok(()),
    }
}

fn run_watchdog_loop(mut config: Config) -> Result<(), DynError> {
    let mut current_state = state::load_state()?;
    let mut critical_since = if current_state.current_state == "Critical" {
        current_state.last_agent_time
    } else {
        None
    };
    let mut service_tracker = config.service_probe_tracker()?;
    health::publish_state(&current_state);

    loop {
        if SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
            log::info("shutdown signal received, stopping talon loop");
            break;
        }

        let force_reload = RELOAD_REQUESTED.swap(false, Ordering::SeqCst);
        if force_reload {
            log::info("received SIGHUP; forcing service probe reload");
        }

        match config.refresh_service_probes(&mut service_tracker, force_reload) {
            Ok(true) => {
                log::info_fields(
                    "dynamic service probes reloaded",
                    &[
                        (
                            "services_file",
                            service_tracker.services_path.display().to_string(),
                        ),
                        ("http_probes", config.http_service_probes.len().to_string()),
                        (
                            "launchd_probes",
                            config.launchd_service_probes.len().to_string(),
                        ),
                    ],
                );
            }
            Ok(false) => {}
            Err(error) => {
                log::warn_fields(
                    "failed to refresh service probes",
                    &[("error", error.to_string())],
                );
            }
        }

        let results = probes::run_all_probes(&config);
        current_state.last_probe_results = results.clone();
        current_state.worker_restarts = worker::worker_restart_count();
        state::write_last_probe(&results)?;

        let mut failed_probes = collect_failed_probes(&results);
        let critical_failures = collect_critical_failures(&failed_probes, &config);

        if failed_probes.is_empty() {
            current_state.consecutive_failures = 0;
            critical_since = None;
            state::transition(&mut current_state, "Healthy");
            health::publish_state(&current_state);
            state::save_state(&current_state)?;
            sleep_with_shutdown(config.check_interval_secs);
            continue;
        }

        current_state.consecutive_failures = current_state.consecutive_failures.saturating_add(1);

        if current_state.current_state == "Healthy" {
            state::transition(&mut current_state, "Degraded");
        }

        let should_escalate = !critical_failures.is_empty()
            || current_state.consecutive_failures
                >= config.probes.consecutive_failures_before_escalate;

        if !should_escalate {
            health::publish_state(&current_state);
            state::save_state(&current_state)?;
            sleep_with_shutdown(config.check_interval_secs);
            continue;
        }

        if current_state.current_state == "Degraded"
            || current_state.current_state == "Investigating"
        {
            state::transition(&mut current_state, "Failed");
        }

        if current_state.current_state == "Failed" {
            let (heal_outcome, heal_output) = if should_use_service_heal(&failed_probes, &config) {
                log::warn("running service-specific heal for dynamic service probe failures");
                escalation::run_service_heal(&config, &mut current_state, &failed_probes, false)?
            } else {
                escalation::run_heal(&config, &mut current_state, false)?
            };

            if heal_outcome == TierOutcome::Fixed {
                let post_heal = probes::run_all_probes(&config);
                current_state.last_probe_results = post_heal.clone();
                current_state.worker_restarts = worker::worker_restart_count();
                state::write_last_probe(&post_heal)?;

                failed_probes = collect_failed_probes(&post_heal);

                if failed_probes.is_empty() {
                    current_state.consecutive_failures = 0;
                    critical_since = None;
                    state::transition(&mut current_state, "Healthy");
                    health::publish_state(&current_state);
                    state::save_state(&current_state)?;
                    sleep_with_shutdown(config.check_interval_secs);
                    continue;
                }
            }

            state::transition(&mut current_state, "Investigating");
            let agent_outcome = escalation::run_agents(
                &config,
                &mut current_state,
                &failed_probes,
                &heal_output,
                false,
            )?;

            match agent_outcome {
                TierOutcome::Fixed => {
                    let post_agent = probes::run_all_probes(&config);
                    current_state.last_probe_results = post_agent.clone();
                    current_state.worker_restarts = worker::worker_restart_count();
                    state::write_last_probe(&post_agent)?;
                    let remaining_failures = collect_failed_probes(&post_agent);

                    if remaining_failures.is_empty() {
                        current_state.consecutive_failures = 0;
                        critical_since = None;
                        state::transition(&mut current_state, "Healthy");
                    } else {
                        state::transition(&mut current_state, "Critical");
                        critical_since = Some(config::now_unix_secs());
                    }
                }
                TierOutcome::Failed => {
                    state::transition(&mut current_state, "Critical");
                    critical_since = Some(config::now_unix_secs());
                }
                TierOutcome::Cooldown => {}
            }
        } else if current_state.current_state == "Critical" || current_state.current_state == "SOS"
        {
            if critical_since.is_none() {
                critical_since = current_state.last_agent_time;
            }

            if let Some(since) = critical_since {
                match escalation::run_sos(
                    &config,
                    &mut current_state,
                    &failed_probes,
                    since,
                    false,
                )? {
                    TierOutcome::Fixed => state::transition(&mut current_state, "SOS"),
                    TierOutcome::Failed => log::error("SOS escalation failed"),
                    TierOutcome::Cooldown => {}
                }
            }
        }

        health::publish_state(&current_state);
        state::save_state(&current_state)?;
        sleep_with_shutdown(config.check_interval_secs);
    }

    Ok(())
}

fn collect_failed_probes(results: &[ProbeResult]) -> Vec<ProbeResult> {
    results
        .iter()
        .filter(|result| !result.passed)
        .cloned()
        .collect()
}

fn collect_critical_failures(results: &[ProbeResult], config: &Config) -> Vec<ProbeResult> {
    results
        .iter()
        .filter(|result| config.is_critical_probe(&result.name))
        .cloned()
        .collect()
}

fn should_use_service_heal(failures: &[ProbeResult], config: &Config) -> bool {
    !failures.is_empty()
        && failures
            .iter()
            .all(|probe| is_dynamic_service_probe(&probe.name, config))
}

fn is_dynamic_service_probe(name: &str, config: &Config) -> bool {
    if let Some(service_name) = name.strip_prefix("launchd:") {
        return config
            .launchd_service_probes
            .iter()
            .any(|probe| probe.name == service_name);
    }

    if let Some(service_name) = name.strip_prefix("http:") {
        if matches!(service_name, "inngest" | "typesense" | "worker") {
            return false;
        }

        return config
            .http_service_probes
            .iter()
            .any(|probe| probe.name == service_name);
    }

    false
}

fn sleep_with_shutdown(seconds: u64) {
    let steps = seconds.saturating_mul(4);
    for _ in 0..steps {
        if SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
            return;
        }
        if RELOAD_REQUESTED.load(Ordering::SeqCst) {
            return;
        }
        thread::sleep(Duration::from_millis(250));
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

fn parse_args() -> Result<Cli, DynError> {
    let mut args = env::args().skip(1);

    let mut config_path = expand_home(DEFAULT_CONFIG_PATH);
    let mut check = false;
    let mut status = false;
    let mut validate = false;
    let mut worker_only = false;
    let mut dry_run = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" => {
                let value = args.next().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "--config requires a path")
                })?;
                config_path = expand_home(&value);
            }
            "--check" => {
                check = true;
            }
            "--status" => {
                status = true;
            }
            "validate" | "--validate" => {
                validate = true;
            }
            "--worker-only" => {
                worker_only = true;
            }
            "--dry-run" => {
                dry_run = true;
            }
            "--help" | "-h" => {
                println!(
                    "talon [--config PATH] [validate|--validate] [--check] [--status] [--worker-only] [--dry-run]"
                );
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
        check,
        status,
        validate,
        worker_only,
        dry_run,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{HttpServiceProbe, LaunchdServiceProbe};

    #[test]
    fn service_heal_selection_uses_only_dynamic_service_failures() {
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

        let only_dynamic = vec![ProbeResult {
            name: "http:voice_agent".to_string(),
            passed: false,
            output: "500".to_string(),
            duration_ms: 12,
        }];

        let mixed_failures = vec![
            ProbeResult {
                name: "http:voice_agent".to_string(),
                passed: false,
                output: "500".to_string(),
                duration_ms: 12,
            },
            ProbeResult {
                name: "redis".to_string(),
                passed: false,
                output: "timeout".to_string(),
                duration_ms: 1000,
            },
        ];

        let builtin_http_failure = vec![ProbeResult {
            name: "http:worker".to_string(),
            passed: false,
            output: "503".to_string(),
            duration_ms: 10,
        }];

        assert!(should_use_service_heal(&only_dynamic, &config));
        assert!(!should_use_service_heal(&mixed_failures, &config));
        assert!(!should_use_service_heal(&builtin_http_failure, &config));
    }
}

mod config;
mod escalation;
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

unsafe extern "C" {
    fn signal(sig: CInt, handler: usize) -> usize;
}

#[derive(Debug, Clone)]
struct Cli {
    config_path: PathBuf,
    check: bool,
    status: bool,
    worker_only: bool,
    dry_run: bool,
}

extern "C" fn signal_handler(sig: CInt) {
    RECEIVED_SIGNAL.store(sig, Ordering::SeqCst);
    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
}

fn main() -> Result<(), DynError> {
    let cli = parse_args()?;

    state::ensure_state_dir()?;
    log::init()?;
    config::ensure_default_config(&cli.config_path)?;
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

    log::info("starting talon watchdog");

    let worker_config = config.clone();
    let worker_handle = thread::spawn(move || worker::run_worker_supervisor(&worker_config));

    let loop_result = run_watchdog_loop(&config);

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

fn run_watchdog_loop(config: &Config) -> Result<(), DynError> {
    let mut current_state = state::load_state()?;
    let mut critical_since = if current_state.current_state == "Critical" {
        current_state.last_agent_time
    } else {
        None
    };

    loop {
        if SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
            log::info("shutdown signal received, stopping talon loop");
            break;
        }

        let results = probes::run_all_probes(config);
        current_state.last_probe_results = results.clone();
        current_state.worker_restarts = worker::worker_restart_count();
        state::write_last_probe(&results)?;

        let mut critical_failures = collect_critical_failures(&results, config);

        if critical_failures.is_empty() {
            current_state.consecutive_failures = 0;
            critical_since = None;
            state::transition(&mut current_state, "Healthy");
            state::save_state(&current_state)?;
            sleep_with_shutdown(config.check_interval_secs);
            continue;
        }

        current_state.consecutive_failures = current_state.consecutive_failures.saturating_add(1);

        if current_state.current_state == "Healthy" {
            state::transition(&mut current_state, "Degraded");
        }

        if current_state.current_state == "Degraded"
            && current_state.consecutive_failures
                >= config.probes.consecutive_failures_before_escalate
        {
            state::transition(&mut current_state, "Failed");
        }

        if current_state.current_state == "Failed" {
            let (heal_outcome, heal_output) =
                escalation::run_heal(config, &mut current_state, false)?;

            if heal_outcome == TierOutcome::Fixed {
                let post_heal = probes::run_all_probes(config);
                current_state.last_probe_results = post_heal.clone();
                current_state.worker_restarts = worker::worker_restart_count();
                state::write_last_probe(&post_heal)?;
                critical_failures = collect_critical_failures(&post_heal, config);

                if critical_failures.is_empty() {
                    current_state.consecutive_failures = 0;
                    critical_since = None;
                    state::transition(&mut current_state, "Healthy");
                    state::save_state(&current_state)?;
                    sleep_with_shutdown(config.check_interval_secs);
                    continue;
                }
            }

            state::transition(&mut current_state, "Investigating");
            let agent_outcome = escalation::run_agents(
                config,
                &mut current_state,
                &critical_failures,
                &heal_output,
                false,
            )?;

            match agent_outcome {
                TierOutcome::Fixed => {
                    let post_agent = probes::run_all_probes(config);
                    current_state.last_probe_results = post_agent.clone();
                    current_state.worker_restarts = worker::worker_restart_count();
                    state::write_last_probe(&post_agent)?;
                    let remaining_failures = collect_critical_failures(&post_agent, config);

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
                    config,
                    &mut current_state,
                    &critical_failures,
                    since,
                    false,
                )? {
                    TierOutcome::Fixed => state::transition(&mut current_state, "SOS"),
                    TierOutcome::Failed => log::error("SOS escalation failed"),
                    TierOutcome::Cooldown => {}
                }
            }
        }

        state::save_state(&current_state)?;
        sleep_with_shutdown(config.check_interval_secs);
    }

    Ok(())
}

fn collect_critical_failures(results: &[ProbeResult], config: &Config) -> Vec<ProbeResult> {
    results
        .iter()
        .filter(|result| !result.passed && config.is_critical_probe(&result.name))
        .cloned()
        .collect()
}

fn sleep_with_shutdown(seconds: u64) {
    let steps = seconds.saturating_mul(4);
    for _ in 0..steps {
        if SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
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
            "--worker-only" => {
                worker_only = true;
            }
            "--dry-run" => {
                dry_run = true;
            }
            "--help" | "-h" => {
                println!("talon [--config PATH] [--check] [--status] [--worker-only] [--dry-run]");
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
        worker_only,
        dry_run,
    })
}

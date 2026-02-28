use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use crate::config::now_unix_secs;
use crate::log;
use crate::state::PersistentState;
use crate::SHUTDOWN_REQUESTED;

#[derive(Debug, Clone)]
struct HealthSnapshot {
    ok: bool,
    state: String,
    consecutive_failures: u32,
    probe_count: usize,
    failed_probe_count: usize,
    failed_probes: Vec<String>,
    worker_restarts: u32,
    updated_at_unix: u64,
}

impl Default for HealthSnapshot {
    fn default() -> Self {
        Self {
            ok: false,
            state: "Starting".to_string(),
            consecutive_failures: 0,
            probe_count: 0,
            failed_probe_count: 0,
            failed_probes: Vec::new(),
            worker_restarts: 0,
            updated_at_unix: now_unix_secs(),
        }
    }
}

static SNAPSHOT: OnceLock<Mutex<HealthSnapshot>> = OnceLock::new();

pub fn publish_state(state: &PersistentState) {
    let failed_probes = state
        .last_probe_results
        .iter()
        .filter(|probe| !probe.passed)
        .map(|probe| probe.name.clone())
        .collect::<Vec<_>>();

    let snapshot = HealthSnapshot {
        ok: failed_probes.is_empty() && state.current_state == "Healthy",
        state: state.current_state.clone(),
        consecutive_failures: state.consecutive_failures,
        probe_count: state.last_probe_results.len(),
        failed_probe_count: failed_probes.len(),
        failed_probes,
        worker_restarts: state.worker_restarts,
        updated_at_unix: now_unix_secs(),
    };

    if let Ok(mut current) = SNAPSHOT
        .get_or_init(|| Mutex::new(HealthSnapshot::default()))
        .lock()
    {
        *current = snapshot;
    }
}

pub fn start(bind: String) {
    let _ = SNAPSHOT.get_or_init(|| Mutex::new(HealthSnapshot::default()));

    thread::spawn(move || {
        let listener = match TcpListener::bind(&bind) {
            Ok(listener) => listener,
            Err(error) => {
                log::error_fields(
                    "failed to bind talon health endpoint",
                    &[("bind", bind), ("error", error.to_string())],
                );
                return;
            }
        };

        if let Err(error) = listener.set_nonblocking(true) {
            log::warn_fields(
                "failed to set talon health endpoint nonblocking mode",
                &[("error", error.to_string())],
            );
        }

        log::info_fields("talon health endpoint listening", &[("bind", bind)]);

        while !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = handle_connection(stream);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(200));
                }
                Err(error) => {
                    log::warn_fields(
                        "talon health endpoint accept error",
                        &[("error", error.to_string())],
                    );
                    thread::sleep(Duration::from_millis(500));
                }
            }
        }

        log::info("talon health endpoint stopped");
    });
}

fn handle_connection(mut stream: TcpStream) -> Result<(), std::io::Error> {
    let mut request = [0_u8; 2048];
    let _ = stream.read(&mut request)?;

    let request_raw = String::from_utf8_lossy(&request);
    let request_line = request_raw.lines().next().unwrap_or("");

    if request_line.starts_with("GET /health") {
        let body = health_json();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes())?;
        return Ok(());
    }

    if request_line.starts_with("GET /") {
        let body = "{\"ok\":true,\"path\":\"/health\"}";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes())?;
        return Ok(());
    }

    let body = "{\"ok\":false,\"error\":\"not_found\"}";
    let response = format!(
        "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes())?;
    Ok(())
}

fn health_json() -> String {
    let snapshot = SNAPSHOT
        .get_or_init(|| Mutex::new(HealthSnapshot::default()))
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| HealthSnapshot::default());

    let failed = snapshot
        .failed_probes
        .iter()
        .map(|name| format!("\"{}\"", json_escape(name)))
        .collect::<Vec<_>>()
        .join(",");

    format!(
        "{{\"ok\":{},\"state\":\"{}\",\"consecutive_failures\":{},\"probe_count\":{},\"failed_probe_count\":{},\"failed_probes\":[{}],\"worker_restarts\":{},\"updated_at_unix\":{}}}",
        if snapshot.ok { "true" } else { "false" },
        json_escape(&snapshot.state),
        snapshot.consecutive_failures,
        snapshot.probe_count,
        snapshot.failed_probe_count,
        failed,
        snapshot.worker_restarts,
        snapshot.updated_at_unix,
    )
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

use std::fs;
use std::io;
use std::path::PathBuf;

use crate::config::{expand_home, STATE_DIR};
use crate::log;
use crate::probes::ProbeResult;
use crate::DynError;

const STATE_FILE: &str = "~/.local/state/talon/state.json";
const LAST_PROBE_FILE: &str = "~/.local/state/talon/last-probe.json";

#[derive(Debug, Clone)]
pub struct PersistentState {
    pub current_state: String,
    pub consecutive_failures: u32,
    pub last_heal_time: Option<u64>,
    pub last_agent_time: Option<u64>,
    pub last_sos_time: Option<u64>,
    pub last_probe_results: Vec<ProbeResult>,
    pub worker_restarts: u32,
}

impl Default for PersistentState {
    fn default() -> Self {
        Self {
            current_state: "Healthy".to_string(),
            consecutive_failures: 0,
            last_heal_time: None,
            last_agent_time: None,
            last_sos_time: None,
            last_probe_results: Vec::new(),
            worker_restarts: 0,
        }
    }
}

pub fn ensure_state_dir() -> Result<(), DynError> {
    let dir = expand_home(STATE_DIR);
    fs::create_dir_all(dir)?;
    Ok(())
}

pub fn load_state() -> Result<PersistentState, DynError> {
    ensure_state_dir()?;
    let path = state_file_path();
    if !path.exists() {
        return Ok(PersistentState::default());
    }

    let raw = fs::read_to_string(path)?;
    let mut state = PersistentState::default();

    if let Some(value) = parse_json_string(&raw, "current_state") {
        state.current_state = value;
    }

    if let Some(value) = parse_json_u64(&raw, "consecutive_failures") {
        state.consecutive_failures = value as u32;
    }

    if let Some(value) = parse_json_optional_u64(&raw, "last_heal_time") {
        state.last_heal_time = value;
    }

    if let Some(value) = parse_json_optional_u64(&raw, "last_agent_time") {
        state.last_agent_time = value;
    }

    if let Some(value) = parse_json_optional_u64(&raw, "last_sos_time") {
        state.last_sos_time = value;
    }

    if let Some(value) = parse_json_u64(&raw, "worker_restarts") {
        state.worker_restarts = value as u32;
    }

    Ok(state)
}

pub fn save_state(state: &PersistentState) -> Result<(), DynError> {
    ensure_state_dir()?;
    let path = state_file_path();
    fs::write(path, state_to_json(state))?;
    Ok(())
}

pub fn transition(state: &mut PersistentState, next_state: &str) {
    if state.current_state == next_state {
        return;
    }

    let from = state.current_state.clone();
    state.current_state = next_state.to_string();

    log::info_fields(
        "state transition",
        &[("from", from), ("to", next_state.to_string())],
    );
}

pub fn write_last_probe(results: &[ProbeResult]) -> Result<(), DynError> {
    ensure_state_dir()?;
    let path = last_probe_file_path();
    fs::write(path, probe_results_to_json(results))?;
    Ok(())
}

pub fn state_to_json(state: &PersistentState) -> String {
    let mut out = String::new();
    out.push('{');
    out.push_str("\n  \"current_state\": \"");
    out.push_str(&json_escape(&state.current_state));
    out.push_str("\",\n  \"consecutive_failures\": ");
    out.push_str(&state.consecutive_failures.to_string());
    out.push_str(",\n  \"last_heal_time\": ");
    out.push_str(&optional_u64_to_json(state.last_heal_time));
    out.push_str(",\n  \"last_agent_time\": ");
    out.push_str(&optional_u64_to_json(state.last_agent_time));
    out.push_str(",\n  \"last_sos_time\": ");
    out.push_str(&optional_u64_to_json(state.last_sos_time));
    out.push_str(",\n  \"last_probe_results\": ");
    out.push_str(&probe_results_to_json(&state.last_probe_results));
    out.push_str(",\n  \"worker_restarts\": ");
    out.push_str(&state.worker_restarts.to_string());
    out.push_str("\n}\n");
    out
}

pub fn probe_results_to_json(results: &[ProbeResult]) -> String {
    let mut out = String::new();
    out.push('[');

    for (index, result) in results.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }

        out.push('{');
        out.push_str("\"name\":\"");
        out.push_str(&json_escape(&result.name));
        out.push_str("\",\"passed\":");
        out.push_str(if result.passed { "true" } else { "false" });
        out.push_str(",\"output\":\"");
        out.push_str(&json_escape(&result.output));
        out.push_str("\",\"duration_ms\":");
        out.push_str(&result.duration_ms.to_string());
        out.push('}');
    }

    out.push(']');
    out
}

fn state_file_path() -> PathBuf {
    expand_home(STATE_FILE)
}

fn last_probe_file_path() -> PathBuf {
    expand_home(LAST_PROBE_FILE)
}

fn optional_u64_to_json(value: Option<u64>) -> String {
    match value {
        Some(value) => value.to_string(),
        None => "null".to_string(),
    }
}

fn parse_json_string(raw: &str, key: &str) -> Option<String> {
    let start = key_position(raw, key)?;
    let mut index = skip_whitespace(raw, start)?;

    if raw.as_bytes().get(index).copied()? != b'"' {
        return None;
    }

    index += 1;
    let mut out = String::new();
    let bytes = raw.as_bytes();

    while index < bytes.len() {
        let ch = bytes[index] as char;
        if ch == '\\' {
            index += 1;
            if index >= bytes.len() {
                break;
            }
            let escaped = bytes[index] as char;
            match escaped {
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                other => out.push(other),
            }
            index += 1;
            continue;
        }

        if ch == '"' {
            return Some(out);
        }

        out.push(ch);
        index += 1;
    }

    None
}

fn parse_json_u64(raw: &str, key: &str) -> Option<u64> {
    let token = parse_json_token(raw, key)?;
    token.parse::<u64>().ok()
}

fn parse_json_optional_u64(raw: &str, key: &str) -> Option<Option<u64>> {
    let token = parse_json_token(raw, key)?;
    if token == "null" {
        return Some(None);
    }

    token.parse::<u64>().ok().map(Some)
}

fn parse_json_token(raw: &str, key: &str) -> Option<String> {
    let start = key_position(raw, key)?;
    let mut index = skip_whitespace(raw, start)?;
    let bytes = raw.as_bytes();

    let mut token = String::new();
    while index < bytes.len() {
        let ch = bytes[index] as char;
        if ch == ',' || ch == '}' || ch == '\n' {
            break;
        }

        token.push(ch);
        index += 1;
    }

    let trimmed = token.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn key_position(raw: &str, key: &str) -> Option<usize> {
    let quoted = format!("\"{key}\"");
    let key_index = raw.find(&quoted)?;
    let after_key = key_index + quoted.len();
    let colon_offset = raw[after_key..].find(':')?;
    Some(after_key + colon_offset + 1)
}

fn skip_whitespace(raw: &str, start: usize) -> Option<usize> {
    let bytes = raw.as_bytes();
    let mut index = start;

    while index < bytes.len() {
        let ch = bytes[index] as char;
        if !ch.is_whitespace() {
            return Some(index);
        }
        index += 1;
    }

    None
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

#[allow(dead_code)]
fn _state_parse_error(message: &str) -> DynError {
    io::Error::new(io::ErrorKind::InvalidData, message).into()
}

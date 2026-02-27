use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::expand_home;
use crate::DynError;

const LOG_PATH: &str = "~/.local/state/talon/talon.log";
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub fn init() -> Result<(), DynError> {
    let path = expand_home(LOG_PATH);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    if !path.exists() {
        OpenOptions::new().create(true).append(true).open(path)?;
    }

    Ok(())
}

pub fn info(message: &str) {
    write_log("info", message, &[]);
}

pub fn warn(message: &str) {
    write_log("warn", message, &[]);
}

pub fn error(message: &str) {
    write_log("error", message, &[]);
}

pub fn info_fields(message: &str, fields: &[(&str, String)]) {
    write_log("info", message, fields);
}

pub fn warn_fields(message: &str, fields: &[(&str, String)]) {
    write_log("warn", message, fields);
}

pub fn error_fields(message: &str, fields: &[(&str, String)]) {
    write_log("error", message, fields);
}

pub fn tail_file(path: &Path, max_lines: usize) -> String {
    let raw = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return String::new(),
    };

    let mut lines: Vec<&str> = raw.lines().collect();
    if lines.len() > max_lines {
        lines = lines.split_off(lines.len() - max_lines);
    }

    lines.join("\n")
}

pub fn tail_talon_log(max_lines: usize) -> String {
    tail_file(&expand_home(LOG_PATH), max_lines)
}

fn write_log(level: &str, message: &str, fields: &[(&str, String)]) {
    let lock = LOG_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = match lock.lock() {
        Ok(guard) => guard,
        Err(_) => {
            eprintln!("[talon][{level}] {message}");
            return;
        }
    };

    let path = expand_home(LOG_PATH);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Err(error) = rotate_if_needed(&path) {
        eprintln!("[talon][error] failed to rotate log: {error}");
    }

    let mut file = match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(file) => file,
        Err(error) => {
            eprintln!("[talon][error] failed to open log file: {error}");
            eprintln!("[talon][{level}] {message}");
            return;
        }
    };

    let mut line = String::new();
    line.push('{');
    line.push_str("\"timestamp\":\"");
    line.push_str(&json_escape(&iso8601_now()));
    line.push_str("\",\"level\":\"");
    line.push_str(&json_escape(level));
    line.push_str("\",\"message\":\"");
    line.push_str(&json_escape(message));
    line.push('"');

    for (key, value) in fields {
        line.push(',');
        line.push('"');
        line.push_str(&json_escape(key));
        line.push_str("\":\"");
        line.push_str(&json_escape(value));
        line.push('"');
    }

    line.push_str("}\n");

    if let Err(error) = file.write_all(line.as_bytes()) {
        eprintln!("[talon][error] failed to write log: {error}");
    }

    eprintln!("[talon][{level}] {message}");
}

fn rotate_if_needed(path: &Path) -> io::Result<()> {
    let size = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(_) => return Ok(()),
    };

    if size < MAX_LOG_BYTES {
        return Ok(());
    }

    let rotated = rotated_path(path);
    if rotated.exists() {
        let _ = fs::remove_file(&rotated);
    }

    fs::rename(path, rotated)?;
    Ok(())
}

fn rotated_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("talon.log");

    let rotated_name = format!("{file_name}.1");
    match path.parent() {
        Some(parent) => parent.join(rotated_name),
        None => PathBuf::from(rotated_name),
    }
}

fn iso8601_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    let days = (now / 86_400) as i64;
    let seconds_of_day = (now % 86_400) as i64;

    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;

    let (year, month, day) = civil_from_days(days);

    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"
    )
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };

    (year, month, day)
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

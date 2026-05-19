use std::{
    io::{self, Write},
    net::SocketAddr,
    path::PathBuf,
};

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub settings_path: PathBuf,
    pub token_present: bool,
    pub bind_address: SocketAddr,
}

pub fn write_json_stdout<T: Serialize>(value: &T) -> Result<()> {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    serde_json::to_writer_pretty(&mut lock, value).context("failed to write JSON output")?;
    writeln!(&mut lock).context("failed to finalize JSON output")
}

pub fn write_doctor_human(report: &DoctorReport) -> Result<()> {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    writeln!(lock, "settings: {}", report.settings_path.display())?;
    writeln!(
        lock,
        "token: {}",
        if report.token_present {
            "present"
        } else {
            "missing"
        }
    )?;
    writeln!(lock, "bind: {}", report.bind_address)?;
    Ok(())
}

pub fn write_tool_call_human(value: &Value) -> Result<()> {
    let stdout = io::stdout();
    let mut lock = stdout.lock();

    if let Some(content) = value.pointer("/result/content").and_then(Value::as_array) {
        for item in content {
            match item.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        writeln!(lock, "{text}")?;
                    }
                }
                _ => {
                    serde_json::to_writer(&mut lock, item)
                        .context("failed to write tool content JSON")?;
                    writeln!(lock)?;
                }
            }
        }
        return Ok(());
    }

    serde_json::to_writer_pretty(&mut lock, value).context("failed to write JSON output")?;
    writeln!(lock).context("failed to finalize JSON output")
}

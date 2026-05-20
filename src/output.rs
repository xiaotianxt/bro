use std::{
    io::{self, Write},
    net::SocketAddr,
    path::PathBuf,
};

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;

use crate::setup::{BrowserSetupReport, CodexSetupReport};

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

pub fn write_codex_setup_human(report: &CodexSetupReport) -> Result<()> {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    writeln!(lock, "Codex MCP config: {}", report.config_path.display())?;
    writeln!(lock, "bro MCP URL: {}", report.server_url)?;
    writeln!(
        lock,
        "config: {}",
        if report.updated {
            "updated"
        } else {
            "already current"
        }
    )?;
    writeln!(lock, "restart Codex to load the MCP server.")?;
    Ok(())
}

pub fn write_browser_setup_human(report: &BrowserSetupReport) -> Result<()> {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    writeln!(lock, "bro extension: {}", report.extension_dir.display())?;
    writeln!(
        lock,
        "token: {}",
        if report.token_copied {
            "copied to clipboard"
        } else {
            "copy it from ~/.bro/settings.json"
        }
    )?;
    writeln!(
        lock,
        "browser extension page: {}",
        if report.extension_page_opened {
            "opened"
        } else {
            "open chrome://extensions/"
        }
    )?;
    writeln!(
        lock,
        "extension folder: {}",
        if report.extension_dir_revealed {
            "shown"
        } else {
            "open the path above"
        }
    )?;
    writeln!(lock, "In the browser: enable Developer mode, Load unpacked, select the extension folder, then open bro Options and paste the token.")?;
    Ok(())
}

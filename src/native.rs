use std::{
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Command,
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBrowserInfo {
    pub metadata_status: NativeMetadataStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_data_dir: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cookie_store_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safe_storage_service: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeMetadataStatus {
    Ok,
    Partial,
    Unavailable,
}

pub fn inspect_browser_connection(peer_addr: Option<SocketAddr>) -> NativeBrowserInfo {
    let Some(peer_addr) = peer_addr else {
        return unavailable("websocket peer address is unavailable");
    };

    match inspect_browser_connection_inner(peer_addr) {
        Ok(info) => info,
        Err(error) => unavailable(error),
    }
}

fn inspect_browser_connection_inner(peer_addr: SocketAddr) -> Result<NativeBrowserInfo, String> {
    let process = find_process_for_peer(peer_addr)?;
    let executable_path = command_output(
        "ps",
        &["-p", &process.pid.to_string(), "-ww", "-o", "comm="],
    )
    .ok()
    .and_then(|value| non_empty(value.trim()).map(PathBuf::from));
    let command_line = command_output(
        "ps",
        &["-p", &process.pid.to_string(), "-ww", "-o", "command="],
    )
    .ok();

    let app_name = executable_path
        .as_deref()
        .and_then(app_name_from_executable)
        .or_else(|| non_empty(process.command.trim()).map(ToOwned::to_owned));
    let user_data_dir = command_line
        .as_deref()
        .and_then(|line| chromium_flag_value(line, "--user-data-dir"))
        .map(expand_home);
    let profile_directory = command_line
        .as_deref()
        .and_then(|line| chromium_flag_value(line, "--profile-directory"))
        .or_else(|| user_data_dir.as_ref().map(|_dir| "Default".to_string()));
    let profile_path = user_data_dir
        .as_ref()
        .zip(profile_directory.as_ref())
        .map(|(dir, profile)| dir.join(profile));
    let cookie_store_path = profile_path.as_deref().map(cookie_store_path);
    let safe_storage_service = app_name
        .as_deref()
        .map(|name| format!("{name} Safe Storage"));

    let metadata_status = if user_data_dir.is_some() && profile_path.is_some() {
        NativeMetadataStatus::Ok
    } else {
        NativeMetadataStatus::Partial
    };

    Ok(NativeBrowserInfo {
        metadata_status,
        metadata_error: None,
        process_id: Some(process.pid),
        app_name,
        executable_path,
        user_data_dir,
        profile_directory,
        profile_path,
        cookie_store_path,
        safe_storage_service,
    })
}

fn unavailable(error: impl Into<String>) -> NativeBrowserInfo {
    NativeBrowserInfo {
        metadata_status: NativeMetadataStatus::Unavailable,
        metadata_error: Some(error.into()),
        process_id: None,
        app_name: None,
        executable_path: None,
        user_data_dir: None,
        profile_directory: None,
        profile_path: None,
        cookie_store_path: None,
        safe_storage_service: None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeProcess {
    pid: u32,
    command: String,
}

fn find_process_for_peer(peer_addr: SocketAddr) -> Result<NativeProcess, String> {
    #[cfg(unix)]
    {
        let port = peer_addr.port().to_string();
        let output = command_output("lsof", &["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-Fpcn"])?;
        parse_lsof_process_for_peer(&output, &port)
            .ok_or_else(|| format!("no established TCP process found for peer port {port}"))
    }

    #[cfg(not(unix))]
    {
        let _ignored = peer_addr;
        Err("native browser metadata is not implemented on this platform".to_string())
    }
}

fn command_output(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("failed to run {program}: {error}"))?;
    if !output.status.success() {
        return Err(format!("{program} exited with {}", output.status));
    }
    String::from_utf8(output.stdout)
        .map_err(|error| format!("{program} output was not UTF-8: {error}"))
}

fn parse_lsof_process_for_peer(output: &str, peer_port: &str) -> Option<NativeProcess> {
    let peer_source_marker = format!(":{peer_port}->");
    let mut pid = None;
    let mut command = None;

    for line in output.lines() {
        if line.is_empty() {
            continue;
        }
        let (kind, value) = line.split_at(1);
        match kind {
            "p" => {
                pid = value.parse::<u32>().ok();
                command = None;
            }
            "c" => {
                command = non_empty(value).map(ToOwned::to_owned);
            }
            "n" if value.contains(&peer_source_marker) => {
                return Some(NativeProcess {
                    pid: pid?,
                    command: command.clone().unwrap_or_default(),
                });
            }
            _ => {}
        }
    }

    None
}

fn chromium_flag_value(command_line: &str, flag: &str) -> Option<String> {
    let needle = format!("{flag}=");
    let start = command_line.find(&needle)? + needle.len();
    let tail = &command_line[start..];
    let value = match tail.find(" --") {
        Some(end) => &tail[..end],
        None => tail,
    };
    non_empty(value.trim_matches(['"', '\''].as_ref())).map(ToOwned::to_owned)
}

fn expand_home(value: String) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(value)
}

fn app_name_from_executable(path: &Path) -> Option<String> {
    for component in path.components() {
        let value = component.as_os_str().to_string_lossy();
        if let Some(app_name) = value.strip_suffix(".app") {
            return non_empty(app_name).map(ToOwned::to_owned);
        }
    }
    path.file_stem()
        .and_then(|name| name.to_str())
        .and_then(non_empty)
        .map(ToOwned::to_owned)
}

fn cookie_store_path(profile_path: &Path) -> PathBuf {
    let network_cookie_store = profile_path.join("Network").join("Cookies");
    if network_cookie_store.exists() {
        network_cookie_store
    } else {
        profile_path.join("Cookies")
    }
}

fn non_empty(value: &str) -> Option<&str> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{app_name_from_executable, chromium_flag_value, parse_lsof_process_for_peer};

    #[test]
    fn parses_lsof_peer_source_process() {
        let output = "\
p111
cGoogle Chrome
n127.0.0.1:3500->127.0.0.1:50123
p222
cHelium
n127.0.0.1:50123->127.0.0.1:3500
";

        let process = parse_lsof_process_for_peer(output, "50123").unwrap();
        assert_eq!(process.pid, 222);
        assert_eq!(process.command, "Helium");
    }

    #[test]
    fn parses_flag_value_with_spaces() {
        let command_line = "/Applications/Helium.app/Contents/MacOS/Helium --user-data-dir=/Users/me/Library/Application Support/net.imput.helium --flag";

        assert_eq!(
            chromium_flag_value(command_line, "--user-data-dir").as_deref(),
            Some("/Users/me/Library/Application Support/net.imput.helium")
        );
    }

    #[test]
    fn derives_app_name_from_bundle_path() {
        assert_eq!(
            app_name_from_executable(Path::new("/Applications/Helium.app/Contents/MacOS/Helium"))
                .as_deref(),
            Some("Helium")
        );
    }
}

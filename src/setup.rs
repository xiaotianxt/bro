use std::{
    env, fs,
    io::Write,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use anyhow::{Context, Result};
use serde::Serialize;
use toml_edit::{value, DocumentMut, Item, Table};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSetupReport {
    pub config_path: PathBuf,
    pub server_url: String,
    pub updated: bool,
    pub restart_required: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSetupReport {
    pub extension_dir: PathBuf,
    pub token_copied: bool,
    pub extension_page_opened: bool,
    pub extension_dir_revealed: bool,
}

pub fn default_codex_config_path() -> Result<PathBuf> {
    if let Some(codex_home) = env::var_os("CODEX_HOME") {
        return Ok(PathBuf::from(codex_home).join("config.toml"));
    }
    let home = env::var_os("HOME").context("HOME is not set")?;
    Ok(PathBuf::from(home).join(".codex").join("config.toml"))
}

pub fn configure_codex(
    config_path: &Path,
    token: &str,
    bind_address: SocketAddr,
) -> Result<CodexSetupReport> {
    let server_url = format!("http://{bind_address}/mcp");
    let existing = match fs::read_to_string(config_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", config_path.display()));
        }
    };

    let mut document = if existing.trim().is_empty() {
        DocumentMut::new()
    } else {
        existing
            .parse::<DocumentMut>()
            .with_context(|| format!("failed to parse TOML {}", config_path.display()))?
    };

    let mcp_servers = ensure_table(&mut document["mcp_servers"], "mcp_servers")?;
    let bro = ensure_table(&mut mcp_servers["bro"], "mcp_servers.bro")?;
    bro["url"] = value(server_url.clone());
    bro.remove("bearer_token_env_var");

    let mut headers = Table::new();
    headers["Authorization"] = value(format!("Bearer {token}"));
    bro["http_headers"] = Item::Table(headers);

    let mut next = document.to_string();
    if !next.ends_with('\n') {
        next.push('\n');
    }
    let updated = next != existing;
    if updated {
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        fs::write(config_path, next)
            .with_context(|| format!("failed to write {}", config_path.display()))?;
        set_private_file_permissions(config_path)
            .with_context(|| format!("failed to secure {}", config_path.display()))?;
    }

    Ok(CodexSetupReport {
        config_path: config_path.to_path_buf(),
        server_url,
        updated,
        restart_required: true,
    })
}

pub fn setup_browser(
    token: &str,
    extension_dir: Option<PathBuf>,
    browser: Option<&str>,
    open: bool,
) -> Result<BrowserSetupReport> {
    let extension_dir = resolve_extension_dir(extension_dir)?;
    let token_copied = copy_to_clipboard(token).unwrap_or(false);
    let (extension_page_opened, extension_dir_revealed) = if open {
        (
            open_extensions_page(browser).unwrap_or(false),
            reveal_extension_dir(&extension_dir).unwrap_or(false),
        )
    } else {
        (false, false)
    };

    Ok(BrowserSetupReport {
        extension_dir,
        token_copied,
        extension_page_opened,
        extension_dir_revealed,
    })
}

fn ensure_table<'a>(item: &'a mut Item, name: &str) -> Result<&'a mut Table> {
    if item.is_none() {
        *item = Item::Table(Table::new());
    }
    item.as_table_mut()
        .with_context(|| format!("{name} must be a TOML table"))
}

fn resolve_extension_dir(explicit: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        return validate_extension_dir(path);
    }

    if let Some(path) = env::var_os("BRO_EXTENSION_DIR") {
        if let Ok(path) = validate_extension_dir(PathBuf::from(path)) {
            return Ok(path);
        }
    }

    for candidate in extension_dir_candidates() {
        if let Ok(path) = validate_extension_dir(candidate) {
            return Ok(path);
        }
    }

    anyhow::bail!(
        "bro extension directory not found; install bro with Homebrew or pass --extension-dir"
    )
}

fn extension_dir_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(exe) = env::current_exe() {
        if let Some(prefix) = exe.parent().and_then(Path::parent) {
            candidates.push(prefix.join("share").join("bro").join("extension"));
        }
    }

    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("extension").join("dist"));
    }

    if let Some(manifest_dir) = option_env!("CARGO_MANIFEST_DIR") {
        candidates.push(PathBuf::from(manifest_dir).join("extension").join("dist"));
    }

    candidates.push(PathBuf::from("/opt/homebrew/share/bro/extension"));
    candidates.push(PathBuf::from("/usr/local/share/bro/extension"));
    candidates.push(PathBuf::from(
        "/home/linuxbrew/.linuxbrew/share/bro/extension",
    ));

    candidates
}

fn validate_extension_dir(path: PathBuf) -> Result<PathBuf> {
    let manifest = path.join("manifest.json");
    if manifest.is_file() {
        Ok(path)
    } else {
        anyhow::bail!("{} does not contain manifest.json", path.display())
    }
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn copy_to_clipboard(token: &str) -> Result<bool> {
    #[cfg(target_os = "macos")]
    {
        write_stdin_command("pbcopy", &[], token)
    }

    #[cfg(target_os = "windows")]
    {
        write_stdin_command("clip", &[], token)
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        if write_stdin_command("wl-copy", &[], token).unwrap_or(false) {
            return Ok(true);
        }
        write_stdin_command("xclip", &["-selection", "clipboard"], token)
    }
}

fn write_stdin_command(program: &str, args: &[&str], input: &str) -> Result<bool> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("failed to spawn {program}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input.as_bytes())
            .with_context(|| format!("failed to write to {program}"))?;
    }
    Ok(child.wait()?.success())
}

fn open_extensions_page(browser: Option<&str>) -> Result<bool> {
    let url = "chrome://extensions/";

    #[cfg(target_os = "macos")]
    {
        if let Some(browser) = browser {
            return command_status("open", &["-a", browser, url]);
        }
        if command_status("open", &[url]).unwrap_or(false) {
            return Ok(true);
        }
        for app in [
            "Helium",
            "Google Chrome",
            "Chromium",
            "Brave Browser",
            "Microsoft Edge",
            "Arc",
        ] {
            if command_status("open", &["-a", app, url]).unwrap_or(false) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(browser) = browser {
            return command_status(browser, &[url]);
        }
        command_status("cmd", &["/C", "start", "", url])
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        if let Some(browser) = browser {
            return command_status(browser, &[url]);
        }
        command_status("xdg-open", &[url])
    }
}

fn reveal_extension_dir(extension_dir: &Path) -> Result<bool> {
    #[cfg(target_os = "macos")]
    {
        command_status(
            "open",
            &["-R", &extension_dir.join("manifest.json").to_string_lossy()],
        )
    }

    #[cfg(target_os = "windows")]
    {
        command_status(
            "explorer",
            &[
                "/select,",
                &extension_dir.join("manifest.json").to_string_lossy(),
            ],
        )
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        command_status("xdg-open", &[&extension_dir.to_string_lossy()])
    }
}

fn command_status(program: &str, args: &[&str]) -> Result<bool> {
    Ok(Command::new(program)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("failed to run {program}"))?
        .success())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::configure_codex;

    #[test]
    fn configure_codex_adds_bro_without_printing_token() {
        let dir = std::env::temp_dir().join(format!("bro-codex-test-{}", Uuid::new_v4()));
        let config = dir.join("config.toml");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            &config,
            r#"[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"
"#,
        )
        .unwrap();

        let report =
            configure_codex(&config, "secret-token", "127.0.0.1:3500".parse().unwrap()).unwrap();

        assert!(report.updated);
        let contents = fs::read_to_string(&config).unwrap();
        assert!(contents.contains("[mcp_servers.bro]"));
        assert!(contents.contains("url = \"http://127.0.0.1:3500/mcp\""));
        assert!(contents.contains("Authorization = \"Bearer secret-token\""));
        assert!(contents.contains("[mcp_servers.openaiDeveloperDocs]"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = fs::metadata(&config).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn configure_codex_replaces_env_token_config() {
        let dir = std::env::temp_dir().join(format!("bro-codex-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config.toml");
        fs::write(
            &config,
            r#"[mcp_servers.bro]
url = "http://127.0.0.1:3500/mcp"
bearer_token_env_var = "BRO_MCP_TOKEN"
"#,
        )
        .unwrap();

        configure_codex(&config, "fixed-token", "127.0.0.1:3500".parse().unwrap()).unwrap();

        let contents = fs::read_to_string(&config).unwrap();
        assert!(!contents.contains("bearer_token_env_var"));
        assert!(contents.contains("Authorization = \"Bearer fixed-token\""));
        fs::remove_dir_all(dir).unwrap();
    }
}

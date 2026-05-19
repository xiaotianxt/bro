use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    token: String,
    #[serde(skip)]
    path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
struct SettingsFile {
    token: String,
}

impl Settings {
    pub fn load_or_create() -> Result<Self> {
        let home = std::env::var_os("HOME").context("HOME is not set")?;
        Self::load_or_create_in(PathBuf::from(home))
    }

    pub fn load_or_create_in(home: impl AsRef<Path>) -> Result<Self> {
        let dir = home.as_ref().join(".bro");
        let path = dir.join("settings.json");

        ensure_private_dir(&dir)
            .with_context(|| format!("failed to prepare settings directory {}", dir.display()))?;

        if let Ok(contents) = fs::read_to_string(&path) {
            if let Ok(file) = serde_json::from_str::<SettingsFile>(&contents) {
                if !file.token.trim().is_empty() {
                    return Ok(Self {
                        token: file.token,
                        path,
                    });
                }
            }
        }

        let token = Uuid::new_v4().to_string();
        write_settings_file(
            &path,
            &SettingsFile {
                token: token.clone(),
            },
        )
        .with_context(|| format!("failed to write settings file {}", path.display()))?;

        Ok(Self { token, path })
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    set_dir_permissions(dir)
}

fn write_settings_file(path: &Path, file: &SettingsFile) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(file)?;

    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    set_file_mode(&mut options);

    let mut handle = options.open(path)?;
    handle.write_all(&bytes)?;
    handle.write_all(b"\n")?;
    handle.sync_all()?;
    set_file_permissions(path)?;
    Ok(())
}

#[cfg(unix)]
fn set_file_mode(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;

    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_file_mode(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn set_file_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_file_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_dir_permissions(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_dir_permissions(_dir: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::Settings;

    #[test]
    fn malformed_file_rebuilds_token() {
        let home = std::env::temp_dir().join(format!("bro-test-{}", Uuid::new_v4()));
        let settings_dir = home.join(".bro");
        fs::create_dir_all(&settings_dir).unwrap();
        fs::write(settings_dir.join("settings.json"), "{ malformed json").unwrap();

        let settings = Settings::load_or_create_in(&home).unwrap();
        assert!(!settings.token().is_empty());
        assert_eq!(
            settings.path(),
            settings_dir.join("settings.json").as_path()
        );

        let rewritten = fs::read_to_string(settings.path()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(parsed["token"], settings.token());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = fs::metadata(settings.path()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        fs::remove_dir_all(home).unwrap();
    }
}

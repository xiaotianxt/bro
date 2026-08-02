use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write};
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
    pub fn load() -> Result<Self> {
        let home = std::env::var_os("HOME").context("HOME is not set")?;
        Self::load_in(PathBuf::from(home))
    }

    pub fn load_or_create() -> Result<Self> {
        let home = std::env::var_os("HOME").context("HOME is not set")?;
        Self::load_or_create_in(PathBuf::from(home))
    }

    pub fn default_path() -> Result<PathBuf> {
        let home = std::env::var_os("HOME").context("HOME is not set")?;
        Ok(settings_path(home))
    }

    pub fn load_in(home: impl AsRef<Path>) -> Result<Self> {
        read_settings_file(&settings_path(home))
    }

    pub fn load_or_create_in(home: impl AsRef<Path>) -> Result<Self> {
        let dir = home.as_ref().join(".bro");
        let path = dir.join("settings.json");

        ensure_private_dir(&dir)
            .with_context(|| format!("failed to prepare settings directory {}", dir.display()))?;

        match read_settings_file(&path) {
            Ok(settings) => Ok(settings),
            Err(error) if io_error_kind(&error) == Some(ErrorKind::NotFound) => {
                create_settings_file(&path)
            }
            Err(error) => Err(error),
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn settings_path(home: impl AsRef<Path>) -> PathBuf {
    home.as_ref().join(".bro").join("settings.json")
}

fn read_settings_file(path: &Path) -> Result<Settings> {
    let contents = fs::read_to_string(path)
        .with_context(|| format!("failed to read settings file {}", path.display()))?;
    let file = serde_json::from_str::<SettingsFile>(&contents)
        .with_context(|| format!("settings file {} is malformed", path.display()))?;
    if file.token.trim().is_empty() {
        anyhow::bail!("settings file {} contains an empty token", path.display());
    }

    Ok(Settings {
        token: file.token,
        path: path.to_path_buf(),
    })
}

fn create_settings_file(path: &Path) -> Result<Settings> {
    let token = Uuid::new_v4().to_string();
    let file = SettingsFile {
        token: token.clone(),
    };
    let temporary_path = path.with_file_name(format!(".settings-{}.tmp", Uuid::new_v4()));
    write_new_settings_file(&temporary_path, &file).with_context(|| {
        format!(
            "failed to write temporary settings file {}",
            temporary_path.display()
        )
    })?;

    let publish_result = fs::hard_link(&temporary_path, path);
    fs::remove_file(&temporary_path).with_context(|| {
        format!(
            "failed to remove temporary settings file {}",
            temporary_path.display()
        )
    })?;

    match publish_result {
        Ok(()) => Ok(Settings {
            token,
            path: path.to_path_buf(),
        }),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => read_settings_file(path),
        Err(error) => Err(error)
            .with_context(|| format!("failed to publish settings file {}", path.display())),
    }
}

fn io_error_kind(error: &anyhow::Error) -> Option<ErrorKind> {
    error.downcast_ref::<io::Error>().map(io::Error::kind)
}

fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    set_dir_permissions(dir)
}

fn write_new_settings_file(path: &Path, file: &SettingsFile) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(file)?;

    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    set_file_mode(&mut options);

    let mut handle = options.open(path)?;
    handle.write_all(&bytes)?;
    handle.write_all(b"\n")?;
    handle.sync_all()?;
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
    use std::sync::{Arc, Barrier};
    use std::thread;

    use uuid::Uuid;

    use super::{settings_path, Settings};

    fn test_home() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("bro-test-{}", Uuid::new_v4()))
    }

    #[test]
    fn load_is_read_only_when_settings_are_missing() {
        let home = test_home();

        let error = Settings::load_in(&home).unwrap_err();

        assert!(error.to_string().contains("failed to read settings file"));
        assert!(!home.join(".bro").exists());
    }

    #[test]
    fn malformed_file_is_preserved() {
        let home = test_home();
        let settings_dir = home.join(".bro");
        let path = settings_dir.join("settings.json");
        fs::create_dir_all(&settings_dir).unwrap();
        fs::write(&path, "{ malformed json").unwrap();

        let error = Settings::load_or_create_in(&home).unwrap_err();

        assert!(error.to_string().contains("is malformed"));
        assert_eq!(fs::read_to_string(path).unwrap(), "{ malformed json");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn empty_token_file_is_preserved() {
        let home = test_home();
        let path = settings_path(&home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{\"token\":\"\"}\n").unwrap();

        let error = Settings::load_or_create_in(&home).unwrap_err();

        assert!(error.to_string().contains("contains an empty token"));
        assert_eq!(fs::read_to_string(path).unwrap(), "{\"token\":\"\"}\n");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn creates_private_settings_file() {
        let home = test_home();

        let settings = Settings::load_or_create_in(&home).unwrap();

        assert!(!settings.token().is_empty());
        assert_eq!(settings.path(), settings_path(&home));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = fs::metadata(settings.path()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn concurrent_creators_share_atomically_published_token() {
        let home = test_home();
        let barrier = Arc::new(Barrier::new(16));
        let handles = (0..16)
            .map(|_| {
                let home = home.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    Settings::load_or_create_in(home)
                })
            })
            .collect::<Vec<_>>();

        let settings = handles
            .into_iter()
            .map(|handle| handle.join().unwrap().unwrap())
            .collect::<Vec<_>>();

        assert!(settings.iter().all(|item| !item.token().is_empty()));
        assert!(settings
            .iter()
            .all(|item| item.token() == settings[0].token()));
        let files = fs::read_dir(home.join(".bro"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(files, ["settings.json"]);

        fs::remove_dir_all(home).unwrap();
    }
}

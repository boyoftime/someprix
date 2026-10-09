//! Saved hosts, trusted server keys and project settings, kept as JSON in the app data folder.
//! Passwords and key passphrases never touch these files: they live in the OS credential store
//! (Windows Credential Manager).

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};

const CREDENTIAL_SERVICE: &str = "Someprix";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    /// Private key file, when `auth` is `Key`.
    pub key_path: Option<String>,
}

impl Host {
    /// The address server keys are remembered under.
    pub fn address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    Password,
    Key,
}

/// Where a project folder pushes to.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLink {
    pub host_id: Option<String>,
    pub remote_dir: Option<String>,
    /// Project paths (files or folders) the user excluded from pushing.
    #[serde(default)]
    pub excluded: Vec<String>,
    /// Whether pushes keep a backup on the server; None follows the setting for all projects.
    #[serde(default)]
    pub backup: Option<bool>,
}

/// Which pushes keep a backup of the server files they replace or delete.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackupMode {
    /// Every project, unless switched off for one.
    #[default]
    All,
    /// Only projects switched on.
    Chosen,
    Off,
}

/// What the user can change on the Settings page (the rest lives in the frontend).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub backups: BackupMode,
    /// SFTP uploads that replace server files keep a backup too.
    pub backup_sftp: bool,
    /// Backups kept per project: the newest pushes, none older than this many days, and no
    /// more than this many megabytes in all (the oldest go first).
    pub keep_pushes: u32,
    pub keep_days: u32,
    pub max_backup_mb: u64,
    /// Files bigger than this are replaced without a backup.
    pub skip_over_mb: u64,
    /// Where backups go on the server; "~" is the login's home folder.
    pub backup_root: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            backups: BackupMode::All,
            backup_sftp: true,
            keep_pushes: 10,
            keep_days: 14,
            max_backup_mb: 200,
            skip_over_mb: 50,
            backup_root: "~/.someprix/backups".into(),
        }
    }
}

impl Settings {
    /// Whether a project with this choice keeps backups.
    pub fn backs_up(&self, choice: Option<bool>) -> bool {
        match self.backups {
            BackupMode::Off => false,
            BackupMode::All => choice.unwrap_or(true),
            BackupMode::Chosen => choice.unwrap_or(false),
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Data {
    hosts: Vec<Host>,
    /// "host:port" → SHA256 fingerprint of the server key the user accepted.
    known_hosts: HashMap<String, String>,
    /// The project folder that was open last.
    active_project: Option<String>,
    projects: HashMap<String, ProjectLink>,
    settings: Settings,
}

pub struct Store {
    dir: PathBuf,
    data: Mutex<Data>,
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let data = fs::read_to_string(dir.join("state.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self {
            dir,
            data: Mutex::new(data),
        }
    }

    fn update<T>(&self, change: impl FnOnce(&mut Data) -> T) -> Result<T, String> {
        let mut data = self.data.lock().unwrap();
        let result = change(&mut data);
        let text = serde_json::to_string_pretty(&*data).map_err(|e| e.to_string())?;
        write_atomic(&self.dir.join("state.json"), text.as_bytes())?;
        Ok(result)
    }

    pub fn hosts(&self) -> Vec<Host> {
        self.data.lock().unwrap().hosts.clone()
    }

    pub fn host(&self, id: &str) -> Option<Host> {
        self.data.lock().unwrap().hosts.iter().find(|h| h.id == id).cloned()
    }

    pub fn save_host(&self, host: Host) -> Result<(), String> {
        self.update(|data| match data.hosts.iter_mut().find(|h| h.id == host.id) {
            Some(existing) => *existing = host,
            None => data.hosts.push(host),
        })
    }

    /// Removes the host, its saved password, and its trusted server key (unless another saved
    /// host points at the same address).
    pub fn remove_host(&self, id: &str) -> Result<(), String> {
        self.update(|data| {
            let Some(removed) = data.hosts.iter().position(|h| h.id == id).map(|i| data.hosts.remove(i)) else {
                return;
            };
            let address = removed.address();
            if !data.hosts.iter().any(|h| h.address() == address) {
                data.known_hosts.remove(&address);
            }
        })?;
        delete_secret(id);
        Ok(())
    }

    pub fn known_host(&self, address: &str) -> Option<String> {
        self.data.lock().unwrap().known_hosts.get(address).cloned()
    }

    pub fn trust_host(&self, address: &str, fingerprint: &str) -> Result<(), String> {
        self.update(|data| {
            data.known_hosts.insert(address.to_string(), fingerprint.to_string());
        })
    }

    pub fn active_project(&self) -> Option<String> {
        self.data.lock().unwrap().active_project.clone()
    }

    pub fn set_active_project(&self, root: Option<&str>) -> Result<(), String> {
        self.update(|data| data.active_project = root.map(str::to_string))
    }

    pub fn project_link(&self, root: &str) -> ProjectLink {
        self.data.lock().unwrap().projects.get(root).cloned().unwrap_or_default()
    }

    pub fn set_project_link(&self, root: &str, link: ProjectLink) -> Result<(), String> {
        self.update(|data| {
            data.projects.insert(root.to_string(), link);
        })
    }

    pub fn projects(&self) -> Vec<(String, ProjectLink)> {
        let mut list: Vec<_> = self.data.lock().unwrap().projects.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        list.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
        list
    }

    pub fn settings(&self) -> Settings {
        self.data.lock().unwrap().settings.clone()
    }

    pub fn set_settings(&self, settings: Settings) -> Result<(), String> {
        self.update(|data| data.settings = settings)
    }

    /// The history of SFTP uploads (and their backups).
    pub fn sftp_history_path(&self) -> PathBuf {
        self.dir.join("history").join("sftp.json")
    }

    /// Unsaved editor text, kept so it comes back after a crash.
    pub fn drafts_dir(&self) -> PathBuf {
        self.dir.join("drafts")
    }

    /// Where a project's "last pushed" snapshot is kept.
    pub fn baseline_path(&self, root: &str) -> PathBuf {
        let id = xxhash_rust::xxh3::xxh3_64(root.as_bytes());
        self.dir.join("baselines").join(format!("{id:016x}.json"))
    }
}

/// Writes through a temporary file, flushed to disk before it takes the real name, so neither a
/// crash nor a power cut can leave a half-written file behind.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension("tmp");
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temp, path).map_err(|e| e.to_string())
}

fn credential(host_id: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(CREDENTIAL_SERVICE, &format!("host:{host_id}"))
}

/// The password (or key passphrase) saved for a host.
pub fn secret(host_id: &str) -> Option<String> {
    credential(host_id).ok()?.get_password().ok()
}

pub fn set_secret(host_id: &str, secret: &str) -> Result<(), String> {
    credential(host_id)
        .and_then(|entry| entry.set_password(secret))
        .map_err(|e| format!("Credential save failed: {e}"))
}

pub fn delete_secret(host_id: &str) {
    if let Ok(entry) = credential(host_id) {
        let _ = entry.delete_credential();
    }
}

//! Backups of the server files a push (or an SFTP upload) replaces or deletes, kept on the server
//! so the change can be undone, and the history of those changes.
//!
//! An old copy is kept by hard-linking it into the backup folder: instant, and it takes no extra
//! space until the file is replaced. Where that can't work (the backup folder is on another disk,
//! or the server has no hard links), the server copies it there instead. Undo moves the kept
//! copies back and removes what the change added.

use std::{
    collections::HashSet,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::{
    conflicts,
    project::{ServerSig, Sig},
    ssh::{self, Connection},
    store::{write_atomic, Settings},
    turbo,
};

/// How long the server may take to copy or move files around.
const SCRIPT_LIMIT: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Added,
    Changed,
    Deleted,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryFile {
    /// Relative to the entry's `remote_dir`.
    pub path: String,
    pub action: Action,
    /// The old server copy is in the backup folder.
    pub backed_up: bool,
    /// The old copy's size (changed, deleted), or the new one's (added).
    pub size: u64,
    /// The server copy right after the change, so undo can tell if anyone changed it since.
    pub after: Option<ServerSig>,
    /// Projects: what the file was last pushed as before this push; undo puts that record back.
    #[serde(default)]
    pub before: Option<Sig>,
}

/// One push or upload, as it changed the server.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    /// Seconds since 1970.
    pub at: u64,
    pub host_id: String,
    pub remote_dir: String,
    /// Where the old copies are on the server; none when backups were off (or cleared).
    pub backup_dir: Option<String>,
    pub files: Vec<EntryFile>,
    /// Folders the change created (absolute), removed again by undo when they're empty.
    #[serde(default)]
    pub created_dirs: Vec<String>,
}

impl Entry {
    pub fn new(host_id: &str, remote_dir: &str, backup_dir: Option<String>, id: String) -> Self {
        Self {
            id,
            at: now(),
            host_id: host_id.to_string(),
            remote_dir: remote_dir.to_string(),
            backup_dir,
            files: Vec::new(),
            created_dirs: Vec::new(),
        }
    }

    pub fn backup_bytes(&self) -> u64 {
        if self.backup_dir.is_none() {
            return 0;
        }
        self.files.iter().filter(|f| f.backed_up).map(|f| f.size).sum()
    }
}

// ---------- History on this computer ----------

pub fn load(path: &Path) -> Vec<Entry> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, entries: &[Entry]) {
    if let Ok(text) = serde_json::to_string(entries) {
        let _ = write_atomic(path, text.as_bytes());
    }
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// A backup folder's name: when it was made (UTC), plus a little randomness.
pub fn new_id() -> String {
    let secs = now();
    let (y, m, d) = civil((secs / 86_400) as i64);
    let t = secs % 86_400;
    let random = uuid::Uuid::new_v4().simple().to_string();
    format!("{y:04}-{m:02}-{d:02}_{:02}-{:02}-{:02}Z-{}", t / 3600, t / 60 % 60, t % 60, &random[..4])
}

/// Year, month, day of a day count since 1970 (H. Hinnant's algorithm).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

// ---------- Where backups go ----------

/// The backup folder setting as an absolute server path ("~" is the login's home folder).
pub fn root(conn: &Connection, setting: &str) -> String {
    let setting = setting.trim().trim_end_matches('/');
    let home = conn.home();
    if setting.is_empty() || setting == "~" {
        return ssh::join(home, ".someprix/backups");
    }
    if let Some(rest) = setting.strip_prefix("~/") {
        return ssh::join(home, rest);
    }
    if setting.starts_with('/') {
        return setting.to_string();
    }
    ssh::join(home, setting)
}

/// A project's folder under the backup root: its name, plus a tag that tells apart projects (and
/// destinations) with the same name.
pub fn project_scope(name: &str, key: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .take(40)
        .collect();
    let tag = xxhash_rust::xxh3::xxh3_64(key.as_bytes()) as u32;
    format!("{}-{tag:08x}", safe.trim_matches('.'))
}

pub const SFTP_SCOPE: &str = "sftp";

/// Whether the server runs commands (an SFTP-only login doesn't).
pub async fn has_shell(conn: &Connection) -> bool {
    conn.exec("command -v mv && command -v cp && command -v rm", Duration::from_secs(15))
        .await
        .is_ok_and(|(code, _)| code == 0)
}

fn parent(path: &str) -> String {
    match path.trim_end_matches('/').rsplit_once('/') {
        Some(("", _)) | None => "/".into(),
        Some((dir, _)) => dir.to_string(),
    }
}

/// Creates every missing folder along an absolute path.
pub async fn make_dirs(conn: &Connection, abs: &str, made: &mut HashSet<String>) -> Result<(), String> {
    let mut current = String::new();
    for part in abs.split('/').filter(|p| !p.is_empty()) {
        current = format!("{current}/{part}");
        if made.contains(&current) {
            continue;
        }
        if !conn.sftp.try_exists(current.as_str()).await.unwrap_or(false) {
            conn.create_dir(&current).await?;
        }
        made.insert(current.clone());
    }
    Ok(())
}

/// Runs a shell script on the server, written to a file first (a long list of files would be too
/// much for one command line). Returns the exit code and what it printed.
async fn run_script(conn: &Connection, dir: &str, script: &str) -> Result<(u32, String), String> {
    let random = uuid::Uuid::new_v4().simple().to_string();
    let file = ssh::join(dir, &format!(".someprix-run-{}.sh", &random[..8]));
    conn.upload(&file, script.as_bytes(), |_| {}).await?;
    let result = conn.exec(&format!("sh {}", ssh::sh_quote(&file)), SCRIPT_LIMIT).await;
    let _ = conn.remove(&file).await;
    result
}

/// The numbers a script printed on lines of their own (the items it finished).
fn finished(output: &str) -> HashSet<usize> {
    output.lines().filter_map(|line| line.trim().parse().ok()).collect()
}

/// Keeps the current server copies of `paths` (relative to `remote_dir`) in `backup_dir`, under
/// the same relative paths. Returns which of them were kept.
pub async fn keep(
    lanes: &[Arc<Connection>],
    shell: bool,
    remote_dir: &str,
    backup_dir: &str,
    paths: &[String],
) -> Result<Vec<bool>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let conn = &lanes[0];
    // Folders one at a time: two lanes making the same one would trip over each other.
    let mut made = HashSet::new();
    let mut dirs: Vec<String> = paths.iter().map(|p| parent(&ssh::join(backup_dir, p))).collect();
    dirs.sort();
    dirs.dedup();
    for dir in &dirs {
        make_dirs(conn, dir, &mut made).await?;
    }

    // A hard link first: instant, and no extra space.
    let kept: Vec<AtomicBool> = paths.iter().map(|_| AtomicBool::new(false)).collect();
    let every: Vec<usize> = (0..paths.len()).collect();
    let kept_ref = &kept;
    turbo::each(lanes, turbo::UPLOAD_STREAMS, &every, |lane, i| async move {
        let from = ssh::join(remote_dir, &paths[i]);
        let to = ssh::join(backup_dir, &paths[i]);
        if matches!(lane.sftp.hardlink(from.as_str(), to.as_str()).await, Ok(true)) {
            kept_ref[i].store(true, Ordering::Relaxed);
        }
        Ok(true)
    })
    .await?;

    // On another disk (or no hard links): a copy, made on the server.
    let missing: Vec<usize> = every.iter().copied().filter(|&i| !kept[i].load(Ordering::Relaxed)).collect();
    if !missing.is_empty() && shell {
        let mut script = String::new();
        for &i in &missing {
            let from = ssh::sh_quote(&ssh::join(remote_dir, &paths[i]));
            let to = ssh::sh_quote(&ssh::join(backup_dir, &paths[i]));
            script.push_str(&format!("cp -p {from} {to} && echo {i}\n"));
        }
        if let Ok((_, output)) = run_script(conn, backup_dir, &script).await {
            for i in finished(&output) {
                if let Some(flag) = kept.get(i) {
                    flag.store(true, Ordering::Relaxed);
                }
            }
        }
    }
    Ok(kept.into_iter().map(AtomicBool::into_inner).collect())
}

/// The backup root a backup folder ("<root>/<scope>/<id>") sits under.
pub fn scope_root(backup_dir: &str) -> String {
    parent(&parent(backup_dir))
}

/// How each of `paths` (relative to `remote_dir`) looks on the server now; None where there's no
/// file. All lanes at once.
pub async fn stat_all(lanes: &[Arc<Connection>], remote_dir: &str, paths: &[String]) -> Result<Vec<Option<ServerSig>>, String> {
    let found: Vec<Mutex<Option<ServerSig>>> = paths.iter().map(|_| Mutex::new(None)).collect();
    let every: Vec<usize> = (0..paths.len()).collect();
    let found_ref = &found;
    turbo::each(lanes, turbo::UPLOAD_STREAMS, &every, |lane, i| async move {
        *found_ref[i].lock().unwrap() = conflicts::server_sig(&lane, &ssh::join(remote_dir, &paths[i])).await?;
        Ok(true)
    })
    .await?;
    Ok(found.into_iter().map(|m| m.into_inner().unwrap()).collect())
}

/// Deletes a backup folder with everything in it; refuses anything outside `root`.
pub async fn delete_dir(conn: &Connection, shell: bool, root: &str, path: &str) {
    if !path.starts_with(&format!("{}/", root.trim_end_matches('/'))) {
        return;
    }
    if shell {
        let _ = conn.exec(&format!("rm -rf -- {}", ssh::sh_quote(path)), SCRIPT_LIMIT).await;
    } else {
        let _ = conn.delete_tree(path).await;
    }
}

/// Drops the history entries past the limits (the newest always stays) and deletes their backups
/// on this server, along with any backup folder in `scope_dir` that no entry knows of. Entries of
/// other servers are dropped too; their folders go the next time that server is pruned.
pub async fn prune(
    conn: &Connection,
    shell: bool,
    settings: &Settings,
    root: &str,
    scope_dir: &str,
    host_id: &str,
    entries: Vec<Entry>,
) -> Vec<Entry> {
    let now = now();
    let max_bytes = settings.max_backup_mb.saturating_mul(1024 * 1024);
    let max_age = u64::from(settings.keep_days) * 86_400;
    let mut bytes = 0;
    let mut kept = Vec::new();
    for (i, entry) in entries.into_iter().enumerate() {
        let within = i < settings.keep_pushes.max(1) as usize
            && now.saturating_sub(entry.at) <= max_age
            && bytes + entry.backup_bytes() <= max_bytes;
        if i == 0 || within {
            bytes += entry.backup_bytes();
            kept.push(entry);
        } else if entry.host_id == host_id {
            if let Some(dir) = &entry.backup_dir {
                delete_dir(conn, shell, root, dir).await;
            }
        }
    }
    if let Ok(list) = conn.list(scope_dir).await {
        for item in list.iter().filter(|item| item.is_dir) {
            if !kept.iter().any(|e| e.backup_dir.as_deref() == Some(item.path.as_str())) {
                delete_dir(conn, shell, root, &item.path).await;
            }
        }
    }
    kept
}

// ---------- Undo ----------

/// The files changed on the server since the entry's change, which undo would replace.
pub async fn changed_since(conn: &Connection, entry: &Entry) -> Vec<String> {
    let mut changed = Vec::new();
    for file in &entry.files {
        let now = conflicts::server_sig(conn, &ssh::join(&entry.remote_dir, &file.path)).await.ok().flatten();
        if now.is_some() && now != file.after {
            changed.push(file.path.clone());
        }
    }
    changed
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Undone {
    /// Old copies put back.
    pub restored: usize,
    /// Files the change added, removed.
    pub removed: usize,
    /// Files that had no backup, left as they are.
    pub missed: usize,
    /// Paths put back or removed, for the caller to update its records.
    #[serde(skip)]
    pub done: Vec<String>,
}

/// Puts the server back as it was before `entry`: old copies back in place, added files removed,
/// folders it created removed if empty, and its backup folder deleted.
pub async fn undo(lanes: &[Arc<Connection>], shell: bool, entry: &Entry) -> Result<Undone, String> {
    let conn = &lanes[0];
    let target = |rel: &str| ssh::join(&entry.remote_dir, rel);
    let mut undone = Undone::default();
    let done = Mutex::new(Vec::new());

    let restores: Vec<&EntryFile> = entry.files.iter().filter(|f| f.action != Action::Added && f.backed_up).collect();
    undone.missed = entry.files.iter().filter(|f| f.action != Action::Added && !f.backed_up).count();
    if let (Some(backup), false) = (&entry.backup_dir, restores.is_empty()) {
        if shell {
            // One script: `mv -f` replaces each file in one step, and copies across disks.
            let mut script = String::new();
            for (i, file) in restores.iter().enumerate() {
                let to = target(&file.path);
                script.push_str(&format!(
                    "mkdir -p {dir} && mv -f {from} {to} && echo {i}\n",
                    dir = ssh::sh_quote(&parent(&to)),
                    from = ssh::sh_quote(&ssh::join(backup, &file.path)),
                    to = ssh::sh_quote(&to),
                ));
            }
            let (_, output) = run_script(conn, backup, &script).await?;
            let finished = finished(&output);
            for (i, file) in restores.iter().enumerate() {
                if finished.contains(&i) {
                    done.lock().unwrap().push(file.path.clone());
                }
            }
        } else {
            let mut made = HashSet::new();
            let mut dirs: Vec<String> = restores.iter().map(|f| parent(&target(&f.path))).collect();
            dirs.sort();
            dirs.dedup();
            for dir in &dirs {
                make_dirs(conn, dir, &mut made).await?;
            }
            let every: Vec<usize> = (0..restores.len()).collect();
            let (restores, done) = (&restores, &done);
            turbo::each(lanes, turbo::UPLOAD_STREAMS, &every, |lane, i| async move {
                let file = restores[i];
                let to = ssh::join(&entry.remote_dir, &file.path);
                lane.remove(&to).await?;
                lane.rename(&ssh::join(backup, &file.path), &to).await?;
                done.lock().unwrap().push(file.path.clone());
                Ok(true)
            })
            .await?;
        }
    }
    undone.restored = done.lock().unwrap().len();

    let added: Vec<&EntryFile> = entry.files.iter().filter(|f| f.action == Action::Added).collect();
    let every: Vec<usize> = (0..added.len()).collect();
    let (added_ref, done_ref) = (&added, &done);
    turbo::each(lanes, turbo::UPLOAD_STREAMS, &every, |lane, i| async move {
        lane.remove(&ssh::join(&entry.remote_dir, &added_ref[i].path)).await?;
        done_ref.lock().unwrap().push(added_ref[i].path.clone());
        Ok(true)
    })
    .await?;
    undone.removed = added.len();

    // Folders the change made, deepest first, and their new parents, while they're empty.
    let mut dirs = entry.created_dirs.clone();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.len()));
    let base = entry.remote_dir.trim_end_matches('/').to_string();
    for dir in dirs {
        let mut current = dir;
        while current.len() > base.len() && current.starts_with(&base) && conn.remove_dir(&current).await.is_ok() {
            current = parent(&current);
        }
    }
    if let Some(backup) = &entry.backup_dir {
        delete_dir(conn, shell, &scope_root(backup), backup).await;
    }
    undone.done = done.into_inner().unwrap();
    Ok(undone)
}

//! The local side of the SFTP page: browsing any folder on this computer, and turning dropped
//! files and folders into an upload plan.

use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub modified: Option<u64>,
}

/// A server name made safe for Windows: characters Windows doesn't allow become "_", trailing
/// dots and spaces go, and reserved device names (CON, NUL, COM1…) get a "_" in front.
pub fn safe_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| if c < ' ' || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    while out.ends_with('.') || out.ends_with(' ') {
        out.pop();
    }
    if out.is_empty() {
        return "_".into();
    }
    let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    let numbered = |prefix: &str| {
        stem.len() == 4 && stem.starts_with(prefix) && matches!(stem.as_bytes()[3], b'1'..=b'9')
    };
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered("COM") || numbered("LPT") {
        out.insert(0, '_');
    }
    out
}

/// The local path of a `/`-separated path relative to `base`.
pub fn under(base: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(base.to_path_buf(), |path, part| path.join(part))
}

/// What the Properties dialog shows for one item. Folders are counted through: their size and
/// counts cover everything inside.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ItemProps {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// A link (symlink or junction): shown, not followed.
    pub link: bool,
    pub size: u64,
    pub files: u64,
    pub folders: u64,
    /// Seconds since the Unix epoch.
    pub modified: Option<u64>,
    pub created: Option<u64>,
    /// Server only, e.g. "drwxr-xr-x (755)".
    pub mode: Option<String>,
    /// Server only: "user:group".
    pub owner: Option<String>,
    /// This computer only.
    pub readonly: Option<bool>,
    pub hidden: Option<bool>,
    /// Some contents couldn't be read, so the totals may be low.
    pub partial: bool,
}

fn seconds(time: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    time.ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
}

#[cfg(windows)]
fn is_hidden(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x2 != 0
}

#[cfg(not(windows))]
fn is_hidden(_: &fs::Metadata) -> bool {
    false
}

/// Properties of a file or folder on this computer. A folder is walked through (links are not
/// followed); `cancelled` stops the walk early.
pub fn properties(path: &str, cancelled: &dyn Fn() -> bool) -> Result<ItemProps, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("Not found: {path}: {e}"))?;
    let link = meta.file_type().is_symlink();
    let mut props = ItemProps {
        name: Path::new(path)
            .file_name()
            .map_or_else(|| path.to_string(), |n| n.to_string_lossy().into_owned()),
        path: path.to_string(),
        is_dir: meta.is_dir(),
        link,
        size: if meta.is_dir() { 0 } else { meta.len() },
        files: u64::from(!meta.is_dir()),
        modified: seconds(meta.modified()),
        created: seconds(meta.created()),
        readonly: Some(meta.permissions().readonly()),
        hidden: Some(is_hidden(&meta)),
        ..Default::default()
    };
    if !meta.is_dir() || link {
        return Ok(props);
    }
    let mut to_visit = vec![PathBuf::from(path)];
    while let Some(dir) = to_visit.pop() {
        if cancelled() {
            return Err("Cancelled".into());
        }
        let Ok(read) = fs::read_dir(&dir) else {
            props.partial = true;
            continue;
        };
        for entry in read {
            let Ok(entry) = entry else {
                props.partial = true;
                continue;
            };
            let Ok(kind) = entry.file_type() else {
                props.partial = true;
                continue;
            };
            if kind.is_dir() {
                props.folders += 1;
                to_visit.push(entry.path());
            } else {
                props.files += 1;
                props.size += entry.metadata().map_or(0, |m| m.len());
            }
        }
    }
    Ok(props)
}

/// Transfers land under this suffix and are renamed into place only once all of them arrived.
pub const PART_SUFFIX: &str = ".someprix-part";

/// Creates the folders along `rel` under `base` that don't exist yet, noting each one made.
pub fn make_dirs(base: &Path, rel: &str, created: &mut Vec<PathBuf>) -> Result<(), String> {
    let mut path = base.to_path_buf();
    for part in rel.split('/') {
        path.push(part);
        if path.is_dir() {
            continue;
        }
        fs::create_dir(&path).map_err(|e| format!("Create failed: {}: {e}", path.display()))?;
        created.push(path.clone());
    }
    Ok(())
}

/// Removes what an unfinished download put on this computer: its temporary files, then the
/// folders it created (deepest first). Returns how many of those couldn't be removed.
pub fn undo(staged: &[(PathBuf, PathBuf)], created: &[PathBuf]) -> usize {
    let mut left = 0;
    for (temp, _) in staged {
        if temp.exists() && fs::remove_file(temp).is_err() {
            left += 1;
        }
    }
    for dir in created.iter().rev() {
        if fs::remove_dir(dir).is_err() {
            left += 1;
        }
    }
    left
}

/// The user's home folder, where the local browser starts.
pub fn home() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| "C:\\".into())
}

/// Lists a folder (dot files included). An empty path lists the drives.
pub fn list(path: &str) -> Result<Vec<LocalFsEntry>, String> {
    if path.is_empty() {
        return Ok(drives());
    }
    let read = fs::read_dir(path).map_err(|e| format!("Open failed: {path}: {e}"))?;
    let mut entries: Vec<LocalFsEntry> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            Some(LocalFsEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path().to_string_lossy().into_owned(),
                is_dir: meta.is_dir(),
                size: if meta.is_dir() { 0 } else { meta.len() },
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs()),
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn drives() -> Vec<LocalFsEntry> {
    (b'A'..=b'Z')
        .map(|letter| format!("{}:\\", letter as char))
        .filter(|root| Path::new(root).exists())
        .map(|root| LocalFsEntry {
            name: root.trim_end_matches('\\').to_string(),
            path: root,
            is_dir: true,
            size: 0,
            modified: None,
        })
        .collect()
}

/// One file to upload: where it is, and its path relative to the drop target.
pub struct PlannedFile {
    pub local: PathBuf,
    pub rel: String,
    pub size: u64,
}

/// What dropping `sources` onto a server folder uploads: every file, and every folder to
/// create (so empty folders arrive too). Relative paths use forward slashes.
pub struct UploadPlan {
    pub files: Vec<PlannedFile>,
    pub folders: Vec<String>,
    /// The top-level names written into the target folder.
    pub roots: Vec<String>,
}

pub fn plan(sources: &[String]) -> Result<UploadPlan, String> {
    let mut plan = UploadPlan {
        files: Vec::new(),
        folders: Vec::new(),
        roots: Vec::new(),
    };
    for source in sources {
        let path = PathBuf::from(source);
        let name = path
            .file_name()
            .ok_or_else(|| format!("Invalid path: {source}"))?
            .to_string_lossy()
            .into_owned();
        let meta = fs::metadata(&path).map_err(|e| format!("Read failed: {source}: {e}"))?;
        plan.roots.push(name.clone());
        if meta.is_file() {
            plan.files.push(PlannedFile {
                local: path,
                rel: name,
                size: meta.len(),
            });
            continue;
        }
        plan.folders.push(name.clone());
        for entry in ignore::WalkBuilder::new(&path)
            .standard_filters(false)
            .follow_links(false)
            .build()
            .filter_map(Result::ok)
        {
            let Ok(inner) = entry.path().strip_prefix(&path) else { continue };
            if inner.as_os_str().is_empty() {
                continue;
            }
            let rel = format!("{name}/{}", inner.to_string_lossy().replace('\\', "/"));
            match entry.file_type() {
                Some(t) if t.is_dir() => plan.folders.push(rel),
                Some(t) if t.is_file() => plan.files.push(PlannedFile {
                    size: entry.metadata().map_or(0, |m| m.len()),
                    local: entry.into_path(),
                    rel,
                }),
                _ => {}
            }
        }
    }
    Ok(plan)
}

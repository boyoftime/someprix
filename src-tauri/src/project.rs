//! Tracks a local project folder against a snapshot of what was last pushed, so the app can
//! show which files changed and push exactly those to the server.
//!
//! The snapshot (the "baseline") records each file's size, modified time and content hash. A
//! file counts as changed only when its content differs, so saving without editing doesn't mark
//! it. The baseline is stored on disk, so edits made while the app is closed still show up.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs, io,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex,
    },
    time::{Duration, UNIX_EPOCH},
};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::store::write_atomic;

pub const CHANGES_EVENT: &str = "project://changes";

/// Always skipped, on top of the project's own .gitignore.
const DEFAULT_IGNORES: &[&str] = &[
    ".git/",
    "node_modules/",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    "*.swp",
    "*.swx",
    "*~",
    "*___jb_tmp___",
    "*___jb_old___",
];

/// How long the folder has to be quiet before changes are re-checked (editors often write a
/// file in several steps).
const SETTLE: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sig {
    pub size: u64,
    pub mtime: u64,
    pub hash: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Clone, Debug, Serialize)]
pub struct Change {
    pub path: String,
    pub kind: ChangeKind,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

pub struct Project {
    pub root: PathBuf,
    generation: u64,
    ignore: Gitignore,
    baseline: HashMap<String, Sig>,
    baseline_file: PathBuf,
    changes: BTreeMap<String, ChangeKind>,
    _watcher: RecommendedWatcher,
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

pub type SharedProject = Arc<Mutex<Option<Project>>>;

/// Opens `root`, compares it with its baseline (creating one if this folder is new), and starts
/// watching it. Changes are emitted as `project://changes` whenever they settle.
pub fn open(app: &AppHandle, shared: &SharedProject, root: &Path, baseline_file: PathBuf) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!("Not a folder: {}", root.display()));
    }
    let ignore = build_ignore(root);
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| format!("Watch failed: {e}"))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| format!("Watch failed: {e}"))?;

    let saved: Option<HashMap<String, Sig>> = fs::read_to_string(&baseline_file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok());

    let mut project = Project {
        root: root.to_path_buf(),
        generation,
        ignore,
        baseline: HashMap::new(),
        baseline_file,
        changes: BTreeMap::new(),
        _watcher: watcher,
    };
    match saved {
        Some(baseline) => {
            project.baseline = baseline;
            project.rescan();
        }
        None => {
            // A folder seen for the first time: everything in it counts as already on the server.
            project.baseline = project.snapshot();
            project.save_baseline();
        }
    }

    *shared.lock().unwrap() = Some(project);
    spawn_settler(app.clone(), shared.clone(), generation, rx);
    Ok(())
}

/// Collects watcher events and re-checks the touched paths once the folder goes quiet.
fn spawn_settler(
    app: AppHandle,
    shared: SharedProject,
    generation: u64,
    rx: mpsc::Receiver<notify::Result<notify::Event>>,
) {
    std::thread::spawn(move || {
        let mut pending: HashSet<PathBuf> = HashSet::new();
        let mut rescan = false;
        loop {
            let wait = if pending.is_empty() && !rescan {
                Duration::from_secs(3600)
            } else {
                SETTLE
            };
            match rx.recv_timeout(wait) {
                Ok(Ok(event)) => {
                    if !matches!(event.kind, EventKind::Access(_)) {
                        pending.extend(event.paths);
                    }
                }
                // The watcher lost track (e.g. too many events at once): check everything.
                Ok(Err(_)) => rescan = true,
                Err(RecvTimeoutError::Timeout) => {
                    if pending.is_empty() && !rescan {
                        continue;
                    }
                    let paths: Vec<PathBuf> = pending.drain().collect();
                    let changes = {
                        let mut guard = shared.lock().unwrap();
                        let Some(project) = guard.as_mut().filter(|p| p.generation == generation) else {
                            return;
                        };
                        if std::mem::take(&mut rescan) {
                            project.rescan();
                        } else {
                            project.refresh(&paths);
                        }
                        project.changes()
                    };
                    let _ = app.emit(CHANGES_EVENT, changes);
                }
                // The project was closed or replaced, which drops the watcher.
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}

fn build_ignore(root: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(root);
    let gitignore = root.join(".gitignore");
    if gitignore.is_file() {
        let _ = builder.add(gitignore);
    }
    for line in DEFAULT_IGNORES {
        let _ = builder.add_line(None, line);
    }
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

/// Project-relative path with forward slashes, the form used everywhere outside this module.
fn rel_path(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let text = rel.to_string_lossy().replace('\\', "/");
    (!text.is_empty()).then_some(text)
}

pub fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

fn hash_file(path: &Path) -> io::Result<u64> {
    let mut file = fs::File::open(path)?;
    let mut hasher = xxhash_rust::xxh3::Xxh3::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(hasher.digest());
        }
        hasher.update(&buffer[..read]);
    }
}

pub fn signature(path: &Path) -> io::Result<Sig> {
    let meta = fs::metadata(path)?;
    Ok(Sig {
        size: meta.len(),
        mtime: mtime_ms(&meta),
        hash: hash_file(path)?,
    })
}

impl Project {
    pub fn is_ignored(&self, path: &Path, is_dir: bool) -> bool {
        path.starts_with(&self.root)
            && path != self.root
            && self.ignore.matched_path_or_any_parents(path, is_dir).is_ignore()
    }

    /// Every tracked file under `dir` (absolute), as project-relative paths.
    fn walk(&self, dir: &Path) -> Vec<String> {
        let ignore = self.ignore.clone();
        let root = self.root.clone();
        ignore::WalkBuilder::new(dir)
            .standard_filters(false)
            .follow_links(false)
            .filter_entry(move |entry| {
                let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
                entry.path() == root || !ignore.matched_path_or_any_parents(entry.path(), is_dir).is_ignore()
            })
            .build()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_some_and(|t| t.is_file()))
            .filter_map(|entry| rel_path(&self.root, entry.path()))
            .collect()
    }

    fn snapshot(&self) -> HashMap<String, Sig> {
        self.walk(&self.root)
            .into_iter()
            .filter_map(|rel| Some((rel.clone(), signature(&self.root.join(&rel)).ok()?)))
            .collect()
    }

    pub fn save_baseline(&self) {
        if let Ok(text) = serde_json::to_string(&self.baseline) {
            let _ = write_atomic(&self.baseline_file, text.as_bytes());
        }
    }

    pub fn changes(&self) -> Vec<Change> {
        self.changes
            .iter()
            .map(|(path, kind)| Change {
                path: path.clone(),
                kind: *kind,
            })
            .collect()
    }

    /// Re-checks the whole folder against the baseline.
    pub fn rescan(&mut self) {
        self.changes.clear();
        let present = self.walk(&self.root);
        let present_set: HashSet<&String> = present.iter().collect();
        let mut touched = false;
        for rel in &present {
            touched |= self.check(rel);
        }
        let gone: Vec<String> = self
            .baseline
            .keys()
            .filter(|rel| !present_set.contains(rel))
            .cloned()
            .collect();
        for rel in gone {
            self.changes.insert(rel, ChangeKind::Deleted);
        }
        if touched {
            self.save_baseline();
        }
    }

    /// Re-checks the given absolute paths (files or folders) after the watcher saw them change.
    pub fn refresh(&mut self, paths: &[PathBuf]) {
        let mut touched = false;
        for path in paths {
            let Some(rel) = rel_path(&self.root, path) else {
                continue;
            };
            let is_dir = path.is_dir();
            if self.is_ignored(path, is_dir) {
                continue;
            }
            if is_dir {
                for file in self.walk(path) {
                    touched |= self.check(&file);
                }
            } else {
                touched |= self.check(&rel);
            }
            // Files under a folder that was deleted or renamed away.
            let prefix = format!("{rel}/");
            let under: Vec<String> = self
                .baseline
                .keys()
                .chain(self.changes.keys())
                .filter(|known| known.starts_with(&prefix))
                .cloned()
                .collect();
            for known in under {
                touched |= self.check(&known);
            }
        }
        if touched {
            self.save_baseline();
        }
    }

    /// Updates the change state of one file. Returns true if the baseline was touched (a file
    /// was re-saved with identical content, so only its modified time moved).
    fn check(&mut self, rel: &str) -> bool {
        let path = self.root.join(rel);
        let mut touched = false;
        let kind = match fs::metadata(&path) {
            Ok(meta) if meta.is_file() => match self.baseline.get_mut(rel) {
                None => Some(ChangeKind::Added),
                Some(base) => {
                    let (size, mtime) = (meta.len(), mtime_ms(&meta));
                    if base.size == size && base.mtime == mtime {
                        None
                    } else if base.size != size {
                        Some(ChangeKind::Modified)
                    } else {
                        match hash_file(&path) {
                            Ok(hash) if hash == base.hash => {
                                base.mtime = mtime;
                                touched = true;
                                None
                            }
                            _ => Some(ChangeKind::Modified),
                        }
                    }
                }
            },
            _ => self.baseline.contains_key(rel).then_some(ChangeKind::Deleted),
        };
        match kind {
            Some(kind) => {
                self.changes.insert(rel.to_string(), kind);
            }
            None => {
                self.changes.remove(rel);
            }
        }
        touched
    }

    /// Records that `rel` is now on the server with signature `sig` (or, with `None`, that it
    /// was deleted there), then re-checks it in case it changed again during the push.
    pub fn mark_pushed(&mut self, rel: &str, sig: Option<Sig>) {
        match sig {
            Some(sig) => {
                self.baseline.insert(rel.to_string(), sig);
            }
            None => {
                self.baseline.remove(rel);
            }
        }
        self.check(rel);
    }

    /// Lists one folder of the project (non-recursive), skipping ignored entries.
    pub fn list(&self, rel_dir: &str) -> Result<Vec<LocalEntry>, String> {
        let dir = if rel_dir.is_empty() {
            self.root.clone()
        } else {
            self.root.join(rel_dir)
        };
        let read = fs::read_dir(&dir).map_err(|e| format!("Open failed: {}: {e}", dir.display()))?;
        let mut entries: Vec<LocalEntry> = read
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                let is_dir = entry.file_type().ok()?.is_dir();
                if self.is_ignored(&path, is_dir) {
                    return None;
                }
                Some(LocalEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: rel_path(&self.root, &path)?,
                    is_dir,
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
}

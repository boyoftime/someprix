//! Tracks a local project folder against a snapshot of what was last pushed, so the app can
//! show which files changed and push exactly those to the server.
//!
//! The snapshot (the "baseline") records each file's size, modified time and content hash. A
//! file counts as changed only when its content differs, so saving without editing doesn't mark
//! it. The baseline is stored on disk, so edits made while the app is closed still show up.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
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

/// Never shown in Sync: Someprix's own copy of a server file on its way in (see
/// project_take_server). Everything else shows, whatever .gitignore says; what stays out of
/// pushing is the user's call (Exclude from push).
const HIDDEN: &[&str] = &["*.someprix-part"];

/// Folders that start out excluded from pushing, wherever they are in the project; the user can
/// include them. A .git folder on a web server gives the code and its history away, and
/// node_modules and a Python .venv are made on the server instead (and are huge).
const EXCLUDED_AT_FIRST: &[&str] = &[".git", ".venv", "node_modules"];

/// What versions before 1.10.1 hid from Sync on top of .gitignore (see adopt_hidden).
const HIDDEN_BEFORE: &[&str] = &[
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

pub const EXCLUDED_EVENT: &str = "project://excluded";

/// How long the folder has to be quiet before changes are re-checked (editors often write a
/// file in several steps).
const SETTLE: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sig {
    pub size: u64,
    pub mtime: u64,
    pub hash: u64,
}

/// A pushed file as the server reported it right after the push: size and modified time (whole
/// seconds, as SFTP gives it). The next push compares the server's copy with it to tell whether
/// someone changed the file there in the meantime.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerSig {
    pub size: u64,
    pub mtime: u64,
}

/// What each pushed file looks like on the server, per destination ("host:folder").
type ServerRecord = HashMap<String, HashMap<String, ServerSig>>;

/// The baseline file's form since .gitignore stopped hiding files from Sync (version 2).
const BASELINE_VERSION: u32 = 2;

#[derive(Serialize)]
struct BaselineOut<'a> {
    version: u32,
    files: &'a HashMap<String, Sig>,
}

/// A saved baseline: the current form, or the plain map saved before version 2.
#[derive(Deserialize)]
#[serde(untagged)]
enum SavedBaseline {
    Versioned { files: HashMap<String, Sig> },
    Plain(HashMap<String, Sig>),
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
    server: ServerRecord,
    server_file: PathBuf,
    changes: BTreeMap<String, ChangeKind>,
    /// Paths the user excluded from pushing: never counted as changes, never pushed.
    excluded: Vec<String>,
    /// Folders excluded at first (EXCLUDED_AT_FIRST) that the user included in pushing.
    included: Vec<String>,
    /// The folders excluded at first that are in the project now.
    at_first: BTreeSet<String>,
    /// `at_first` changed since the list was last sent (see take_excluded_change).
    excluded_changed: bool,
    _watcher: RecommendedWatcher,
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

pub type SharedProject = Arc<Mutex<Option<Project>>>;

/// Opens `root`, compares it with its baseline (creating one if this folder is new), and starts
/// watching it. Changes are emitted as `project://changes` whenever they settle.
pub fn open(
    app: &AppHandle,
    shared: &SharedProject,
    root: &Path,
    baseline_file: PathBuf,
    excluded: Vec<String>,
    included: Vec<String>,
) -> Result<(), String> {
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

    let saved: Option<SavedBaseline> = fs::read_to_string(&baseline_file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok());
    let server_file = baseline_file.with_extension("server.json");
    let server: ServerRecord = fs::read_to_string(&server_file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();

    let mut project = Project {
        root: root.to_path_buf(),
        generation,
        ignore,
        baseline: HashMap::new(),
        baseline_file,
        server,
        server_file,
        changes: BTreeMap::new(),
        excluded,
        included,
        at_first: BTreeSet::new(),
        excluded_changed: false,
        _watcher: watcher,
    };
    match saved {
        Some(SavedBaseline::Versioned { files }) => project.baseline = files,
        Some(SavedBaseline::Plain(files)) => {
            project.baseline = files;
            project.adopt_hidden();
            project.save_baseline();
        }
        None => {
            // A folder seen for the first time: everything in it counts as already on the server.
            project.baseline = project.snapshot();
            project.save_baseline();
        }
    }
    project.rescan();

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
                    let (changes, excluded) = {
                        let mut guard = shared.lock().unwrap();
                        let Some(project) = guard.as_mut().filter(|p| p.generation == generation) else {
                            return;
                        };
                        if std::mem::take(&mut rescan) {
                            project.rescan();
                        } else {
                            project.refresh(&paths);
                        }
                        (project.changes(), project.take_excluded_change())
                    };
                    // A node_modules that came (or went) is excluded (or not) before the tree shows it.
                    if let Some(excluded) = excluded {
                        let _ = app.emit(EXCLUDED_EVENT, excluded);
                    }
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
    for line in HIDDEN {
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

/// Whether `rel` is one of `excluded`, or inside one of them.
fn is_excluded(excluded: &[String], rel: &str) -> bool {
    excluded
        .iter()
        .any(|ex| rel == ex || rel.strip_prefix(ex.as_str()).is_some_and(|rest| rest.starts_with('/')))
}

/// The folder (or file) excluded at first that `rel` is, or is in, unless the user included it.
fn excluded_at_first<'a>(rel: &'a str, included: &[String]) -> Option<&'a str> {
    let mut end = 0;
    for part in rel.split('/') {
        end += part.len();
        let folder = &rel[..end];
        if EXCLUDED_AT_FIRST.contains(&part) && !included.iter().any(|i| i == folder) {
            return Some(folder);
        }
        end += 1;
    }
    None
}

/// Whether `rel` stays out of pushing: the user excluded it, or it's excluded at first.
fn left_out(excluded: &[String], included: &[String], rel: &str) -> bool {
    is_excluded(excluded, rel) || excluded_at_first(rel, included).is_some()
}

impl Project {
    /// Everything excluded from pushing: what the user excluded, and the folders excluded at first
    /// that are in the project now (not counting those inside a folder the user excluded).
    pub fn excluded(&self) -> Vec<String> {
        let mut all: BTreeSet<String> = self.at_first.iter().filter(|f| !is_excluded(&self.excluded, f)).cloned().collect();
        all.extend(self.excluded.iter().cloned());
        all.into_iter().collect()
    }

    /// What the user chose, to keep: paths excluded, and folders excluded at first included.
    pub fn exclusions(&self) -> (Vec<String>, Vec<String>) {
        (self.excluded.clone(), self.included.clone())
    }

    /// Excludes paths from pushing, or with `exclude` false includes them again, then re-checks
    /// the folder. A folder covers everything inside it.
    pub fn exclude(&mut self, paths: &[String], exclude: bool) {
        let inside = |item: &str, folder: &str| item == folder || item.strip_prefix(folder).is_some_and(|rest| rest.starts_with('/'));
        for path in paths.iter().map(|p| p.trim_matches('/')).filter(|p| !p.is_empty()) {
            if exclude {
                // An included .git, .venv or node_modules goes back to how it started.
                self.included.retain(|item| item != path);
                // Already covered (by an excluded folder, or one excluded at first): nothing to add.
                if excluded_at_first(path, &self.included).is_some() || self.excluded.iter().any(|item| inside(path, item)) {
                    continue;
                }
                // A folder takes over anything excluded inside it.
                self.excluded.retain(|item| !inside(item, path));
                self.excluded.push(path.to_string());
            } else {
                self.excluded.retain(|item| item != path);
                if excluded_at_first(path, &self.included) == Some(path) {
                    self.included.push(path.to_string());
                }
            }
        }
        self.excluded.sort();
        self.included.sort();
        self.rescan();
    }

    /// The full excluded list, if the folders excluded at first changed since it was last taken.
    pub fn take_excluded_change(&mut self) -> Option<Vec<String>> {
        std::mem::take(&mut self.excluded_changed).then(|| self.excluded())
    }

    fn is_left_out(&self, rel: &str) -> bool {
        left_out(&self.excluded, &self.included, rel)
    }

    fn note_at_first(&mut self, found: BTreeSet<String>) {
        if found != self.at_first {
            self.at_first = found;
            self.excluded_changed = true;
        }
    }

    pub fn is_ignored(&self, path: &Path, is_dir: bool) -> bool {
        path.starts_with(&self.root)
            && path != self.root
            && self.ignore.matched_path_or_any_parents(path, is_dir).is_ignore()
    }

    /// Whether the project file `rel` is one Sync never shows (see HIDDEN), whether or not it
    /// still exists. Those are never changes: not new, not changed, not deleted.
    fn ignores(&self, rel: &str) -> bool {
        self.ignore.matched_path_or_any_parents(self.root.join(rel), false).is_ignore()
    }

    /// Brings a baseline saved by a version that hid files from Sync (by .gitignore, and see
    /// HIDDEN_BEFORE) up to date. The files it hid count as already on the server, as they are
    /// now (like a folder opened the first time), rather than all turning up as new, or as
    /// changed from a record made before they were hidden.
    fn adopt_hidden(&mut self) {
        let mut builder = GitignoreBuilder::new(&self.root);
        let gitignore = self.root.join(".gitignore");
        if gitignore.is_file() {
            let _ = builder.add(gitignore);
        }
        for line in HIDDEN_BEFORE {
            let _ = builder.add_line(None, line);
        }
        let Ok(hidden) = builder.build() else {
            return;
        };
        let root = self.root.clone();
        let hid = |rel: &str| hidden.matched_path_or_any_parents(root.join(rel), false).is_ignore();
        let (excluded, included) = (&self.excluded, &self.included);
        self.baseline.retain(|rel, _| !hid(rel) || left_out(excluded, included, rel));
        for rel in self.walk(&self.root).0 {
            if hid(&rel) {
                if let Ok(sig) = signature(&self.root.join(&rel)) {
                    self.baseline.insert(rel, sig);
                }
            }
        }
    }

    /// Every tracked file under `dir` (absolute), as project-relative paths, and the folders
    /// excluded at first met on the way (not gone into).
    fn walk(&self, dir: &Path) -> (Vec<String>, Vec<String>) {
        let ignore = self.ignore.clone();
        let root = self.root.clone();
        let excluded = self.excluded.clone();
        let included = self.included.clone();
        let met = Arc::new(Mutex::new(Vec::new()));
        let noting = met.clone();
        let files = ignore::WalkBuilder::new(dir)
            .standard_filters(false)
            .follow_links(false)
            .filter_entry(move |entry| {
                if entry.path() == root {
                    return true;
                }
                let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
                if ignore.matched_path_or_any_parents(entry.path(), is_dir).is_ignore() {
                    return false;
                }
                let Some(rel) = rel_path(&root, entry.path()) else {
                    return true;
                };
                if is_excluded(&excluded, &rel) {
                    return false;
                }
                match excluded_at_first(&rel, &included) {
                    Some(folder) => {
                        if folder.len() == rel.len() {
                            noting.lock().unwrap().push(rel.clone());
                        }
                        false
                    }
                    None => true,
                }
            })
            .build()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_some_and(|t| t.is_file()))
            .filter_map(|entry| rel_path(&self.root, entry.path()))
            .collect();
        let met = std::mem::take(&mut *met.lock().unwrap());
        (files, met)
    }

    fn snapshot(&self) -> HashMap<String, Sig> {
        self.walk(&self.root)
            .0
            .into_iter()
            .filter_map(|rel| Some((rel.clone(), signature(&self.root.join(&rel)).ok()?)))
            .collect()
    }

    pub fn save_baseline(&self) {
        let saved = BaselineOut {
            version: BASELINE_VERSION,
            files: &self.baseline,
        };
        if let Ok(text) = serde_json::to_string(&saved) {
            let _ = write_atomic(&self.baseline_file, text.as_bytes());
        }
    }

    pub fn save_server(&self) {
        if let Ok(text) = serde_json::to_string(&self.server) {
            let _ = write_atomic(&self.server_file, text.as_bytes());
        }
    }

    /// What `rel` was when last pushed (or when the folder was first opened).
    pub fn baseline_sig(&self, rel: &str) -> Option<Sig> {
        self.baseline.get(rel).copied()
    }

    /// What `rel` looked like on the server at `target` right after it was last pushed there.
    pub fn server_sig(&self, target: &str, rel: &str) -> Option<ServerSig> {
        self.server.get(target)?.get(rel).copied()
    }

    /// Records what `rel` looks like on the server at `target` now (`None`: it's gone from there).
    pub fn record_server(&mut self, target: &str, rel: &str, sig: Option<ServerSig>) {
        let files = self.server.entry(target.to_string()).or_default();
        match sig {
            Some(sig) => {
                files.insert(rel.to_string(), sig);
            }
            None => {
                files.remove(rel);
            }
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
        let (present, met) = self.walk(&self.root);
        self.note_at_first(met.into_iter().collect());
        let present_set: HashSet<&String> = present.iter().collect();
        let mut touched = false;
        for rel in &present {
            touched |= self.check(rel);
        }
        let gone: Vec<String> = self
            .baseline
            .keys()
            // Excluded files aren't deleted, just left out; nor are files Sync never shows.
            .filter(|rel| !present_set.contains(rel) && !self.is_left_out(rel) && !self.ignores(rel))
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
        // Folders excluded at first that something happened in (or to): they may have come or gone.
        let mut noted: BTreeSet<String> = BTreeSet::new();
        for path in paths {
            let Some(rel) = rel_path(&self.root, path) else {
                continue;
            };
            if !is_excluded(&self.excluded, &rel) {
                if let Some(folder) = excluded_at_first(&rel, &self.included) {
                    noted.insert(folder.to_string());
                }
            }
            let is_dir = path.is_dir();
            if self.is_ignored(path, is_dir) || self.is_left_out(&rel) {
                continue;
            }
            if is_dir {
                let (files, met) = self.walk(path);
                noted.extend(met);
                for file in files {
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
        let mut at_first = self.at_first.clone();
        at_first.extend(noted);
        at_first.retain(|folder| self.root.join(folder).exists());
        self.note_at_first(at_first);
        if touched {
            self.save_baseline();
        }
    }

    /// Updates the change state of one file. Returns true if the baseline was touched (a file
    /// was re-saved with identical content, so only its modified time moved).
    fn check(&mut self, rel: &str) -> bool {
        if self.is_left_out(rel) || self.ignores(rel) {
            self.changes.remove(rel);
            return false;
        }
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

    /// Takes the folder as it is now as what's on the server, so its changes (all of them, or
    /// those at or under `paths`) stop counting. Files aren't touched, here or on the server.
    /// Excluded files keep their records, so including them again doesn't make them new.
    pub fn accept(&mut self, paths: Option<&[String]>) {
        match paths {
            None => {
                let mut fresh = self.snapshot();
                for (rel, sig) in &self.baseline {
                    if self.is_left_out(rel) {
                        fresh.entry(rel.clone()).or_insert(*sig);
                    }
                }
                self.baseline = fresh;
                self.changes.clear();
            }
            Some(paths) => {
                let hit: Vec<String> = self
                    .changes
                    .keys()
                    .filter(|rel| {
                        paths
                            .iter()
                            .any(|p| *rel == p || rel.strip_prefix(p.as_str()).is_some_and(|rest| rest.starts_with('/')))
                    })
                    .cloned()
                    .collect();
                for rel in hit {
                    match signature(&self.root.join(&rel)) {
                        Ok(sig) => {
                            self.baseline.insert(rel.clone(), sig);
                        }
                        Err(_) => {
                            self.baseline.remove(&rel);
                        }
                    }
                    self.check(&rel);
                }
            }
        }
        self.save_baseline();
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

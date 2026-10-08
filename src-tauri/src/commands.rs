//! Commands the frontend calls: saved hosts, server connections, the project folder, and push.

use std::{
    collections::HashSet,
    sync::Arc,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    conflicts::{self, Conflict},
    edit, fast,
    turbo::{self, Meter},
    files::{self, PART_SUFFIX},
    project::{self, Change, ChangeKind, LocalEntry, ServerSig, SharedProject, Sig, CHANGES_EVENT},
    ssh::{self, ConnectOutcome, RemoteEntry, Ssh},
    store::{self, AuthMethod, Host, ProjectLink, Store},
    terminal::Terminals,
};

const PUSH_EVENT: &str = "project://push-progress";

pub struct AppState {
    store: Store,
    ssh: Ssh,
    project: SharedProject,
    pushing: AtomicBool,
    uploading: AtomicBool,
    /// Set by the Cancel button; the running upload stops and undoes itself.
    upload_cancel: AtomicBool,
    /// Bumped for every Properties request (and when its dialog closes); a walk that sees it
    /// change stops.
    props_generation: Arc<AtomicU64>,
    terminals: Terminals,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            ssh: Ssh::default(),
            project: SharedProject::default(),
            pushing: AtomicBool::new(false),
            uploading: AtomicBool::new(false),
            upload_cancel: AtomicBool::new(false),
            props_generation: Arc::new(AtomicU64::new(0)),
            terminals: Terminals::default(),
        }
    }
}

// ---------- Hosts ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    id: Option<String>,
    label: String,
    host: String,
    port: u16,
    username: String,
    auth: AuthMethod,
    key_path: Option<String>,
    /// A new password or key passphrase. Left out, the saved one is kept.
    secret: Option<String>,
}

#[tauri::command]
pub fn hosts_list(state: State<'_, AppState>) -> Vec<Host> {
    state.store.hosts()
}

#[tauri::command]
pub async fn host_save(state: State<'_, AppState>, input: HostInput) -> Result<Host, String> {
    let address = input.host.trim().to_string();
    let username = input.username.trim().to_string();
    if address.is_empty() {
        return Err("Address required".into());
    }
    if username.is_empty() {
        return Err("Username required".into());
    }
    if input.port == 0 {
        return Err("Port must be 1-65535".into());
    }
    let key_path = input.key_path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if input.auth == AuthMethod::Key && key_path.is_none() {
        return Err("Key file required".into());
    }

    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    match input.secret.filter(|s| !s.is_empty()) {
        Some(secret) => store::set_secret(&id, &secret)?,
        None if input.auth == AuthMethod::Password && store::secret(&id).is_none() => {
            return Err("Password required".into());
        }
        None => {}
    }

    let label = input.label.trim();
    let host = Host {
        label: if label.is_empty() { address.clone() } else { label.to_string() },
        id,
        host: address,
        port: input.port,
        username,
        auth: input.auth,
        key_path,
    };
    state.store.save_host(host.clone())?;
    // New address or credentials take effect on the next connect.
    state.ssh.disconnect(&host.id).await;
    Ok(host)
}

#[tauri::command]
pub async fn host_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.ssh.disconnect(&id).await;
    state.store.remove_host(&id)
}

// ---------- Connections ----------

#[tauri::command]
pub async fn ssh_connect(state: State<'_, AppState>, host_id: String) -> Result<ConnectOutcome, String> {
    let host = state.store.host(&host_id).ok_or("Host not found")?;
    state.ssh.connect(&state.store, &host).await
}

/// Remembers the server key the user just confirmed.
#[tauri::command]
pub fn ssh_trust(state: State<'_, AppState>, host_id: String, fingerprint: String) -> Result<(), String> {
    let host = state.store.host(&host_id).ok_or("Host not found")?;
    state.store.trust_host(&host.address(), &fingerprint)
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, AppState>, host_id: String) -> Result<(), String> {
    state.ssh.disconnect(&host_id).await;
    Ok(())
}

#[tauri::command]
pub async fn ssh_connected(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.ssh.connected_ids().await)
}

#[tauri::command]
pub async fn ssh_list(state: State<'_, AppState>, host_id: String, path: String) -> Result<Vec<RemoteEntry>, String> {
    state.ssh.get(&host_id).await?.list(&path).await
}

#[tauri::command]
pub async fn ssh_mkdir(state: State<'_, AppState>, host_id: String, path: String) -> Result<(), String> {
    state.ssh.get(&host_id).await?.create_dir(&path).await
}

/// Deletes files and folders (with everything inside) on the server, one after another. Stops
/// at the first one that fails; returns how many items were removed in all. Fast mode deletes
/// them all with one server command instead (and then counts only the items asked for).
#[tauri::command]
pub async fn ssh_delete(
    state: State<'_, AppState>,
    host_id: String,
    paths: Vec<String>,
    fast: Option<bool>,
) -> Result<usize, String> {
    let conn = state.ssh.get(&host_id).await?;
    if fast.unwrap_or(false) {
        if let Some(result) = fast::delete_remote(&conn, &paths).await {
            return result.map(|()| paths.len());
        }
    }
    let mut removed = 0;
    for path in &paths {
        removed += conn.delete_tree(path).await?;
    }
    Ok(removed)
}

/// Creates an empty file on the server (never replacing an existing one).
#[tauri::command]
pub async fn ssh_create_file(state: State<'_, AppState>, host_id: String, path: String) -> Result<(), String> {
    state.ssh.get(&host_id).await?.create_file(&path).await
}

// ---------- Terminal ----------

/// Opens a shell on a connected host in a pseudo-terminal of `cols` x `rows`, in `start_dir` if
/// given (a reconnect carrying on where it was), else home. Its output streams
/// to `output` as raw bytes, then one last JSON message says how it ended. Returns its id.
#[tauri::command]
pub async fn terminal_open(
    state: State<'_, AppState>,
    host_id: String,
    cols: u32,
    rows: u32,
    start_dir: Option<String>,
    output: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<u32, String> {
    let conn = state.ssh.get(&host_id).await?;
    let channel = conn.open_shell(cols, rows, start_dir.as_deref()).await?;
    Ok(state.terminals.start(channel, output))
}

/// Sends typed keys (or pasted text) to a terminal's shell.
#[tauri::command]
pub fn terminal_write(state: State<'_, AppState>, id: u32, data: Vec<u8>) -> Result<(), String> {
    state.terminals.write(id, data)
}

/// Tells a terminal's shell its window changed size.
#[tauri::command]
pub fn terminal_resize(state: State<'_, AppState>, id: u32, cols: u32, rows: u32) -> Result<(), String> {
    state.terminals.resize(id, cols, rows)
}

/// Ends a terminal's shell session.
#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, id: u32) {
    state.terminals.close(id);
}

// ---------- Editor ----------

/// Opens a text file on this computer for the editor.
#[tauri::command]
pub async fn local_read_text(path: String) -> Result<edit::TextFile, String> {
    tauri::async_runtime::spawn_blocking(move || edit::read_local(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Saves the editor's text over a file on this computer, unless it changed since `expected`.
#[tauri::command]
pub async fn local_save_text(path: String, text: String, bom: bool, expected: Option<String>) -> Result<edit::Saved, String> {
    tauri::async_runtime::spawn_blocking(move || edit::save_local(&path, &text, bom, expected.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// Opens a text file on the server for the editor.
#[tauri::command]
pub async fn ssh_read_text(state: State<'_, AppState>, host_id: String, path: String) -> Result<edit::TextFile, String> {
    let conn = state.ssh.get(&host_id).await?;
    edit::read_remote(&conn, &path).await
}

/// Saves the editor's text over a server file, unless it changed since `expected`.
#[tauri::command]
pub async fn ssh_save_text(
    state: State<'_, AppState>,
    host_id: String,
    path: String,
    text: String,
    bom: bool,
    expected: Option<String>,
) -> Result<edit::Saved, String> {
    let conn = state.ssh.get(&host_id).await?;
    edit::save_remote(&conn, &path, &text, bom, expected.as_deref()).await
}

// ---------- Project ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    root: String,
    name: String,
    host_id: Option<String>,
    remote_dir: Option<String>,
    changes: Vec<Change>,
    /// Paths excluded from pushing.
    excluded: Vec<String>,
}

/// Project folders are keyed by their path without a trailing separator.
fn root_key(root: &str) -> String {
    let trimmed = root.trim_end_matches(['\\', '/']);
    if trimmed.ends_with(':') {
        format!("{trimmed}\\")
    } else {
        trimmed.to_string()
    }
}

fn project_info(state: &AppState) -> Option<ProjectInfo> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref()?;
    let root = project.root.to_string_lossy().into_owned();
    let ProjectLink { host_id, remote_dir, .. } = state.store.project_link(&root);
    Some(ProjectInfo {
        name: project
            .root
            .file_name()
            .map_or_else(|| root.clone(), |n| n.to_string_lossy().into_owned()),
        root,
        host_id,
        remote_dir,
        changes: project.changes(),
        excluded: project.excluded().to_vec(),
    })
}

#[tauri::command]
pub async fn project_open(app: AppHandle, state: State<'_, AppState>, root: String) -> Result<ProjectInfo, String> {
    let root = root_key(&root);
    let baseline = state.store.baseline_path(&root);
    let shared = state.project.clone();
    let path = PathBuf::from(&root);
    let excluded = state.store.project_link(&root).excluded;
    // Hashing a large folder the first time takes a moment; keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(move || project::open(&app, &shared, &path, baseline, excluded))
        .await
        .map_err(|e| e.to_string())??;
    state.store.set_active_project(Some(&root))?;
    project_info(&state).ok_or_else(|| "Project closed".into())
}

/// The project that was open last time, reopened.
#[tauri::command]
pub async fn project_current(app: AppHandle, state: State<'_, AppState>) -> Result<Option<ProjectInfo>, String> {
    if let Some(info) = project_info(&state) {
        return Ok(Some(info));
    }
    match state.store.active_project() {
        Some(root) if Path::new(&root).is_dir() => project_open(app, state, root).await.map(Some),
        _ => Ok(None),
    }
}

#[tauri::command]
pub fn project_close(state: State<'_, AppState>) -> Result<(), String> {
    *state.project.lock().unwrap() = None;
    state.store.set_active_project(None)
}

#[tauri::command]
pub fn project_list(state: State<'_, AppState>, dir: String) -> Result<Vec<LocalEntry>, String> {
    let guard = state.project.lock().unwrap();
    guard.as_ref().ok_or("No project open")?.list(&dir)
}

#[tauri::command]
pub fn project_set_target(
    state: State<'_, AppState>,
    host_id: Option<String>,
    remote_dir: Option<String>,
) -> Result<(), String> {
    let root = project_info(&state).ok_or("No project open")?.root;
    let excluded = state.store.project_link(&root).excluded;
    state.store.set_project_link(&root, ProjectLink { host_id, remote_dir, excluded })
}

/// Excludes project paths (files or folders) from pushing, or, with `exclude` false, includes
/// them again. Excluded paths stop counting as changes; a folder covers everything inside it.
#[tauri::command]
pub async fn project_exclude(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    exclude: bool,
) -> Result<ProjectInfo, String> {
    let shared = state.project.clone();
    let (root, excluded, changes) = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = shared.lock().unwrap();
        let project = guard.as_mut().ok_or("No project open")?;
        let mut list = project.excluded().to_vec();
        for path in paths.iter().map(|p| p.trim_matches('/').to_string()).filter(|p| !p.is_empty()) {
            let inside = |item: &String, folder: &str| {
                item == folder || item.strip_prefix(folder).is_some_and(|rest| rest.starts_with('/'))
            };
            if exclude {
                // Already covered by an excluded folder: nothing to add.
                if list.iter().any(|item| inside(&path, item)) {
                    continue;
                }
                // A folder takes over anything excluded inside it.
                list.retain(|item| !inside(item, &path));
                list.push(path);
            } else {
                list.retain(|item| item != &path);
            }
        }
        list.sort();
        project.set_excluded(list.clone());
        Ok::<_, String>((project.root.to_string_lossy().into_owned(), list, project.changes()))
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut link = state.store.project_link(&root);
    link.excluded = excluded;
    state.store.set_project_link(&root, link)?;
    let _ = app.emit(CHANGES_EVENT, changes);
    project_info(&state).ok_or_else(|| "Project closed".into())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PushProgress {
    /// Files finished so far, and in all.
    done: usize,
    total: usize,
    /// The file being worked on; none once everything is done.
    path: Option<String>,
    /// Bytes uploaded so far, and in all, for a smooth percentage.
    bytes_done: u64,
    bytes_total: u64,
    /// Everything has arrived and is being moved into place; it can no longer be cancelled.
    finishing: bool,
    /// Fast mode's extra steps: "packing" the files here, "unpacking" them on the server.
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<&'static str>,
}


#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushReport {
    uploaded: usize,
    deleted: usize,
    /// The files went as one compressed archive (fast mode).
    fast: bool,
}

/// Pushes the project's changes, or with `only`, just the changes at or under those paths.
/// Changes listed in `skip` stay behind this time.
#[tauri::command]
pub async fn project_push(
    app: AppHandle,
    state: State<'_, AppState>,
    include_deletions: bool,
    only: Option<Vec<String>>,
    fast: Option<bool>,
    skip: Option<Vec<String>>,
) -> Result<PushReport, String> {
    if state.pushing.swap(true, Ordering::SeqCst) {
        return Err("Push in progress".into());
    }
    let mut report = PushReport::default();
    let skip = skip.unwrap_or_default();
    let result = push(&app, &state, include_deletions, only.as_deref(), &skip, fast.unwrap_or(false), &mut report).await;
    state.pushing.store(false, Ordering::SeqCst);

    // Whatever made it to the server stays marked as pushed, even if a later file failed.
    let changes = {
        let guard = state.project.lock().unwrap();
        guard.as_ref().map(|project| {
            project.save_baseline();
            project.save_server();
            project.changes()
        })
    };
    if let Some(changes) = changes {
        let _ = app.emit(CHANGES_EVENT, changes);
    }
    result.map(|()| report)
}

/// A file packed into the archive: what it is, and where its compressed bytes end.
struct Packed<'a> {
    path: &'a str,
    sig: Sig,
    end: u64,
}

/// Fast mode: the changed files travel as one compressed archive, which the server unpacks in
/// place (`tar`), so a slow link carries fewer bytes and one file instead of many. Progress still
/// reads per file: each file's share of the archive is known from packing it.
async fn push_packed(
    lanes: &[Arc<ssh::Connection>],
    root: &Path,
    remote_dir: &str,
    uploads: &[Change],
    bytes_total: u64,
    emit: &(dyn Fn(usize, Option<&str>, u64, Option<&'static str>) + Sync),
    mark: &(dyn Fn(&str, Option<(Sig, Option<ServerSig>)>) + Sync),
) -> Result<(), String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (local, mut archive) = fast::create("someprix-push")?;
    let pack_fail = |e: &dyn std::fmt::Display| format!("Pack failed: {e}");

    // Pack: each file is read here and compressed on a worker thread.
    let mut packed = Vec::with_capacity(uploads.len());
    for change in uploads {
        emit(0, Some(&change.path), 0, Some("packing"));
        let path = root.join(&change.path);
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|e| format!("Read failed: {}: {e}", change.path))?;
        let mtime = tokio::fs::metadata(&path).await.map(|m| project::mtime_ms(&m)).unwrap_or(0);
        let sig = Sig {
            size: bytes.len() as u64,
            mtime,
            hash: xxhash_rust::xxh3::xxh3_64(&bytes),
        };
        let rel = change.path.clone();
        archive = tauri::async_runtime::spawn_blocking(move || -> std::io::Result<fast::Archive> {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_mtime(mtime / 1000);
            archive.append_data(&mut header, &rel, bytes.as_slice())?;
            Ok(archive)
        })
        .await
        .map_err(|e| pack_fail(&e))?
        .map_err(|e| pack_fail(&e))?;
        let end = fast::written(&archive);
        packed.push(Packed { path: &change.path, sig, end });
    }
    let archive_len = fast::finish(archive).await?;

    // Send: progress maps the archive's bytes back onto the files inside it.
    let archive_name = format!(".someprix-push-{id}.tar.gz");
    let remote_archive = ssh::join(remote_dir, &archive_name);
    let conn = &lanes[0];
    emit(0, packed.first().map(|p| p.path), 0, None);
    let meter = Meter::default();
    let sending = async {
        if turbo::split_upload(archive_len, lanes.len()) {
            turbo::upload_split(lanes, &local.0, &remote_archive, archive_len, &meter, &|| false).await
        } else {
            turbo::upload_one(conn, &local.0, &remote_archive, &meter, &|| false).await
        }
    };
    let sent = turbo::with_ticker(sending, || {
        let sent = meter.bytes();
        let done = packed.iter().take_while(|p| p.end <= sent).count();
        let current = packed.get(done).or(packed.last()).map(|p| p.path);
        let share = sent as f64 / archive_len.max(1) as f64;
        emit(done, current, (share * bytes_total as f64) as u64, None);
    })
    .await;
    if let Err(error) = sent {
        let _ = conn.remove(&remote_archive).await;
        return Err(error);
    }
    emit(packed.len(), packed.last().map(|p| p.path), bytes_total, None);

    emit(packed.len(), None, bytes_total, Some("unpacking"));
    fast::unpack_remote(conn, remote_dir, &archive_name).await?;
    // tar sets each file's size and modified time (to the second) from the archive.
    for file in packed {
        let server = ServerSig {
            size: file.sig.size,
            mtime: file.sig.mtime / 1000,
        };
        mark(file.path, Some((file.sig, Some(server))));
    }
    Ok(())
}

fn in_scope(path: &str, only: Option<&[String]>) -> bool {
    only.is_none_or(|paths| {
        paths
            .iter()
            .any(|p| path == p || path.strip_prefix(p.as_str()).is_some_and(|rest| rest.starts_with('/')))
    })
}

async fn push(
    app: &AppHandle,
    state: &AppState,
    include_deletions: bool,
    only: Option<&[String]>,
    skip: &[String],
    fast: bool,
    report: &mut PushReport,
) -> Result<(), String> {
    let info = project_info(state).ok_or("No project open")?;
    let host_id = info.host_id.ok_or("No server selected")?;
    let remote_dir = info.remote_dir.ok_or("No destination set")?;
    let lanes = state.ssh.lanes(&state.store, &host_id, turbo::LANES).await?;
    let _deadlines: Vec<_> = lanes.iter().map(|lane| lane.transfer_deadline()).collect();
    let conn = &lanes[0];
    let root = PathBuf::from(&info.root);
    let destination = conflicts::target_key(&host_id, &remote_dir);

    let (deletions, uploads): (Vec<Change>, Vec<Change>) = info
        .changes
        .into_iter()
        .filter(|c| in_scope(&c.path, only) && !skip.contains(&c.path))
        .partition(|c| c.kind == ChangeKind::Deleted);
    let deletions = if include_deletions { deletions } else { Vec::new() };
    let total = uploads.len() + deletions.len();
    let mut bytes_total = 0;
    for change in &uploads {
        bytes_total += tokio::fs::metadata(root.join(&change.path)).await.map_or(0, |m| m.len());
    }
    let emit = |done: usize, path: Option<&str>, bytes_done: u64, stage: Option<&'static str>| {
        let _ = app.emit(
            PUSH_EVENT,
            PushProgress {
                done,
                total,
                path: path.map(str::to_string),
                bytes_done: bytes_done.min(bytes_total),
                bytes_total,
                finishing: stage == Some("unpacking"),
                stage,
            },
        );
    };
    let progress = |done: usize, path: Option<&str>, bytes_done: u64| emit(done, path, bytes_done, None);
    // A pushed file: what was sent, and how the server's copy looks now (for the next push's
    // conflict check). `None`: deleted on the server.
    let mark = |rel: &str, pushed: Option<(Sig, Option<ServerSig>)>| {
        let mut guard = state.project.lock().unwrap();
        if let Some(project) = guard.as_mut().filter(|p| p.root == root) {
            project.mark_pushed(rel, pushed.map(|(sig, _)| sig));
            project.record_server(&destination, rel, pushed.and_then(|(_, server)| server));
        }
    };

    // Fast mode needs tar on the server; without it the files go the ordinary way.
    let fast = fast && !uploads.is_empty() && fast::remote_has_tar(conn).await;
    if fast {
        push_packed(&lanes, &root, &remote_dir, &uploads, bytes_total, &emit, &mark).await?;
        report.uploaded = uploads.len();
        report.fast = true;
    } else {
        // Each lane takes the next file; a big one is split across every lane.
        let meter = Meter::default();
        let made_dirs = tokio::sync::Mutex::new(HashSet::new());
        let every: Vec<usize> = (0..uploads.len()).collect();
        let (uploads, root, remote_dir, meter, made_dirs, mark, all_lanes) =
            (&uploads, &root, &remote_dir, &meter, &made_dirs, &mark, &lanes);
        let pushing = turbo::each(&lanes, turbo::UPLOAD_STREAMS, &every, |lane, i| async move {
            let change = &uploads[i];
            meter.start(&change.path);
            let local = root.join(&change.path);
            let bytes = tokio::fs::read(&local)
                .await
                .map_err(|e| format!("Read failed: {}: {e}", change.path))?;
            let mtime = tokio::fs::metadata(&local).await.map(|m| project::mtime_ms(&m)).unwrap_or(0);
            let sig = Sig {
                size: bytes.len() as u64,
                mtime,
                hash: xxhash_rust::xxh3::xxh3_64(&bytes),
            };
            if let Some((dir, _)) = change.path.rsplit_once('/') {
                let mut made = made_dirs.lock().await;
                lane.ensure_dirs(remote_dir, dir, &mut made, &mut Vec::new()).await?;
            }
            let target = ssh::join(remote_dir, &change.path);
            if turbo::split_upload(sig.size, all_lanes.len()) {
                turbo::upload_split(all_lanes, &local, &target, sig.size, meter, &|| false).await?;
            } else {
                let mut counted = 0;
                lane.upload(&target, &bytes, |sent| {
                    meter.add(sent as u64 - counted);
                    counted = sent as u64;
                })
                .await?;
            }
            meter.finish_file();
            let server = conflicts::server_sig(&lane, &target).await.ok().flatten();
            mark(&change.path, Some((sig, server)));
            Ok(true)
        });
        turbo::with_ticker(pushing, || progress(meter.done(), meter.current().as_deref(), meter.bytes())).await?;
        report.uploaded = meter.done();
    }
    let bytes_done = bytes_total;
    for change in &deletions {
        progress(report.uploaded + report.deleted, Some(&change.path), bytes_done);
        conn.remove(&ssh::join(&remote_dir, &change.path)).await?;
        mark(&change.path, None);
        report.deleted += 1;
    }
    progress(total, None, bytes_total);
    Ok(())
}

/// Before a push: the files about to be pushed (or deleted) that someone changed on the server
/// since they were last pushed, or that are new here but already there.
#[tauri::command]
pub async fn project_conflicts(
    state: State<'_, AppState>,
    include_deletions: bool,
    only: Option<Vec<String>>,
) -> Result<Vec<Conflict>, String> {
    let info = project_info(&state).ok_or("No project open")?;
    let host_id = info.host_id.ok_or("No server selected")?;
    let remote_dir = info.remote_dir.ok_or("No destination set")?;
    let conn = state.ssh.get(&host_id).await?;
    let changes: Vec<Change> = info
        .changes
        .into_iter()
        .filter(|c| in_scope(&c.path, only.as_deref()) && (include_deletions || c.kind != ChangeKind::Deleted))
        .collect();
    let target = conflicts::target_key(&host_id, &remote_dir);
    conflicts::find(&conn, &state.project, Path::new(&info.root), &remote_dir, &target, changes).await
}

/// Replaces project files with the server's copies, so they stop counting as changes. The local
/// versions go to the Recycle Bin. Returns how many files were replaced.
#[tauri::command]
pub async fn project_take_server(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>) -> Result<usize, String> {
    let info = project_info(&state).ok_or("No project open")?;
    let host_id = info.host_id.ok_or("No server selected")?;
    let remote_dir = info.remote_dir.ok_or("No destination set")?;
    let conn = state.ssh.get(&host_id).await?;
    let root = PathBuf::from(&info.root);
    let target = conflicts::target_key(&host_id, &remote_dir);

    let mut taken = 0;
    let mut result = Ok(());
    for rel in &paths {
        result = take_server(&state, &conn, &root, &remote_dir, &target, rel).await;
        if result.is_err() {
            break;
        }
        taken += 1;
    }

    let changes = {
        let guard = state.project.lock().unwrap();
        guard.as_ref().map(|project| {
            project.save_baseline();
            project.save_server();
            project.changes()
        })
    };
    if let Some(changes) = changes {
        let _ = app.emit(CHANGES_EVENT, changes);
    }
    result.map(|()| taken)
}

async fn take_server(
    state: &AppState,
    conn: &ssh::Connection,
    root: &Path,
    remote_dir: &str,
    target: &str,
    rel: &str,
) -> Result<(), String> {
    let remote = ssh::join(remote_dir, rel);
    let local = root.join(rel);
    let name = local.file_name().ok_or("Bad path")?.to_string_lossy().into_owned();
    // It arrives next to the old file first (the change tracker ignores it there), so a failed
    // download leaves the local file as it was.
    let part = local.with_file_name(format!("{name}{PART_SUFFIX}"));
    if let Some(dir) = local.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("Create failed: {}: {e}", dir.display()))?;
    }
    if let Err(error) = conn.download_file(&remote, &part, |_| true).await {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(error);
    }
    if local.exists() {
        let old = local.clone();
        let trashed = tauri::async_runtime::spawn_blocking(move || trash::delete(&old))
            .await
            .map_err(|e| e.to_string())?;
        if let Err(error) = trashed {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(format!("Recycle Bin failed: {}: {error}", local.display()));
        }
    }
    tokio::fs::rename(&part, &local)
        .await
        .map_err(|e| format!("Write failed: {}: {e}", local.display()))?;

    let sig = {
        let path = local.clone();
        tauri::async_runtime::spawn_blocking(move || project::signature(&path))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Read failed: {}: {e}", local.display()))?
    };
    let server = conflicts::server_sig(conn, &remote).await.ok().flatten();
    let mut guard = state.project.lock().unwrap();
    if let Some(project) = guard.as_mut().filter(|p| p.root == root) {
        project.mark_pushed(rel, Some(sig));
        project.record_server(target, rel, server);
    }
    Ok(())
}

// ---------- SFTP page ----------

const TRANSFER_EVENT: &str = "sftp://transfer-progress";

#[tauri::command]
pub fn local_home() -> String {
    files::home()
}

/// The user's Downloads folder, where downloads from the menu go.
#[tauri::command]
pub fn local_downloads(app: AppHandle) -> String {
    app.path()
        .download_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|_| files::under(Path::new(&files::home()), "Downloads").to_string_lossy().into_owned())
}

/// Moves files and folders on this computer to the Recycle Bin, where they can be restored.
#[tauri::command]
pub async fn local_delete(paths: Vec<String>) -> Result<usize, String> {
    if let Some(drive) = paths.iter().find(|p| Path::new(p).parent().is_none()) {
        return Err(format!("Can't delete drive: {drive}"));
    }
    if let Some(gone) = paths.iter().find(|p| !Path::new(p).exists()) {
        return Err(format!("Not found: {gone}"));
    }
    let count = paths.len();
    tauri::async_runtime::spawn_blocking(move || trash::delete_all(&paths))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| match e {
            trash::Error::Os { description, .. } | trash::Error::Unknown { description } => format!(
                "Recycle failed: {}",
                description.trim_start_matches("windows error: ")
            ),
            other => format!("Recycle failed: {other}"),
        })?;
    Ok(count)
}

/// Properties of files and folders on this computer (folders counted through).
#[tauri::command]
pub async fn local_properties(state: State<'_, AppState>, paths: Vec<String>) -> Result<Vec<files::ItemProps>, String> {
    let generation = state.props_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let counter = state.props_generation.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cancelled = || counter.load(Ordering::SeqCst) != generation;
        paths.iter().map(|p| files::properties(p, &cancelled)).collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Properties of files and folders on the server (folders counted through).
#[tauri::command]
pub async fn ssh_properties(
    state: State<'_, AppState>,
    host_id: String,
    paths: Vec<String>,
) -> Result<Vec<files::ItemProps>, String> {
    let generation = state.props_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let conn = state.ssh.get(&host_id).await?;
    let cancelled = || state.props_generation.load(Ordering::SeqCst) != generation;
    conn.properties(&paths, &cancelled).await
}

/// Stops a Properties count that's still running (its dialog closed).
#[tauri::command]
pub fn properties_cancel(state: State<'_, AppState>) {
    state.props_generation.fetch_add(1, Ordering::SeqCst);
}

/// Lists a folder on this computer; an empty path lists the drives.
#[tauri::command]
pub async fn local_list(path: String) -> Result<Vec<files::LocalFsEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || files::list(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadReport {
    files: usize,
    folders: usize,
    bytes: u64,
    /// Server paths of what was dropped (the top-level files and folders), to point them out.
    written: Vec<String>,
    /// The user cancelled; what had been uploaded was removed again.
    cancelled: bool,
    /// Items a cancelled upload couldn't remove from the server.
    leftovers: usize,
    /// The files went as one compressed archive (fast mode).
    fast: bool,
}

/// Sends fast mode's progress as the SFTP page's transfer progress.
fn emit_transfer(app: &AppHandle, step: fast::Step) {
    let _ = app.emit(
        TRANSFER_EVENT,
        PushProgress {
            done: step.done,
            total: step.total,
            path: step.path.map(str::to_string),
            bytes_done: step.bytes_done.min(step.bytes_total),
            bytes_total: step.bytes_total,
            finishing: step.stage == Some("unpacking"),
            stage: step.stage,
        },
    );
}

/// Stops the running upload or download; it removes what it had already written.
#[tauri::command]
pub fn sftp_cancel(state: State<'_, AppState>) {
    state.upload_cancel.store(true, Ordering::SeqCst);
}

/// Uploads local files and folders (with everything inside) into `remote_dir`, reporting
/// progress as `sftp://upload-progress`. Existing files with the same name are replaced.
#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    sources: Vec<String>,
    remote_dir: String,
    fast: Option<bool>,
) -> Result<UploadReport, String> {
    if state.uploading.swap(true, Ordering::SeqCst) {
        return Err("Transfer in progress".into());
    }
    state.upload_cancel.store(false, Ordering::SeqCst);
    let result = upload(&app, &state, &host_id, sources, &remote_dir, fast.unwrap_or(false)).await;
    state.uploading.store(false, Ordering::SeqCst);
    result
}

/// Downloads server files and folders (with everything inside) into `local_dir`, reporting
/// progress as `sftp://transfer-progress`. Existing files with the same name are replaced.
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    sources: Vec<String>,
    local_dir: String,
    fast: Option<bool>,
) -> Result<UploadReport, String> {
    if state.uploading.swap(true, Ordering::SeqCst) {
        return Err("Transfer in progress".into());
    }
    state.upload_cancel.store(false, Ordering::SeqCst);
    let result = download(&app, &state, &host_id, sources, &local_dir, fast.unwrap_or(false)).await;
    state.uploading.store(false, Ordering::SeqCst);
    result
}

async fn download(
    app: &AppHandle,
    state: &AppState,
    host_id: &str,
    sources: Vec<String>,
    local_dir: &str,
    fast: bool,
) -> Result<UploadReport, String> {
    let cancelled = || state.upload_cancel.load(Ordering::SeqCst);
    let base = PathBuf::from(local_dir);
    if !base.is_dir() {
        return Err(format!("Not a folder: {local_dir}"));
    }
    let lanes = state.ssh.lanes(&state.store, host_id, turbo::LANES).await?;
    let _deadlines: Vec<_> = lanes.iter().map(|lane| lane.transfer_deadline()).collect();
    let conn = &lanes[0];

    // Fast mode: the server packs, one archive comes down. Items from different folders, or a
    // server without tar, go the ordinary way.
    if let Some((parent, names)) = fast.then(|| fast::shared_parent(&sources)).flatten() {
        if fast::remote_has_tar(conn).await {
            let emit = |step: fast::Step| emit_transfer(app, step);
            let packed = fast::download(&lanes, &parent, &names, &base, &cancelled, &emit).await;
            let mut report = UploadReport {
                files: 0,
                folders: 0,
                bytes: 0,
                written: Vec::new(),
                cancelled: false,
                leftovers: 0,
                fast: true,
            };
            match packed {
                Ok(Some(done)) => {
                    report.files = done.files;
                    report.folders = done.folders;
                    report.bytes = done.bytes;
                    report.written = done.roots.iter().map(|n| base.join(n).to_string_lossy().into_owned()).collect();
                    return Ok(report);
                }
                Ok(None) => {
                    report.cancelled = true;
                    return Ok(report);
                }
                Err(Some(error)) => return Err(error),
                Err(None) => {}
            }
        }
    }

    let plan = conn.plan_download(&sources).await?;
    let mut report = UploadReport {
        files: plan.files.len(),
        folders: plan.folders.len(),
        bytes: 0,
        written: plan
            .roots
            .iter()
            .map(|name| base.join(name).to_string_lossy().into_owned())
            .collect(),
        cancelled: false,
        leftovers: 0,
        fast: false,
    };
    let total = plan.files.len();
    let bytes_total: u64 = plan.files.iter().map(|f| f.size).sum();
    let meter = Meter::default();
    let progress = |done: usize, path: Option<&str>, bytes_done: u64, finishing: bool| {
        let _ = app.emit(
            TRANSFER_EVENT,
            PushProgress {
                done,
                total,
                path: path.map(str::to_string),
                bytes_done: bytes_done.min(bytes_total),
                bytes_total,
                finishing,
                stage: None,
            },
        );
    };

    // As with uploads, files arrive under temporary names and replace anything only once all of
    // them are here, so a cancel (or a failure) leaves this computer as it was.
    let mut created: Vec<PathBuf> = Vec::new();
    let staged: Vec<(PathBuf, PathBuf)> = plan
        .files
        .iter()
        .map(|file| {
            let target = files::under(&base, &file.rel);
            let mut temp = target.clone().into_os_string();
            temp.push(PART_SUFFIX);
            (PathBuf::from(temp), target)
        })
        .collect();
    let (whole, split): (Vec<usize>, Vec<usize>) =
        (0..plan.files.len()).partition(|&i| !turbo::split_download(plan.files[i].size, lanes.len()));

    let outcome: Result<bool, String> = async {
        for folder in &plan.folders {
            if cancelled() {
                return Ok(false);
            }
            files::make_dirs(&base, folder, &mut created)?;
        }
        let (plan, staged, meter, cancelled, lanes) = (&plan, &staged, &meter, &cancelled, &lanes);
        let moving = async move {
            // Each lane takes the next file; big files then go one at a time, split across lanes.
            let finished = turbo::each(lanes, turbo::DOWNLOAD_STREAMS, &whole, |lane, i| async move {
                if cancelled() {
                    return Ok(false);
                }
                let file = &plan.files[i];
                meter.start(&file.rel);
                let ok = turbo::download_one(&lane, &file.remote, &staged[i].0, meter, cancelled).await?;
                if ok {
                    meter.finish_file();
                }
                Ok(ok)
            })
            .await?;
            if !finished {
                return Ok(false);
            }
            for &i in &split {
                if cancelled() {
                    return Ok(false);
                }
                let file = &plan.files[i];
                meter.start(&file.rel);
                if !turbo::download_split(lanes, &file.remote, &staged[i].0, file.size, meter, cancelled).await? {
                    return Ok(false);
                }
                meter.finish_file();
            }
            Ok(true)
        };
        turbo::with_ticker(moving, || progress(meter.done(), meter.current().as_deref(), meter.bytes(), false)).await
    }
    .await;

    match outcome {
        Ok(true) => {
            progress(total, None, bytes_total, true);
            for (i, (temp, target)) in staged.iter().enumerate() {
                if let Err(e) = std::fs::rename(temp, target) {
                    // Nothing half-named stays behind.
                    for (rest, _) in &staged[i..] {
                        let _ = std::fs::remove_file(rest);
                    }
                    return Err(format!("Save failed: {}: {e}", target.display()));
                }
            }
            progress(total, None, bytes_total, false);
            report.bytes = meter.bytes();
            Ok(report)
        }
        Ok(false) => {
            report.cancelled = true;
            report.leftovers = files::undo(&staged, &created);
            Ok(report)
        }
        Err(error) => {
            files::undo(&staged, &created);
            Err(error)
        }
    }
}

async fn upload(
    app: &AppHandle,
    state: &AppState,
    host_id: &str,
    sources: Vec<String>,
    remote_dir: &str,
    fast: bool,
) -> Result<UploadReport, String> {
    let cancelled = || state.upload_cancel.load(Ordering::SeqCst);
    let plan = tauri::async_runtime::spawn_blocking(move || files::plan(&sources))
        .await
        .map_err(|e| e.to_string())??;
    let lanes = state.ssh.lanes(&state.store, host_id, turbo::LANES).await?;
    let _deadlines: Vec<_> = lanes.iter().map(|lane| lane.transfer_deadline()).collect();
    let conn = &lanes[0];

    let mut report = UploadReport {
        files: plan.files.len(),
        folders: plan.folders.len(),
        bytes: 0,
        written: plan.roots.iter().map(|name| ssh::join(remote_dir, name)).collect(),
        cancelled: false,
        leftovers: 0,
        fast: false,
    };
    let total = plan.files.len();
    let bytes_total: u64 = plan.files.iter().map(|f| f.size).sum();

    // Fast mode: one archive goes up and the server unpacks it.
    if fast && !plan.files.is_empty() && fast::remote_has_tar(conn).await {
        let emit = |step: fast::Step| emit_transfer(app, step);
        report.fast = true;
        if fast::upload(&lanes, &plan, remote_dir, &cancelled, &emit).await? {
            report.bytes = bytes_total;
        } else {
            report.cancelled = true;
        }
        return Ok(report);
    }
    let meter = Meter::default();
    let progress = |done: usize, path: Option<&str>, bytes_done: u64, finishing: bool| {
        let _ = app.emit(
            TRANSFER_EVENT,
            PushProgress {
                done,
                total,
                path: path.map(str::to_string),
                bytes_done: bytes_done.min(bytes_total),
                bytes_total,
                finishing,
                stage: None,
            },
        );
    };

    // Files are written under temporary names and only swapped into place once all of them have
    // arrived, so a cancel (or a failure) can put the server back exactly as it was.
    let mut made_dirs = HashSet::new();
    let mut created_dirs = Vec::new();
    let staged: Vec<(String, String)> = plan
        .files
        .iter()
        .map(|file| {
            let target = ssh::join(remote_dir, &file.rel);
            (format!("{target}{PART_SUFFIX}"), target)
        })
        .collect();
    let (whole, split): (Vec<usize>, Vec<usize>) =
        (0..plan.files.len()).partition(|&i| !turbo::split_upload(plan.files[i].size, lanes.len()));

    let outcome: Result<bool, String> = async {
        // Every folder first (the plan lists each one), so the lanes only write files.
        for folder in &plan.folders {
            if cancelled() {
                return Ok(false);
            }
            conn.ensure_dirs(remote_dir, folder, &mut made_dirs, &mut created_dirs).await?;
        }
        let (plan, staged, meter, cancelled, lanes) = (&plan, &staged, &meter, &cancelled, &lanes);
        let moving = async move {
            // Each lane takes the next file; big files then go one at a time, split across lanes.
            let finished = turbo::each(lanes, turbo::UPLOAD_STREAMS, &whole, |lane, i| async move {
                if cancelled() {
                    return Ok(false);
                }
                let file = &plan.files[i];
                meter.start(&file.rel);
                let ok = turbo::upload_one(&lane, &file.local, &staged[i].0, meter, cancelled).await?;
                if ok {
                    meter.finish_file();
                }
                Ok(ok)
            })
            .await?;
            if !finished {
                return Ok(false);
            }
            for &i in &split {
                if cancelled() {
                    return Ok(false);
                }
                let file = &plan.files[i];
                meter.start(&file.rel);
                if !turbo::upload_split(lanes, &file.local, &staged[i].0, file.size, meter, cancelled).await? {
                    return Ok(false);
                }
                meter.finish_file();
            }
            Ok(true)
        };
        turbo::with_ticker(moving, || progress(meter.done(), meter.current().as_deref(), meter.bytes(), false)).await
    }
    .await;

    match outcome {
        Ok(true) => {
            // Everything arrived: move each file into place (replacing any older copy), all lanes
            // at once.
            progress(total, None, bytes_total, true);
            let every: Vec<usize> = (0..staged.len()).collect();
            let staged_ref = &staged;
            turbo::each(&lanes, turbo::UPLOAD_STREAMS, &every, |lane, i| async move {
                let (temp, target) = &staged_ref[i];
                lane.remove(target).await?;
                lane.rename(temp, target).await?;
                Ok(true)
            })
            .await?;
            progress(total, None, bytes_total, false);
            report.bytes = meter.bytes();
            Ok(report)
        }
        Ok(false) => {
            report.cancelled = true;
            report.leftovers = undo(&lanes, &staged, &created_dirs).await;
            Ok(report)
        }
        Err(error) => {
            undo(&lanes, &staged, &created_dirs).await;
            Err(error)
        }
    }
}

/// Removes what an unfinished upload put on the server: its temporary files (all lanes at once),
/// then the folders it created (deepest first). Returns how many of those couldn't be removed.
async fn undo(lanes: &[Arc<ssh::Connection>], staged: &[(String, String)], created_dirs: &[String]) -> usize {
    let left = AtomicUsize::new(0);
    let every: Vec<usize> = (0..staged.len()).collect();
    let left_ref = &left;
    let _ = turbo::each(lanes, turbo::UPLOAD_STREAMS, &every, |lane, i| async move {
        if lane.remove(&staged[i].0).await.is_err() {
            left_ref.fetch_add(1, Ordering::Relaxed);
        }
        Ok(true)
    })
    .await;
    for dir in created_dirs.iter().rev() {
        if lanes[0].remove_dir(dir).await.is_err() {
            left.fetch_add(1, Ordering::Relaxed);
        }
    }
    left.into_inner()
}

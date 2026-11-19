//! Before a push: finds the files someone changed on the server since Someprix last pushed them,
//! so a push never silently overwrites work done there.
//!
//! Every push records each file's size and modified time on the server (see
//! `Project::record_server`). The check compares the server's copy with that record; when there
//! is no record, or it differs, small files are fetched and compared by content with what was
//! last pushed, so a file that was only touched (or got the same edit) doesn't count. Big ones
//! aren't fetched: the server fingerprints them itself (SHA-256), and one that already has
//! exactly what's here counts as pushed.

use std::{io::Read, path::Path, time::Duration};

use futures::{stream, StreamExt, TryStreamExt};
use russh_sftp::{client::error::Error as SftpError, protocol::StatusCode};
use serde::Serialize;

use crate::{
    project::{self, Change, ChangeKind, ServerSig, SharedProject},
    ssh::{self, Connection},
};

/// Larger files aren't fetched just to compare them; their record decides.
const COMPARE_LIMIT: u64 = 1024 * 1024;

/// Server checks in flight at once (SFTP takes many requests on one connection).
const AT_ONCE: usize = 16;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub path: String,
    /// The local change the push would send.
    pub kind: ChangeKind,
    /// "changed": the server's copy changed since the last push. "exists": new here, but the
    /// server already has a different file by that name.
    pub reason: &'static str,
    pub server_size: u64,
    /// Seconds since 1970.
    pub server_modified: u64,
}

/// The destination a record belongs to.
pub fn target_key(host_id: &str, remote_dir: &str) -> String {
    let dir = remote_dir.trim_end_matches('/');
    format!("{host_id}:{}", if dir.is_empty() { "/" } else { dir })
}

/// The server's copy of `remote`, or `None` if there's no file there.
pub async fn server_sig(conn: &Connection, remote: &str) -> Result<Option<ServerSig>, String> {
    match conn.sftp.metadata(remote).await {
        Ok(meta) if meta.is_dir() => Ok(None),
        Ok(meta) => Ok(Some(ServerSig {
            size: meta.size.unwrap_or(0),
            mtime: meta.mtime.map_or(0, u64::from),
        })),
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(None),
        Err(error) => Err(format!("Check failed: {remote}: {}", ssh::describe(&error))),
    }
}

async fn server_hash(conn: &Connection, remote: &str) -> Result<u64, String> {
    let bytes = conn
        .sftp
        .read(remote)
        .await
        .map_err(|e| format!("Read failed: {remote}: {}", ssh::describe(&e)))?;
    Ok(xxhash_rust::xxh3::xxh3_64(&bytes))
}

/// What the check found for one file.
enum Found {
    Conflict(Conflict),
    /// No conflict, but the server's copy moved without its content changing: remember it as is.
    Unchanged(String, ServerSig),
    Fine,
}

/// The conflicts among `changes` (the ones about to be pushed), sorted by path.
pub async fn find(
    conn: &Connection,
    project: &SharedProject,
    root: &Path,
    remote_dir: &str,
    target: &str,
    changes: Vec<Change>,
) -> Result<Vec<Conflict>, String> {
    let found: Vec<Found> = stream::iter(changes)
        .map(|change| check(conn, project, root, remote_dir, target, change))
        .buffer_unordered(AT_ONCE)
        .try_collect()
        .await?;

    let mut conflicts = Vec::new();
    let mut unchanged = Vec::new();
    for item in found {
        match item {
            Found::Conflict(conflict) => conflicts.push(conflict),
            Found::Unchanged(path, sig) => unchanged.push((path, sig)),
            Found::Fine => {}
        }
    }
    if !unchanged.is_empty() {
        if let Some(project) = project.lock().unwrap().as_mut() {
            for (path, sig) in &unchanged {
                project.record_server(target, path, Some(*sig));
            }
            project.save_server();
        }
    }
    // Big files the server already has exactly: no conflict, and nothing to send. They count as
    // pushed now, so the push leaves them be.
    let same = same_on_server(conn, root, remote_dir, &conflicts).await;
    if !same.is_empty() {
        conflicts.retain(|c| !same.iter().any(|(path, ..)| *path == c.path));
        if let Some(project) = project.lock().unwrap().as_mut() {
            for (path, sig, server) in &same {
                project.mark_pushed(path, Some(*sig));
                project.record_server(target, path, Some(*server));
            }
            project.save_baseline();
            project.save_server();
        }
    }
    conflicts.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(conflicts)
}

/// Among conflicts too big to have been fetched and compared, the ones whose server copy is
/// exactly the local file: the server fingerprints them (one command for all), and so does this
/// computer. None when the server won't run commands (an SFTP-only login): they stay conflicts.
async fn same_on_server(conn: &Connection, root: &Path, remote_dir: &str, conflicts: &[Conflict]) -> Vec<(String, project::Sig, ServerSig)> {
    let mut candidates = Vec::new();
    for conflict in conflicts {
        if conflict.kind == ChangeKind::Deleted || conflict.server_size <= COMPARE_LIMIT {
            continue;
        }
        // Different sizes can't be the same file.
        let size = tokio::fs::metadata(root.join(&conflict.path)).await.map(|m| m.len());
        if size.is_ok_and(|size| size == conflict.server_size) {
            candidates.push(conflict);
        }
    }
    if candidates.is_empty() {
        return Vec::new();
    }
    // One line per file, in order: its SHA-256, or nothing when it couldn't be read.
    let mut script = String::from("for f in");
    for conflict in &candidates {
        script.push(' ');
        script.push_str(&ssh::sh_quote(&ssh::join(remote_dir, &conflict.path)));
    }
    script.push_str(r#"; do h=$(sha256sum -- "$f" 2>/dev/null || shasum -a 256 -- "$f" 2>/dev/null); echo "${h%% *}"; done"#);
    let Ok((0, output)) = conn.exec(&script, Duration::from_secs(300)).await else {
        return Vec::new();
    };
    let lines: Vec<&str> = output.lines().collect();
    if lines.len() != candidates.len() {
        return Vec::new();
    }
    let mut same = Vec::new();
    for (conflict, line) in candidates.into_iter().zip(lines) {
        // (A name with odd characters gets a backslash in front of its line.)
        let server = line.trim().trim_start_matches('\\').to_ascii_lowercase();
        if server.len() != 64 {
            continue;
        }
        let path = root.join(&conflict.path);
        let here = tauri::async_runtime::spawn_blocking(move || -> std::io::Result<(String, project::Sig)> {
            Ok((sha256_file(&path)?, project::signature(&path)?))
        })
        .await;
        if let Ok(Ok((hash, sig))) = here {
            if hash == server {
                same.push((conflict.path.clone(), sig, ServerSig { size: conflict.server_size, mtime: conflict.server_modified }));
            }
        }
    }
    same
}

/// A file's SHA-256, in lowercase hex (as sha256sum prints it).
fn sha256_file(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

async fn check(
    conn: &Connection,
    project: &SharedProject,
    root: &Path,
    remote_dir: &str,
    target: &str,
    change: Change,
) -> Result<Found, String> {
    let remote = ssh::join(remote_dir, &change.path);
    // Nothing there: nothing to lose.
    let Some(now) = server_sig(conn, &remote).await? else {
        return Ok(Found::Fine);
    };
    let (record, base) = {
        let guard = project.lock().unwrap();
        let Some(project) = guard.as_ref() else {
            return Err("No project open".into());
        };
        (project.server_sig(target, &change.path), project.baseline_sig(&change.path))
    };
    if record == Some(now) {
        return Ok(Found::Fine);
    }

    // Fetched at most once, and only when it settles the question.
    let mut fetched = None;
    let small = now.size <= COMPARE_LIMIT;

    // Has the server's copy moved on from what Someprix last pushed?
    let moved = match base {
        // New here, and the server has a file by that name.
        None => true,
        Some(base) if base.size != now.size => true,
        Some(base) if small => {
            let hash = server_hash(conn, &remote).await?;
            fetched = Some(hash);
            hash != base.hash
        }
        // Too big to fetch: trust the record, if there is one.
        Some(_) => record.is_some(),
    };
    if !moved {
        return Ok(Found::Unchanged(change.path, now));
    }

    // The server may already have exactly what's being pushed (the same edit made on both).
    if change.kind != ChangeKind::Deleted && small {
        let local = tokio::fs::read(root.join(&change.path)).await.ok();
        if let Some(local) = local.filter(|bytes| bytes.len() as u64 == now.size) {
            let server = match fetched {
                Some(hash) => hash,
                None => server_hash(conn, &remote).await?,
            };
            if server == xxhash_rust::xxh3::xxh3_64(&local) {
                return Ok(Found::Fine);
            }
        }
    }

    Ok(Found::Conflict(Conflict {
        reason: if base.is_none() { "exists" } else { "changed" },
        path: change.path,
        kind: change.kind,
        server_size: now.size,
        server_modified: now.mtime,
    }))
}

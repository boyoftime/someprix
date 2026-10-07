//! Text files for the editor, on this computer or a server: read whole, saved whole. A save first
//! checks the file hasn't changed since it was opened, so nobody else's edit is lost silently.

use std::{fmt::Display, fs, io::Read, time::UNIX_EPOCH};

use russh_sftp::client::fs::Metadata;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh::{describe, Connection};

/// The largest file the editor opens.
const MAX_SIZE: u64 = 5 << 20;
const BOM: &[u8] = b"\xEF\xBB\xBF";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub text: String,
    /// Starts with a UTF-8 byte order mark; saving keeps it.
    pub bom: bool,
    /// Which version of the file this is (its change time and size), handed back on save.
    pub version: String,
    /// This computer only: the file is marked read-only.
    pub readonly: bool,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Saved {
    /// Written; `version` is the file's new one, for the next save to check against.
    Saved { version: String },
    /// Someone else changed the file since it was opened; nothing was written.
    Changed,
}

fn too_big(path: &str) -> String {
    format!("Too large to edit (max 5 MB): {path}")
}

/// The text of a file, or why it isn't one the editor can show.
fn decode(mut bytes: Vec<u8>, path: &str) -> Result<(String, bool), String> {
    if bytes.len() as u64 > MAX_SIZE {
        return Err(too_big(path));
    }
    let bom = bytes.starts_with(BOM);
    if bom {
        bytes.drain(..BOM.len());
    }
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Err(format!("Binary file: {path}"));
    }
    String::from_utf8(bytes)
        .map(|text| (text, bom))
        .map_err(|_| format!("Not UTF-8 text: {path}"))
}

fn encode(text: &str, bom: bool) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() + BOM.len());
    if bom {
        bytes.extend_from_slice(BOM);
    }
    bytes.extend_from_slice(text.as_bytes());
    bytes
}

// ---------- This computer ----------

fn local_version(meta: &fs::Metadata) -> String {
    let millis = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis());
    format!("{millis}:{}", meta.len())
}

pub fn read_local(path: &str) -> Result<TextFile, String> {
    let fail = |e: &dyn Display| format!("Open failed: {path}: {e}");
    let meta = fs::metadata(path).map_err(|e| fail(&e))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {path}"));
    }
    if meta.len() > MAX_SIZE {
        return Err(too_big(path));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_SIZE + 1).read_to_end(&mut bytes))
        .map_err(|e| fail(&e))?;
    let (text, bom) = decode(bytes, path)?;
    Ok(TextFile { text, bom, version: local_version(&meta), readonly: meta.permissions().readonly() })
}

/// Writes `text` over the file, unless it has changed since `expected` (left out: write anyway).
pub fn save_local(path: &str, text: &str, bom: bool, expected: Option<&str>) -> Result<Saved, String> {
    let fail = |e: &dyn Display| format!("Save failed: {path}: {e}");
    // A file that's gone since is simply written again.
    if let (Some(expected), Ok(meta)) = (expected, fs::metadata(path)) {
        if local_version(&meta) != expected {
            return Ok(Saved::Changed);
        }
    }
    fs::write(path, encode(text, bom)).map_err(|e| fail(&e))?;
    let meta = fs::metadata(path).map_err(|e| fail(&e))?;
    Ok(Saved::Saved { version: local_version(&meta) })
}

// ---------- Server ----------

fn remote_version(meta: &Metadata) -> String {
    format!("{}:{}", meta.mtime.unwrap_or(0), meta.size.unwrap_or(0))
}

pub async fn read_remote(conn: &Connection, path: &str) -> Result<TextFile, String> {
    let fail = |e: &dyn Display| format!("Open failed: {path}: {}", describe(e));
    let meta = conn.sftp.metadata(path).await.map_err(|e| fail(&e))?;
    // Only plain files: a device like /dev/zero would never end.
    if !meta.file_type().is_file() {
        return Err(format!("Not a file: {path}"));
    }
    if meta.size.unwrap_or(0) > MAX_SIZE {
        return Err(too_big(path));
    }
    let mut file = conn.sftp.open(path).await.map_err(|e| fail(&e))?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_SIZE + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| fail(&e))?;
    let _ = file.shutdown().await;
    let (text, bom) = decode(bytes, path)?;
    Ok(TextFile { text, bom, version: remote_version(&meta), readonly: false })
}

/// Writes `text` over the server file, unless it has changed since `expected` (left out: write
/// anyway). Written in place, so the file keeps its owner and permissions.
pub async fn save_remote(
    conn: &Connection,
    path: &str,
    text: &str,
    bom: bool,
    expected: Option<&str>,
) -> Result<Saved, String> {
    let fail = |e: &dyn Display| format!("Save failed: {path}: {}", describe(e));
    if let Some(expected) = expected {
        if let Ok(meta) = conn.sftp.metadata(path).await {
            if remote_version(&meta) != expected {
                return Ok(Saved::Changed);
            }
        }
    }
    let mut file = conn.sftp.create(path).await.map_err(|e| fail(&e))?;
    file.write_all(&encode(text, bom)).await.map_err(|e| fail(&e))?;
    // Closing waits for every write to be confirmed.
    file.shutdown().await.map_err(|e| fail(&e))?;
    let meta = conn.sftp.metadata(path).await.map_err(|e| fail(&e))?;
    Ok(Saved::Saved { version: remote_version(&meta) })
}

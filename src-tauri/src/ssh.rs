//! SSH connections to saved hosts, and the SFTP sessions used to browse and push files.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

use russh::{
    client,
    keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    ChannelMsg, Disconnect,
};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use crate::store::{self, AuthMethod, Host, Store};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

pub struct Connection {
    pub sftp: SftpSession,
    handle: client::Handle<Client>,
    home: String,
}

/// How long an ordinary request (a listing, a rename…) may take before it counts as lost.
const REQUEST_TIMEOUT_SECS: u64 = 20;
/// How long a request may take while files are moving. Reads and writes are queued several at a
/// time and each one's clock starts when it's sent, so on a slow link the last in the queue waits
/// for all the others: with 8 reads of 256 KB in flight, this still allows links down to ~17 KB/s.
const TRANSFER_TIMEOUT_SECS: u64 = 120;
/// Reads kept in flight while downloading (the library's default is 16, 4 MB at a time).
const READS_IN_FLIGHT: usize = 8;
/// Writes kept in flight per open file while uploading: 16 x 32 KB = 512 KB. Transfers run four
/// files (or file parts) per connection at once, so each connection still keeps 2 MB moving,
/// enough to fill a long line, while what's unconfirmed per file stays small enough for progress
/// to move in small, steady steps.
const WRITES_IN_FLIGHT: usize = 16;
/// Bytes an upload can have handed to the write pipeline that the server hasn't confirmed yet.
/// Progress counts only what's past this, so it follows what the server actually has instead of
/// jumping ahead when the pipeline fills and then stalling while it drains.
pub const UNCONFIRMED: u64 = WRITES_IN_FLIGHT as u64 * 32 * 1024;

/// While alive, requests on the connection get the transfer deadline; dropping it restores the
/// ordinary one, however the transfer ended.
pub struct TransferDeadline<'a>(&'a Connection);

impl Drop for TransferDeadline<'_> {
    fn drop(&mut self) {
        self.0.sftp.set_timeout(REQUEST_TIMEOUT_SECS);
    }
}

/// An SFTP error in words: the library's bare "Timeout" becomes something a person can act on.
pub fn describe(error: &dyn std::fmt::Display) -> String {
    let text = error.to_string();
    if text.trim().eq_ignore_ascii_case("timeout") {
        "timeout (no response)".into()
    } else {
        text
    }
}

#[derive(Default)]
pub struct Ssh {
    connections: tokio::sync::Mutex<HashMap<String, Arc<Connection>>>,
    /// Extra connections per host, used alongside the main one to move files in parallel.
    lanes: tokio::sync::Mutex<HashMap<String, Vec<Arc<Connection>>>>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ConnectOutcome {
    Connected { home: String },
    /// First connection to this server: the user has to confirm its key.
    UnknownHost { fingerprint: String },
    /// The server's key differs from the one the user trusted before.
    ChangedHost { fingerprint: String, expected: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
}

/// Accepts the server only if its key matches the fingerprint the user trusted, and records the
/// key it saw so an unknown or changed key can be shown to the user.
struct Client {
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let trusted = self.expected.as_deref() == Some(fingerprint.as_str());
        *self.seen.lock().unwrap() = Some(fingerprint);
        Ok(trusted)
    }
}

/// What opening a connection came to: ready, or waiting on the user to trust the server's key.
enum Opened {
    Ready(Connection),
    Prompt(ConnectOutcome),
}

/// How long an extra transfer connection may take to open before it's left out.
const LANE_OPEN_LIMIT: Duration = Duration::from_secs(20);

/// Opens a new SSH connection with an SFTP session to `host`.
async fn open(store: &Store, host: &Host) -> Result<Opened, String> {
    let address = host.address();
    let expected = store.known_host(&address);
    let seen = Arc::new(Mutex::new(None));
    let handler = Client {
        expected: expected.clone(),
        seen: seen.clone(),
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        // Every SFTP request is a small packet; don't hold it back waiting to bundle more.
        nodelay: true,
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        ..Default::default()
    });

    let connecting = client::connect(config, (host.host.as_str(), host.port), handler);
    let mut handle = match tokio::time::timeout(CONNECT_TIMEOUT, connecting).await {
        Err(_) => return Err(format!("Timeout: {address} (15 s)")),
        Ok(Ok(handle)) => handle,
        Ok(Err(err)) => {
            let seen = seen.lock().unwrap().clone();
            return match (seen, expected) {
                (Some(fingerprint), None) => Ok(Opened::Prompt(ConnectOutcome::UnknownHost { fingerprint })),
                (Some(fingerprint), Some(expected)) if fingerprint != expected => {
                    Ok(Opened::Prompt(ConnectOutcome::ChangedHost { fingerprint, expected }))
                }
                _ => Err(format!("Connect failed: {address}: {err}")),
            };
        }
    };

    let secret = store::secret(&host.id);
    let auth = match host.auth {
        AuthMethod::Password => {
            let password = secret.ok_or("No saved password")?;
            handle.authenticate_password(host.username.as_str(), password).await
        }
        AuthMethod::Key => {
            let path = host.key_path.as_deref().ok_or("No key file set")?;
            let key = russh::keys::load_secret_key(path, secret.as_deref())
                .map_err(|e| format!("Key read failed: {e}"))?;
            let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
            handle.authenticate_publickey(host.username.as_str(), key).await
        }
    }
    .map_err(|e| format!("Login failed: {address}: {e}"))?;

    if !auth.success() {
        return Err(format!("Auth failed: {}@{}", host.username, host.host));
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Session failed: {address}: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("SFTP unavailable: {address}: {e}"))?;
    let config = russh_sftp::client::Config {
        max_concurrent_reads: READS_IN_FLIGHT,
        max_concurrent_writes: WRITES_IN_FLIGHT,
        request_timeout_secs: REQUEST_TIMEOUT_SECS,
        ..Default::default()
    };
    let sftp = SftpSession::new_with_config(channel.into_stream(), config)
        .await
        .map_err(|e| format!("SFTP unavailable: {address}: {e}"))?;
    let home = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());

    Ok(Opened::Ready(Connection { sftp, handle, home }))
}

impl Ssh {
    pub async fn connect(&self, store: &Store, host: &Host) -> Result<ConnectOutcome, String> {
        // Already connected: reuse it rather than dropping a connection that's in use.
        if let Ok(conn) = self.get(&host.id).await {
            return Ok(ConnectOutcome::Connected { home: conn.home.clone() });
        }
        match open(store, host).await? {
            Opened::Prompt(outcome) => Ok(outcome),
            Opened::Ready(conn) => {
                let home = conn.home.clone();
                self.connections.lock().await.insert(host.id.clone(), Arc::new(conn));
                Ok(ConnectOutcome::Connected { home })
            }
        }
    }

    /// The host's connection plus up to `count - 1` extra ones for transfers, opened in parallel
    /// the first time and kept for later. Extras that can't open are simply left out, so this
    /// only fails when the main connection is gone.
    pub async fn lanes(&self, store: &Store, host_id: &str, count: usize) -> Result<Vec<Arc<Connection>>, String> {
        let main = self.get(host_id).await?;
        let mut all = vec![main];
        let Some(host) = store.host(host_id) else {
            return Ok(all);
        };
        let mut pool = self.lanes.lock().await;
        let extra = pool.entry(host_id.to_string()).or_default();
        extra.retain(|conn| !conn.handle.is_closed());
        let missing = count.saturating_sub(1 + extra.len());
        if missing > 0 {
            let opening = (0..missing).map(|_| tokio::time::timeout(LANE_OPEN_LIMIT, open(store, &host)));
            for opened in futures::future::join_all(opening).await {
                if let Ok(Ok(Opened::Ready(conn))) = opened {
                    extra.push(Arc::new(conn));
                }
            }
        }
        all.extend(extra.iter().take(count.saturating_sub(1)).cloned());
        Ok(all)
    }

    pub async fn disconnect(&self, host_id: &str) {
        if let Some(conn) = self.connections.lock().await.remove(host_id) {
            let _ = conn.handle.disconnect(Disconnect::ByApplication, "", "en").await;
        }
        for conn in self.lanes.lock().await.remove(host_id).unwrap_or_default() {
            let _ = conn.handle.disconnect(Disconnect::ByApplication, "", "en").await;
        }
    }

    /// The live connection for a host, or an error the user can act on.
    pub async fn get(&self, host_id: &str) -> Result<Arc<Connection>, String> {
        let mut connections = self.connections.lock().await;
        match connections.get(host_id) {
            Some(conn) if !conn.handle.is_closed() => Ok(conn.clone()),
            Some(_) => {
                connections.remove(host_id);
                Err("Connection lost".into())
            }
            None => Err("Not connected".into()),
        }
    }

    pub async fn connected_ids(&self) -> Vec<String> {
        let connections = self.connections.lock().await;
        connections
            .iter()
            .filter(|(_, conn)| !conn.handle.is_closed())
            .map(|(id, _)| id.clone())
            .collect()
    }
}

/// One file a download fetches: where it is on the server, where it goes (relative to the
/// destination folder, `/`-separated), and its size.
pub struct RemoteFile {
    pub remote: String,
    pub rel: String,
    pub size: u64,
}

/// Everything a download fetches: its files, the folders to create (relative, parents first),
/// and the dragged items' names as they'll appear locally.
#[derive(Default)]
pub struct DownloadPlan {
    pub files: Vec<RemoteFile>,
    pub folders: Vec<String>,
    pub roots: Vec<String>,
}

/// A mode like 0o40755 as "drwxr-xr-x (755)".
fn format_mode(mode: u32) -> String {
    let kind = match mode & 0o170000 {
        0o040000 => 'd',
        0o120000 => 'l',
        _ => '-',
    };
    let bits: String = (0..9)
        .map(|i| {
            let on = mode & (0o400 >> i) != 0;
            match (on, i % 3) {
                (false, _) => '-',
                (true, 0) => 'r',
                (true, 1) => 'w',
                (true, _) => 'x',
            }
        })
        .collect();
    format!("{kind}{bits} ({:o})", mode & 0o777)
}

/// Quotes text for a POSIX shell, so paths with spaces or quotes stay one argument.
pub fn sh_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

impl Connection {
    /// Runs a shell command on the server and waits up to `limit` for it to finish. Returns its
    /// exit code and everything it printed; a server that won't run commands (an SFTP-only
    /// login, say) gives code 255.
    pub async fn exec(&self, command: &str, limit: Duration) -> Result<(u32, String), String> {
        let fail = |e: &dyn std::fmt::Display| format!("Exec failed: {e}");
        let mut channel = self.handle.channel_open_session().await.map_err(|e| fail(&e))?;
        channel.exec(true, command).await.map_err(|e| fail(&e))?;
        let run = async {
            let mut output = Vec::new();
            let mut code = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => output.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                    // Refused: some servers say no but leave the channel open, so stop here.
                    ChannelMsg::Failure => break,
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            (code.unwrap_or(255), String::from_utf8_lossy(&output).trim().to_string())
        };
        let result = tokio::time::timeout(limit, run).await;
        let _ = channel.close().await;
        result.map_err(|_| "Server timeout".to_string())
    }

    /// Properties of files and folders on the server. Folders are counted through with one
    /// command (du and find) when the server runs commands, else by walking them over SFTP.
    pub async fn properties(
        &self,
        paths: &[String],
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<Vec<crate::files::ItemProps>, String> {
        let mut items = Vec::with_capacity(paths.len());
        for path in paths {
            let meta = self
                .sftp
                .symlink_metadata(path.as_str())
                .await
                .map_err(|e| format!("Not found: {path}: {}", describe(&e)))?;
            let kind = meta.file_type();
            items.push(crate::files::ItemProps {
                name: path.trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_string(),
                path: path.clone(),
                is_dir: kind.is_dir(),
                link: kind.is_symlink(),
                size: if kind.is_dir() { 0 } else { meta.len() },
                files: u64::from(!kind.is_dir()),
                modified: meta.mtime.map(u64::from),
                mode: meta.permissions.map(format_mode),
                owner: match (&meta.user, &meta.group, meta.uid, meta.gid) {
                    (Some(user), Some(group), _, _) => Some(format!("{user}:{group}")),
                    (_, _, Some(uid), Some(gid)) => Some(format!("{uid}:{gid}")),
                    _ => None,
                },
                ..Default::default()
            });
        }

        // One command answers for everything: size, file and folder counts, owner names.
        let script = format!(
            "for p in {}; do \
               s=$(du -sb -- \"$p\" 2>/dev/null | cut -f1); \
               [ -n \"$s\" ] || {{ k=$(du -sk -- \"$p\" 2>/dev/null | cut -f1); s=$(( ${{k:-0}} * 1024 )); }}; \
               f=$(find \"$p\" -type f 2>/dev/null | wc -l); \
               d=$(find \"$p\" -type d 2>/dev/null | wc -l); \
               o=$(stat -c '%U:%G' -- \"$p\" 2>/dev/null); \
               printf '%s\\t%s\\t%s\\t%s\\n' \"$s\" $f $d \"$o\"; \
             done",
            paths.iter().map(|p| sh_quote(p)).collect::<Vec<_>>().join(" ")
        );
        let answered = match self.exec(&script, Duration::from_secs(300)).await {
            Ok((_, output)) => {
                let lines: Vec<&str> = output.lines().filter(|l| l.contains('\t')).collect();
                if lines.len() == items.len() {
                    for (item, line) in items.iter_mut().zip(lines) {
                        let mut parts = line.split('\t');
                        let mut number = || parts.next().and_then(|n| n.trim().parse::<u64>().ok());
                        let (size, files, folders) = (number(), number(), number());
                        if item.is_dir && !item.link {
                            item.size = size.unwrap_or(0);
                            item.files = files.unwrap_or(0);
                            // find counts the folder itself.
                            item.folders = folders.unwrap_or(1).saturating_sub(1);
                        }
                        if let Some(owner) = parts.next().map(str::trim).filter(|o| o.contains(':')) {
                            item.owner = Some(owner.to_string());
                        }
                    }
                    true
                } else {
                    false
                }
            }
            Err(_) => false,
        };
        if answered {
            return Ok(items);
        }

        // No commands here: walk each folder over SFTP.
        for item in items.iter_mut().filter(|i| i.is_dir && !i.link) {
            let mut to_visit = vec![item.path.clone()];
            while let Some(dir) = to_visit.pop() {
                if cancelled() {
                    return Err("Cancelled".into());
                }
                let Ok(listing) = self.sftp.read_dir(dir.as_str()).await else {
                    item.partial = true;
                    continue;
                };
                for entry in listing {
                    let name = entry.file_name();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let meta = entry.metadata();
                    if meta.file_type().is_dir() {
                        item.folders += 1;
                        to_visit.push(join(&dir, &name));
                    } else {
                        item.files += 1;
                        item.size += meta.len();
                    }
                }
            }
        }
        Ok(items)
    }

    /// A login shell on the server with a pseudo-terminal `cols` x `rows`, for a terminal tab.
    /// The server answers the shell request on the channel itself (Success or Failure).
    pub async fn open_shell(&self, cols: u32, rows: u32) -> Result<russh::Channel<client::Msg>, String> {
        let fail = |e: &dyn std::fmt::Display| format!("Shell failed: {e}");
        let channel = self.handle.channel_open_session().await.map_err(|e| fail(&e))?;
        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| fail(&e))?;
        channel.request_shell(true).await.map_err(|e| fail(&e))?;
        Ok(channel)
    }

    /// Gives requests the patient transfer deadline until the returned guard is dropped.
    pub fn transfer_deadline(&self) -> TransferDeadline<'_> {
        self.sftp.set_timeout(TRANSFER_TIMEOUT_SECS);
        TransferDeadline(self)
    }

    pub async fn list(&self, path: &str) -> Result<Vec<RemoteEntry>, String> {
        let dir = self
            .sftp
            .read_dir(path)
            .await
            .map_err(|e| format!("Open failed: {path}: {e}"))?;

        let mut entries = Vec::new();
        for entry in dir {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let path = join(path, &name);
            let meta = entry.metadata();
            let file_type = entry.file_type();
            // Follow symlinks so linked folders (e.g. /var/www) can be opened.
            let is_dir = if file_type.is_symlink() {
                self.sftp.metadata(path.as_str()).await.map(|m| m.is_dir()).unwrap_or(false)
            } else {
                file_type.is_dir()
            };
            entries.push(RemoteEntry {
                name,
                path,
                is_dir,
                size: meta.size.unwrap_or(0),
                modified: meta.mtime.map(u64::from),
            });
        }
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub async fn create_dir(&self, path: &str) -> Result<(), String> {
        self.refuse_existing(path).await?;
        self.sftp
            .create_dir(path)
            .await
            .map_err(|e| format!("Create failed: {path}: {e}"))
    }

    /// Creates an empty file. Never replaces one: an existing name is an error.
    pub async fn create_file(&self, path: &str) -> Result<(), String> {
        use russh_sftp::protocol::OpenFlags;
        self.refuse_existing(path).await?;
        let fail = |e: &dyn std::fmt::Display| format!("Create failed: {path}: {e}");
        let mut file = self
            .sftp
            .open_with_flags(path, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE)
            .await
            .map_err(|e| fail(&e))?;
        file.shutdown().await.map_err(|e| fail(&e))
    }

    /// Walks the dragged files and folders to plan a download. Names are made safe for Windows.
    /// Symlinks to files are followed; symlinks to folders are skipped, so a loop can't trap it.
    pub async fn plan_download(&self, sources: &[String]) -> Result<DownloadPlan, String> {
        let mut plan = DownloadPlan::default();
        for source in sources {
            let path = source.trim_end_matches('/');
            let name = path.rsplit('/').next().unwrap_or_default();
            if name.is_empty() {
                return Err("Can't download /".into());
            }
            let meta = self
                .sftp
                .metadata(path)
                .await
                .map_err(|e| format!("Not found: {path}: {e}"))?;
            let root = crate::files::safe_name(name);
            plan.roots.push(root.clone());
            if !meta.file_type().is_dir() {
                plan.files.push(RemoteFile { remote: path.to_string(), rel: root, size: meta.len() });
                continue;
            }
            plan.folders.push(root.clone());
            let mut to_visit = vec![(path.to_string(), root)];
            while let Some((dir, rel_dir)) = to_visit.pop() {
                let listing = self
                    .sftp
                    .read_dir(dir.as_str())
                    .await
                    .map_err(|e| format!("Open failed: {dir}: {e}"))?;
                for entry in listing {
                    let name = entry.file_name();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let remote = join(&dir, &name);
                    let rel = format!("{rel_dir}/{}", crate::files::safe_name(&name));
                    let mut meta = entry.metadata();
                    if meta.file_type().is_symlink() {
                        match self.sftp.metadata(remote.as_str()).await {
                            Ok(target) if !target.file_type().is_dir() => meta = target,
                            _ => continue,
                        }
                    }
                    if meta.file_type().is_dir() {
                        plan.folders.push(rel.clone());
                        to_visit.push((remote, rel));
                    } else {
                        plan.files.push(RemoteFile { remote, rel, size: meta.len() });
                    }
                }
            }
        }
        Ok(plan)
    }

    /// Streams `remote_path` into a local file, reporting how many bytes have arrived so far.
    /// `on_progress` returns false to stop; the result is then `Ok(false)` and the local file is
    /// left partial for the caller to clean up.
    pub async fn download_file(
        &self,
        remote_path: &str,
        local: &std::path::Path,
        mut on_progress: impl FnMut(u64) -> bool,
    ) -> Result<bool, String> {
        use tokio::io::AsyncReadExt;
        let read_fail = |e: &dyn std::fmt::Display| format!("Read failed: {remote_path}: {}", describe(e));
        let write_fail = |e: &dyn std::fmt::Display| format!("Write failed: {}: {e}", local.display());
        let mut source = self.sftp.open(remote_path).await.map_err(|e| read_fail(&e))?;
        let mut target = tokio::fs::File::create(local).await.map_err(|e| write_fail(&e))?;
        let mut buffer = vec![0; 128 * 1024];
        let mut received = 0;
        let mut finished = true;
        loop {
            let read = source.read(&mut buffer).await.map_err(|e| read_fail(&e))?;
            if read == 0 {
                break;
            }
            target.write_all(&buffer[..read]).await.map_err(|e| write_fail(&e))?;
            received += read as u64;
            if !on_progress(received) {
                finished = false;
                break;
            }
        }
        // Let the writes land and the file close before anyone renames or removes it.
        target.flush().await.map_err(|e| write_fail(&e))?;
        drop(target);
        let _ = source.shutdown().await;
        Ok(finished)
    }

    /// Deletes a file, or a folder with everything inside it. Symlinks are removed as links,
    /// never followed. Returns how many items were removed.
    pub async fn delete_tree(&self, path: &str) -> Result<usize, String> {
        if path.trim_end_matches('/').is_empty() {
            return Err("Can't delete /".into());
        }
        let meta = self
            .sftp
            .symlink_metadata(path)
            .await
            .map_err(|e| format!("Not found: {path}: {e}"))?;
        if !meta.file_type().is_dir() {
            self.sftp
                .remove_file(path)
                .await
                .map_err(|e| format!("Delete failed: {path}: {e}"))?;
            return Ok(1);
        }

        // Walk the folder, removing files as they're found; folders go last, deepest first.
        let mut folders = vec![path.to_string()];
        let mut to_visit = vec![path.to_string()];
        let mut removed = 0;
        while let Some(dir) = to_visit.pop() {
            let listing = self
                .sftp
                .read_dir(dir.as_str())
                .await
                .map_err(|e| format!("Open failed: {dir}: {e}"))?;
            for entry in listing {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let child = join(&dir, &name);
                if entry.file_type().is_dir() {
                    folders.push(child.clone());
                    to_visit.push(child);
                } else {
                    self.sftp
                        .remove_file(child.as_str())
                        .await
                        .map_err(|e| format!("Delete failed: {child}: {e}"))?;
                    removed += 1;
                }
            }
        }
        for dir in folders.iter().rev() {
            self.sftp
                .remove_dir(dir.as_str())
                .await
                .map_err(|e| format!("Delete failed: {dir}: {e}"))?;
            removed += 1;
        }
        Ok(removed)
    }

    async fn refuse_existing(&self, path: &str) -> Result<(), String> {
        if self.sftp.try_exists(path).await.unwrap_or(false) {
            let name = path.rsplit('/').next().unwrap_or(path);
            return Err(format!("Already exists: {name}"));
        }
        Ok(())
    }

    /// Creates `base/rel_dir` and any missing folders in between. `made` remembers what already
    /// exists so a push doesn't ask the server about the same folder twice.
    /// Also records in `created` the folders it actually had to create, so they can be removed
    /// again if the upload is undone.
    pub async fn ensure_dirs(
        &self,
        base: &str,
        rel_dir: &str,
        made: &mut HashSet<String>,
        created: &mut Vec<String>,
    ) -> Result<(), String> {
        let mut current = base.trim_end_matches('/').to_string();
        for part in rel_dir.split('/').filter(|p| !p.is_empty()) {
            current = join(&current, part);
            if made.contains(&current) {
                continue;
            }
            if !self.sftp.try_exists(current.as_str()).await.unwrap_or(false) {
                self.create_dir(&current).await?;
                created.push(current.clone());
            }
            made.insert(current.clone());
        }
        Ok(())
    }

    pub async fn remove_dir(&self, path: &str) -> Result<(), String> {
        self.sftp
            .remove_dir(path)
            .await
            .map_err(|e| format!("Delete failed: {path}: {e}"))
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        self.sftp
            .rename(from, to)
            .await
            .map_err(|e| format!("Rename failed: {from} -> {to}: {e}"))
    }

    /// Streams a local file to `remote_path` without loading it all into memory, reporting how
    /// many bytes have been sent so far. `on_progress` returns false to stop; the result is then
    /// `Ok(false)` and the remote file is left partial for the caller to clean up.
    pub async fn upload_file(
        &self,
        local: &std::path::Path,
        remote_path: &str,
        mut on_progress: impl FnMut(u64) -> bool,
    ) -> Result<bool, String> {
        use tokio::io::AsyncReadExt;
        let fail = |e: &dyn std::fmt::Display| format!("Write failed: {remote_path}: {}", describe(e));
        let mut source = tokio::fs::File::open(local)
            .await
            .map_err(|e| format!("Read failed: {}: {e}", local.display()))?;
        let mut file = self.sftp.create(remote_path).await.map_err(|e| fail(&e))?;
        let mut buffer = vec![0; 128 * 1024];
        let mut sent = 0;
        loop {
            let read = source
                .read(&mut buffer)
                .await
                .map_err(|e| format!("Read failed: {}: {e}", local.display()))?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read]).await.map_err(|e| fail(&e))?;
            sent += read as u64;
            if !on_progress(sent.saturating_sub(UNCONFIRMED)) {
                let _ = file.shutdown().await;
                return Ok(false);
            }
        }
        // Closing waits for every write to be confirmed: now all of it counts.
        file.shutdown().await.map_err(|e| fail(&e))?;
        on_progress(sent);
        Ok(true)
    }

    /// Writes `bytes` to `remote_path` in pieces, reporting how many bytes have been sent so far.
    pub async fn upload(
        &self,
        remote_path: &str,
        bytes: &[u8],
        mut on_progress: impl FnMut(usize),
    ) -> Result<(), String> {
        const PIECE: usize = 128 * 1024;
        let fail = |e: &dyn std::fmt::Display| format!("Write failed: {remote_path}: {}", describe(e));
        let mut file = self.sftp.create(remote_path).await.map_err(|e| fail(&e))?;
        let mut sent = 0;
        for piece in bytes.chunks(PIECE) {
            file.write_all(piece).await.map_err(|e| fail(&e))?;
            sent += piece.len();
            on_progress(sent.saturating_sub(UNCONFIRMED as usize));
        }
        // Closing waits for every write to be confirmed: now all of it counts.
        file.shutdown().await.map_err(|e| fail(&e))?;
        on_progress(sent);
        Ok(())
    }

    pub async fn remove(&self, remote_path: &str) -> Result<(), String> {
        match self.sftp.remove_file(remote_path).await {
            Ok(()) => Ok(()),
            // Already gone is what we wanted.
            Err(_) if !self.sftp.try_exists(remote_path).await.unwrap_or(true) => Ok(()),
            Err(e) => Err(format!("Delete failed: {remote_path}: {e}")),
        }
    }
}

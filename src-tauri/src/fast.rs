//! Fast mode: files travel as one compressed archive (.tar.gz) that the other end unpacks with
//! `tar`. A slow link then carries fewer bytes, and one file instead of many.

use std::{
    io::Write,
    path::{Component, Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};

use std::sync::Arc;

use crate::{
    files, ssh,
    turbo::{self, Meter},
};

/// How long the server may take to pack or unpack.
const TAR_LIMIT: Duration = Duration::from_secs(600);

/// Counts the bytes written through it, to know where in the archive each file ended up.
pub struct Counting<W> {
    inner: W,
    written: u64,
}

impl<W: Write> Write for Counting<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// A local file removed when dropped, however the transfer ends.
pub struct TempFile(pub PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub type Archive = tar::Builder<flate2::write::GzEncoder<Counting<std::fs::File>>>;

fn pack_fail(e: &dyn std::fmt::Display) -> String {
    format!("Pack failed: {e}")
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// A fresh temporary path for an archive.
fn temp(prefix: &str) -> TempFile {
    TempFile(std::env::temp_dir().join(format!("{prefix}-{}.tar.gz", new_id())))
}

/// Starts an archive in a temporary file, compressed as tightly as gzip goes.
pub fn create(prefix: &str) -> Result<(TempFile, Archive), String> {
    let temp = temp(prefix);
    let file = std::fs::File::create(&temp.0).map_err(|e| pack_fail(&e))?;
    let encoder = flate2::write::GzEncoder::new(Counting { inner: file, written: 0 }, flate2::Compression::best());
    Ok((temp, tar::Builder::new(encoder)))
}

/// Compressed bytes written so far.
pub fn written(archive: &Archive) -> u64 {
    archive.get_ref().get_ref().written
}

/// Closes the archive; returns its size.
pub async fn finish(archive: Archive) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || -> std::io::Result<u64> {
        let mut counting = archive.into_inner()?.finish()?;
        counting.flush()?;
        Ok(counting.written)
    })
    .await
    .map_err(|e| pack_fail(&e))?
    .map_err(|e| pack_fail(&e))
}

/// Whether the server can run tar (an SFTP-only login can't).
pub async fn remote_has_tar(conn: &ssh::Connection) -> bool {
    conn.exec("command -v tar", Duration::from_secs(15))
        .await
        .is_ok_and(|(code, _)| code == 0)
}

/// Deletes files and folders (with everything inside) on the server with one `rm -rf`, instead of
/// a request per file. Returns None when the server won't run commands (an SFTP-only login), so
/// the caller can delete the ordinary way.
pub async fn delete_remote(conn: &ssh::Connection, paths: &[String]) -> Option<Result<(), String>> {
    for path in paths {
        let trimmed = path.trim_end_matches('/');
        if trimmed.is_empty() {
            return Some(Err("Can't delete /".into()));
        }
        // Only plain absolute paths: nothing that could resolve somewhere unexpected.
        if !path.starts_with('/') || trimmed.split('/').any(|part| part == "." || part == "..") {
            return Some(Err(format!("Invalid path: {path}")));
        }
    }
    if !conn
        .exec("command -v rm", Duration::from_secs(15))
        .await
        .is_ok_and(|(code, _)| code == 0)
    {
        return None;
    }
    let quoted: Vec<String> = paths.iter().map(|p| ssh::sh_quote(p)).collect();
    let command = format!("rm -rf -- {}", quoted.join(" "));
    Some(match conn.exec(&command, TAR_LIMIT).await {
        Ok((0, _)) => Ok(()),
        Ok((code, output)) => Err(format!(
            "Delete failed: {}",
            if output.is_empty() { format!("rm exit {code}") } else { output }
        )),
        Err(error) => Err(error),
    })
}

/// What happens on the server once an archive has arrived.
pub struct SwapPlan<'a> {
    /// Folders to create (relative), e.g. empty ones from an upload.
    pub dirs: &'a [String],
    /// Files in the archive (relative), each put in place as a whole.
    pub files: &'a [String],
    /// Files to delete (relative).
    pub deletions: &'a [String],
    /// Where the old copies of replaced or deleted files go, and the biggest size kept.
    pub backup: Option<(&'a str, u64)>,
}

/// What the server did, file by file: "A" added, "B" replaced (old copy kept), "C" replaced,
/// "X" deleted (old copy kept), "D" deleted, "G" already gone, "M" folder made; with the old
/// copy's size where one was kept. Paths are relative.
pub struct Swapped {
    pub lines: Vec<(char, u64, String)>,
    /// Set when it stopped partway; `lines` still say what was done.
    pub failure: Option<String>,
}

/// The steps for each file, in shell. `$S` is the folder the archive was unpacked into, `$B` the
/// backup folder (empty: none) and `$L` the biggest file it keeps.
const SWAP_FUNCTIONS: &str = r#"keep() {
  z=0
  [ -n "$B" ] && [ -f "$1" ] && [ ! -L "$1" ] || return 1
  z=$(wc -c < "$1" | tr -d " ") || return 1
  [ "$z" -le "$L" ] || return 1
  mkdir -p "$B/$(dirname "$1")" || return 1
  ln "$1" "$B/$1" 2>/dev/null || cp -p "$1" "$B/$1"
}
dir() {
  [ -d "$1" ] && return 0
  mkdir -p "$1" && echo "M 0 $1"
}
put() {
  dir "$(dirname "$1")" || return 1
  z=0
  if [ -e "$1" ] || [ -L "$1" ]; then
    if keep "$1"; then t=B; else t=C; fi
  else
    t=A
  fi
  mv -f "$S/$1" "$1" || return 1
  echo "$t $z $1"
}
gone() {
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then echo "G 0 $1"; return 0; fi
  if keep "$1"; then t=X; else t=D; fi
  rm -f "$1" || return 1
  echo "$t $z $1"
}
"#;

/// Unpacks `archive_name` (already uploaded into `remote_dir`) into a hidden folder beside the
/// files, then moves each file into place in one step (`mv` replaces a file whole), keeping the
/// old copy first when there's a backup folder. Nothing half-written is ever in place.
pub async fn unpack_swap(conn: &ssh::Connection, remote_dir: &str, archive_name: &str, plan: &SwapPlan<'_>) -> Result<Swapped, String> {
    let id = new_id();
    let stage = format!(".someprix-stage-{id}");
    // "./" in front, so no name can be read as an option.
    let rel = |path: &str| ssh::sh_quote(&format!("./{}", path.trim_start_matches('/')));
    let (backup, limit) = plan.backup.unwrap_or(("", 0));
    let mut script = format!("S={}\nB={}\nL={limit}\n{SWAP_FUNCTIONS}", ssh::sh_quote(&stage), ssh::sh_quote(backup));
    for dir in plan.dirs {
        script.push_str(&format!("dir {} || exit 1\n", rel(dir)));
    }
    for file in plan.files {
        script.push_str(&format!("put {} || exit 1\n", rel(file)));
    }
    for file in plan.deletions {
        script.push_str(&format!("gone {} || exit 1\n", rel(file)));
    }
    let script_name = format!(".someprix-swap-{id}.sh");
    let remote_archive = ssh::join(remote_dir, archive_name);
    if let Err(error) = conn.upload(&ssh::join(remote_dir, &script_name), script.as_bytes(), |_| {}).await {
        let _ = conn.remove(&remote_archive).await;
        return Err(error);
    }
    let command = format!(
        "cd {dir} || exit 1; mkdir -p {stage} && tar -x -z -o -f {archive} -C {stage}; c=$?; rm -f {archive}; \
         if [ $c -eq 0 ]; then sh {script}; c=$?; fi; rm -rf {stage} {script}; exit $c",
        dir = ssh::sh_quote(remote_dir),
        stage = ssh::sh_quote(&stage),
        archive = ssh::sh_quote(archive_name),
        script = ssh::sh_quote(&script_name),
    );
    let (code, output) = match conn.exec(&command, TAR_LIMIT).await {
        Ok(result) => result,
        Err(error) => {
            let _ = conn.remove(&remote_archive).await;
            return Err(error);
        }
    };
    let mut lines = Vec::new();
    let mut other = Vec::new();
    for line in output.lines() {
        let mut parts = line.splitn(3, ' ');
        let kind = parts.next().filter(|k| k.len() == 1).and_then(|k| k.chars().next());
        let size = parts.next().and_then(|z| z.parse::<u64>().ok());
        match (kind, size, parts.next()) {
            (Some(kind @ ('A' | 'B' | 'C' | 'X' | 'D' | 'G' | 'M')), Some(size), Some(path)) if path.starts_with("./") => {
                lines.push((kind, size, path[2..].to_string()));
            }
            _ => other.push(line),
        }
    }
    let failure = (code != 0).then(|| {
        let detail = other.join(" ").trim().to_string();
        format!("Unpack failed: {}", if detail.is_empty() { format!("exit {code}") } else { detail })
    });
    Ok(Swapped { lines, failure })
}

/// A progress report from fast mode.
pub struct Step<'a> {
    pub done: usize,
    pub total: usize,
    pub path: Option<&'a str>,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// "packing" or "unpacking"; none while the archive moves.
    pub stage: Option<&'static str>,
}

pub type Emit<'a> = &'a (dyn Fn(Step<'_>) + Sync);
pub type Cancelled<'a> = &'a (dyn Fn() -> bool + Sync);

fn unix_seconds(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

/// Uploads `plan` into `remote_dir` as one archive the server unpacks and puts in place (see
/// [`unpack_swap`]), keeping old copies in `backup` if given. Returns None when cancelled, which
/// leaves the server untouched: nothing is unpacked until the archive is whole.
pub async fn upload(
    lanes: &[Arc<ssh::Connection>],
    plan: &files::UploadPlan,
    remote_dir: &str,
    backup: Option<(&str, u64)>,
    cancelled: Cancelled<'_>,
    emit: Emit<'_>,
) -> Result<Option<Swapped>, String> {
    let total = plan.files.len();
    let bytes_total: u64 = plan.files.iter().map(|f| f.size).sum();
    let step = |done: usize, path: Option<&str>, bytes_done: u64, stage: Option<&'static str>| {
        emit(Step { done, total, path, bytes_done, bytes_total, stage })
    };
    let (local, mut archive) = create("someprix-up")?;

    // Folders first, so empty ones arrive too; then each file, streamed from disk.
    let folders = plan.folders.clone();
    archive = tauri::async_runtime::spawn_blocking(move || -> std::io::Result<Archive> {
        for rel in folders {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Directory);
            header.set_size(0);
            header.set_mode(0o755);
            archive.append_data(&mut header, format!("{rel}/"), std::io::empty())?;
        }
        Ok(archive)
    })
    .await
    .map_err(|e| pack_fail(&e))?
    .map_err(|e| pack_fail(&e))?;

    let mut ends = Vec::with_capacity(total);
    for file in &plan.files {
        if cancelled() {
            return Ok(None);
        }
        step(0, Some(&file.rel), 0, Some("packing"));
        let (path, rel) = (file.local.clone(), file.rel.clone());
        archive = tauri::async_runtime::spawn_blocking(move || -> std::io::Result<Archive> {
            let source = std::fs::File::open(&path)?;
            let meta = source.metadata()?;
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(meta.len());
            header.set_mode(0o644);
            header.set_mtime(unix_seconds(&meta));
            // Never more than the header promised, even if the file grows meanwhile.
            archive.append_data(&mut header, &rel, std::io::Read::take(source, meta.len()))?;
            Ok(archive)
        })
        .await
        .map_err(|e| pack_fail(&e))?
        .map_err(|e| format!("Pack failed: {}: {e}", file.rel))?;
        ends.push(written(&archive));
    }
    let archive_len = finish(archive).await?;
    if cancelled() {
        return Ok(None);
    }

    let archive_name = format!(".someprix-up-{}.tar.gz", new_id());
    let remote_archive = ssh::join(remote_dir, &archive_name);
    let label = |done: usize| plan.files.get(done).or(plan.files.last()).map(|f| f.rel.as_str());
    step(0, label(0), 0, None);
    let conn = &lanes[0];
    let meter = Meter::default();
    let sending = async {
        if turbo::split_upload(archive_len, lanes.len()) {
            turbo::upload_split(lanes, &local.0, &remote_archive, archive_len, &meter, cancelled).await
        } else {
            turbo::upload_one(conn, &local.0, &remote_archive, &meter, cancelled).await
        }
    };
    let sent = turbo::with_ticker(sending, || {
        let sent = meter.bytes();
        let done = ends.iter().take_while(|&&end| end <= sent).count();
        let share = sent as f64 / archive_len.max(1) as f64;
        step(done, label(done), (share * bytes_total as f64) as u64, None);
    })
    .await;
    match sent {
        Ok(true) if !cancelled() => {}
        Ok(_) => {
            let _ = conn.remove(&remote_archive).await;
            return Ok(None);
        }
        Err(error) => {
            let _ = conn.remove(&remote_archive).await;
            return Err(error);
        }
    }

    step(total, None, bytes_total, Some("unpacking"));
    let names: Vec<String> = plan.files.iter().map(|f| f.rel.clone()).collect();
    let swap = SwapPlan { dirs: &plan.folders, files: &names, deletions: &[], backup };
    unpack_swap(conn, remote_dir, &archive_name, &swap).await.map(Some)
}

/// The folder all `sources` sit in, and their names; None when they come from different folders.
pub fn shared_parent(sources: &[String]) -> Option<(String, Vec<String>)> {
    let mut parent = None;
    let mut names = Vec::with_capacity(sources.len());
    for source in sources {
        let (dir, name) = source.trim_end_matches('/').rsplit_once('/')?;
        if name.is_empty() {
            return None;
        }
        let dir = if dir.is_empty() { "/" } else { dir };
        match parent {
            None => parent = Some(dir.to_string()),
            Some(ref p) if p != dir => return None,
            _ => {}
        }
        names.push(name.to_string());
    }
    parent.map(|p| (p, names))
}

/// What a fast download wrote.
pub struct Downloaded {
    pub files: usize,
    pub folders: usize,
    pub bytes: u64,
    /// The top-level names, as written here (made safe for Windows).
    pub roots: Vec<String>,
}

/// Downloads `names` (all inside the server folder `parent`) into `base` as one archive the server
/// packs. Ok(None) when cancelled, which leaves this computer untouched. Errors before anything
/// was written come back as Err(None), so the caller can fall back to an ordinary download.
pub async fn download(
    lanes: &[Arc<ssh::Connection>],
    parent: &str,
    names: &[String],
    base: &Path,
    cancelled: Cancelled<'_>,
    emit: Emit<'_>,
) -> Result<Option<Downloaded>, Option<String>> {
    let conn = &lanes[0];
    let label = if names.len() == 1 { names[0].clone() } else { format!("{} items", names.len()) };
    let step = |path: Option<&str>, bytes_done: u64, bytes_total: u64, stage: Option<&'static str>| {
        emit(Step { done: 0, total: 0, path, bytes_done, bytes_total, stage })
    };

    // The server packs the items into a temporary archive.
    step(Some(&label), 0, 0, Some("packing"));
    let remote_archive = format!("/tmp/.someprix-down-{}.tar.gz", new_id());
    let quoted: Vec<String> = names.iter().map(|n| ssh::sh_quote(n)).collect();
    let command = format!(
        "cd {dir} || exit 1; tar -c -z -f {archive} -- {names}",
        dir = ssh::sh_quote(parent),
        archive = ssh::sh_quote(&remote_archive),
        names = quoted.join(" "),
    );
    let clean_up = || async {
        let _ = conn.remove(&remote_archive).await;
    };
    // Packing can't be stopped midway on the server; a cancel just stops waiting for it.
    let packed = tokio::select! {
        result = conn.exec(&command, TAR_LIMIT) => result,
        _ = async { while !cancelled() { tokio::time::sleep(Duration::from_millis(200)).await } } => {
            clean_up().await;
            return Ok(None);
        }
    };
    match packed {
        Ok((0, _)) => {}
        // tar says 1 when a file changed while it was read; the archive is still whole.
        Ok((1, _)) => {}
        _ => {
            clean_up().await;
            return Err(None);
        }
    }
    let archive_len = match conn.sftp.metadata(remote_archive.as_str()).await {
        Ok(meta) => meta.len(),
        Err(_) => {
            clean_up().await;
            return Err(None);
        }
    };

    // Fetch it.
    let local = temp("someprix-down");
    step(Some(&label), 0, archive_len, None);
    let meter = Meter::default();
    let fetching = async {
        if turbo::split_download(archive_len, lanes.len()) {
            turbo::download_split(lanes, &remote_archive, &local.0, archive_len, &meter, cancelled).await
        } else {
            turbo::download_one(conn, &remote_archive, &local.0, &meter, cancelled).await
        }
    };
    let fetched = turbo::with_ticker(fetching, || step(Some(&label), meter.bytes(), archive_len, None)).await;
    clean_up().await;
    match fetched {
        Ok(true) if !cancelled() => {}
        Ok(_) => return Ok(None),
        Err(error) => return Err(Some(error)),
    }

    // Unpack here: every file lands under a temporary name and moves into place only once all
    // of them are out, so a damaged archive leaves this computer as it was.
    step(None, archive_len, archive_len, Some("unpacking"));
    let archive_path = local.0.clone();
    let base = base.to_path_buf();
    let roots: Vec<String> = names.iter().map(|n| files::safe_name(n)).collect();
    let unpacked = tauri::async_runtime::spawn_blocking(move || unpack_local(&archive_path, &base))
        .await
        .map_err(|e| Some(format!("Unpack failed: {e}")))?
        .map_err(Some)?;
    drop(local);
    Ok(Some(Downloaded { files: unpacked.0, folders: unpacked.1, bytes: unpacked.2, roots }))
}

/// Unpacks a .tar.gz into `base`: folders and regular files only (links are skipped), each name
/// made safe for Windows, nothing allowed outside `base`. Returns files, folders and bytes.
fn unpack_local(archive_path: &Path, base: &Path) -> Result<(usize, usize, u64), String> {
    let fail = |e: &dyn std::fmt::Display| format!("Unpack failed: {e}");
    let file = std::fs::File::open(archive_path).map_err(|e| fail(&e))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut created = Vec::new();
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
    let (mut file_count, mut folder_count, mut bytes) = (0, 0, 0);

    let result = (|| -> Result<(), String> {
        for entry in archive.entries().map_err(|e| fail(&e))? {
            let mut entry = entry.map_err(|e| fail(&e))?;
            let path = entry.path().map_err(|e| fail(&e))?.into_owned();
            let mut parts = Vec::new();
            for component in path.components() {
                match component {
                    Component::Normal(part) => parts.push(files::safe_name(&part.to_string_lossy())),
                    Component::CurDir => {}
                    // Absolute paths or ".." could reach outside the destination.
                    _ => return Err(fail(&format!("unsafe path {}", path.display()))),
                }
            }
            if parts.is_empty() {
                continue;
            }
            let rel = parts.join("/");
            match entry.header().entry_type() {
                tar::EntryType::Directory => {
                    files::make_dirs(base, &rel, &mut created)?;
                    folder_count += 1;
                }
                tar::EntryType::Regular | tar::EntryType::Continuous => {
                    if let Some((dir, _)) = rel.rsplit_once('/') {
                        files::make_dirs(base, dir, &mut created)?;
                    }
                    let target = files::under(base, &rel);
                    let mut temp = target.clone().into_os_string();
                    temp.push(files::PART_SUFFIX);
                    let temp = PathBuf::from(temp);
                    staged.push((temp.clone(), target));
                    let mut out = std::fs::File::create(&temp).map_err(|e| fail(&e))?;
                    bytes += std::io::copy(&mut entry, &mut out).map_err(|e| fail(&e))?;
                    out.flush().map_err(|e| fail(&e))?;
                    file_count += 1;
                }
                _ => {}
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        files::undo(&staged, &created);
        return Err(error);
    }
    for (i, (temp, target)) in staged.iter().enumerate() {
        if let Err(e) = std::fs::rename(temp, target) {
            for (rest, _) in &staged[i..] {
                let _ = std::fs::remove_file(rest);
            }
            return Err(format!("Save failed: {}: {e}", target.display()));
        }
    }
    Ok((file_count, folder_count, bytes))
}

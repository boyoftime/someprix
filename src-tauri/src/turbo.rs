//! Parallel transfers over several SSH connections ("lanes") to the same server. On a long or
//! lossy line each TCP connection is held back on its own (every lost packet slows it, and it
//! needs round trips to speed up again), so spreading files across lanes, and splitting big
//! files into one part per lane, gets much closer to the line's real speed.

use std::{
    future::Future,
    io::SeekFrom,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use russh_sftp::protocol::OpenFlags;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::ssh::{describe, Connection, UNCONFIRMED};

/// Connections used for one transfer: the main one plus three extra.
pub const LANES: usize = 4;
/// Uploads run this many files (or parts of a file) at once on each connection: together they
/// keep the connection's 2 MB window full, and each one's unconfirmed tail stays small.
pub const UPLOAD_STREAMS: usize = 4;
/// Downloads already keep 2 MB of reads in flight per file, filling a connection on their own.
pub const DOWNLOAD_STREAMS: usize = 1;
/// Uploads split a file across lanes from this size up (each part at least 1 MB).
const SPLIT_UPLOAD_FROM: u64 = 4 << 20;
/// Downloads split only from here: each part's reads run up to ~2 MB past its end, which only
/// stops mattering on big files.
const SPLIT_DOWNLOAD_FROM: u64 = 64 << 20;
const CHUNK: usize = 128 * 1024;
/** The size split uploads aim for per part. */
const PART_TARGET: u64 = 4 << 20;
/// How often progress is reported while lanes work.
const TICK: Duration = Duration::from_millis(100);

pub type Cancelled<'a> = &'a (dyn Fn() -> bool + Sync);

/// Live counts that every lane adds to and the progress ticker reads.
#[derive(Default)]
pub struct Meter {
    bytes: AtomicU64,
    done: AtomicUsize,
    current: Mutex<Option<String>>,
}

impl Meter {
    pub fn add(&self, bytes: u64) {
        self.bytes.fetch_add(bytes, Ordering::Relaxed);
    }

    /// A file started: it's the one progress names.
    pub fn start(&self, path: &str) {
        *self.current.lock().unwrap() = Some(path.to_string());
    }

    pub fn finish_file(&self) {
        self.done.fetch_add(1, Ordering::Relaxed);
    }

    pub fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }

    pub fn done(&self) -> usize {
        self.done.load(Ordering::Relaxed)
    }

    pub fn current(&self) -> Option<String> {
        self.current.lock().unwrap().clone()
    }
}

/// Runs `work`, calling `tick` every 100 ms meanwhile (and once at the end), so progress shows
/// however the lanes interleave.
pub async fn with_ticker<T>(work: impl Future<Output = T>, tick: impl Fn()) -> T {
    tokio::pin!(work);
    loop {
        tokio::select! {
            out = &mut work => {
                tick();
                return out;
            }
            _ = tokio::time::sleep(TICK) => tick(),
        }
    }
}

/// Runs `job` for every index in `items`, with `streams` workers per lane each taking the next
/// one as soon as it's free. Stops at the first error; Ok(false) when a job reports it was cancelled.
pub async fn each<F, Fut>(lanes: &[Arc<Connection>], streams: usize, items: &[usize], job: F) -> Result<bool, String>
where
    F: Fn(Arc<Connection>, usize) -> Fut,
    Fut: Future<Output = Result<bool, String>>,
{
    let next = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    // Interleaved (lane 1, 2, 3, 4, 1, 2…), so the first items spread over every lane.
    let workers = (0..streams.max(1)).flat_map(|_| lanes.iter()).map(|lane| {
        let (next, stop, job) = (&next, &stop, &job);
        async move {
            loop {
                if stop.load(Ordering::Relaxed) {
                    return Ok(true);
                }
                let Some(&item) = items.get(next.fetch_add(1, Ordering::Relaxed)) else {
                    return Ok(true);
                };
                match job(lane.clone(), item).await {
                    Ok(true) => {}
                    other => {
                        stop.store(true, Ordering::Relaxed);
                        return other;
                    }
                }
            }
        }
    });
    let mut finished = true;
    for result in futures::future::join_all(workers).await {
        finished &= result?;
    }
    Ok(finished)
}

/// Whether a file of this size is worth splitting across lanes.
pub fn split_upload(size: u64, lanes: usize) -> bool {
    lanes > 1 && size >= SPLIT_UPLOAD_FROM
}

pub fn split_download(size: u64, lanes: usize) -> bool {
    lanes > 1 && size >= SPLIT_DOWNLOAD_FROM
}

/// One byte range per lane, in whole chunks.
fn parts(size: u64, lanes: usize) -> Vec<(u64, u64)> {
    let part = size.div_ceil(lanes as u64).next_multiple_of(CHUNK as u64).max(CHUNK as u64);
    (0..lanes as u64)
        .map(|i| ((i * part).min(size), ((i + 1) * part).min(size)))
        .collect()
}

/// Uploads `local` (`size` bytes) to `remote`, one part per lane, each written at its own offset.
/// Ok(false) when cancelled; the partial file is left for the caller to clean up.
pub async fn upload_split(
    lanes: &[Arc<Connection>],
    local: &Path,
    remote: &str,
    size: u64,
    meter: &Meter,
    cancelled: Cancelled<'_>,
) -> Result<bool, String> {
    let write_fail = |e: &dyn std::fmt::Display| format!("Write failed: {remote}: {}", describe(e));
    let read_fail = |e: &dyn std::fmt::Display| format!("Read failed: {}: {e}", local.display());
    // The file exists (empty) before the lanes open it.
    let mut first = lanes[0].sftp.create(remote).await.map_err(|e| write_fail(&e))?;
    first.shutdown().await.map_err(|e| write_fail(&e))?;

    // Parts of about 4 MB: at least one per lane, up to UPLOAD_STREAMS per lane on big files so
    // each lane's window stays full. Bigger parts mean less of each waits unconfirmed at its end,
    // so progress moves steadily.
    let streams = ((size / PART_TARGET) as usize).clamp(lanes.len(), lanes.len() * UPLOAD_STREAMS);
    let lane_of = |i: usize| &lanes[i % lanes.len()];
    let jobs = parts(size, streams).into_iter().enumerate().map(|(i, (start, end))| async move {
        let lane = lane_of(i);
        if start >= end {
            return Ok(true);
        }
        let mut out = lane
            .sftp
            .open_with_flags(remote, OpenFlags::WRITE)
            .await
            .map_err(|e| write_fail(&e))?;
        out.seek(SeekFrom::Start(start)).await.map_err(|e| write_fail(&e))?;
        let mut input = tokio::fs::File::open(local).await.map_err(|e| read_fail(&e))?;
        input.seek(SeekFrom::Start(start)).await.map_err(|e| read_fail(&e))?;
        let mut buffer = vec![0; CHUNK];
        let mut left = end - start;
        // Only bytes the server has confirmed count (see UNCONFIRMED).
        let (mut queued, mut counted) = (0u64, 0u64);
        while left > 0 {
            let want = (left as usize).min(CHUNK);
            let read = input.read(&mut buffer[..want]).await.map_err(|e| read_fail(&e))?;
            if read == 0 {
                break;
            }
            out.write_all(&buffer[..read]).await.map_err(|e| write_fail(&e))?;
            left -= read as u64;
            queued += read as u64;
            let confirmed = queued.saturating_sub(UNCONFIRMED);
            meter.add(confirmed - counted);
            counted = confirmed;
            if cancelled() {
                let _ = out.shutdown().await;
                return Ok(false);
            }
        }
        out.shutdown().await.map_err(|e| write_fail(&e))?;
        meter.add(queued - counted);
        Ok::<bool, String>(true)
    });
    let results = futures::future::try_join_all(jobs).await?;
    Ok(results.into_iter().all(|ok| ok))
}

/// Downloads `remote` (`size` bytes) into `local`, one part per lane, each written in place.
/// Ok(false) when cancelled; the partial file is left for the caller to clean up.
pub async fn download_split(
    lanes: &[Arc<Connection>],
    remote: &str,
    local: &Path,
    size: u64,
    meter: &Meter,
    cancelled: Cancelled<'_>,
) -> Result<bool, String> {
    let read_fail = |e: &dyn std::fmt::Display| format!("Read failed: {remote}: {}", describe(e));
    let write_fail = |e: &dyn std::fmt::Display| format!("Write failed: {}: {e}", local.display());
    // The whole file is laid out first, so every lane can write its part in place.
    std::fs::File::create(local)
        .and_then(|file| file.set_len(size))
        .map_err(|e| write_fail(&e))?;

    let jobs = parts(size, lanes.len()).into_iter().zip(lanes).map(|((start, end), lane)| async move {
        if start >= end {
            return Ok(true);
        }
        let mut input = lane.sftp.open(remote).await.map_err(|e| read_fail(&e))?;
        input.seek(SeekFrom::Start(start)).await.map_err(|e| read_fail(&e))?;
        let mut out = tokio::fs::OpenOptions::new()
            .write(true)
            .open(local)
            .await
            .map_err(|e| write_fail(&e))?;
        out.seek(SeekFrom::Start(start)).await.map_err(|e| write_fail(&e))?;
        let mut buffer = vec![0; CHUNK];
        let mut left = end - start;
        let mut finished = true;
        while left > 0 {
            let want = (left as usize).min(CHUNK);
            let read = input.read(&mut buffer[..want]).await.map_err(|e| read_fail(&e))?;
            if read == 0 {
                break;
            }
            out.write_all(&buffer[..read]).await.map_err(|e| write_fail(&e))?;
            left -= read as u64;
            meter.add(read as u64);
            if cancelled() {
                finished = false;
                break;
            }
        }
        // Let the writes land and the file close before anyone renames or removes it.
        out.flush().await.map_err(|e| write_fail(&e))?;
        drop(out);
        let _ = input.shutdown().await;
        Ok::<bool, String>(finished)
    });
    let results = futures::future::try_join_all(jobs).await?;
    Ok(results.into_iter().all(|ok| ok))
}

/// Uploads one file on one lane, adding its progress to `meter`.
pub async fn upload_one(
    lane: &Connection,
    local: &Path,
    remote: &str,
    meter: &Meter,
    cancelled: Cancelled<'_>,
) -> Result<bool, String> {
    let mut counted = 0;
    lane.upload_file(local, remote, |sent| {
        meter.add(sent - counted);
        counted = sent;
        !cancelled()
    })
    .await
}

/// Downloads one file on one lane, adding its progress to `meter`.
pub async fn download_one(
    lane: &Connection,
    remote: &str,
    local: &Path,
    meter: &Meter,
    cancelled: Cancelled<'_>,
) -> Result<bool, String> {
    let mut counted = 0;
    lane.download_file(remote, local, |got| {
        meter.add(got - counted);
        counted = got;
        !cancelled()
    })
    .await
}

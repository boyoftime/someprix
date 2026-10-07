//! Terminal tabs: each one is a shell session on the host's existing SSH connection. What the
//! shell prints streams to the page as raw bytes; keys and size changes come back as commands.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use russh::{client, ChannelMsg};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::{sync::mpsc, time::Instant};

/// During a burst (a long listing, a build log), output is gathered for this long before it goes to
/// the page, so it arrives as a few large pieces rather than thousands of tiny ones. Output after a
/// quiet spell, like the echo of a typed key, goes at once.
const GATHER: Duration = Duration::from_millis(8);
/// ...or until this much is waiting.
const GATHER_MAX: usize = 256 * 1024;

enum Input {
    Keys(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(Default)]
pub struct Terminals {
    next: AtomicU32,
    open: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<Input>>>>,
}

impl Terminals {
    /// Runs a shell channel until it ends, streaming its output to `output`. Returns its id.
    pub fn start(&self, channel: russh::Channel<client::Msg>, output: Channel<InvokeResponseBody>) -> u32 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (send, receive) = mpsc::unbounded_channel();
        self.open.lock().unwrap().insert(id, send);
        let open = self.open.clone();
        tauri::async_runtime::spawn(async move {
            let ended = pump(channel, receive, &output).await;
            open.lock().unwrap().remove(&id);
            // The last message is the only one that isn't raw output.
            let _ = output.send(InvokeResponseBody::Json(serde_json::to_string(&ended).unwrap_or_default()));
        });
        id
    }

    fn send(&self, id: u32, input: Input) -> Result<(), String> {
        let open = self.open.lock().unwrap();
        let session = open.get(&id).ok_or("Session closed")?;
        session.send(input).map_err(|_| "Session closed".to_string())
    }

    pub fn write(&self, id: u32, keys: Vec<u8>) -> Result<(), String> {
        self.send(id, Input::Keys(keys))
    }

    pub fn resize(&self, id: u32, cols: u32, rows: u32) -> Result<(), String> {
        self.send(id, Input::Resize { cols, rows })
    }

    pub fn close(&self, id: u32) {
        let _ = self.send(id, Input::Close);
    }
}

/// How a session ended, for the tab to show.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ended {
    /// The shell's exit code, when it gave one.
    exit_code: Option<u32>,
    /// Why it ended, when it wasn't the shell exiting.
    reason: Option<String>,
    /// The connection went: the shell didn't exit and nobody closed it.
    lost: bool,
}

async fn pump(
    channel: russh::Channel<client::Msg>,
    mut input: mpsc::UnboundedReceiver<Input>,
    output: &Channel<InvokeResponseBody>,
) -> Ended {
    let (mut read, write) = channel.split();
    let mut ended = Ended { exit_code: None, reason: None, lost: false };
    let mut exited = false;
    let mut gathered: Vec<u8> = Vec::new();
    let mut flush_at = Instant::now();
    let mut last_flush = Instant::now() - GATHER;
    let flush = |gathered: &mut Vec<u8>| -> bool {
        gathered.is_empty() || output.send(InvokeResponseBody::Raw(std::mem::take(gathered))).is_ok()
    };

    loop {
        tokio::select! {
            message = read.wait() => match message {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    let quiet = gathered.is_empty() && last_flush.elapsed() >= GATHER;
                    if gathered.is_empty() {
                        flush_at = Instant::now() + GATHER;
                    }
                    gathered.extend_from_slice(&data);
                    if quiet || gathered.len() >= GATHER_MAX {
                        if !flush(&mut gathered) {
                            break;
                        }
                        last_flush = Instant::now();
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exited = true;
                    ended.exit_code = Some(exit_status);
                }
                Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                    exited = true;
                    ended.reason = Some(format!("Killed by signal {signal_name:?}"));
                }
                // The only request that wants a reply is the shell itself.
                Some(ChannelMsg::Failure) => {
                    ended.reason = Some("Shell refused by server".into());
                    break;
                }
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            },
            _ = tokio::time::sleep_until(flush_at), if !gathered.is_empty() => {
                if !flush(&mut gathered) {
                    break;
                }
                last_flush = Instant::now();
            }
            next = input.recv() => match next {
                Some(Input::Keys(keys)) => {
                    if write.data_bytes(keys).await.is_err() {
                        break;
                    }
                }
                Some(Input::Resize { cols, rows }) => {
                    let _ = write.window_change(cols, rows, 0, 0).await;
                }
                Some(Input::Close) | None => {
                    let _ = write.close().await;
                    ended.reason = Some("Closed".into());
                    break;
                }
            },
        }
    }
    flush(&mut gathered);
    ended.lost = !exited && ended.reason.is_none();
    ended
}

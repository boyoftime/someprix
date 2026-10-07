import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Upload } from "lucide-react";
import { api, type LocalFsEntry, type PushProgress } from "../lib/api";
import { errorMessage, useAppData } from "../state/AppData";
import { HostDialog } from "../hosts/HostDialog";
import { ServerPane } from "../sync/ServerPane";
import { Splitter, useSplit } from "../sync/Splitter";
import { settling, useTransferSpeed } from "../ui/useTransferSpeed";
import { loadFast, saveFast } from "../ui/FastToggle";
import { remember, remembered } from "../lib/storage";
import type { MenuItem } from "../ui/ContextMenu";
import { DragProvider, type DragKind } from "./drag";
import { LocalBrowser, type Revealed } from "./LocalBrowser";
import { TransferBar, type FinishedTransfer } from "./TransferBar";

const LAST_HOST = "someprix.sftp.host";
const FAST_SFTP = "someprix.sftp.fast";
/** How long the outcome of a transfer stays in the footer. */
const OUTCOME_FOR = 6000;

/** One upload or download: these paths, into that folder (on the server, or on this computer). */
type Job = { id: number; kind: DragKind; hostId: string; sources: string[]; dir: string; fast: boolean };


const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Move files between this computer and a server: browse both sides, drag across either way. */
export function SftpPage() {
  const { hosts, connected, reconnecting, connect, notify, recordPush } = useAppData();
  const [chosenHost, setChosenHost] = useState<string | null>(() => remembered(LAST_HOST));
  const [addingHost, setAddingHost] = useState(false);
  const [remoteDir, setRemoteDir] = useState<string | null>(null);
  const [localDir, setLocalDir] = useState<string | null>(null);
  const localDirRef = useRef(localDir);
  localDirRef.current = localDir;
  // Where Download from the menu saves to.
  const [downloadsDir, setDownloadsDir] = useState<string | null>(null);
  useEffect(() => {
    api.localDownloads().then(setDownloadsDir, () => setDownloadsDir(null));
  }, []);
  const [selection, setSelection] = useState<LocalFsEntry[]>([]);
  // What the latest download wrote, for the local list to reload and point out.
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const panes = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useSplit("someprix.split.sftp");

  const hostId =
    (chosenHost && hosts.some((h) => h.id === chosenHost) ? chosenHost : null) ??
    (hosts.length === 1 ? hosts[0].id : null);
  const host = hosts.find((h) => h.id === hostId) ?? null;
  const isConnected = host ? connected.has(host.id) : false;

  const selectHost = (id: string) => {
    setChosenHost(id);
    remember(LAST_HOST, id);
    if (!connected.has(id)) void connect(id);
  };

  // ---------- Transfers: one at a time, the rest wait in line ----------
  const [queue, setQueue] = useState<Job[]>([]);
  const [active, setActive] = useState<Job | null>(null);
  const [progress, setProgress] = useState<PushProgress | null>(null);
  const [finished, setFinished] = useState<FinishedTransfer | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const transfer = useTransferSpeed(active !== null, settling(progress));
  const jobId = useRef(0);
  // Fast mode: transfers go as one compressed archive the other end unpacks.
  const [fast, setFast] = useState(() => loadFast(FAST_SFTP));
  const changeFast = (on: boolean) => {
    setFast(on);
    saveFast(FAST_SFTP, on);
  };

  const enqueue = useCallback(
    (kind: DragKind, sources: string[], dir: string) => {
      if (!host || !connected.has(host.id) || !sources.length) return;
      setQueue((q) => [...q, { id: ++jobId.current, kind, hostId: host.id, sources, dir, fast }]);
    },
    [host, connected, fast],
  );
  const upload = useCallback((sources: string[], dir: string) => enqueue("upload", sources, dir), [enqueue]);
  const download = useCallback((sources: string[], dir: string) => enqueue("download", sources, dir), [enqueue]);

  useEffect(() => {
    if (active || queue.length === 0) return;
    const [job, ...rest] = queue;
    setQueue(rest);
    setActive(job);
    setProgress(null);
    setFinished(null);
    setCancelling(false);
    transfer.reset();
    const up = job.kind === "upload";
    // Show the result on the side that was written to.
    const settle = (written: string[]) => {
      if (up) recordPush(written);
      else setRevealed({ at: Date.now(), paths: written });
    };
    void (async () => {
      const unlisten = await api.onTransferProgress((next) => {
        if (next.bytesDone !== undefined) transfer.record(next.bytesDone);
        setProgress(next);
      });
      try {
        const report = up
          ? await api.upload(job.hostId, job.sources, job.dir, job.fast)
          : await api.download(job.hostId, job.sources, job.dir, job.fast);
        if (job.fast && !report.fast && !report.cancelled) notify("Fast mode skipped: standard transfer used");
        if (report.cancelled) {
          settle([]);
          setFinished({
            tone: "cancelled",
            text: report.leftovers
              ? `${up ? "Upload" : "Download"} cancelled (${plural(report.leftovers, "item")} not removed)`
              : `${up ? "Upload" : "Download"} cancelled`,
          });
        } else {
          settle(report.written);
          const parts = [plural(report.files, "file")];
          if (report.folders) parts.push(plural(report.folders, "folder"));
          setFinished({
            tone: "done",
            text: `${up ? "Uploaded" : "Downloaded"} ${parts.join(", ")} to ${job.dir}`,
            // A download into a folder that isn't showing on the left gets a way to find it.
            reveal: !up && job.dir !== localDirRef.current ? report.written[0] : undefined,
          });
        }
      } catch (e) {
        // Some files may have made it before the undo: refresh the listing anyway.
        settle([]);
        setFinished({ tone: "failed", text: `${up ? "Upload" : "Download"} failed: ${errorMessage(e)}` });
        notify(errorMessage(e), "error");
      } finally {
        unlisten();
        setCancelling(false);
        setActive(null);
      }
    })();
  }, [active, queue]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!finished || active) return;
    const timer = setTimeout(() => setFinished(null), finished.reveal ? OUTCOME_FOR * 2 : OUTCOME_FOR);
    return () => clearTimeout(timer);
  }, [finished, active]);

  /** Cancel: the running transfer stops and undoes itself; anything waiting is dropped. */
  const cancel = () => {
    setCancelling(true);
    setQueue([]);
    void api.cancelTransfer();
  };

  const uploadBlocker = !host
    ? "No server selected"
    : !isConnected
      ? reconnecting.has(host.id)
        ? "Reconnecting…"
        : "Not connected"
      : !remoteDir
        ? "No server folder open"
        : null;

  const uploadHere = (path: string): MenuItem[] => [
    {
      label: selection.length ? `Upload ${selection.length === 1 ? selection[0].name : `${selection.length} items`} here` : "Upload selected here",
      icon: Upload,
      onSelect: () => upload(selection.map((s) => s.path), path),
      disabled: !selection.length,
    },
  ];

  return (
    <DragProvider onUpload={upload} onDownload={download}>
      <div className="sync" ref={panes} style={{ "--split": `${split * 100}%` } as CSSProperties}>
        <LocalBrowser
          uploadBlocker={uploadBlocker}
          remoteDir={remoteDir}
          onUpload={(sources) => remoteDir && upload(sources, remoteDir)}
          onSelectionChange={setSelection}
          onPathChange={setLocalDir}
          revealed={revealed}
        />
        <Splitter container={panes} split={split} onChange={setSplit} />
        <ServerPane
          hostId={hostId}
          fastDelete={fast}
          onSelectHost={selectHost}
          onAddHost={() => setAddingHost(true)}
          rememberAs="sftp"
          folderMenu={uploadHere}
          acceptsDrops
          download={{
            onDownload: (paths) => {
              if (downloadsDir) download(paths, downloadsDir);
              else notify("Downloads folder not found", "error");
            },
          }}
          onCwdChange={setRemoteDir}
          footer={() => (
            <TransferBar
              direction={active?.kind ?? "upload"}
              fast={fast}
              onFastChange={changeFast}
              fastActive={active?.fast ?? false}
              activeDir={active?.dir ?? null}
              progress={progress}
              speed={transfer.speed}
              waiting={queue.length}
              finished={finished}
              cancelling={cancelling}
              onCancel={cancel}
            />
          )}
        />
      </div>
      {addingHost && (
        <HostDialog
          onClose={() => setAddingHost(false)}
          onSaved={(saved) => {
            selectHost(saved.id);
          }}
        />
      )}
    </DragProvider>
  );
}

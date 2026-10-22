import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Upload } from "lucide-react";
import { api, type LocalFsEntry, type ProjectPair, type PushProgress } from "../lib/api";
import { errorMessage, useAppData } from "../state/AppData";
import { HostDialog } from "../hosts/HostDialog";
import { ServerPane, type GoTo } from "../sync/ServerPane";
import { lastOn, mirror, pairFor, sameLocal } from "../lib/pairs";
import { Splitter, useSplit } from "../sync/Splitter";
import { settling, useTransferSpeed } from "../ui/useTransferSpeed";
import { useFast } from "../ui/FastToggle";
import { setActivity } from "../state/activity";
import { remember, remembered } from "../lib/storage";
import type { MenuItem } from "../ui/ContextMenu";
import { DragProvider, type DragKind } from "./drag";
import { LocalBrowser, type Pairing, type Revealed } from "./LocalBrowser";
import { TransferBar, type FinishedTransfer } from "./TransferBar";

const LAST_HOST = "someprix.sftp.host";
const FAST_SFTP = "someprix.sftp.fast";
/** How long the outcome of a transfer stays in the footer. */
const OUTCOME_FOR = 6000;

/** One upload or download: these paths, into that folder (on the server, or on this computer). */
type Job = { id: number; kind: DragKind; hostId: string; sources: string[]; dir: string; fast: boolean };


const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Move files between this computer and a server: browse both sides, drag across either way.
 *  It stays open while another page shows (`shown` false), so transfers carry on and their
 *  progress is still here when you come back. */
export function SftpPage({ shown }: { shown: boolean }) {
  const { hosts, connected, reconnecting, connect, notify, recordPush, project, refreshProject } = useAppData();
  const shownRef = useRef(shown);
  shownRef.current = shown;
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

  // ---------- Paired folders: a local folder brings its server folder along ----------
  // Sync's projects (each with its destination), and folders paired here. Read again on each visit.
  const [pairs, setPairs] = useState<ProjectPair[] | null>(null);
  const loadPairs = useCallback(() => api.projectPairs().then(setPairs, () => setPairs((p) => p ?? [])), []);
  useEffect(() => {
    if (shown) void loadPairs();
  }, [shown, loadPairs, project?.hostId, project?.remoteDir]);
  const hostIdRef = useRef(hostId);
  hostIdRef.current = hostId;
  const remoteDirRef = useRef(remoteDir);
  remoteDirRef.current = remoteDir;
  // Where the server side was asked to go, on the server showing (only picking one by hand
  // changes servers).
  const [goTo, setGoTo] = useState<GoTo | null>(null);
  const goSeq = useRef(0);
  const go = (onHost: string, path: string, fallback?: string) =>
    setGoTo({ hostId: onHost, path, fallback, seq: ++goSeq.current });

  // Entering a folder paired on the server showing opens its folder there; moving about inside
  // it, the server side follows as long as it's still in step (browsed elsewhere, it stays put).
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (pairs === null || localDir === null) return;
    const before = followed.current;
    followed.current = localDir;
    // Opened to stay where the server is (Back, after switching servers): nothing follows.
    if (quiet.current !== null && sameLocal(quiet.current, localDir)) {
      quiet.current = null;
      return;
    }
    const onHost = hostIdRef.current;
    const pair = onHost ? pairFor(pairs, localDir, onHost) : null;
    const dir = pair && onHost ? pair.destinations[onHost] : undefined;
    if (!pair || !onHost || !dir) return;
    const target = mirror(pair, dir, localDir);
    const previous = before === null ? null : pairFor(pairs, before, onHost);
    if (previous?.root === pair.root) {
      // Inside the same pair: only while in step, and only to a folder that's there.
      const was = before === null ? null : mirror(pair, dir, before);
      if (remoteDirRef.current !== was || target === remoteDirRef.current) return;
      void api.listRemote(onHost, target).then(
        () => followed.current === localDir && remoteDirRef.current === was && go(onHost, target),
        () => {},
      );
      return;
    }
    // Just came in: its folder (the paired one itself if the way down isn't there).
    if (target !== remoteDirRef.current) go(onHost, target, dir);
  }, [localDir, pairs]); // eslint-disable-line react-hooks/exhaustive-deps

  // The local side, sent to a folder from here (switching servers); `quiet`: without the server following.
  const [localGoTo, setLocalGoTo] = useState<{ path: string; seq: number } | null>(null);
  const quiet = useRef<string | null>(null);
  const openLocal = (path: string, follow = true) => {
    quiet.current = follow ? null : path;
    setLocalGoTo({ path, seq: ++goSeq.current });
  };

  /** Another server picked here. In a project folder with no folder on that server, the left side
   *  goes to the project last used with it, so both sides match (Back undoes that). */
  const chooseServer = (id: string) => {
    selectHost(id);
    if (!pairs || localDir === null) return;
    const pair = pairFor(pairs, localDir);
    if (!pair || pair.destinations[id]) return;
    const other = lastOn(pairs, id, true);
    if (!other || sameLocal(other.root, pair.root)) return;
    const from = localDir;
    openLocal(other.root);
    const server = hosts.find((h) => h.id === id)?.label ?? "that server";
    notify(`Opened ${other.name}, the folder paired with ${server}`, "info", {
      label: `Back to ${pair.name}`,
      run: () => openLocal(from, false),
    });
  };

  // Another server picked: a paired folder goes to its folder on that one, if it has one there.
  const shownHost = useRef(hostId);
  useEffect(() => {
    const switched = shownHost.current !== hostId;
    shownHost.current = hostId;
    if (!switched || !hostId || !pairs || localDir === null) return;
    const pair = pairFor(pairs, localDir, hostId);
    const dir = pair?.destinations[hostId];
    if (pair && dir) go(hostId, mirror(pair, dir, localDir), dir);
  }, [hostId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The pair on the server showing (each server has its own; others don't show here).
  const shownPair = localDir && hostId && pairs ? pairFor(pairs, localDir, hostId) : null;
  const shownDir = shownPair && hostId ? shownPair.destinations[hostId] : undefined;
  const pairing: Pairing = {
    pair:
      shownPair && shownDir && localDir
        ? {
            remotePath: mirror(shownPair, shownDir, localDir),
            hostLabel: host?.label ?? "the server",
            showing: mirror(shownPair, shownDir, localDir) === remoteDir,
            own: sameLocal(shownPair.root, localDir),
          }
        : null,
    onGo: () => shownPair && shownDir && hostId && localDir && go(hostId, mirror(shownPair, shownDir, localDir), shownDir),
    canPairWith: host && isConnected && remoteDir ? remoteDir : null,
    onPair: () => {
      if (!localDir || !host || !remoteDir) return;
      void pairWith(localDir, host.id, remoteDir);
    },
    onUnpair: () => {
      if (shownPair && hostId) void pairWith(shownPair.root, hostId, null);
    },
  };

  /** Pairs a local folder with a folder on that server (with none, unpairs it from that server);
   *  Sync's destination too, if it's the project open there. */
  const pairWith = async (root: string, pairHost: string, dir: string | null) => {
    try {
      await api.pairFolder(root, pairHost, dir);
      await loadPairs();
      if (project && sameLocal(project.root, root)) await refreshProject();
      const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
      const server = hosts.find((h) => h.id === pairHost)?.label ?? "the server";
      notify(dir ? `Paired ${name} with ${dir}` : `${name} is no longer paired on ${server}`);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  // ---------- Transfers: one at a time, the rest wait in line ----------
  const [queue, setQueue] = useState<Job[]>([]);
  const [active, setActive] = useState<Job | null>(null);
  const [progress, setProgress] = useState<PushProgress | null>(null);
  const [finished, setFinished] = useState<FinishedTransfer | null>(null);
  // Undo of the upload that just finished is running.
  const [undoing, setUndoing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const transfer = useTransferSpeed(active !== null, settling(progress));
  const jobId = useRef(0);
  // Fast mode: transfers go as one compressed archive the other end unpacks.
  const [fast, changeFast] = useFast(FAST_SFTP);

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
            text: `${up ? "Uploaded" : "Downloaded"} ${parts.join(", ")} to ${job.dir}${report.backedUp ? ` (${plural(report.backedUp, "replaced file")} backed up)` : ""}`,
            // A download into a folder that isn't showing on the left gets a way to find it.
            reveal: !up && job.dir !== localDirRef.current ? report.written[0] : undefined,
            undo: up && report.history ? { id: report.history, hostId: job.hostId } : undefined,
          });
          // Finished while another page shows: say so there.
          if (!shownRef.current) {
            const target = up && report.history ? { id: report.history, hostId: job.hostId } : null;
            notify(
              `${up ? "Uploaded" : "Downloaded"} ${parts.join(", ")} to ${job.dir}`,
              "info",
              target ? { label: "Undo", run: () => void undoRef.current(target, false) } : undefined,
            );
          }
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
    // An upload that can be undone keeps its Undo button a while longer; a question stays until answered.
    if (!finished || active || undoing || finished.undoForce) return;
    const timer = setTimeout(() => setFinished(null), finished.undo ? OUTCOME_FOR * 5 : finished.reveal ? OUTCOME_FOR * 2 : OUTCOME_FOR);
    return () => clearTimeout(timer);
  }, [finished, active, undoing]);

  // Undo of the upload that just finished: replaced files come back, added ones go.
  const undoUpload = async (target: { id: string; hostId: string }, force: boolean) => {
    setUndoing(true);
    try {
      if (!connected.has(target.hostId) && !(await connect(target.hostId))) throw new Error("Not connected");
      const report = await api.undoUpload(target.id, force);
      if (!report.done) {
        const text = `${plural(report.changedSince.length, "file")} changed on the server since. Undo replaces those changes too.`;
        setFinished({ tone: "failed", text, undo: target, undoForce: true });
        if (!shownRef.current) notify(text, "error", { label: "Undo anyway", run: () => void undoRef.current(target, true) });
        return;
      }
      const parts = [];
      if (report.restored) parts.push(`${plural(report.restored, "file")} put back`);
      if (report.removed) parts.push(`${report.removed} removed`);
      const text = `Upload undone${parts.length ? `: ${parts.join(", ")}` : ""}`;
      setFinished({ tone: "cancelled", text });
      if (!shownRef.current) notify(text);
      recordPush([]);
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setUndoing(false);
    }
  };
  // Toasts call the latest version (they outlive the render that made them).
  const undoRef = useRef(undoUpload);
  undoRef.current = undoUpload;

  // The sidebar shows a running transfer while another page is open.
  useEffect(() => {
    if (!active) {
      setActivity("sftp", null);
      return;
    }
    const up = active.kind === "upload";
    const bytesTotal = progress?.bytesTotal ?? 0;
    const percent = bytesTotal
      ? ((progress?.bytesDone ?? 0) / bytesTotal) * 100
      : progress?.total
        ? (progress.done / progress.total) * 100
        : null;
    const files = progress?.total ? ` ${plural(progress.total, "file")}` : "";
    const waiting = queue.length ? `, ${queue.length} more waiting` : "";
    setActivity("sftp", {
      label: `${cancelling ? "Cancelling" : up ? "Uploading" : "Downloading"}${files}${waiting}`,
      percent: percent === null ? null : Math.min(99, percent),
    });
  }, [active, progress, queue.length, cancelling]);
  useEffect(() => () => setActivity("sftp", null), []);

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
          pairing={pairing}
          goTo={localGoTo}
        />
        <Splitter container={panes} split={split} onChange={setSplit} />
        <ServerPane
          hostId={hostId}
          fastDelete={fast}
          onSelectHost={chooseServer}
          onAddHost={() => setAddingHost(true)}
          rememberAs="sftp"
          goTo={goTo}
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
              onUndo={(force) => finished?.undo && void undoUpload(finished.undo, force)}
              undoing={undoing}
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

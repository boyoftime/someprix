import { useEffect, useState } from "react";
import { ChevronRight, RotateCcw, Trash2 } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Loading } from "../ui/Loading";
import { Switch } from "../ui/Switch";
import { api, joinRemote, type HistoryEntry } from "../lib/api";
import { formatAgo, formatSize } from "../lib/format";
import { errorMessage, useAppData } from "../state/AppData";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** What undoing an entry takes back, in a few words. */
export function undoSummary(entry: HistoryEntry) {
  const back = entry.files.filter((f) => f.action !== "added" && f.backedUp).length;
  const added = entry.files.filter((f) => f.action === "added").length;
  const missed = entry.files.filter((f) => f.action !== "added" && !f.backedUp).length;
  const parts = [];
  if (back) parts.push(`puts back ${plural(back, "file")}`);
  if (added) parts.push(`removes ${plural(added, "file")} it added`);
  return { text: parts.join(" and "), missed };
}

export const backupBytes = (entries: HistoryEntry[]) =>
  entries
    .filter((e) => e.backupDir)
    .reduce((sum, e) => sum + e.files.filter((f) => f.backedUp).reduce((n, f) => n + f.size, 0), 0);

function counts(entry: HistoryEntry) {
  const of = (action: string) => entry.files.filter((f) => f.action === action).length;
  const parts = [];
  if (of("changed")) parts.push(`${of("changed")} changed`);
  if (of("added")) parts.push(`${of("added")} added`);
  if (of("deleted")) parts.push(`${of("deleted")} deleted`);
  return parts.join(", ");
}

type Asking =
  | { kind: "undo"; entry: HistoryEntry }
  | { kind: "changed"; entry: HistoryEntry; paths: string[] }
  | { kind: "clear" };

/** The open project's pushes, newest first: what each changed on the server, and Undo for the newest. */
export function HistoryDialog({ undoId, onClose }: { undoId?: string; onClose: () => void }) {
  const { project, hosts, connected, connect, notify, recordPush, refreshProject } = useAppData();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backupsOff, setBackupsOff] = useState(false);

  useEffect(() => {
    void api
      .pushHistory()
      .then((list) => {
        setEntries(list);
        // From a push's Undo button: go straight to the question.
        if (undoId && list[0]?.id === undoId) setAsking({ kind: "undo", entry: list[0] });
      })
      .catch((e) => setError(errorMessage(e)));
    void api.settings().then((s) => setBackupsOff(s.backups === "off"));
  }, [undoId]);

  const hostName = (id: string) => hosts.find((h) => h.id === id)?.label ?? "a removed server";

  async function undo(entry: HistoryEntry, force: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (!connected.has(entry.hostId) && !(await connect(entry.hostId))) throw new Error(`Not connected to ${hostName(entry.hostId)}`);
      const report = await api.undoPush(entry.id, force);
      if (!report.done) {
        setAsking({ kind: "changed", entry, paths: report.changedSince });
        return;
      }
      const parts = [];
      if (report.restored) parts.push(`${plural(report.restored, "file")} put back`);
      if (report.removed) parts.push(`${report.removed} removed`);
      notify(`Undid the push from ${formatAgo(entry.at)}${parts.length ? `: ${parts.join(", ")}` : ""}`);
      recordPush(entry.files.map((f) => joinRemote(entry.remoteDir, f.path)));
      setAsking(null);
      setEntries(await api.pushHistory());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!project?.hostId) return;
    setBusy(true);
    setError(null);
    try {
      if (!connected.has(project.hostId) && !(await connect(project.hostId))) throw new Error("Not connected");
      setEntries(await api.clearPushBackups());
      setAsking(null);
      notify("Backups deleted from the server");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const used = entries ? backupBytes(entries) : 0;

  return (
    <Dialog title="Push history" onClose={onClose} locked={busy} width={600}>
      {project && (
        <Switch
          on={!backupsOff && project.backup}
          disabled={backupsOff || busy}
          label={`Back up ${project.name}`}
          hint={
            backupsOff
              ? "Backups are off for every project. Turn them on in Settings."
              : "Before a push replaces or deletes server files, it keeps the old copies, so the push can be undone."
          }
          onChange={(on) => void api.setProjectBackup(project.root, on).then(refreshProject)}
        />
      )}

      {asking?.kind === "undo" && (
        <div className="history-ask" role="alertdialog" aria-label="Undo push">
          <p>
            <strong>Undo the push from {formatAgo(asking.entry.at)}?</strong> It {undoSummary(asking.entry).text || "changes nothing"} on{" "}
            {hostName(asking.entry.hostId)}, and your edits show as changes here again.
            {undoSummary(asking.entry).missed > 0 &&
              ` ${plural(undoSummary(asking.entry).missed, "file")} had no backup and stay as they are.`}
          </p>
          <div className="history-ask-actions">
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setAsking(null)} disabled={busy}>
              Keep it
            </button>
            <button type="button" className="btn btn-primary btn-small" onClick={() => void undo(asking.entry, false)} disabled={busy}>
              {busy ? "Undoing…" : "Undo push"}
            </button>
          </div>
        </div>
      )}
      {asking?.kind === "changed" && (
        <div className="history-ask" data-tone="warn" role="alertdialog" aria-label="Changed since">
          <p>
            <strong>{plural(asking.paths.length, "file")} changed on the server since that push.</strong> Undo replaces those changes
            too:
          </p>
          <ul className="history-ask-files">
            {asking.paths.slice(0, 6).map((path) => (
              <li key={path} className="mono">
                {path}
              </li>
            ))}
            {asking.paths.length > 6 && <li>and {asking.paths.length - 6} more</li>}
          </ul>
          <div className="history-ask-actions">
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setAsking(null)} disabled={busy}>
              Keep it
            </button>
            <button type="button" className="btn btn-danger btn-small" onClick={() => void undo(asking.entry, true)} disabled={busy}>
              {busy ? "Undoing…" : "Undo anyway"}
            </button>
          </div>
        </div>
      )}
      {asking?.kind === "clear" && (
        <div className="history-ask" data-tone="warn" role="alertdialog" aria-label="Delete backups">
          <p>
            <strong>Delete this project's backups from the server?</strong> Pushes can't be undone after that.
          </p>
          <div className="history-ask-actions">
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setAsking(null)} disabled={busy}>
              Keep them
            </button>
            <button type="button" className="btn btn-danger btn-small" onClick={() => void clear()} disabled={busy}>
              {busy ? "Deleting…" : "Delete backups"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {entries === null ? (
        <Loading />
      ) : entries.length === 0 ? (
        <p className="dialog-text">No pushes yet. Each push shows here, with a way to undo the latest.</p>
      ) : (
        <ul className="history-list">
          {entries.map((entry, i) => {
            const expanded = open === entry.id;
            const bytes = backupBytes([entry]);
            return (
              <li key={entry.id} className="history-entry" data-latest={i === 0 ? "" : undefined}>
                <div className="history-head">
                  <button
                    type="button"
                    className="history-toggle"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : entry.id)}
                  >
                    <ChevronRight size={14} strokeWidth={2} className="history-chevron" />
                    <span className="history-when" data-tip={dateFormat.format(new Date(entry.at * 1000))}>
                      {formatAgo(entry.at)}
                    </span>
                    <span className="history-counts">{counts(entry)}</span>
                  </button>
                  <span className="history-backup">
                    {entry.backupDir ? (bytes ? `${formatSize(bytes)} kept` : "Backed up") : "No backup"}
                  </span>
                  {i === 0 && (
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => setAsking({ kind: "undo", entry })}
                      disabled={busy}
                    >
                      <RotateCcw size={13} strokeWidth={2} />
                      Undo
                    </button>
                  )}
                </div>
                {expanded && (
                  <ul className="history-files">
                    <li className="history-target mono">
                      {hostName(entry.hostId)}:{entry.remoteDir}
                    </li>
                    {entry.files.map((file) => (
                      <li key={file.path}>
                        <span className={`change-dot ${file.action === "changed" ? "modified" : file.action}`} aria-hidden="true" />
                        <span className="push-path">{file.path}</span>
                        {file.action !== "added" && !file.backedUp && <span className="history-nobackup">no backup</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {entries && entries.length > 0 && (
        <div className="history-foot">
          <span className="hint">
            {used ? `Backups use ${formatSize(used)} on the server.` : "No backups on the server."} Undo goes from the newest push back.
          </span>
          {used > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-small btn-danger-text"
              onClick={() => setAsking({ kind: "clear" })}
              disabled={busy}
            >
              <Trash2 size={13} strokeWidth={2} />
              Clear backups
            </button>
          )}
        </div>
      )}
    </Dialog>
  );
}

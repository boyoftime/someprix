import { useState } from "react";
import { Check, Gauge, Zap } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { settling, useTransferSpeed } from "../ui/useTransferSpeed";
import { useSmoothFill } from "../ui/useSmoothFill";
import { api, joinRemote, type Change, type Host, type PushProgress } from "../lib/api";
import { formatSize, formatSpeed, formatTimeLeft } from "../lib/format";
import { errorMessage, useAppData } from "../state/AppData";

type PushDialogProps = {
  host: Host;
  remoteDir: string;
  changes: Change[];
  /** Limits the push to changes at or under these paths (the list above is already filtered). */
  only?: string[];
  /** Send the files as one compressed archive that the server unpacks. */
  fast?: boolean;
  onClose: () => void;
};

type Phase = "ready" | "pushing" | "done";

/** How long the finished bar stays on screen before the dialog closes. */
const DONE_PAUSE = 700;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function PushDialog({ host, remoteDir, changes, only, fast = false, onClose }: PushDialogProps) {
  const { notify, recordPush } = useAppData();
  // The list as it was when the dialog opened; pushing updates the live one underneath.
  const [listed] = useState(changes);
  const [includeDeletions, setIncludeDeletions] = useState(false);
  const [phase, setPhase] = useState<Phase>("ready");
  const [progress, setProgress] = useState<PushProgress | null>(null);
  const transfer = useTransferSpeed(phase === "pushing", settling(progress));

  const onProgress = (next: PushProgress) => {
    if (next.bytesDone !== undefined) transfer.record(next.bytesDone);
    setProgress(next);
  };
  const [error, setError] = useState<string | null>(null);

  const uploads = listed.filter((c) => c.kind !== "deleted");
  const deletions = listed.filter((c) => c.kind === "deleted");
  const count = uploads.length + (includeDeletions ? deletions.length : 0);
  const target = `${host.username}@${host.host}:${remoteDir}`;
  // The order the server works through them: uploads first, then deletions.
  const order = uploads.concat(includeDeletions ? deletions : []).map((c) => c.path);

  async function push() {
    setPhase("pushing");
    setError(null);
    setProgress(null);
    transfer.reset();
    const unlisten = await api.onPushProgress(onProgress);
    try {
      const report = await api.push(includeDeletions, only, fast);
      setPhase("done");
      // Let the full bar register before the dialog goes away.
      await new Promise((r) => setTimeout(r, DONE_PAUSE));
      const parts = [`Pushed ${plural(report.uploaded, "file")}`];
      if (report.deleted) parts.push(`deleted ${report.deleted}`);
      notify(`${parts.join(", ")} to ${remoteDir}`);
      if (fast && !report.fast && report.uploaded > 0) {
        notify("Fast mode unavailable: no tar on server");
      }
      recordPush(uploads.map((c) => joinRemote(remoteDir, c.path)));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setPhase("ready");
      // Some files may have made it before the failure: refresh anyway, without pointing any out.
      recordPush([]);
    } finally {
      unlisten();
    }
  }

  const busy = phase !== "ready";
  const done = phase === "done";
  const filesDone = done ? order.length : (progress?.done ?? 0);
  const bytesTotal = progress?.bytesTotal ?? 0;
  const bytesDone = done ? bytesTotal : (progress?.bytesDone ?? 0);
  // Bytes give a smooth bar; with nothing to upload (only deletions) count files instead.
  const fraction = done ? 1 : bytesTotal > 0 ? bytesDone / bytesTotal : order.length ? filesDone / order.length : 0;
  // Never claim 100% before the server has confirmed the last file.
  const percent = done ? 100 : Math.min(99, Math.floor(fraction * 100));
  const currentPath = progress?.path ?? null;
  const stage = progress?.stage ?? null;
  const currentIsDeletion = deletions.some((c) => c.path === currentPath);

  // Deleting, packing and unpacking send no data, so there's no speed to show then.
  const speed = currentIsDeletion || stage ? null : transfer.speed;
  const timeLeft = speed && speed > 0 ? (bytesTotal - bytesDone) / speed : null;
  // The bar fills smoothly at the current speed between confirmations (see useSmoothFill).
  const smooth = useSmoothFill(fraction, speed && bytesTotal ? speed / bytesTotal : 0, busy, done);

  return (
    <Dialog
      title={only ? (only.length === 1 && listed.length === 1 ? "Push file" : "Push changes") : "Push"}
      onClose={onClose}
      locked={busy}
      width={540}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={push} disabled={busy || count === 0}>
            {done ? "Pushed" : busy ? "Pushing…" : error ? "Retry" : `Push ${plural(count, "file")}`}
          </button>
        </>
      }
    >
      <p className="dialog-text">
        Target <span className="mono">{target}</span>
      </p>
      {fast && (
        <p className="fast-note">
          <Zap size={14} strokeWidth={2} />
          Fast mode (tar.gz)
        </p>
      )}

      <ul className="push-list">
        {uploads.concat(deletions).map((change) => {
          const skipped = change.kind === "deleted" && !includeDeletions;
          const index = order.indexOf(change.path);
          const state = !busy || index < 0 ? "idle" : index < filesDone ? "done" : index === filesDone && !done ? "current" : "waiting";
          return (
            <li key={change.path} data-skipped={skipped ? "" : undefined} data-state={state}>
              <span className={`change-dot ${change.kind}`} aria-hidden="true" />
              <span className="push-path">{change.path}</span>
              <span className="push-kind">
                {state === "done" ? (
                  <Check size={15} strokeWidth={2.25} className="push-done" aria-label="Done" />
                ) : state === "current" ? (
                  <span className="push-spinner" aria-label="In progress" />
                ) : change.kind === "added" ? (
                  "New"
                ) : change.kind === "modified" ? (
                  "Changed"
                ) : skipped ? (
                  "Skip"
                ) : (
                  "Delete"
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {deletions.length > 0 && !busy && (
        <label className="check">
          <input type="checkbox" checked={includeDeletions} onChange={(e) => setIncludeDeletions(e.target.checked)} />
          <span>Delete {plural(deletions.length, "removed file")} on server</span>
        </label>
      )}

      {busy && (
        <div className="push-progress" data-phase={phase}>
          <div className="push-progress-head">
            <span className="push-percent">
              {done && <Check size={20} strokeWidth={2.5} />}
              <span ref={smooth.label} />
            </span>
            <span className="push-status">
              {done
                ? "Done"
                : stage === "packing"
                  ? `Packing ${currentPath ?? "…"}`
                  : stage === "unpacking"
                    ? "Unpacking…"
                    : currentPath
                  ? `${currentIsDeletion ? "Deleting" : "Uploading"} ${currentPath}`
                  : "Connecting…"}
            </span>
            {timeLeft !== null && timeLeft >= 1 && <span className="push-eta">{formatTimeLeft(timeLeft)}</span>}
          </div>
          <div
            className="push-track"
            role="progressbar"
            aria-label="Push progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="push-fill smooth-fill" ref={smooth.fill} />
          </div>
          <div className="push-meta">
            <span>
              {Math.min(filesDone + (done ? 0 : 1), order.length)} of {plural(order.length, "file")}
            </span>
            <span className="push-meta-right">
              {bytesTotal > 0 && (
                <span>
                  {formatSize(bytesDone)} of {formatSize(bytesTotal)}
                </span>
              )}
              {speed !== null && (
                <span className="push-speed" aria-label={`Upload speed ${formatSpeed(speed)}`}>
                  <Gauge size={13} strokeWidth={2} />
                  {formatSpeed(speed)}
                </span>
              )}
            </span>
          </div>
        </div>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

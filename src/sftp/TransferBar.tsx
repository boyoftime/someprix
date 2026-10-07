import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ArrowDownUp, CircleAlert, CircleCheck, FolderSearch, Gauge, Undo2, X, Zap } from "lucide-react";
import type { PushProgress } from "../lib/api";
import { formatSize, formatSpeed, formatTimeLeft } from "../lib/format";
import { FastToggle } from "../ui/FastToggle";
import { useSmoothFill } from "../ui/useSmoothFill";

export type FinishedTransfer = {
  tone: "done" | "failed" | "cancelled";
  text: string;
  /** Something to show in Explorer from here, e.g. a download that went to the Downloads folder. */
  reveal?: string;
};

type TransferBarProps = {
  /** Which way the running transfer goes. */
  direction: "upload" | "download";
  /** Fast mode for the next transfers, and whether the running one uses it. */
  fast: boolean;
  onFastChange: (on: boolean) => void;
  fastActive: boolean;
  /** The folder the running transfer writes into, or null when idle. */
  activeDir: string | null;
  progress: PushProgress | null;
  speed: number | null;
  /** Transfers waiting behind the running one. */
  waiting: number;
  finished: FinishedTransfer | null;
  /** Cancel was pressed and the transfer is undoing itself. */
  cancelling: boolean;
  onCancel: () => void;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The SFTP page's footer: transfer progress while one runs, the outcome after, a hint otherwise. */
export function TransferBar({
  direction,
  fast,
  onFastChange,
  fastActive,
  activeDir,
  progress,
  speed,
  waiting,
  finished,
  cancelling,
  onCancel,
}: TransferBarProps) {
  const bytesTotal = progress?.bytesTotal ?? 0;
  const bytesDone = progress?.bytesDone ?? 0;
  const total = progress?.total ?? 0;
  const fraction = bytesTotal > 0 ? bytesDone / bytesTotal : total ? (progress?.done ?? 0) / total : 0;
  // The bar fills smoothly at the current speed between confirmations (see useSmoothFill).
  const smooth = useSmoothFill(fraction, speed && bytesTotal ? speed / bytesTotal : 0, activeDir !== null);

  if (activeDir === null) {
    return (
      <footer className="pane-foot transfer-bar" data-state={finished?.tone ?? "idle"}>
        {finished ? (
          <span className="transfer-outcome" role="status">
            {finished.tone === "done" ? (
              <CircleCheck size={16} strokeWidth={2} />
            ) : finished.tone === "cancelled" ? (
              <Undo2 size={16} strokeWidth={2} />
            ) : (
              <CircleAlert size={16} strokeWidth={2} />
            )}
            <span className="transfer-outcome-text">{finished.text}</span>
            {finished.reveal && (
              <button
                type="button"
                className="btn btn-small btn-ghost transfer-reveal"
                onClick={() => void revealItemInDir(finished.reveal!).catch(() => undefined)}
              >
                <FolderSearch size={14} strokeWidth={2} />
                Show in folder
              </button>
            )}
          </span>
        ) : (
          <span className="muted transfer-hint">
            <ArrowDownUp size={15} strokeWidth={1.75} />
            Ready
          </span>
        )}
        <span className="spacer" />
        <FastToggle on={fast} onChange={onFastChange} />
      </footer>
    );
  }

  const upload = direction === "upload";
  // Never claim 100% before the last file is confirmed.
  const percent = Math.min(99, Math.floor(fraction * 100));
  const finishing = progress?.finishing === true;
  const stage = progress?.stage ?? null;
  // Packing and unpacking send nothing over the link, so there's no speed or time left then.
  const timeLeft = speed && speed > 0 && !cancelling && !finishing && !stage ? (bytesTotal - bytesDone) / speed : null;
  const shownSpeed = stage ? null : speed;

  return (
    <footer className="pane-foot transfer-bar" data-state={cancelling ? "cancelling" : "running"}>
      <div className="transfer-main">
        <div className="transfer-head">
          <span className="transfer-percent" ref={smooth.label} />
          {fastActive && <Zap size={14} strokeWidth={2} className="transfer-fast" aria-label="Fast mode" />}
          <span className="transfer-file">
            {cancelling
              ? "Rolling back…"
              : stage === "packing"
                ? upload
                  ? `Packing ${progress?.path ?? "…"}`
                  : "Packing on server…"
                : stage === "unpacking"
                  ? "Unpacking…"
                  : finishing
                ? "Finishing…"
                : progress?.path
                  ? `${upload ? "Uploading" : "Downloading"} ${progress.path}`
                  : "Preparing…"}
          </span>
          {timeLeft !== null && timeLeft >= 1 && <span className="push-eta">{formatTimeLeft(timeLeft)}</span>}
          <span
            className="tip-wrap transfer-cancel"
            data-tip={
              finishing ? "Finishing" : "Cancel and roll back"
            }
          >
            <button type="button" className="btn btn-small btn-ghost btn-danger-text" onClick={onCancel} disabled={cancelling || finishing}>
              <X size={14} strokeWidth={2} />
              {cancelling ? "Cancelling…" : waiting > 0 ? "Cancel all" : "Cancel"}
            </button>
          </span>
        </div>
        <div
          className="push-track transfer-track"
          role="progressbar"
          aria-label={`${upload ? "Uploading" : "Downloading"} to ${activeDir}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="push-fill smooth-fill" ref={smooth.fill} />
        </div>
        <div className="push-meta">
          <span>
            {total ? `${Math.min((progress?.done ?? 0) + 1, total)} of ${plural(total, "file")}` : ""}
            {waiting > 0 ? `, ${waiting} queued` : ""}
          </span>
          <span className="push-meta-right">
            {bytesTotal > 0 && (
              <span>
                {formatSize(bytesDone)} of {formatSize(bytesTotal)}
              </span>
            )}
            {shownSpeed !== null && (
              <span className="push-speed" aria-label={`${upload ? "Upload" : "Download"} speed ${formatSpeed(shownSpeed)}`}>
                <Gauge size={13} strokeWidth={2} />
                {formatSpeed(shownSpeed)}
              </span>
            )}
          </span>
        </div>
      </div>
    </footer>
  );
}

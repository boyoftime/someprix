import { useState } from "react";
import { Check, Gauge, TriangleAlert, Zap } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { settling, useTransferSpeed } from "../ui/useTransferSpeed";
import { useSmoothFill } from "../ui/useSmoothFill";
import { api, joinRemote, localPath, type Change, type Conflict, type Host, type PushProgress } from "../lib/api";
import { formatAgo, formatSize, formatSpeed, formatTimeLeft } from "../lib/format";
import { errorMessage, useAppData } from "../state/AppData";
import { CompareDialog, type Choice } from "./CompareDialog";

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

/** ready → checking the server → (conflicts to decide → taking server versions) → pushing → done */
type Phase = "ready" | "checking" | "conflicts" | "taking" | "pushing" | "done";

/** How long the finished bar stays on screen before the dialog closes. */
const DONE_PAUSE = 700;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What can be done with a conflicting file; a file deleted here is deleted there by "Overwrite". */
function choicesFor(conflict: Conflict): [Choice, string][] {
  return [
    ["overwrite", conflict.kind === "deleted" ? "Delete" : "Overwrite"],
    ["skip", "Skip"],
    ["server", "Get server version"],
  ];
}

function why(conflict: Conflict) {
  if (conflict.reason === "exists") return "Already on the server";
  const changed = `Changed on the server ${formatAgo(conflict.serverModified)}`;
  return conflict.kind === "deleted" ? `${changed}, deleted here` : changed;
}

export function PushDialog({ host, remoteDir, changes, only, fast = false, onClose }: PushDialogProps) {
  const { notify, recordPush, project } = useAppData();
  // The list as it was when the dialog opened; pushing updates the live one underneath.
  const [listed] = useState(changes);
  const [includeDeletions, setIncludeDeletions] = useState(false);
  const [phase, setPhase] = useState<Phase>("ready");
  const [progress, setProgress] = useState<PushProgress | null>(null);
  const transfer = useTransferSpeed(phase === "pushing", settling(progress));
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [comparing, setComparing] = useState<Conflict | null>(null);
  /** Conflicting files left out of this push (skipped, or replaced by the server's version). */
  const [held, setHeld] = useState<string[]>([]);

  const onProgress = (next: PushProgress) => {
    if (next.bytesDone !== undefined) transfer.record(next.bytesDone);
    setProgress(next);
  };
  const [error, setError] = useState<string | null>(null);

  const uploads = listed.filter((c) => c.kind !== "deleted");
  const deletions = listed.filter((c) => c.kind === "deleted");
  const target = `${host.username}@${host.host}:${remoteDir}`;
  // The order the server works through them: uploads first, then deletions.
  const order = uploads
    .concat(includeDeletions ? deletions : [])
    .map((c) => c.path)
    .filter((path) => !held.includes(path));
  const count = order.length;

  /** Checks the server for changes made there since the last push, then pushes or asks. */
  async function start() {
    setError(null);
    setHeld([]);
    setPhase("checking");
    let found: Conflict[];
    try {
      found = await api.conflicts(includeDeletions, only);
    } catch (e) {
      setError(errorMessage(e));
      setPhase("ready");
      return;
    }
    if (found.length === 0) return push([]);
    setConflicts(found);
    setChoices({});
    setPhase("conflicts");
  }

  /** Carries out the choices made for the conflicting files, then pushes the rest. */
  async function resolve() {
    const take = conflicts.filter((c) => choices[c.path] === "server").map((c) => c.path);
    const hold = conflicts.filter((c) => choices[c.path] !== "overwrite").map((c) => c.path);
    const rest = order.filter((path) => !hold.includes(path));
    setError(null);
    setHeld(hold);
    if (take.length) {
      setPhase("taking");
      try {
        const got = await api.takeServer(take);
        notify(`Got the server version of ${plural(got, "file")}`);
      } catch (e) {
        // Whatever was replaced is no longer a change; checking again sorts out the rest.
        setError(errorMessage(e));
        setHeld([]);
        setPhase("ready");
        return;
      }
    }
    if (rest.length === 0) return onClose();
    await push(hold);
  }

  async function push(skip: string[]) {
    setPhase("pushing");
    setProgress(null);
    transfer.reset();
    const unlisten = await api.onPushProgress(onProgress);
    try {
      const report = await api.push(includeDeletions, only, fast, skip);
      setPhase("done");
      // Let the full bar register before the dialog goes away.
      await new Promise((r) => setTimeout(r, DONE_PAUSE));
      const parts = [`Pushed ${plural(report.uploaded, "file")}`];
      if (report.deleted) parts.push(`deleted ${report.deleted}`);
      notify(`${parts.join(", ")} to ${remoteDir}`);
      if (fast && !report.fast && report.uploaded > 0) {
        notify("Fast mode unavailable: no tar on server");
      }
      recordPush(uploads.filter((c) => !skip.includes(c.path)).map((c) => joinRemote(remoteDir, c.path)));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setPhase("ready");
      setHeld([]);
      // Some files may have made it before the failure: refresh anyway, without pointing any out.
      recordPush([]);
    } finally {
      unlisten();
    }
  }

  const deciding = phase === "conflicts" || phase === "taking";
  const busy = phase !== "ready" && phase !== "conflicts";
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
  const pushing = phase === "pushing" || done;

  // Deleting, packing and unpacking send no data, so there's no speed to show then.
  const speed = currentIsDeletion || stage ? null : transfer.speed;
  const timeLeft = speed && speed > 0 ? (bytesTotal - bytesDone) / speed : null;
  // The bar fills smoothly at the current speed between confirmations (see useSmoothFill).
  const smooth = useSmoothFill(fraction, speed && bytesTotal ? speed / bytesTotal : 0, pushing, done);

  // The conflicts step: every file needs a choice before going on.
  const undecided = conflicts.filter((c) => !choices[c.path]).length;
  const holding = conflicts.filter((c) => choices[c.path] && choices[c.path] !== "overwrite").map((c) => c.path);
  const taking = conflicts.filter((c) => choices[c.path] === "server").length;
  const pushingAfter = order.filter((path) => !holding.includes(path)).length;
  const others = order.length - conflicts.length;
  const choose = (path: string, choice: Choice) => setChoices((now) => ({ ...now, [path]: choice }));
  const chooseAll = (choice: Choice) => setChoices(Object.fromEntries(conflicts.map((c) => [c.path, choice])));

  let action: { label: string; run: () => void; disabled: boolean };
  if (deciding) {
    action = {
      label:
        phase === "taking"
          ? "Getting server versions…"
          : undecided > 0
            ? "Continue"
            : pushingAfter > 0
              ? `Push ${plural(pushingAfter, "file")}`
              : taking > 0
                ? `Get ${plural(taking, "server version")}`
                : "Done",
      run: resolve,
      disabled: phase === "taking" || undecided > 0,
    };
  } else {
    action = {
      label: done
        ? "Pushed"
        : phase === "checking"
          ? "Checking server…"
          : busy
            ? "Pushing…"
            : error
              ? "Retry"
              : `Push ${plural(count, "file")}`,
      run: start,
      disabled: busy || count === 0,
    };
  }

  return (
    <>
      <Dialog
        title={only ? (only.length === 1 && listed.length === 1 ? "Push file" : "Push changes") : "Push"}
        onClose={onClose}
        locked={busy || comparing !== null}
        width={deciding ? 720 : 540}
        footer={
          <>
            <span className="spacer" />
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={action.run} disabled={action.disabled}>
              {action.label}
            </button>
          </>
        }
      >
        <p className="dialog-text">
          Target <span className="mono">{target}</span>
        </p>
        {fast && !deciding && (
          <p className="fast-note">
            <Zap size={14} strokeWidth={2} />
            Fast mode (tar.gz)
          </p>
        )}

        {deciding ? (
          <section className="conflicts" aria-label="Changed on the server">
            <div className="conflicts-head">
              <TriangleAlert size={18} strokeWidth={2} aria-hidden="true" />
              <div>
                <p className="conflicts-title">
                  {conflicts.length === 1 ? "1 file also changed" : `${conflicts.length} files also changed`} on the server
                </p>
                <p className="hint">Pushing replaces the server's version. Choose what to do with each.</p>
              </div>
            </div>

            <ul className="conflict-list">
              {conflicts.map((conflict) => (
                <li key={conflict.path} className="conflict">
                  <span className={`change-dot ${conflict.kind}`} aria-hidden="true" />
                  <span className="conflict-file">
                    <span className="push-path" title={conflict.path}>
                      {conflict.path}
                    </span>
                    <span className="conflict-why">{why(conflict)}</span>
                  </span>
                  <span className="segmented conflict-choice" role="radiogroup" aria-label={`${conflict.path}: what to do`}>
                    {choicesFor(conflict).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={choices[conflict.path] === value}
                        disabled={phase === "taking"}
                        onClick={() => choose(conflict.path, value)}
                      >
                        {label}
                      </button>
                    ))}
                  </span>
                  <span className="tip-wrap" data-tip={conflict.kind === "deleted" ? "Deleted here: nothing to compare" : undefined}>
                    <button
                      type="button"
                      className="btn btn-small conflict-compare"
                      onClick={() => setComparing(conflict)}
                      disabled={conflict.kind === "deleted" || phase === "taking"}
                      aria-label={`Compare ${conflict.path}`}
                    >
                      Compare
                    </button>
                  </span>
                </li>
              ))}
            </ul>

            <div className="conflict-foot">
              {conflicts.length > 1 && (
                <span className="conflict-all">
                  All files:
                  {(
                    [
                      ["overwrite", "Overwrite"],
                      ["skip", "Skip"],
                      ["server", "Get server version"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className="btn btn-small btn-ghost"
                      disabled={phase === "taking"}
                      onClick={() => chooseAll(value)}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              )}
              {others > 0 && <span className="hint">{plural(others, "other file")} will push as usual.</span>}
            </div>
          </section>
        ) : (
          <ul className="push-list">
            {uploads.concat(deletions).map((change) => {
              const skipped = (change.kind === "deleted" && !includeDeletions) || held.includes(change.path);
              const index = order.indexOf(change.path);
              const state =
                !pushing || index < 0 ? "idle" : index < filesDone ? "done" : index === filesDone && !done ? "current" : "waiting";
              return (
                <li key={change.path} data-skipped={skipped ? "" : undefined} data-state={state}>
                  <span className={`change-dot ${change.kind}`} aria-hidden="true" />
                  <span className="push-path">{change.path}</span>
                  <span className="push-kind">
                    {state === "done" ? (
                      <Check size={15} strokeWidth={2.25} className="push-done" aria-label="Done" />
                    ) : state === "current" ? (
                      <span className="push-spinner" aria-label="In progress" />
                    ) : skipped ? (
                      "Skip"
                    ) : change.kind === "added" ? (
                      "New"
                    ) : change.kind === "modified" ? (
                      "Changed"
                    ) : (
                      "Delete"
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {deletions.length > 0 && phase === "ready" && (
          <label className="check">
            <input type="checkbox" checked={includeDeletions} onChange={(e) => setIncludeDeletions(e.target.checked)} />
            <span>Delete {plural(deletions.length, "removed file")} on server</span>
          </label>
        )}

        {phase === "checking" && (
          <p className="push-checking" role="status">
            <span className="push-spinner" aria-hidden="true" />
            Checking the server for changes made there…
          </p>
        )}

        {pushing && (
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

      {comparing && project && (
        <CompareDialog
          conflict={comparing}
          hostId={host.id}
          remotePath={joinRemote(remoteDir, comparing.path)}
          localPath={localPath(project.root, comparing.path)}
          choice={choices[comparing.path]}
          onChoose={(choice) => choose(comparing.path, choice)}
          onClose={() => setComparing(null)}
        />
      )}
    </>
  );
}

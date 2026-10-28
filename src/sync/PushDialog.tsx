import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Gauge, Trash2, TriangleAlert, Zap } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { settling, useTransferSpeed } from "../ui/useTransferSpeed";
import { useSmoothFill } from "../ui/useSmoothFill";
import { api, joinRemote, localPath, type Change, type Conflict, type Host, type PushProgress } from "../lib/api";
import { formatAgo, formatSize, formatSpeed, formatTimeLeft } from "../lib/format";
import { errorMessage, useAppData } from "../state/AppData";
import { CompareDialog, type Choice } from "./CompareDialog";
import { setActivity } from "../state/activity";
import { GithubPushPanel, type GithubPhase } from "../github/GithubPushPanel";

type PushDialogProps = {
  host: Host;
  remoteDir: string;
  changes: Change[];
  /** Limits the push to changes at or under these paths (the list above is already filtered). */
  only?: string[];
  /** Send the files as one compressed archive that the server unpacks. */
  fast?: boolean;
  onClose: () => void;
  /** Opens the push history to undo this push (from the toast once it's done). */
  onUndo: (historyId: string) => void;
  /** Push to both: GitHub goes alongside (its own message and progress). */
  github?: boolean;
  /** GitHub has the push (to refresh what it's missing). */
  onGithubPushed?: () => void;
};

/** ready → checking the server → (conflicts to decide → taking server versions) → pushing → done */
type Phase = "ready" | "checking" | "conflicts" | "taking" | "pushing" | "done";

/** How long the finished bar stays on screen before the dialog closes. */
const DONE_PAUSE = 700;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Push 3 files", "Push 3 files, delete 1", or "Delete 1 file". */
function pushLabel(uploading: number, deleting: number) {
  if (deleting === 0) return `Push ${plural(uploading, "file")}`;
  if (uploading === 0) return `Delete ${plural(deleting, "file")}`;
  return `Push ${plural(uploading, "file")}, delete ${deleting}`;
}

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

export function PushDialog({ host, remoteDir, changes, only, fast = false, onClose, onUndo, github = false, onGithubPushed }: PushDialogProps) {
  const { notify, recordPush, project } = useAppData();
  // The list as it was when the dialog opened; pushing updates the live one underneath.
  const [listed] = useState(changes);
  // Files deleted here are deleted on the server too, except these, kept there this time.
  const [kept, setKept] = useState<string[]>([]);
  const toggleKept = (path: string) =>
    setKept((now) => (now.includes(path) ? now.filter((p) => p !== path) : [...now, path]));
  const [phase, setPhase] = useState<Phase>("ready");
  const [progress, setProgress] = useState<PushProgress | null>(null);
  const transfer = useTransferSpeed(phase === "pushing", settling(progress));
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [comparing, setComparing] = useState<Conflict | null>(null);
  /** Conflicting files left out of this push (skipped, or replaced by the server's version). */
  const [held, setHeld] = useState<string[]>([]);
  const [cancelling, setCancelling] = useState(false);

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
    .concat(deletions)
    .map((c) => c.path)
    .filter((path) => !held.includes(path) && !kept.includes(path));
  const count = order.length;
  const isDeletion = (path: string) => deletions.some((c) => c.path === path);
  const deleting = order.filter(isDeletion).length;

  // Push to both: GitHub goes alongside, and the dialog closes once both are done.
  const [ghGo, setGhGo] = useState(0);
  const [gh, setGh] = useState<GithubPhase | null>(github ? { phase: "loading" } : null);
  const ghRef = useRef(gh);
  ghRef.current = gh;
  const serverDone = useRef(false);
  /** Nothing (more) for GitHub to do: pushed, or nothing new for it. */
  const ghSettled = (state: GithubPhase | null) => !state || state.phase === "done" || (state.phase === "ready" && state.files === 0);
  const ghWork = gh?.phase === "ready" && gh.files > 0;
  const startGithub = () => {
    if (gh?.phase === "ready" && gh.canPush && gh.files > 0) setGhGo((n) => n + 1);
  };
  /** The server part is over: close, unless GitHub is still going (or needs a hand). */
  const finish = () => {
    serverDone.current = true;
    if (ghSettled(ghRef.current)) onClose();
  };
  useEffect(() => {
    if (gh?.phase !== "done") return;
    const url = gh.url;
    notify(gh.text, "info", url ? { label: "Open on GitHub", run: () => void openUrl(url) } : undefined);
    onGithubPushed?.();
    if (serverDone.current) onClose();
  }, [gh?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Checks the server for changes made there since the last push, then pushes or asks. */
  async function start() {
    startGithub();
    setError(null);
    setHeld([]);
    setPhase("checking");
    let found: Conflict[];
    try {
      found = (await api.conflicts(true, only)).filter((c) => !kept.includes(c.path));
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
    if (rest.length === 0) return finish();
    await push(hold);
  }

  async function push(skip: string[]) {
    setPhase("pushing");
    setProgress(null);
    setCancelling(false);
    transfer.reset();
    const unlisten = await api.onPushProgress(onProgress);
    try {
      const report = await api.push(true, only, fast, skip.concat(kept));
      if (report.cancelled) {
        notify("Push cancelled. Nothing changed on the server.");
        recordPush([]);
        finish();
        return;
      }
      setPhase("done");
      // Let the full bar register before the dialog goes away.
      await new Promise((r) => setTimeout(r, DONE_PAUSE));
      // Only deletions: say that, not "Pushed 0 files".
      const said = !report.uploaded && report.deleted
        ? `Deleted ${plural(report.deleted, "file")} from ${remoteDir}`
        : `Pushed ${plural(report.uploaded, "file")}${report.deleted ? `, deleted ${report.deleted}` : ""} to ${remoteDir}`;
      const history = report.history;
      notify(said, "info", history ? { label: "Undo", run: () => onUndo(history) } : undefined);
      if (report.notBackedUp) {
        notify(`${plural(report.notBackedUp, "file")} replaced without a backup (too big, or the server couldn't keep a copy)`);
      }
      if (fast && !report.fast && report.uploaded > 0) {
        notify("Fast mode unavailable: no tar on server");
      }
      recordPush(uploads.filter((c) => !skip.includes(c.path)).map((c) => joinRemote(remoteDir, c.path)));
      finish();
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
  const currentIsDeletion = currentPath !== null && isDeletion(currentPath);
  const pushing = phase === "pushing" || done;

  // Until files start going into place, Cancel takes the push back.
  const cancellable = phase === "pushing" && stage !== "placing" && !cancelling;

  // Deleting, packing and unpacking send no data, so there's no speed to show then.
  const speed = currentIsDeletion || stage ? null : transfer.speed;
  const timeLeft = speed && speed > 0 ? (bytesTotal - bytesDone) / speed : null;
  // The bar fills smoothly at the current speed between confirmations (see useSmoothFill).
  const smooth = useSmoothFill(fraction, speed && bytesTotal ? speed / bytesTotal : 0, pushing, done);

  // The sidebar shows a running push while another page is open.
  useEffect(() => {
    if (phase === "checking") setActivity("sync", { label: "Checking the server before pushing", percent: null });
    else if (phase === "taking") setActivity("sync", { label: "Getting server versions", percent: null });
    else if (phase === "pushing")
      setActivity("sync", { label: cancelling ? "Cancelling a push" : `Pushing ${plural(order.length, "file")}`, percent: percent });
    else setActivity("sync", null);
  }, [phase, percent, cancelling, order.length]);
  useEffect(() => () => setActivity("sync", null), []);

  // The conflicts step: every file needs a choice before going on.
  const undecided = conflicts.filter((c) => !choices[c.path]).length;
  const holding = conflicts.filter((c) => choices[c.path] && choices[c.path] !== "overwrite").map((c) => c.path);
  const taking = conflicts.filter((c) => choices[c.path] === "server").length;
  const after = order.filter((path) => !holding.includes(path));
  const pushingAfter = after.length;
  const deletingAfter = after.filter(isDeletion).length;
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
              ? pushLabel(pushingAfter - deletingAfter, deletingAfter)
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
              : github
                ? count > 0
                  ? "Push to both"
                  : "Push to GitHub"
                : pushLabel(count - deleting, deleting),
      // Nothing new for the server: GitHub alone.
      run: count === 0 ? () => (startGithub(), finish()) : start,
      disabled: busy || (count === 0 && !ghWork) || (ghWork && gh?.phase === "ready" && !gh.canPush),
    };
  }

  return (
    <>
      <Dialog
        title={github ? "Push to server and GitHub" : only ? (only.length === 1 && listed.length === 1 ? "Push file" : "Push changes") : "Push"}
        onClose={onClose}
        locked={busy || comparing !== null || gh?.phase === "pushing"}
        width={deciding ? 720 : 540}
        footer={
          <>
            <span className="spacer" />
            {phase === "pushing" ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setCancelling(true);
                  void api.cancelPush();
                }}
                disabled={!cancellable}
              >
                {cancelling ? "Cancelling…" : "Cancel"}
              </button>
            ) : (
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
            )}
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
              const deletion = change.kind === "deleted";
              const keeping = kept.includes(change.path);
              const skipped = keeping || held.includes(change.path);
              const index = order.indexOf(change.path);
              const state =
                !pushing || index < 0 ? "idle" : index < filesDone ? "done" : index === filesDone && !done ? "current" : "waiting";
              return (
                <li
                  key={change.path}
                  data-skipped={skipped ? "" : undefined}
                  data-state={state}
                  data-delete={deletion && !skipped && state !== "done" ? "" : undefined}
                >
                  <span className={`change-dot ${change.kind}`} aria-hidden="true" />
                  <span className="push-path">{change.path}</span>
                  <span className="push-kind">
                    {state === "done" ? (
                      <Check size={15} strokeWidth={2.25} className="push-done" aria-label="Done" />
                    ) : state === "current" ? (
                      <span className="push-spinner" aria-label="In progress" />
                    ) : deletion && phase === "ready" ? (
                      // Deleted on the server too; a click keeps it there this time.
                      <button
                        type="button"
                        className="push-delete"
                        aria-pressed={!keeping}
                        aria-label={keeping ? `Delete ${change.path} on the server too` : `Keep ${change.path} on the server`}
                        data-tip={keeping ? "Delete it on the server too" : "Keep it on the server this time"}
                        onClick={() => toggleKept(change.path)}
                      >
                        {keeping ? (
                          "Skip"
                        ) : (
                          <>
                            <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                            Delete
                          </>
                        )}
                      </button>
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
                      : stage === "placing"
                        ? project?.backup
                          ? "Keeping the old copies, putting files in place…"
                          : "Putting files in place…"
                        : cancelling
                          ? "Cancelling, removing what was sent…"
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

        {github && (
          <div className="push-dialog-github">
            <GithubPushPanel compact go={ghGo} onPhase={setGh} />
          </div>
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

import { useEffect, useRef, useState } from "react";
import { Check, ShieldAlert } from "lucide-react";
import { api, type Change, type GithubProgress, type GithubStatus } from "../lib/api";
import { errorMessage } from "../state/AppData";
import { GithubMark } from "./GithubMark";

/** Where a GitHub push stands. */
export type GithubPhase =
  | { phase: "loading" }
  | { phase: "ready"; canPush: boolean; files: number }
  | { phase: "pushing" }
  | { phase: "behind" }
  | { phase: "done"; text: string; url: string | null }
  | { phase: "failed"; error: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A starting message: what changed, in a few words. */
function suggest(changes: Change[]) {
  const names = changes.map((c) => c.path.split("/").pop() ?? c.path);
  if (names.length === 0) return "";
  if (names.length <= 2) return `Update ${names.join(", ")}`;
  return `Update ${names.length} files`;
}

const STAGE: Record<GithubProgress["stage"], string> = {
  fetching: "Checking GitHub's copy…",
  committing: "Committing…",
  uploading: "Uploading…",
  merging: "Joining GitHub's work with yours…",
};

/**
 * Pushing to GitHub, inside a dialog: the message, what goes (or how many, `compact`), a stop
 * for files that look like secrets, then progress. Starts when `go` changes; reports how it
 * stands through `onPhase`.
 */
export function GithubPushPanel({ go, compact = false, onPhase }: { go: number; compact?: boolean; onPhase: (phase: GithubPhase) => void }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [message, setMessage] = useState("");
  // Typed by the user: from then on, the suggestion stays out of it.
  const typed = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Files that look like secrets: kept off GitHub (into .gitignore), or allowed this once.
  const [allowSecrets, setAllowSecrets] = useState(false);
  const [phase, setPhase] = useState<GithubPhase>({ phase: "loading" });
  const [progress, setProgress] = useState<GithubProgress | null>(null);
  const onPhaseRef = useRef(onPhase);
  onPhaseRef.current = onPhase;

  const load = async () => {
    try {
      const next = await api.githubStatus();
      setStatus(next);
      if (!typed.current) setMessage(suggest(next.changes));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  };
  useEffect(() => void load(), []);

  const secrets = status?.secrets ?? [];
  const canPush = Boolean(status) && message.trim().length > 0 && (secrets.length === 0 || allowSecrets);

  const report = (next: GithubPhase) => {
    setPhase(next);
    onPhaseRef.current(next);
  };
  // While not started, the parent hears whether it could be.
  useEffect(() => {
    if (phase.phase === "loading" || phase.phase === "ready") {
      if (loadError) report({ phase: "failed", error: loadError });
      else if (status) report({ phase: "ready", canPush, files: status.changes.length });
    }
  }, [status, canPush, loadError]); // eslint-disable-line react-hooks/exhaustive-deps

  const where = status ? `${status.repo} (${status.branch})` : "GitHub";

  const push = async () => {
    report({ phase: "pushing" });
    setProgress(null);
    const unlisten = await api.onGithubProgress(setProgress);
    try {
      const result = await api.githubPush(message);
      if (result.outcome === "behind") return report({ phase: "behind" });
      report({
        phase: "done",
        text: result.outcome === "pushed" ? `Pushed ${plural(result.files, "file")} to ${where}` : `GitHub already has all of it (${where})`,
        url: status?.url ?? null,
      });
    } catch (e) {
      report({ phase: "failed", error: errorMessage(e) });
    } finally {
      unlisten();
    }
  };

  // GitHub had newer work: get it, then push again.
  const getLatest = async () => {
    report({ phase: "pushing" });
    const unlisten = await api.onGithubProgress(setProgress);
    try {
      await api.githubPull();
      unlisten();
      await push();
    } catch (e) {
      unlisten();
      report({ phase: "failed", error: errorMessage(e) });
    }
  };

  const keepOff = async () => {
    try {
      await api.githubIgnore(secrets);
      await load();
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  };

  const started = useRef(go);
  useEffect(() => {
    if (go === started.current) return;
    started.current = go;
    if (canPush || phase.phase === "failed") void push();
  }, [go]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = phase.phase === "pushing";
  const changes = status?.changes ?? [];

  return (
    <section className="gh-push" aria-label="GitHub">
      <p className="gh-push-where">
        <GithubMark size={15} />
        <span className="mono">{where}</span>
        {compact && status && <span className="muted">· {changes.length ? plural(changes.length, "file") : "nothing new"}</span>}
      </p>

      {loadError && phase.phase !== "failed" && (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      )}

      {status && phase.phase !== "done" && (
        <label className="field">
          <span>What changed</span>
          <input
            value={message}
            onChange={(e) => {
              typed.current = true;
              setMessage(e.target.value);
            }}
            placeholder="A few words for the history on GitHub"
            disabled={busy}
            maxLength={200}
          />
        </label>
      )}

      {!compact && status && (
        <ul className="push-list gh-push-list">
          {changes.length === 0 && <li className="muted">Nothing new for GitHub.</li>}
          {changes.map((change) => (
            <li key={change.path}>
              <span className={`change-dot ${change.kind}`} aria-hidden="true" />
              <span className="push-path">{change.path}</span>
              <span className="push-kind">{change.kind === "added" ? "New" : change.kind === "modified" ? "Changed" : "Delete"}</span>
            </li>
          ))}
        </ul>
      )}

      {secrets.length > 0 && !allowSecrets && phase.phase !== "done" && (
        <div className="gh-secrets" role="alert">
          <ShieldAlert size={18} strokeWidth={2} aria-hidden="true" />
          <div>
            <p className="gh-secrets-title">These look like secrets, and .gitignore doesn't keep them off GitHub:</p>
            <p className="mono gh-secrets-list">{secrets.join(", ")}</p>
            <p className="hint">Anyone who can see the repository could read them.</p>
            <div className="gh-secrets-actions">
              <button type="button" className="btn btn-small btn-primary" onClick={() => void keepOff()} disabled={busy}>
                Keep them off GitHub
              </button>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => setAllowSecrets(true)} disabled={busy}>
                Push them too
              </button>
            </div>
          </div>
        </div>
      )}

      {busy && (
        <p className="push-checking" role="status">
          <span className="push-spinner" aria-hidden="true" />
          {progress ? STAGE[progress.stage] : "Starting…"}
          {progress?.stage === "uploading" && progress.total > 0 && ` ${progress.done} of ${progress.total}`}
        </p>
      )}

      {phase.phase === "behind" && (
        <div className="gh-behind" role="alert">
          <p>GitHub has newer work, pushed from somewhere else. Get it first, then this goes up.</p>
          <button type="button" className="btn btn-small btn-primary" onClick={() => void getLatest()}>
            Get latest first
          </button>
        </div>
      )}

      {phase.phase === "done" && (
        <p className="gh-done" role="status">
          <Check size={16} strokeWidth={2.25} />
          {phase.text}
        </p>
      )}

      {phase.phase === "failed" && (
        <p className="form-error" role="alert">
          {phase.error}
        </p>
      )}
      {/* Inside Push to both, the dialog's own button belongs to the server. */}
      {compact && phase.phase === "failed" && status && (
        <button type="button" className="btn btn-small gh-retry" onClick={() => void push()}>
          Try GitHub again
        </button>
      )}
    </section>
  );
}

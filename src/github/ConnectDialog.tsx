import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "../ui/Dialog";
import { Switch } from "../ui/Switch";
import { api, onGithub, type GithubState, type ProjectInfo } from "../lib/api";
import { errorMessage } from "../state/AppData";
import { GitHubSignIn } from "./GitHubSignIn";
import { RepoPicker } from "./RepoPicker";

type Choice = "folder" | "create" | "existing";

/** A name GitHub takes: letters, digits, dot, dash, underscore (spaces become dashes). */
const repoName = (name: string) => name.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "");

/**
 * Connects the open project to GitHub: the repository the folder already pushes to (if it has
 * one), a new one on the account, or one that's there already. Signing in happens here too.
 */
export function ConnectDialog({
  projectName,
  onConnected,
  onClose,
}: {
  projectName: string;
  onConnected: (info: ProjectInfo) => void;
  onClose: () => void;
}) {
  const [github, setGithub] = useState<GithubState | null>(null);
  const [detected, setDetected] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>("create");
  // Picked by hand: the folder's own repository, found a moment later, doesn't override it.
  const pickedByHand = useRef(false);
  const choose = (next: Choice) => {
    pickedByHand.current = true;
    setChoice(next);
  };
  const [name, setName] = useState(repoName(projectName));
  const [isPrivate, setPrivate] = useState(true);
  const [existing, setExisting] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const existingId = useId();

  useEffect(() => {
    void api.githubState().then(setGithub, () => setGithub({ account: null, deviceFlow: false }));
    void api.githubDetect().then((url) => {
      setDetected(url);
      if (url && !pickedByHand.current) setChoice("folder");
    });
  }, []);

  const signedIn = Boolean(github?.account);
  // GitHub needs signing in; another host (or a folder) doesn't.
  const target = choice === "folder" ? (detected ?? "") : choice === "create" ? name : existing.trim();
  const onGithubToo = (repo: string) => onGithub(repo) || repo.includes("github.com");
  const needsSignIn = choice === "create" || onGithubToo(target);
  const blocked = !target || (needsSignIn && !signedIn);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      onConnected(await api.githubConnect(target, choice === "create", isPrivate));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Connect to GitHub"
      onClose={onClose}
      locked={busy}
      width={520}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void connect()} disabled={busy || blocked}>
            {busy ? "Connecting…" : choice === "create" ? "Create and connect" : "Connect"}
          </button>
        </>
      }
    >
      <p className="dialog-text">
        Push <strong>{projectName}</strong> to GitHub, as well as or instead of your server. Only what <code>.gitignore</code>{" "}
        allows goes there.
      </p>

      {github && !signedIn && (needsSignIn || choice === "existing") && (
        <section className="gh-connect-signin" aria-label="Sign in to GitHub">
          <p className="hint">
            {needsSignIn ? "Sign in to GitHub first." : "Sign in to GitHub to pick from your repositories, or type any git address below."}
          </p>
          <GitHubSignIn deviceFlow={github.deviceFlow} onSignedIn={(account) => setGithub({ ...github, account })} />
        </section>
      )}
      {signedIn && <p className="hint">Signed in as {github?.account?.login}.</p>}

      <div className="gh-choices" role="radiogroup" aria-label="Which repository">
        {detected && (
          <label className="gh-choice" data-on={choice === "folder" ? "" : undefined}>
            <input type="radio" name="gh-choice" checked={choice === "folder"} onChange={() => choose("folder")} />
            <span className="gh-choice-text">
              <span className="gh-choice-title">The repository this folder already has</span>
              <span className="gh-choice-sub mono">{detected}</span>
            </span>
          </label>
        )}

        <label className="gh-choice" data-on={choice === "create" ? "" : undefined}>
          <input type="radio" name="gh-choice" checked={choice === "create"} onChange={() => choose("create")} />
          <span className="gh-choice-text">
            <span className="gh-choice-title">A new repository</span>
            {choice === "create" && (
              <span className="gh-choice-fields">
                <span className="field">
                  <span>Name</span>
                  <input value={name} onChange={(e) => setName(repoName(e.target.value))} spellCheck={false} />
                </span>
                <Switch on={isPrivate} onChange={setPrivate} label="Private" hint="Only you (and people you invite) can see it." />
              </span>
            )}
          </span>
        </label>

        {/* Not a label all through: the list inside takes its own clicks. */}
        <div className="gh-choice" data-on={choice === "existing" ? "" : undefined} onClick={() => choose("existing")}>
          <input
            id={existingId}
            type="radio"
            name="gh-choice"
            checked={choice === "existing"}
            onChange={() => choose("existing")}
          />
          <span className="gh-choice-text">
            <label className="gh-choice-title" htmlFor={existingId}>
              A repository I already have
            </label>
            {choice === "existing" && (
              <span className="gh-choice-fields">
                <RepoPicker
                  signedIn={signedIn}
                  sameName={repoName(projectName)}
                  value={existing}
                  onChange={setExisting}
                  onSubmit={() => {
                    if (!busy && !blocked) void connect();
                  }}
                />
              </span>
            )}
          </span>
        </div>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

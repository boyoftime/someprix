import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, ExternalLink, KeyRound } from "lucide-react";
import { api, type DeviceCode, type GithubAccount } from "../lib/api";
import { errorMessage } from "../state/AppData";
import { GithubMark } from "./GithubMark";
import { Lottie } from "../ui/Lottie";
import connectingAnimation from "../assets/lottie/connecting.json";

/** GitHub's page for making a token with access to repositories. */
const TOKEN_PAGE = "https://github.com/settings/tokens/new?scopes=repo&description=Someprix";

/** Tells the pages that care (Sync's Push button) that the GitHub account changed. */
export const announceGithub = () => window.dispatchEvent(new Event("someprix:github"));

/**
 * Signing in to GitHub: through GitHub's own page (a short code to enter there), or with a
 * token made on GitHub. The token is kept in the system's credential store.
 */
export function GitHubSignIn({ deviceFlow, onSignedIn }: { deviceFlow: boolean; onSignedIn: (account: GithubAccount) => void }) {
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [starting, setStarting] = useState(false);
  const [useToken, setUseToken] = useState(!deviceFlow);
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Still on screen (set on every mount: React's dev mode mounts twice).
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const done = (account: GithubAccount) => {
    announceGithub();
    onSignedIn(account);
  };

  // Waits for the code to be entered on GitHub, checking as often as GitHub allows.
  useEffect(() => {
    if (!code) return;
    let interval = code.interval;
    let timer: number | undefined;
    const check = async () => {
      try {
        const answer = await api.githubDevicePoll(code.deviceCode);
        if (!live.current) return;
        if (answer.status === "done") return done(answer.account);
        if (answer.status === "slowDown") interval += 5;
        timer = window.setTimeout(check, interval * 1000);
      } catch (e) {
        if (!live.current) return;
        setError(errorMessage(e));
        setCode(null);
      }
    };
    timer = window.setTimeout(check, interval * 1000);
    return () => window.clearTimeout(timer);
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      const started = await api.githubDeviceStart();
      setCode(started);
      void openUrl(started.verificationUri).catch(() => {});
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const signInWithToken = async () => {
    setError(null);
    setChecking(true);
    try {
      done(await api.githubSignInToken(token));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="gh-signin">
      {checking ? (
        <div className="gh-signing" role="status">
          <Lottie data={connectingAnimation} size={64} />
          <p>Signing in to GitHub…</p>
        </div>
      ) : code ? (
        <div className="gh-code-box" role="status">
          <p className="gh-code-label">Enter this code on GitHub</p>
          <div className="gh-code-row">
            <span className="gh-code">{code.userCode}</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Copy the code"
              data-tip={copied ? "Copied" : "Copy"}
              onClick={() => void writeText(code.userCode).then(() => setCopied(true))}
            >
              <Copy size={15} strokeWidth={1.9} />
            </button>
          </div>
          <div className="gh-code-actions">
            <button type="button" className="btn btn-primary" onClick={() => void openUrl(code.verificationUri)}>
              <ExternalLink size={15} strokeWidth={1.9} />
              Open GitHub
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setCode(null)}>
              Cancel
            </button>
          </div>
          <p className="gh-waiting">
            <span className="push-spinner" aria-hidden="true" />
            Waiting for GitHub…
          </p>
        </div>
      ) : (
        <>
          {deviceFlow && (
            <button type="button" className="btn btn-primary gh-signin-btn" onClick={() => void start()} disabled={starting}>
              <GithubMark size={16} />
              {starting ? "Starting…" : "Sign in with GitHub"}
            </button>
          )}
          {deviceFlow && !useToken && (
            <button type="button" className="link-btn" onClick={() => setUseToken(true)}>
              Use a token instead
            </button>
          )}
          {useToken && (
            <form
              className="gh-token"
              onSubmit={(event) => {
                event.preventDefault();
                void signInWithToken();
              }}
            >
              <div className="field">
                <span>Token from GitHub</span>
                <div className="gh-token-row">
                  <input
                    aria-label="Token from GitHub"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="ghp_… or github_pat_…"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                  />
                  <button type="submit" className="btn btn-primary" disabled={checking || !token.trim()}>
                    <KeyRound size={15} strokeWidth={1.9} />
                    {checking ? "Checking…" : "Sign in"}
                  </button>
                </div>
              </div>
              <p className="hint">
                Make one on GitHub with access to your repositories (the repo scope).{" "}
                <button type="button" className="link-btn" onClick={() => void openUrl(TOKEN_PAGE)}>
                  Open GitHub's token page
                </button>
              </p>
            </form>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

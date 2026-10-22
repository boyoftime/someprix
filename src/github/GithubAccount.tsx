import { useState } from "react";
import { LogOut } from "lucide-react";
import type { GithubAccount as Account } from "../lib/api";
import { Dialog } from "../ui/Dialog";

/** The blue tick: a filled badge with a white check. */
function VerifiedBadge() {
  return (
    <svg className="gh-verified" width="18" height="18" viewBox="0 0 24 24" role="img" aria-label="Signed in">
      <path
        className="gh-verified-badge"
        d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"
      />
      <path className="gh-verified-check" d="m8.6 12.2 2.4 2.4 4.6-4.8" />
    </svg>
  );
}

/** Their GitHub picture, or the first letter of their name when it can't load. */
function Avatar({ account, name }: { account: Account; name: string }) {
  const [picture, setPicture] = useState(true);
  return (
    <span className="gh-avatar" aria-hidden="true">
      {picture ? (
        <img src={`https://avatars.githubusercontent.com/u/${account.id}?s=96&v=4`} alt="" onError={() => setPicture(false)} />
      ) : (
        <span>{name.charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}

/**
 * Who's signed in to GitHub: their picture, name with a blue tick, and @login. `fresh`: just
 * signed in (the tick pops in). Signing out asks first.
 */
export function GithubAccount({ account, fresh = false, onSignOut }: { account: Account; fresh?: boolean; onSignOut: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const name = account.name?.trim() || account.login;

  const signOut = async () => {
    setLeaving(true);
    await onSignOut();
    // Still here: it didn't go through (the reason shows as a message).
    setLeaving(false);
    setAsking(false);
  };

  return (
    <div className="gh-account" data-fresh={fresh ? "" : undefined}>
      <Avatar account={account} name={name} />
      <span className="gh-account-text">
        <span className="gh-account-name">
          <span className="gh-account-name-text">{name}</span>
          <VerifiedBadge />
        </span>
        <span className="gh-account-login">@{account.login} · signed in to GitHub</span>
      </span>
      <button type="button" className="btn" onClick={() => setAsking(true)}>
        Sign out
      </button>

      {asking && (
        <Dialog
          title="Sign out of GitHub?"
          onClose={() => setAsking(false)}
          locked={leaving}
          width={420}
          footer={
            <>
              <span className="spacer" />
              <button type="button" className="btn btn-ghost" onClick={() => setAsking(false)} disabled={leaving}>
                Stay signed in
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void signOut()} disabled={leaving} aria-busy={leaving}>
                {leaving && <span className="btn-spinner" aria-hidden="true" />}
                {leaving ? "Signing out…" : "Sign out"}
              </button>
            </>
          }
        >
          <div className="gh-leaving">
            <span className="gh-leaving-pic">
              <Avatar account={account} name={name} />
              <span className="gh-leaving-mark" aria-hidden="true">
                <LogOut size={11} strokeWidth={2.4} />
              </span>
            </span>
            <span className="gh-account-text">
              <span className="gh-account-name">
                <span className="gh-account-name-text">{name}</span>
                <VerifiedBadge />
              </span>
              <span className="gh-account-login">@{account.login}</span>
            </span>
          </div>
          <p className="dialog-text">
            Someprix forgets your sign-in on this computer. Projects stay connected to their repositories and nothing
            changes on GitHub. Sign in again to push there.
          </p>
        </Dialog>
      )}
    </div>
  );
}

import { useState } from "react";
import type { GithubAccount as Account } from "../lib/api";

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

/**
 * Who's signed in to GitHub: their picture, name with a blue tick, and @login. `fresh`: just
 * signed in (the tick pops in).
 */
export function GithubAccount({ account, fresh = false, onSignOut }: { account: Account; fresh?: boolean; onSignOut: () => void }) {
  const [picture, setPicture] = useState(true);
  const name = account.name?.trim() || account.login;
  return (
    <div className="gh-account" data-fresh={fresh ? "" : undefined}>
      <span className="gh-avatar" aria-hidden="true">
        {picture ? (
          <img src={`https://avatars.githubusercontent.com/u/${account.id}?s=96&v=4`} alt="" onError={() => setPicture(false)} />
        ) : (
          <span>{name.charAt(0).toUpperCase()}</span>
        )}
      </span>
      <span className="gh-account-text">
        <span className="gh-account-name">
          <span className="gh-account-name-text">{name}</span>
          <VerifiedBadge />
        </span>
        <span className="gh-account-login">@{account.login} · signed in to GitHub</span>
      </span>
      <button type="button" className="btn" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}

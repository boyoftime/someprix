import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Archive, BookMarked, Check, Link2, Lock, RotateCw, Search } from "lucide-react";
import { api, type GithubRepo } from "../lib/api";
import { formatAgo } from "../lib/format";
import { errorMessage } from "../state/AppData";

/** Typed into the search, but not one of theirs: an address (or owner/name) to use as it is. */
const looksLikeAddress = (text: string) => text.includes("/") || text.includes(":") || text.endsWith(".git");

type Row = { kind: "repo"; repo: GithubRepo; usable: boolean } | { kind: "typed"; value: string };

const valueOf = (row: Row) => (row.kind === "repo" ? row.repo.fullName : row.value);

/**
 * Picks one of the account's repositories: searchable, most recently pushed first, one named
 * like the project on top. Signed out (or for another host), the search takes an address.
 * `onSubmit`: Enter, or a double click, on the one picked.
 */
export function RepoPicker({
  signedIn,
  sameName,
  value,
  onChange,
  onSubmit,
}: {
  signedIn: boolean;
  /** The project's name as a repository name: a repository called that comes first. */
  sameName: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    setError(null);
    setRepos(null);
    api.githubRepos().then(
      (found) => {
        if (!live) return;
        setRepos(found);
        // Named like the project: most likely the one, so it starts picked.
        const named = found.filter((r) => r.fullName.split("/")[1]?.toLowerCase() === sameName.toLowerCase() && r.canPush && !r.archived);
        if (named.length === 1 && !value) onChange(named[0].fullName);
      },
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [signedIn, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo<Row[]>(() => {
    const words = query.trim().toLowerCase();
    const isSame = (r: GithubRepo) => r.fullName.split("/")[1]?.toLowerCase() === sameName.toLowerCase();
    const shown = (repos ?? [])
      .filter((r) => !words || r.fullName.toLowerCase().includes(words) || r.description?.toLowerCase().includes(words))
      .sort((a, b) => Number(isSame(b)) - Number(isSame(a)))
      .map<Row>((repo) => ({ kind: "repo", repo, usable: repo.canPush && !repo.archived }));
    const typed = query.trim();
    const listed = (repos ?? []).some((r) => r.fullName.toLowerCase() === typed.toLowerCase());
    return typed && !listed && (looksLikeAddress(typed) || !signedIn) ? [{ kind: "typed", value: typed }, ...shown] : shown;
  }, [repos, query, sameName, signedIn]);

  const usable = rows.filter((row) => row.kind === "typed" || row.usable);

  // The one picked went out of the search: nothing is picked (Connect waits).
  useEffect(() => {
    if (value && !rows.some((row) => valueOf(row) === value)) onChange("");
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keeps the picked one in view as the arrows move through the list.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  }, [value]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!usable.length) return;
      const at = usable.findIndex((row) => valueOf(row) === value);
      const next = event.key === "ArrowDown" ? Math.min(at + 1, usable.length - 1) : Math.max(at - 1, 0);
      onChange(valueOf(usable[at < 0 ? 0 : next]));
    } else if (event.key === "Enter" && value) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="repo-picker">
      <label className="repo-search">
        <Search size={15} strokeWidth={1.9} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={signedIn ? "Search your repositories, or paste an address" : "owner/name, or the repository's address"}
          aria-label="Repository"
          aria-controls={signedIn ? listId : undefined}
          spellCheck={false}
          autoFocus
        />
      </label>

      {(signedIn || rows.length > 0) && (
        <div className="repo-list" id={listId} role="listbox" aria-label="Your repositories" ref={list}>
          {rows.map((row) =>
            row.kind === "typed" ? (
              <div
                key="typed"
                className="repo-row"
                role="option"
                aria-selected={value === row.value}
                onClick={() => onChange(row.value)}
                onDoubleClick={onSubmit}
              >
                <Link2 className="repo-row-icon" size={16} strokeWidth={1.9} />
                <span className="repo-row-text">
                  <span className="repo-row-name">
                    Use <span className="mono">{row.value}</span>
                  </span>
                  <span className="repo-row-sub">{signedIn ? "Not in your list: connect to it by this address" : "Connect to it by this address"}</span>
                </span>
                {value === row.value && <Check className="repo-row-check" size={16} strokeWidth={2.4} />}
              </div>
            ) : (
              <RepoRow
                key={row.repo.fullName}
                repo={row.repo}
                usable={row.usable}
                same={row.repo.fullName.split("/")[1]?.toLowerCase() === sameName.toLowerCase()}
                picked={value === row.repo.fullName}
                onPick={() => onChange(row.repo.fullName)}
                onSubmit={onSubmit}
              />
            ),
          )}
          {signedIn && repos === null && !error && (
            <div className="repo-list-note" role="status">
              <span className="push-spinner" aria-hidden="true" />
              Getting your repositories…
            </div>
          )}
          {error && (
            <div className="repo-list-note repo-list-error" role="alert">
              <span>{error}</span>
              <button type="button" className="link-btn" onClick={() => setAttempt((n) => n + 1)}>
                <RotateCw size={13} strokeWidth={2} />
                Try again
              </button>
            </div>
          )}
          {repos && repos.length === 0 && !query.trim() && (
            <div className="repo-list-note">No repositories on this account yet. Make a new one above.</div>
          )}
          {repos && repos.length > 0 && rows.length === 0 && <div className="repo-list-note">None of your repositories match “{query.trim()}”.</div>}
        </div>
      )}
      {repos && repos.length > 0 && (
        <span className="repo-count">
          {repos.length === 1 ? "1 repository" : `${repos.length} repositories`} · most recently pushed first
        </span>
      )}
    </div>
  );
}

function RepoRow({
  repo,
  usable,
  same,
  picked,
  onPick,
  onSubmit,
}: {
  repo: GithubRepo;
  usable: boolean;
  same: boolean;
  picked: boolean;
  onPick: () => void;
  onSubmit: () => void;
}) {
  const [owner, name] = repo.fullName.split("/");
  const pushed = repo.pushedAt ? Date.parse(repo.pushedAt) : NaN;
  const why = repo.archived ? "Archived on GitHub: it can't take pushes" : !repo.canPush ? "You can look but not push to it" : null;
  const Icon = repo.archived ? Archive : repo.private ? Lock : BookMarked;
  return (
    <div
      className="repo-row"
      role="option"
      aria-selected={picked}
      aria-disabled={!usable || undefined}
      data-tip={why ?? undefined}
      onClick={usable ? onPick : undefined}
      onDoubleClick={usable ? onSubmit : undefined}
    >
      <Icon className="repo-row-icon" size={16} strokeWidth={1.9} aria-label={repo.archived ? "Archived" : repo.private ? "Private" : "Public"} />
      <span className="repo-row-text">
        <span className="repo-row-line">
          <span className="repo-row-name">
            <span className="repo-row-owner">{owner}/</span>
            {name}
          </span>
          {same && (
            <span className="repo-tag" data-tip="Named like this folder" data-tip-on="hover">
              Same name
            </span>
          )}
        </span>
        <span className="repo-row-sub">{why ?? repo.description ?? (repo.private ? "Private" : "Public")}</span>
      </span>
      {!Number.isNaN(pushed) && <span className="repo-row-when">{formatAgo(pushed / 1000).replace(/^on /, "")}</span>}
      {picked && <Check className="repo-row-check" size={16} strokeWidth={2.4} />}
    </div>
  );
}

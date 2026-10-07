import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Ban, ChevronDown, Copy, FolderOpen, FolderSearch, Laptop, Upload } from "lucide-react";
import { errorMessage, useAppData } from "../state/AppData";
import { useContextMenu } from "../ui/ContextMenu";
import { FastToggle } from "../ui/FastToggle";
import { Logo } from "../components/Logo";
import { LocalTree } from "./LocalTree";
import { ExcludedDialog } from "./ExcludedDialog";
import type { Change } from "../lib/api";

type LocalPaneProps = {
  /** Why pushing isn't possible right now, or null when it is. */
  pushBlocker: string | null;
  onPush: () => void;
  /** Push only the changes at or under these project paths. */
  onPushPaths: (paths: string[]) => void;
  /** Fast mode: changes go as one compressed archive the server unpacks. */
  fast: boolean;
  onFastChange: (on: boolean) => void;
};

async function pickFolder() {
  const picked = await open({ title: "Select project folder", directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}

function ChangeSummary({ changes }: { changes: Change[] }) {
  if (changes.length === 0) return <span className="muted">No changes</span>;
  const count = (kind: Change["kind"]) => changes.filter((c) => c.kind === kind).length;
  const parts = [
    { kind: "modified", n: count("modified"), label: "changed" },
    { kind: "added", n: count("added"), label: "new" },
    { kind: "deleted", n: count("deleted"), label: "deleted" },
  ].filter((p) => p.n > 0);
  return (
    <span className="change-summary">
      {parts.map((p) => (
        <span key={p.kind} className="change-count">
          <span className={`change-dot ${p.kind}`} aria-hidden="true" />
          {p.n} {p.label}
        </span>
      ))}
    </span>
  );
}

/** How long "Change detected" shows after the folder changes. */
const DETECTED_FOR = 1800;

/**
 * Shows that the open folder is watched: every save, new file or delete is picked up on its own,
 * no refresh needed. Reads "Change detected" for a moment when something new turns up.
 */
function WatchStatus({ changes, scanning }: { changes: Change[]; scanning: boolean }) {
  const [detected, setDetected] = useState(0);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const now = new Set(changes.map((c) => `${c.kind}:${c.path}`));
    // Only something new counts: a push clearing the list isn't a change in the folder.
    if (seen.current && [...now].some((key) => !seen.current!.has(key))) setDetected((n) => n + 1);
    seen.current = now;
  }, [changes]);

  useEffect(() => {
    if (!detected) return;
    const timer = setTimeout(() => setDetected(0), DETECTED_FOR);
    return () => clearTimeout(timer);
  }, [detected]);

  const state = scanning ? "scanning" : detected ? "detected" : "watching";
  return (
    <span className="watch" data-state={state} role="status" data-tip="Changes in this folder are tracked automatically">
      {/* Restarts its ripple on each detection. */}
      <span key={detected} className="watch-dot" aria-hidden="true" />
      {state === "scanning" ? "Scanning…" : state === "detected" ? "Change detected" : "Watching"}
    </span>
  );
}

export function LocalPane({ pushBlocker, onPush, onPushPaths, fast, onFastChange }: LocalPaneProps) {
  const { project, projectLoading, openProject, notify, excludeFromPush } = useAppData();
  // The list of excluded paths, while it's open.
  const [showExcluded, setShowExcluded] = useState(false);
  const openMenu = useContextMenu();
  const attempt = (action: Promise<unknown>) => void action.catch((e) => notify(errorMessage(e), "error"));

  async function choose() {
    const folder = await pickFolder();
    if (!folder) return;
    const opened = await openProject(folder);
    if (opened) notify(`Watching ${opened.name}`);
  }

  if (!project) {
    return (
      <section
        className="pane"
        aria-label="Local"
        onContextMenu={(event) =>
          openMenu(event, [{ label: "Open project", icon: FolderOpen, onSelect: () => void choose() }])
        }
      >
        <header className="pane-head">
          <span className="pane-title">
            <Laptop size={16} strokeWidth={1.75} />
            Local
          </span>
        </header>
        <div className="pane-empty welcome-empty">
          <Logo size={48} className="welcome-mark" />
          <h1 className="welcome-title">Welcome to Someprix</h1>
          <button type="button" className="btn btn-primary" onClick={choose} disabled={projectLoading}>
            <FolderOpen size={16} strokeWidth={1.75} />
            {projectLoading ? "Opening…" : "Open project"}
          </button>
        </div>
      </section>
    );
  }

  const changes = project.changes;
  const root = project.root;
  return (
    <section
      className="pane"
      aria-label="Local"
      onContextMenu={(event) =>
        openMenu(event, [
          {
            label: changes.length ? `Push all (${changes.length})` : "Nothing to push",
            icon: Upload,
            onSelect: onPush,
            disabled: changes.length === 0 || pushBlocker !== null,
          },
          "separator",
          { label: "Open in Explorer", icon: FolderSearch, onSelect: () => attempt(openPath(root)) },
          { label: "Change project", icon: FolderOpen, onSelect: () => void choose() },
          "separator",
          { label: "Copy path", icon: Copy, onSelect: () => attempt(writeText(root)) },
        ])
      }
    >
      <header className="pane-head">
        <span className="pane-title">
          <Laptop size={16} strokeWidth={1.75} />
          Local
        </span>
        <button type="button" className="chip" onClick={choose} data-tip="Change project">
          <FolderOpen size={15} strokeWidth={1.75} />
          {project.name}
          <ChevronDown size={14} strokeWidth={2} />
        </button>
      </header>
      <div className="pane-path">
        <span className="path-tail" data-tip={project.root}>
          <bdi>{project.root}</bdi>
        </span>
        <WatchStatus key={project.root} changes={changes} scanning={projectLoading} />
      </div>

      <LocalTree
        root={project.root}
        changes={changes}
        pushBlocker={pushBlocker}
        onPushPaths={onPushPaths}
        excluded={project.excluded}
        onExclude={(paths, exclude) => void excludeFromPush(paths, exclude)}
      />

      <footer className="pane-foot">
        <ChangeSummary changes={changes} />
        {project.excluded.length > 0 && (
          <button
            type="button"
            className="excluded-count"
            onClick={() => setShowExcluded(true)}
            data-tip="Left out of pushing"
          >
            <Ban size={13} strokeWidth={2} />
            {project.excluded.length} excluded
          </button>
        )}
        <span className="spacer" />
        <FastToggle on={fast} onChange={onFastChange} />
        <span className="tip-wrap" data-tip={changes.length > 0 ? (pushBlocker ?? undefined) : "No changes"}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onPush}
            disabled={changes.length === 0 || pushBlocker !== null}
          >
            <Upload size={16} strokeWidth={1.75} />
            Push to server
          </button>
        </span>
      </footer>
      {changes.length > 0 && pushBlocker && <p className="pane-note">{pushBlocker}</p>}
      {showExcluded && (
        <ExcludedDialog
          excluded={project.excluded}
          onInclude={(paths) => void excludeFromPush(paths, false)}
          onClose={() => setShowExcluded(false)}
        />
      )}
    </section>
  );
}

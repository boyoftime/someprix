import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Ban, ChevronDown, Copy, Eraser, FolderOpen, FolderSearch, History, Laptop, Upload } from "lucide-react";
import { errorMessage, useAppData } from "../state/AppData";
import { useContextMenu } from "../ui/ContextMenu";
import { FastToggle } from "../ui/FastToggle";
import { Logo } from "../components/Logo";
import { LocalTree } from "./LocalTree";
import { ExcludedDialog } from "./ExcludedDialog";
import { rowWidth } from "./Splitter";
import { fileManager } from "../lib/platform";
import { Dialog } from "../ui/Dialog";
import { api, type Change } from "../lib/api";

type LocalPaneProps = {
  /** Why pushing isn't possible right now, or null when it is. */
  pushBlocker: string | null;
  onPush: () => void;
  /** Push only the changes at or under these project paths. */
  onPushPaths: (paths: string[]) => void;
  /** Fast mode: changes go as one compressed archive the server unpacks. */
  fast: boolean;
  onFastChange: (on: boolean) => void;
  /** Opens the push history (with Undo). */
  onShowHistory: () => void;
  /** Told the width the footer needs on one line, so the divider never squeezes it. */
  onFootWidth: (width: number) => void;
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
        <span key={p.kind} className="change-count" data-tip={`${p.n} ${p.label}`}>
          <span className={`change-dot ${p.kind}`} aria-hidden="true" />
          <span className="foot-long">
            {p.n} {p.label}
          </span>
          <span className="foot-short">{p.n}</span>
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

export function LocalPane({ pushBlocker, onPush, onPushPaths, fast, onFastChange, onShowHistory, onFootWidth }: LocalPaneProps) {
  const { project, projectLoading, openProject, notify, excludeFromPush } = useAppData();
  // The list of excluded paths, while it's open.
  const [showExcluded, setShowExcluded] = useState(false);
  // "Clear all changes?", while it's asking.
  const [clearing, setClearing] = useState(false);
  const clearChanges = async (paths?: string[]) => {
    try {
      const before = project?.changes.length ?? 0;
      const after = await api.clearChanges(paths);
      const cleared = before - after.changes.length;
      notify(paths ? `Cleared ${cleared === 1 ? "1 change" : `${cleared} changes`}` : `Cleared all changes in ${after.name}`);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };
  const openMenu = useContextMenu();
  const attempt = (action: Promise<unknown>) => void action.catch((e) => notify(errorMessage(e), "error"));

  // The footer stays on one line: the divider stops where it would no longer fit, and if the
  // whole window is too narrow even so, it goes compact ("Push", counts without words).
  const foot = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  const fullWidth = useRef(0);
  const footWidthSink = useRef(onFootWidth);
  footWidthSink.current = onFootWidth;
  useLayoutEffect(() => {
    const row = foot.current;
    const pane = row?.closest<HTMLElement>(".pane");
    if (!row || !pane) return;
    const update = () => {
      if (!row.hasAttribute("data-compact")) {
        fullWidth.current = rowWidth(row);
        footWidthSink.current(fullWidth.current);
      }
      setCompact(pane.clientWidth < fullWidth.current);
    };
    update();
    const resized = new ResizeObserver(update);
    resized.observe(pane);
    const changed = new MutationObserver(update);
    changed.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      resized.disconnect();
      changed.disconnect();
    };
  }, [project?.root]);

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
          {
            label: changes.length ? "Clear all changes…" : "No changes to clear",
            icon: Eraser,
            onSelect: () => setClearing(true),
            disabled: changes.length === 0,
          },
          "separator",
          { label: `Open in ${fileManager}`, icon: FolderSearch, onSelect: () => attempt(openPath(root)) },
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
        <button type="button" className="chip project-chip" onClick={choose} data-tip={`Change project (${project.name})`}>
          <FolderOpen size={15} strokeWidth={1.75} />
          <span className="chip-label">{project.name}</span>
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
        onClearChanges={(paths) => void clearChanges(paths)}
      />

      <footer className="pane-foot local-foot" ref={foot} data-compact={compact ? "" : undefined}>
        <ChangeSummary changes={changes} />
        {project.excluded.length > 0 && (
          <button
            type="button"
            className="excluded-count"
            onClick={() => setShowExcluded(true)}
            data-tip="Left out of pushing"
          >
            <Ban size={13} strokeWidth={2} />
            <span className="foot-long">{project.excluded.length} excluded</span>
            <span className="foot-short">{project.excluded.length}</span>
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={onShowHistory} aria-label="Push history" data-tip="Push history and undo">
          <History size={17} strokeWidth={1.75} />
        </button>
        <FastToggle on={fast} onChange={onFastChange} />
        <span className="tip-wrap" data-tip={changes.length > 0 ? (pushBlocker ?? undefined) : "No changes"}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onPush}
            disabled={changes.length === 0 || pushBlocker !== null}
          >
            <Upload size={16} strokeWidth={1.75} />
            <span className="foot-long">Push to server</span>
            <span className="foot-short">Push</span>
          </button>
        </span>
      </footer>
      {changes.length > 0 && pushBlocker && <p className="pane-note">{pushBlocker}</p>}
      {clearing && (
        <Dialog
          title="Clear all changes?"
          onClose={() => setClearing(false)}
          footer={
            <>
              <span className="spacer" />
              <button type="button" className="btn btn-ghost" onClick={() => setClearing(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  setClearing(false);
                  void clearChanges();
                }}
              >
                Clear {changes.length === 1 ? "1 change" : `${changes.length} changes`}
              </button>
            </>
          }
        >
          <p className="dialog-text">
            Someprix will take <strong>{project.name}</strong> as it is now as what's on the server: the{" "}
            {changes.length === 1 ? "change stops" : `${changes.length} changes stop`} showing and won't be pushed.
          </p>
          <p className="dialog-text">Your files and the server stay exactly as they are. What you edit after this shows as a change again.</p>
        </Dialog>
      )}
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

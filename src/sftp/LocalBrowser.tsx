import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ArrowUp,
  Copy,
  ExternalLink,
  File,
  FilePen,
  Folder,
  FolderOpen,
  FolderSearch,
  HardDrive,
  Info,
  House,
  Laptop,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { api, type LocalFsEntry } from "../lib/api";
import { formatSize } from "../lib/format";
import { errorMessage, useAppData } from "../state/AppData";
import { CopyButton } from "../ui/CopyButton";
import { useContextMenu, type MenuItem } from "../ui/ContextMenu";
import { Loading } from "../ui/Loading";
import { DeleteDialog } from "../sync/DeleteDialog";
import { PropertiesDialog } from "../ui/PropertiesDialog";
import { useDrag } from "./drag";
import { useListSelection } from "../ui/useListSelection";
import { useSpin } from "../ui/useSpin";
import { useTypeAhead } from "../ui/useTypeAhead";
import { useOpenInEditor } from "../editor/EditorProvider";
import { isTextFile } from "../editor/languages";
import { Crumbs, type Crumb } from "../ui/Crumbs";
import { fileManager, isWindows, trashName } from "../lib/platform";

const LAST_FOLDER = "someprix.sftp.local";
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Where a folder's parent is, or null at the top. On Windows a drive root goes up to the drive
 * list (""), which is the top; on Mac and Linux "/" is.
 */
export function parentLocal(path: string): string | null {
  if (!isWindows) {
    const trimmed = path.replace(/\/+$/, "");
    if (!trimmed) return null;
    const cut = trimmed.lastIndexOf("/");
    return cut <= 0 ? "/" : trimmed.slice(0, cut);
  }
  if (!path) return null;
  const trimmed = path.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(trimmed)) return "";
  const cut = trimmed.lastIndexOf("\\");
  if (cut < 0) return "";
  const parent = trimmed.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

function LocalCrumbs({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  let items: Crumb[];
  if (isWindows) {
    const parts = path.replace(/[\\/]+$/, "").split("\\").filter(Boolean);
    items = [
      { label: "This PC", path: "" },
      ...parts.map((part, i) => ({
        label: part,
        path: i === 0 ? `${part}\\` : parts.slice(0, i + 1).join("\\"),
        sep: "\\",
      })),
    ];
  } else {
    const parts = path.split("/").filter(Boolean);
    items = [
      { label: "/", path: "/" },
      ...parts.map((part, i) => ({ label: part, path: `/${parts.slice(0, i + 1).join("/")}`, sep: i > 0 ? "/" : undefined })),
    ];
  }
  return <Crumbs items={items} fullPath={path || "This PC"} label="Folder on this computer" onOpen={onOpen} />;
}

/** What a download just wrote, to reload the list and point it out. */
export type Revealed = { at: number; paths: string[] };

type LocalBrowserProps = {
  /** Why uploading isn't possible right now, or null when it is. */
  uploadBlocker: string | null;
  /** The server folder uploads go to from the button and menus. */
  remoteDir: string | null;
  onUpload: (sources: string[]) => void;
  onSelectionChange: (entries: LocalFsEntry[]) => void;
  /** Told whenever the open folder changes ("" is the drive list). */
  onPathChange?: (path: string | null) => void;
  revealed?: Revealed | null;
};

export function LocalBrowser({
  uploadBlocker,
  remoteDir,
  onUpload,
  onSelectionChange,
  onPathChange,
  revealed = null,
}: LocalBrowserProps) {
  const { notify } = useAppData();
  const openMenu = useContextMenu();
  const drag = useDrag();
  const openInEditor = useOpenInEditor();
  const attempt = (action: Promise<unknown>) => void action.catch((e) => notify(errorMessage(e), "error"));

  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<LocalFsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [listing, setListing] = useState(false);
  const refreshSpin = useSpin(listing);
  const refresh = () => {
    refreshSpin.spin();
    setReload((n) => n + 1);
  };
  const body = useRef<HTMLDivElement>(null);
  const order = useCallback(() => (entries ?? []).map((e) => e.path), [entries]);
  const { selected, setSelected, only, clear, all, click, beginBox, box } = useListSelection(
    body,
    ".local-row[data-path]",
    order,
  );
  const typeAhead = useTypeAhead();
  // The local folder a server drag is over, if any.
  const downloadOver = drag?.drag?.kind === "download" ? drag.drag.overDir : null;
  // Items a download just wrote, lit up for a moment.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const reveal = useRef<string[] | null>(null);
  // What the delete confirmation is asking about, while it's open.
  const [toDelete, setToDelete] = useState<LocalFsEntry[] | null>(null);
  // What the Properties dialog shows, while it's open.
  const [propsFor, setPropsFor] = useState<LocalFsEntry[] | null>(null);
  // Windows' list of drives (""), above every drive root.
  const atDrives = isWindows && path === "";
  const up = path === null ? null : parentLocal(path);

  // Start where the user left off, else in their home folder.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(LAST_FOLDER);
    } catch {
      // No storage: start at home.
    }
    if (saved !== null) setPath(saved);
    else void api.localHome().then(setPath);
  }, []);

  useEffect(() => {
    if (path === null) return;
    try {
      localStorage.setItem(LAST_FOLDER, path);
    } catch {
      // Not remembered; fine.
    }
    let current = true;
    setError(null);
    setListing(true);
    api
      .localList(path)
      .then((list) => current && setEntries(list))
      .catch((e) => current && setError(errorMessage(e)))
      .finally(() => current && setListing(false));
    return () => {
      current = false;
      setListing(false);
    };
  }, [path, reload]);

  useEffect(() => onPathChange?.(path), [path]); // eslint-disable-line react-hooks/exhaustive-deps

  // After a download: reload, then select and light up what arrived.
  useEffect(() => {
    if (!revealed) return;
    reveal.current = revealed.paths;
    setReload((n) => n + 1);
  }, [revealed]);

  useEffect(() => {
    const wanted = reveal.current;
    if (!entries || !wanted) return;
    reveal.current = null;
    const here = entries.filter((e) => wanted.includes(e.path)).map((e) => e.path);
    if (!here.length) return;
    setSelected(new Set(here));
    setFresh(new Set(here));
    body.current
      ?.querySelector(`[data-path="${CSS.escape(here[0])}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [entries]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!fresh.size) return;
    const timer = setTimeout(() => setFresh(new Set()), 8000);
    return () => clearTimeout(timer);
  }, [fresh]);

  const chosen = useMemo(() => (entries ?? []).filter((e) => selected.has(e.path)), [entries, selected]);
  useEffect(() => onSelectionChange(chosen), [chosen]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (next: string) => {
    // Opening the folder that's already open (e.g. its breadcrumb) refreshes it.
    if (next === path) {
      refresh();
      return;
    }
    setEntries(null);
    clear();
    setPath(next);
  };

  const activate = (entry: LocalFsEntry) => {
    if (entry.isDir) open(entry.path);
    // Text opens in the editor; anything else in its own app.
    else if (openInEditor && isTextFile(entry.name)) openInEditor({ kind: "local", path: entry.path });
    else attempt(openPath(entry.path));
  };

  /** What a drag or a right-click acts on: the selection if the row is in it, else just the row. */
  const targetsFor = (entry: LocalFsEntry) => {
    if (selected.has(entry.path)) return chosen;
    only(entry.path);
    return [entry];
  };

  const uploadLabel = (count: number) =>
    remoteDir ? `Upload ${count === 1 ? "" : `${count} items `}to ${remoteDir}` : "Upload to server";

  const rowMenu = (entry: LocalFsEntry): MenuItem[] => {
    const targets = targetsFor(entry);
    return [
      ...(!entry.isDir && path && openInEditor && isTextFile(entry.name)
        ? [{ label: "Edit", icon: FilePen, onSelect: () => openInEditor({ kind: "local", path: entry.path }) }]
        : []),
      entry.isDir
        ? { label: "Open", icon: FolderOpen, onSelect: () => open(entry.path) }
        : { label: path && isTextFile(entry.name) ? "Open externally" : "Open", icon: ExternalLink, onSelect: () => attempt(openPath(entry.path)) },
      { label: `Show in ${fileManager}`, icon: FolderSearch, onSelect: () => attempt(revealItemInDir(entry.path)) },
      "separator",
      {
        label: uploadLabel(targets.length),
        icon: Upload,
        onSelect: () => onUpload(targets.map((t) => t.path)),
        disabled: uploadBlocker !== null,
      },
      "separator",
      { label: "Copy path", icon: Copy, onSelect: () => attempt(writeText(entry.path)) },
      // Drives themselves can't be deleted.
      ...(!atDrives
        ? ([
            "separator",
            {
              label: targets.length === 1 ? "Delete" : `Delete ${targets.length} items`,
              icon: Trash2,
              onSelect: () => setToDelete(targets),
              danger: true,
            },
            "separator",
            { label: "Properties", icon: Info, onSelect: () => setPropsFor(targets) },
          ] as MenuItem[])
        : []),
    ];
  };

  const paneMenu = (event: MouseEvent) =>
    openMenu(event, [
      {
        label: chosen.length ? uploadLabel(chosen.length) : "Upload",
        icon: Upload,
        onSelect: () => onUpload(chosen.map((c) => c.path)),
        disabled: !chosen.length || uploadBlocker !== null,
      },
      "separator",
      { label: "Refresh", icon: RefreshCw, onSelect: refresh },
      { label: "Parent folder", icon: ArrowUp, onSelect: () => up !== null && open(up), disabled: up === null },
      { label: "Home", icon: House, onSelect: () => void api.localHome().then(open) },
      ...(path && !atDrives ? [{ label: `Open in ${fileManager}`, icon: FolderSearch, onSelect: () => attempt(openPath(path)) }] : []),
      "separator",
      { label: "Copy path", icon: Copy, onSelect: () => path && attempt(writeText(path)), disabled: !path || atDrives },
    ]);

  const onListKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" && event.altKey && !atDrives && chosen.length) {
      event.preventDefault();
      setPropsFor(chosen);
    } else if (event.key === "Delete" && !atDrives && chosen.length) {
      event.preventDefault();
      setToDelete(chosen);
    } else if (event.key === "Backspace" && up !== null) {
      event.preventDefault();
      open(up);
    } else if (event.key === "a" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      all();
    } else if (event.key === "Escape") {
      clear();
    } else {
      // Type a name's first letters to jump to it.
      const hit = typeAhead.onKey(event, body.current, ".local-row")?.dataset.path;
      if (hit) only(hit);
    }
  };

  const totalSize = chosen.reduce((n, e) => n + e.size, 0);

  return (
    <section className="pane" aria-label="This computer" onContextMenu={paneMenu}>
      <header className="pane-head">
        <span className="pane-title">
          <Laptop size={16} strokeWidth={1.75} />
          <span className="pane-title-text">Local</span>
        </span>
        <span className="pane-tools">
          <button
            type="button"
            className="icon-btn"
            onClick={() => up !== null && open(up)}
            disabled={up === null}
            aria-label="Parent folder"
            data-tip="Parent folder"
          >
            <ArrowUp size={15} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void api.localHome().then(open)}
            aria-label="Home"
            data-tip="Home"
          >
            <House size={15} strokeWidth={1.75} />
          </button>
          <button type="button" className="icon-btn" onClick={refresh} aria-label="Refresh" data-tip="Refresh">
            <RefreshCw ref={refreshSpin.icon} size={15} strokeWidth={1.75} />
          </button>
        </span>
      </header>

      <div className="pane-path">
        {path !== null && <LocalCrumbs path={path} onOpen={open} />}
        {path && <CopyButton text={path} label="Copy path" />}
      </div>

      <div
        ref={body}
        className="pane-body local-body"
        tabIndex={-1}
        onKeyDown={onListKey}
        onPointerDown={(event) => {
          if (!(event.target as Element).closest(".local-row")) beginBox(event, true);
        }}
        data-drop-local={path || undefined}
        data-drop-active={downloadOver !== null && downloadOver === path ? "" : undefined}
      >
        {error ? (
          <p className="pane-message">{error}</p>
        ) : entries === null ? (
          <Loading />
        ) : entries.length === 0 ? (
          <p className="pane-message muted">Empty folder</p>
        ) : (
          <ul className="remote-list" aria-label="Files on this computer" aria-multiselectable="true">
            {entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="remote-row local-row"
                  aria-selected={selected.has(entry.path)}
                  data-path={entry.path}
                  data-fresh={fresh.has(entry.path) ? "" : undefined}
                  data-drop-local={entry.isDir ? entry.path : undefined}
                  data-drop-active={entry.isDir && downloadOver === entry.path ? "" : undefined}
                  onPointerDown={(event) => {
                    // A selected row picks up from anywhere (like Explorer); others by their name or
                    // icon, while the rest of the row starts a selection box.
                    if (selected.has(entry.path) || (event.target as Element).closest(".name-hit, .tree-icon")) {
                      drag?.beginDrag(event, () => targetsFor(entry).map(({ name, path, isDir }) => ({ name, path, isDir })), "upload");
                    } else {
                      beginBox(event, false);
                    }
                  }}
                  onClick={(event) => click(entry.path, event)}
                  onDoubleClick={() => activate(entry)}
                  onKeyDown={(event) => event.key === "Enter" && activate(entry)}
                  onContextMenu={(event) => openMenu(event, rowMenu(entry))}
                >
                  {atDrives ? (
                    <HardDrive size={16} strokeWidth={1.75} className="tree-icon" />
                  ) : entry.isDir ? (
                    <Folder size={16} strokeWidth={1.75} className="tree-icon folder" />
                  ) : (
                    <File size={16} strokeWidth={1.75} className="tree-icon" />
                  )}
                  <span className="tree-name">
                    <span className="name-hit">{entry.name}</span>
                  </span>
                  <span className="remote-meta">
                    {entry.modified ? dateFormat.format(new Date(entry.modified * 1000)) : ""}
                  </span>
                  <span className="remote-size">{entry.isDir ? "" : formatSize(entry.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {box && (
          <div
            className="select-box"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            aria-hidden="true"
          />
        )}
      </div>

      <footer className="pane-foot">
        <span className={chosen.length ? "selection-summary" : "muted"}>
          {chosen.length
            ? `${chosen.length} selected${totalSize ? ` (${formatSize(totalSize)})` : ""}`
            : entries
              ? `${entries.length} ${entries.length === 1 ? "item" : "items"}`
              : ""}
        </span>
      </footer>

      {propsFor && (
        <PropertiesDialog
          items={propsFor}
          load={() => api.localProperties(propsFor.map((i) => i.path))}
          onClose={() => setPropsFor(null)}
        />
      )}
      {toDelete && (
        <DeleteDialog
          place="this computer"
          items={toDelete}
          recycle
          removeOne={(path) => api.trashLocal([path])}
          onClose={() => setToDelete(null)}
          onFailed={() => setReload((n) => n + 1)}
          onDeleted={() => {
            const single = toDelete.length === 1 ? toDelete[0] : null;
            notify(`Moved to ${trashName}: ${single ? single.name : `${toDelete.length} items`}`);
            setToDelete(null);
            clear();
            setReload((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}

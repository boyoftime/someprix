import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ArrowUp,
  Copy,
  Download,
  File,
  FilePen,
  Folder,
  FolderOpen,
  FilePlus,
  FolderPlus,
  Info,
  Plug,
  Plus,
  RefreshCw,
  Server,
  SquareTerminal,
  Target,
  Trash2,
  Unplug,
} from "lucide-react";
import { api, joinRemote, parentRemote, type RemoteEntry } from "../lib/api";
import { errorMessage, useAppData } from "../state/AppData";
import { formatSize } from "../lib/format";
import { useContextMenu, type MenuItem } from "../ui/ContextMenu";
import { Loading } from "../ui/Loading";
import { Lottie } from "../ui/Lottie";
import { HostPicker } from "./HostPicker";
import { CopyButton } from "../ui/CopyButton";
import { useDrag } from "../sftp/drag";
import { useListSelection } from "../ui/useListSelection";
import { useSpin } from "../ui/useSpin";
import { useTypeAhead } from "../ui/useTypeAhead";
import { DeleteDialog } from "./DeleteDialog";
import { PropertiesDialog } from "../ui/PropertiesDialog";
import { useOpenInEditor } from "../editor/EditorProvider";
import { useOpenTerminal } from "../terminal/TerminalProvider";
import { forget, remember, remembered } from "../lib/storage";
import { isTextFile } from "../editor/languages";
import connectingAnimation from "../assets/lottie/connecting.json";

type ServerPaneProps = {
  hostId: string | null;
  onSelectHost: (hostId: string) => void;
  onAddHost: () => void;
  /** Where to open once connected; falls back to the login's home folder. */
  startDir?: string | null;
  /** A folder to mark with a target icon (Sync's destination). */
  markedDir?: string | null;
  /** Extra right-click items for a folder: rows, and the open folder itself. */
  folderMenu?: (path: string) => MenuItem[];
  /** The footer under the listing, given the open folder. */
  footer?: (cwd: string | null) => ReactNode;
  /** Accept drops from the local side, into the open folder or onto a folder row. */
  acceptsDrops?: boolean;
  /** Told whenever the open folder changes. */
  onCwdChange?: (cwd: string | null) => void;
  /** Downloads: names drag onto local folders, and rows get a Download item (to the Downloads folder). */
  download?: { onDownload: (paths: string[]) => void };
  /** Fast mode: deletes run as one server command. */
  fastDelete?: boolean;
  /** Remember the open folder per host under this name, to come back to it after a reconnect or restart. */
  rememberAs?: string;
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function Breadcrumbs({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const parts = path.split("/").filter(Boolean);
  return (
    <nav className="crumbs" aria-label="Server folder">
      <button type="button" onClick={() => onOpen("/")}>
        /
      </button>
      {parts.map((part, i) => {
        const target = `/${parts.slice(0, i + 1).join("/")}`;
        return (
          <span key={target} className="crumb">
            <button type="button" onClick={() => onOpen(target)} aria-current={i === parts.length - 1 ? "location" : undefined}>
              {part}
            </button>
            {i < parts.length - 1 && <span className="crumb-sep">/</span>}
          </span>
        );
      })}
    </nav>
  );
}

export function ServerPane({
  hostId,
  onSelectHost,
  onAddHost,
  startDir = null,
  markedDir = null,
  folderMenu,
  footer,
  acceptsDrops = false,
  onCwdChange,
  download,
  fastDelete = false,
  rememberAs,
}: ServerPaneProps) {
  const { hosts, connected, connecting, reconnecting, connect, disconnect, homes, refreshConnections, notify, lastPush } =
    useAppData();
  const openMenu = useContextMenu();
  const dragApi = useDrag();
  const openInEditor = useOpenInEditor();
  const openTerminal = useOpenTerminal();
  const dragging = dragApi?.drag ?? null;
  const copy = (text: string) => void writeText(text).catch((e) => notify(errorMessage(e), "error"));
  const host = hosts.find((h) => h.id === hostId) ?? null;
  const isConnected = host ? connected.has(host.id) : false;
  const isConnecting = host ? connecting.has(host.id) : false;
  // The connection dropped and is coming back by itself: the folder keeps showing meanwhile.
  const isReconnecting = host ? reconnecting.has(host.id) : false;

  const [cwd, setCwd] = useState<string | null>(null);
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The name box for a new folder or file, open while one is being named.
  const [newItem, setNewItem] = useState<{ kind: "folder" | "file"; name: string; error?: string } | null>(null);
  const [reload, setReload] = useState(0);
  // A listing is on its way (a reload keeps the old one showing meanwhile).
  const [listing, setListing] = useState(false);
  const refreshSpin = useSpin(listing);
  const refresh = () => {
    refreshSpin.spin();
    setReload((n) => n + 1);
  };
  const listRef = useRef<HTMLUListElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const typeAhead = useTypeAhead();
  const order = useCallback(() => (entries ?? []).map((e) => e.path), [entries]);
  const { selected, only, clear, all, click, beginBox, box } = useListSelection(bodyRef, ".remote-row[data-path]", order);
  const chosen = useMemo(() => (entries ?? []).filter((e) => selected.has(e.path)), [entries, selected]);
  // What the delete confirmation is asking about, while it's open.
  const [toDelete, setToDelete] = useState<RemoteEntry[] | null>(null);
  // What the Properties dialog shows, while it's open.
  const [propsFor, setPropsFor] = useState<RemoteEntry[] | null>(null);
  // What the folder held before the latest reload, to tell new entries from updated ones.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const previousPaths = useRef<ReadonlySet<string>>(new Set());

  // Where this pane last was on this host, kept between reconnects and launches.
  const memoryKey = rememberAs && host ? `someprix.${rememberAs}.remote.${host.id}` : null;
  /** Where to open without a remembered folder: the start folder, else the login's home. */
  const fallbackDir = () => (host ? (startDir ?? homes.get(host.id) ?? "/") : "/");
  // The remembered folder being reopened, until its listing arrives (it may have gone since).
  const reopening = useRef<string | null>(null);

  // Which host the listing belongs to, to tell switching hosts from a reconnect.
  const shownHost = useRef<string | null>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(() => {
    const id = host?.id ?? null;
    const sameHost = shownHost.current === id;
    shownHost.current = id;
    if (!host || !isConnected) {
      // Dropped for a moment: keep the folder on screen while the connection comes back.
      if (sameHost && isReconnecting) return;
      setEntries(null);
      clear();
      setToDelete(null);
      setCwd(null);
      return;
    }
    // Back after a drop: the folder that's showing simply reloads.
    if (sameHost && cwdRef.current) return;
    // Connected: carry on in the folder from last time, else the start folder.
    setEntries(null);
    clear();
    setToDelete(null);
    const last = memoryKey ? remembered(memoryKey) : null;
    reopening.current = last;
    setCwd(last ?? fallbackDir());
  }, [host?.id, isConnected, isReconnecting]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onCwdChange?.(cwd);
    if (cwd && memoryKey) remember(memoryKey, cwd);
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!host || !isConnected || !cwd) return;
    let current = true;
    setError(null);
    setListing(true);
    api
      .listRemote(host.id, cwd)
      .then((list) => {
        if (!current) return;
        reopening.current = null;
        previousPaths.current = new Set((entriesRef.current ?? []).map((e) => e.path));
        setEntries(list);
      })
      .catch(async (e) => {
        if (!current) return;
        // The connection dropped: it comes back by itself, and the folder reloads then.
        const alive = await api.connected().then((ids) => ids.includes(host.id), () => false);
        if (!current) return;
        if (!alive) {
          void refreshConnections();
          return;
        }
        // The folder from last time is gone (or can't be opened): start from the usual place.
        if (reopening.current === cwd && cwd !== fallbackDir()) {
          reopening.current = null;
          if (memoryKey) forget(memoryKey);
          setCwd(fallbackDir());
          return;
        }
        setError(errorMessage(e));
      })
      .finally(() => current && setListing(false));
    return () => {
      current = false;
      setListing(false);
    };
    // A finished push or upload changes the server, so the listing reloads after every one.
  }, [host, isConnected, cwd, reload, refreshConnections, lastPush]);

  /** Entries in this folder that the latest push or upload wrote (files, or folders holding them). */
  const fresh = useMemo(() => {
    const written = new Set<string>();
    if (!lastPush || !cwd || Date.now() - lastPush.at > 8000) return written;
    const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
    for (const path of lastPush.paths) {
      if (path.startsWith(prefix)) written.add(prefix + path.slice(prefix.length).split("/")[0]);
    }
    return written;
  }, [lastPush, cwd]);

  // Bring the result into view: the first entry that was created, else the first that was updated.
  useEffect(() => {
    if (!fresh.size || !entries) return;
    const written = entries.filter((e) => fresh.has(e.path));
    const target = written.find((e) => !previousPaths.current.has(e.path)) ?? written[0];
    if (!target) return;
    listRef.current
      ?.querySelector(`[data-path="${CSS.escape(target.path)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [entries, fresh]);

  const openDir = (path: string) => {
    // Opening the folder that's already open (e.g. its breadcrumb) refreshes it.
    if (path === cwd) {
      refresh();
      return;
    }
    setEntries(null);
    clear();
    setCwd(path);
  };

  /** Folders open in the list; text files in the editor. */
  const activate = (entry: RemoteEntry) => {
    if (entry.isDir) openDir(entry.path);
    else if (host && openInEditor && isTextFile(entry.name)) openInEditor({ kind: "remote", hostId: host.id, path: entry.path });
  };

  /** What a right-click acts on: the selection if the row is in it, else just the row. */
  const targetsFor = (entry: RemoteEntry) => {
    if (selected.has(entry.path)) return chosen;
    only(entry.path);
    return [entry];
  };

  const startNew = (kind: "folder" | "file") => setNewItem({ kind, name: "" });

  async function createItem(event: FormEvent) {
    event.preventDefault();
    if (!host || !cwd || !newItem) return;
    const name = newItem.name.trim();
    const problem =
      !name ? "Name required" : name.includes("/") ? "Invalid character: /" : name === "." || name === ".." ? "Invalid name" : null;
    if (problem) {
      setNewItem({ ...newItem, error: problem });
      return;
    }
    const path = joinRemote(cwd, name);
    try {
      if (newItem.kind === "folder") await api.makeRemoteDir(host.id, path);
      else await api.createRemoteFile(host.id, path);
      setNewItem(null);
      only(path);
      setReload((n) => n + 1);
    } catch (e) {
      setNewItem({ ...newItem, error: errorMessage(e) });
    }
  }

  const rowMenu = (entry: RemoteEntry): MenuItem[] => {
    const targets = targetsFor(entry);
    const remove: MenuItem = {
      label: targets.length === 1 ? "Delete" : `Delete ${targets.length} items`,
      icon: Trash2,
      onSelect: () => setToDelete(targets),
      danger: true,
    };
    const properties: MenuItem = { label: "Properties", icon: Info, onSelect: () => setPropsFor(targets) };
    const take: MenuItem[] = download
      ? [
          {
            label: targets.length === 1 ? "Download" : `Download ${targets.length} items`,
            icon: Download,
            onSelect: () => download.onDownload(targets.map((t) => t.path)),
          },
          "separator",
        ]
      : [];
    if (targets.length > 1) {
      return [
        ...take,
        { label: "Copy paths", icon: Copy, onSelect: () => copy(targets.map((t) => t.path).join("\n")) },
        "separator",
        remove,
        "separator",
        properties,
      ];
    }
    return [
      ...(entry.isDir
        ? [{ label: "Open", icon: FolderOpen, onSelect: () => openDir(entry.path) }, ...(folderMenu?.(entry.path) ?? []), "separator" as const]
        : openInEditor && isTextFile(entry.name)
          ? [{ label: "Edit", icon: FilePen, onSelect: () => activate(entry) }, "separator" as const]
          : []),
      ...take,
      { label: "Copy path", icon: Copy, onSelect: () => copy(entry.path) },
      "separator",
      remove,
      "separator",
      properties,
    ];
  };

  const onListKey = (event: KeyboardEvent) => {
    // Typing in the new folder or file name box isn't a command for the list.
    if ((event.target as HTMLElement).closest("input, textarea")) return;
    if (event.key === "Enter" && event.altKey && chosen.length) {
      event.preventDefault();
      setPropsFor(chosen);
    } else if (event.key === "Delete" && chosen.length) {
      event.preventDefault();
      setToDelete(chosen);
    } else if (event.key === "Backspace" && cwd && cwd !== "/") {
      event.preventDefault();
      openDir(parentRemote(cwd));
    } else if (event.key === "a" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      all();
    } else if (event.key === "Escape") {
      clear();
    } else {
      // Type a name's first letters to jump to it.
      const hit = typeAhead.onKey(event, bodyRef.current, ".remote-row")?.dataset.path;
      if (hit) only(hit);
    }
  };

  /** The menu for the pane itself, which depends on where the connection stands. */
  const paneMenu = (event: MouseEvent) => {
    let items: MenuItem[];
    if (!host) {
      items = [{ label: "New host", icon: Plus, onSelect: onAddHost }];
    } else if (!isConnected && !isReconnecting) {
      items = [
        { label: "Connect", icon: Plug, onSelect: () => void connect(host.id), disabled: isConnecting },
        { label: "New host", icon: Plus, onSelect: onAddHost },
      ];
    } else {
      items = [
        { label: "New folder", icon: FolderPlus, onSelect: () => startNew("folder") },
        { label: "New file", icon: FilePlus, onSelect: () => startNew("file") },
        { label: "Refresh", icon: RefreshCw, onSelect: refresh },
        { label: "Parent folder", icon: ArrowUp, onSelect: () => cwd && openDir(parentRemote(cwd)), disabled: !cwd || cwd === "/" },
        "separator",
        ...(cwd ? (folderMenu?.(cwd) ?? []) : []),
        "separator",
        { label: "Copy path", icon: Copy, onSelect: () => cwd && copy(cwd), disabled: !cwd },
        ...(openTerminal ? [{ label: "Open terminal", icon: SquareTerminal, onSelect: () => openTerminal(host.id) }] : []),
        { label: "Disconnect", icon: Unplug, onSelect: () => void disconnect(host.id) },
      ];
    }
    openMenu(event, items);
  };

  const head = (tools?: ReactNode) => (
    <header className="pane-head">
      <span className="pane-title">
        <Server size={16} strokeWidth={1.75} />
        <span className="pane-title-text">Server</span>
      </span>
      {tools}
      {hosts.length > 0 && (
        <HostPicker
          hosts={hosts}
          value={host?.id ?? null}
          connected={connected}
          connecting={connecting}
          onSelect={onSelectHost}
          onAddHost={onAddHost}
        />
      )}
      {isConnected ? (
        <span className="status-dot" aria-label="Connected" data-tip="Connected" />
      ) : isReconnecting ? (
        <span className="status-dot" data-state="reconnecting" aria-label="Reconnecting" data-tip="Reconnecting…" />
      ) : null}
    </header>
  );

  if (hosts.length === 0 || !host) {
    return (
      <section className="pane" aria-label="Server" onContextMenu={paneMenu}>
        {head()}
        <div className="pane-empty">
          <Server size={28} strokeWidth={1.5} />
          <h2>{hosts.length === 0 ? "No hosts" : "No host selected"}</h2>
          {hosts.length === 0 && (
            <button type="button" className="btn btn-primary" onClick={onAddHost}>
              New host
            </button>
          )}
        </div>
      </section>
    );
  }

  if (!isConnected && !isReconnecting) {
    return (
      <section className="pane" aria-label="Server" onContextMenu={paneMenu}>
        {head()}
        {isConnecting ? (
          <div className="pane-empty connecting" role="status">
            <Lottie data={connectingAnimation} size={132} className="connecting-anim" />
            <h2>Connecting to {host.label}…</h2>
            <p className="connecting-address">
              {host.username}@{host.host}
              {host.port !== 22 ? `:${host.port}` : ""}
            </p>
          </div>
        ) : (
          <div className="pane-empty">
            <Plug size={28} strokeWidth={1.5} />
            <h2>{host.label}</h2>
            <p>
              {host.username}@{host.host}
              {host.port !== 22 ? `:${host.port}` : ""}
            </p>
            <button type="button" className="btn btn-primary" onClick={() => void connect(host.id)}>
              Connect
            </button>
          </div>
        )}
      </section>
    );
  }

  // Only an upload can land here.
  const overDir = dragging?.kind === "upload" ? dragging.overDir : null;

  return (
    <section className="pane" aria-label="Server" onContextMenu={paneMenu}>
      {head(
        <span className="pane-tools">
          <button
            type="button"
            className="icon-btn"
            onClick={() => cwd && openDir(parentRemote(cwd))}
            disabled={!cwd || cwd === "/"}
            aria-label="Parent folder"
            data-tip="Parent folder"
          >
            <ArrowUp size={15} strokeWidth={1.75} />
          </button>
          <button type="button" className="icon-btn" onClick={() => startNew("folder")} aria-label="New folder" data-tip="New folder">
            <FolderPlus size={15} strokeWidth={1.75} />
          </button>
          <button type="button" className="icon-btn" onClick={() => startNew("file")} aria-label="New file" data-tip="New file">
            <FilePlus size={15} strokeWidth={1.75} />
          </button>
          <button type="button" className="icon-btn" onClick={refresh} aria-label="Refresh" data-tip="Refresh">
            <RefreshCw ref={refreshSpin.icon} size={15} strokeWidth={1.75} />
          </button>
          {openTerminal && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => openTerminal(host.id)}
              aria-label="SSH Terminal"
              data-tip="SSH Terminal"
            >
              <SquareTerminal size={15} strokeWidth={1.75} />
            </button>
          )}
        </span>,
      )}
      <div className="pane-path">
        {cwd && <Breadcrumbs path={cwd} onOpen={openDir} />}
        {cwd && <CopyButton text={cwd} label="Copy path" />}
      </div>

      <div
        ref={bodyRef}
        className="pane-body server-body"
        data-drag-out={download ? "" : undefined}
        tabIndex={-1}
        onKeyDown={onListKey}
        onPointerDown={(event) => {
          // Empty space starts a selection box (and a plain click there clears the selection).
          if (!(event.target as Element).closest(".remote-row, .new-folder")) beginBox(event, true);
        }}
        data-drop-dir={acceptsDrops && cwd ? cwd : undefined}
        data-drop-active={acceptsDrops && overDir !== null && overDir === cwd ? "" : undefined}
      >
        {newItem !== null && (
          <form className="new-folder" onSubmit={createItem}>
            {newItem.kind === "folder" ? (
              <Folder size={16} strokeWidth={1.75} className="tree-icon folder" />
            ) : (
              <File size={16} strokeWidth={1.75} className="tree-icon" />
            )}
            <input
              key={newItem.kind}
              autoFocus
              value={newItem.name}
              onChange={(e) => setNewItem({ kind: newItem.kind, name: e.target.value })}
              onKeyDown={(e) => e.key === "Escape" && setNewItem(null)}
              onBlur={() => !newItem.name && setNewItem(null)}
              placeholder={newItem.kind === "folder" ? "Folder name" : "File name"}
              aria-label={newItem.kind === "folder" ? "New folder name" : "New file name"}
              aria-invalid={newItem.error ? true : undefined}
              spellCheck={false}
            />
            <button type="submit" className="btn btn-small">
              Create
            </button>
          </form>
        )}
        {newItem?.error && (
          <p className="new-item-error" role="alert">
            {newItem.error}
          </p>
        )}
        {error ? (
          <p className="pane-message">{error}</p>
        ) : entries === null ? (
          <Loading />
        ) : entries.length === 0 && newItem === null ? (
          <p className="pane-message muted">Empty folder</p>
        ) : (
          <ul className="remote-list" aria-label="Server files" aria-multiselectable="true" ref={listRef}>
            {entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="remote-row"
                  aria-selected={selected.has(entry.path)}
                  data-fresh={fresh.has(entry.path) ? "" : undefined}
                  data-path={entry.path}
                  data-drop-dir={acceptsDrops && entry.isDir ? entry.path : undefined}
                  data-drop-active={acceptsDrops && entry.isDir && overDir === entry.path ? "" : undefined}
                  onPointerDown={(event) => {
                    // With downloads on, a selected row picks up from anywhere and others by their
                    // name or icon; elsewhere a press starts a selection box (and with downloads off,
                    // anywhere on the row does).
                    const grab = selected.has(entry.path) || (event.target as Element).closest(".name-hit, .tree-icon");
                    if (download && dragApi && grab) {
                      dragApi.beginDrag(
                        event,
                        () => targetsFor(entry).map(({ name, path, isDir }) => ({ name, path, isDir })),
                        "download",
                      );
                    } else {
                      beginBox(event, false);
                    }
                  }}
                  onClick={(event) => click(entry.path, event)}
                  onDoubleClick={() => activate(entry)}
                  onKeyDown={(e) => e.key === "Enter" && activate(entry)}
                  onContextMenu={(event) => openMenu(event, rowMenu(entry))}
                >
                  {entry.isDir ? (
                    <Folder size={16} strokeWidth={1.75} className="tree-icon folder" />
                  ) : (
                    <File size={16} strokeWidth={1.75} className="tree-icon" />
                  )}
                  <span className="tree-name">
                    <span className="name-hit">{entry.name}</span>
                  </span>
                  {entry.path === markedDir && <Target size={14} strokeWidth={1.75} className="dest-mark" />}
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

      {footer?.(cwd)}

      {propsFor && (
        <PropertiesDialog
          items={propsFor}
          load={() =>
            api.remoteProperties(
              host.id,
              propsFor.map((i) => i.path),
            )
          }
          onClose={() => setPropsFor(null)}
        />
      )}
      {toDelete && (
        <DeleteDialog
          place={host.label}
          items={toDelete}
          removeOne={(path) => api.deleteRemote(host.id, [path])}
          removeAll={fastDelete ? (paths) => api.deleteRemote(host.id, paths, true) : undefined}
          onClose={() => setToDelete(null)}
          onFailed={() => setReload((n) => n + 1)}
          onDeleted={() => {
            const single = toDelete.length === 1 ? toDelete[0] : null;
            notify(single ? `Deleted ${single.name}` : `Deleted ${toDelete.length} items`);
            setToDelete(null);
            clear();
            setReload((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}

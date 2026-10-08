import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  Ban,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  Folder,
  FolderOpen,
  FolderSearch,
  FilePen,
  Info,
  ListTree,
  Undo2,
  Upload,
} from "lucide-react";
import { api, localPath, type Change, type ChangeKind, type LocalEntry } from "../lib/api";
import { errorMessage, useAppData } from "../state/AppData";
import { useContextMenu, type MenuItem } from "../ui/ContextMenu";
import { Loading } from "../ui/Loading";
import { PropertiesDialog } from "../ui/PropertiesDialog";
import { useListSelection } from "../ui/useListSelection";
import { useTypeAhead } from "../ui/useTypeAhead";
import { useOpenInEditor } from "../editor/EditorProvider";
import { isTextFile } from "../editor/languages";
import { fileManager } from "../lib/platform";

type Row = LocalEntry & { deleted?: boolean };
/** A row as it's showing: the entry and its change, if any. */
type Shown = { row: Row; kind: ChangeKind | undefined };

type LocalTreeProps = {
  root: string;
  changes: Change[];
  /** Why pushing isn't possible right now, or null when it is. */
  pushBlocker: string | null;
  /** Push only the changes at or under these project paths. */
  onPushPaths: (paths: string[]) => void;
  /** Paths excluded from pushing (files, or folders with everything inside). */
  excluded: string[];
  /** Excludes paths from pushing, or with `exclude` false includes them again. */
  onExclude: (paths: string[], exclude: boolean) => void;
};

const KIND_LABEL: Record<ChangeKind, string> = {
  added: "New",
  modified: "Changed",
  deleted: "Deleted",
};

const ROW = ".tree-row[data-path]";

/** A folder's dot takes one colour if every change inside it is the same kind, else "modified". */
function summarize(kinds: Set<ChangeKind>): ChangeKind {
  return kinds.size === 1 ? [...kinds][0] : "modified";
}

export function LocalTree({ root, changes, pushBlocker, onPushPaths, excluded, onExclude }: LocalTreeProps) {
  /** The excluded path that covers `path` (itself, or a folder it's in), if any. */
  const excludedBy = (path: string) => excluded.find((ex) => path === ex || path.startsWith(`${ex}/`)) ?? null;
  const { notify } = useAppData();
  const openMenu = useContextMenu();
  const attempt = (action: Promise<unknown>) => void action.catch((e) => notify(errorMessage(e), "error"));
  const openInEditor = useOpenInEditor();
  /** Text opens in the editor; anything else in its own app. */
  const openFile = (row: Row) => {
    const full = localPath(root, row.path);
    if (openInEditor && isTextFile(row.name)) openInEditor({ kind: "local", path: full });
    else attempt(openPath(full));
  };
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [listings, setListings] = useState<ReadonlyMap<string, LocalEntry[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const typeAhead = useTypeAhead();
  // What the Properties dialog shows (full paths), while it's open.
  const [propsFor, setPropsFor] = useState<{ name: string; path: string; isDir: boolean }[] | null>(null);
  /** Properties for rows that still exist (deleted ones are only in the change list). */
  const showProperties = (targets: Shown[]) => {
    const existing = targets.filter((t) => !t.row.deleted && t.kind !== "deleted");
    if (existing.length) {
      setPropsFor(existing.map(({ row }) => ({ name: row.name, path: localPath(root, row.path), isDir: row.isDir })));
    }
  };
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // Rows in the order they're showing (folders open or closed), for Shift+click ranges and Ctrl+A.
  const order = useCallback(
    () => [...(body.current?.querySelectorAll<HTMLElement>(ROW) ?? [])].map((row) => row.dataset.path!),
    [],
  );
  const { selected, only, clear, all, click, beginBox, box } = useListSelection(body, ROW, order);

  const load = useCallback(async (dirs: string[]) => {
    try {
      const results = await Promise.all(dirs.map(async (dir) => [dir, await api.listLocal(dir)] as const));
      setListings((current) => {
        const next = new Map(current);
        for (const [dir, entries] of results) next.set(dir, entries);
        return next;
      });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  // A different project folder starts collapsed, with nothing selected.
  useEffect(() => {
    setExpanded(new Set());
    setListings(new Map());
    clear();
    void load([""]);
  }, [root, load, clear]);

  // Files appear and disappear as the user works: re-read the open folders when changes arrive.
  useEffect(() => {
    const timer = setTimeout(() => void load(["", ...expandedRef.current]), 120);
    return () => clearTimeout(timer);
  }, [changes, load]);

  const fileKinds = useMemo(() => new Map(changes.map((c) => [c.path, c.kind])), [changes]);

  const folderKinds = useMemo(() => {
    const map = new Map<string, Set<ChangeKind>>();
    for (const { path, kind } of changes) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!map.has(dir)) map.set(dir, new Set());
        map.get(dir)!.add(kind);
      }
    }
    return map;
  }, [changes]);

  const deletedPaths = useMemo(() => changes.filter((c) => c.kind === "deleted").map((c) => c.path), [changes]);

  /** The folder's entries plus deleted files (and folders) that only exist in the change list. */
  const rowsFor = (dir: string): Row[] => {
    const listed: Row[] = listings.get(dir) ?? [];
    const names = new Set(listed.map((e) => e.name));
    const prefix = dir ? `${dir}/` : "";
    const ghosts = new Map<string, Row>();
    for (const path of deletedPaths) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const name = rest.split("/")[0];
      if (names.has(name) || ghosts.has(name)) continue;
      ghosts.set(name, { name, path: prefix + name, isDir: rest.includes("/"), deleted: true });
    }
    return [...listed, ...ghosts.values()].sort(
      (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  };

  const toggle = (row: Row) => {
    const open = expanded.has(row.path);
    setExpanded((set) => {
      const next = new Set(set);
      if (open) next.delete(row.path);
      else next.add(row.path);
      return next;
    });
    if (!open && !row.deleted) void load([row.path]);
  };

  // Every row showing in this render, by path, so menus can act on the whole selection.
  const shown = new Map<string, Shown>();

  /** What a right-click acts on: the selection if the row is in it, else just the row. */
  const targetsFor = (row: Row): Shown[] => {
    if (selected.has(row.path)) return [...selected].flatMap((path) => shown.get(path) ?? []);
    only(row.path);
    return [shown.get(row.path)!];
  };

  /** Exclude the chosen items from pushing, or include the ones excluded themselves again. */
  const excludeMenu = (targets: Shown[]): MenuItem[] => {
    const paths = targets.map((t) => t.row.path);
    const free = paths.filter((path) => !excludedBy(path));
    const own = paths.filter((path) => excluded.includes(path));
    const many = targets.length > 1;
    const items: MenuItem[] = [];
    if (free.length) {
      items.push({
        label: many ? `Exclude ${free.length} from push` : "Exclude from push",
        icon: Ban,
        onSelect: () => onExclude(free, true),
      });
    }
    if (own.length) {
      items.push({
        label: many ? `Include ${own.length} in push` : "Include in push",
        icon: Undo2,
        onSelect: () => onExclude(own, false),
      });
    }
    // Inside an excluded folder: it's that folder that has to be included again.
    if (!items.length) {
      items.push({ label: `Excluded with ${excludedBy(paths[0])}`, icon: Ban, onSelect: () => {}, disabled: true });
    }
    return items;
  };

  const manyMenu = (targets: Shown[]): MenuItem[] => {
    const changed = targets.filter((t) => t.kind);
    return [
      {
        label: changed.length ? `Push ${targets.length} items` : "Nothing to push",
        icon: Upload,
        onSelect: () => onPushPaths(changed.map((t) => t.row.path)),
        disabled: !changed.length || pushBlocker !== null,
      },
      ...excludeMenu(targets),
      "separator",
      {
        label: "Copy paths",
        icon: Copy,
        onSelect: () => attempt(writeText(targets.map((t) => localPath(root, t.row.path)).join("\n"))),
      },
      {
        label: "Copy relative paths",
        icon: Copy,
        onSelect: () => attempt(writeText(targets.map((t) => t.row.path).join("\n"))),
      },
      "separator",
      { label: "Properties", icon: Info, onSelect: () => showProperties(targets) },
    ];
  };

  const rowMenu = (row: Row): MenuItem[] => {
    const targets = targetsFor(row);
    if (targets.length > 1) return manyMenu(targets);
    const kind = targets[0]?.kind;
    const full = localPath(root, row.path);
    const gone = Boolean(row.deleted) || kind === "deleted";
    const open: MenuItem[] = row.isDir
      ? [
          {
            label: expanded.has(row.path) ? "Collapse" : "Expand",
            icon: ListTree,
            onSelect: () => toggle(row),
            disabled: row.deleted,
          },
          { label: `Open in ${fileManager}`, icon: FolderSearch, onSelect: () => attempt(openPath(full)), disabled: gone },
        ]
      : [
          ...(isTextFile(row.name) ? [{ label: "Edit", icon: FilePen, onSelect: () => openFile(row), disabled: gone }] : []),
          { label: isTextFile(row.name) ? "Open externally" : "Open", icon: ExternalLink, onSelect: () => attempt(openPath(full)), disabled: gone },
          { label: `Show in ${fileManager}`, icon: FolderSearch, onSelect: () => attempt(revealItemInDir(full)), disabled: gone },
        ];
    const push: MenuItem[] = kind
      ? [
          {
            label: row.isDir ? "Push folder" : kind === "deleted" ? "Push deletion" : "Push file",
            icon: Upload,
            onSelect: () => onPushPaths([row.path]),
            disabled: pushBlocker !== null,
          },
        ]
      : [];
    return [
      ...open,
      "separator",
      ...push,
      ...excludeMenu(targets),
      "separator",
      { label: "Copy path", icon: Copy, onSelect: () => attempt(writeText(full)) },
      { label: "Copy relative path", icon: Copy, onSelect: () => attempt(writeText(row.path)) },
      "separator",
      { label: "Properties", icon: Info, onSelect: () => showProperties(targets), disabled: gone },
    ];
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" && event.altKey && selected.size) {
      event.preventDefault();
      showProperties([...selected].flatMap((path) => shown.get(path) ?? []));
    } else if (event.key === "a" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      all();
    } else if (event.key === "Escape") {
      clear();
    } else {
      // Type a name's first letters to jump to it (among the rows that are showing).
      const hit = typeAhead.onKey(event, body.current, ".tree-row")?.dataset.path;
      if (hit) only(hit);
    }
  };

  const renderRows = (dir: string, depth: number): ReactNode =>
    rowsFor(dir).map((row) => {
      const open = row.isDir && expanded.has(row.path);
      const kind = row.isDir
        ? folderKinds.has(row.path)
          ? summarize(folderKinds.get(row.path)!)
          : undefined
        : fileKinds.get(row.path);
      shown.set(row.path, { row, kind });
      return (
        <li key={row.path} role="none">
          <button
            type="button"
            role="treeitem"
            aria-expanded={row.isDir ? open : undefined}
            aria-selected={selected.has(row.path)}
            className="tree-row"
            data-path={row.path}
            data-deleted={row.deleted || kind === "deleted" ? "" : undefined}
            data-excluded={excludedBy(row.path) ? "" : undefined}
            style={{ paddingLeft: 10 + depth * 16 }}
            // Rows aren't dragged anywhere here, so pressing anywhere on one can start a selection box.
            onPointerDown={(event) => beginBox(event, false)}
            onClick={(event) => {
              const plain = !event.ctrlKey && !event.metaKey && !event.shiftKey;
              // A plain click on a folder also opens or closes it.
              if (click(row.path, event) && plain && row.isDir) toggle(row);
            }}
            onDoubleClick={() => !row.isDir && !row.deleted && kind !== "deleted" && openFile(row)}
            onContextMenu={(event) => openMenu(event, rowMenu(row))}
          >
            <span className="tree-chevron" data-open={open ? "" : undefined}>
              {row.isDir && <ChevronRight size={14} strokeWidth={2} />}
            </span>
            {row.isDir ? (
              open ? (
                <FolderOpen size={16} strokeWidth={1.75} className="tree-icon folder" />
              ) : (
                <Folder size={16} strokeWidth={1.75} className="tree-icon folder" />
              )
            ) : (
              <File size={16} strokeWidth={1.75} className="tree-icon" />
            )}
            <span className="tree-name">{row.name}</span>
            {excluded.includes(row.path) && (
              <span className="excluded-mark" data-tip="Excluded from push">
                <Ban size={13} strokeWidth={2} />
                <span className="sr-only">Excluded from push</span>
              </span>
            )}
            {kind && (
              <span className={`change-dot ${kind}`} data-tip={row.isDir ? "Changes inside" : KIND_LABEL[kind]}>
                <span className="sr-only">{row.isDir ? "Has changes" : KIND_LABEL[kind]}</span>
              </span>
            )}
          </button>
          {open && <ul role="group">{renderRows(row.path, depth + 1)}</ul>}
        </li>
      );
    });

  let content: ReactNode;
  if (error) content = <p className="pane-message">{error}</p>;
  else if (!listings.has("")) content = <Loading />;
  else if (rowsFor("").length === 0) content = <p className="pane-message muted">Empty folder</p>;
  else
    content = (
      <ul className="tree" role="tree" aria-label="Project files" aria-multiselectable="true">
        {renderRows("", 0)}
      </ul>
    );

  return (
    <>
    <div
      ref={body}
      className="pane-body tree-body"
      tabIndex={-1}
      onKeyDown={onKey}
      onPointerDown={(event) => {
        // Empty space starts a selection box (and a plain click there clears the selection).
        if (!(event.target as Element).closest(".tree-row")) beginBox(event, true);
      }}
    >
      {content}
      {box && (
        <div
          className="select-box"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          aria-hidden="true"
        />
      )}
    </div>
    {/* Beside the list, not in it: clicks and keys in the dialog stay out of the list. */}
    {propsFor && (
      <PropertiesDialog items={propsFor} load={() => api.localProperties(propsFor.map((i) => i.path))} onClose={() => setPropsFor(null)} />
    )}
    </>
  );
}

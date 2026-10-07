import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Download, File, Files, Folder, Upload } from "lucide-react";

export type DragItem = { name: string; path: string; isDir: boolean };

/** "upload": local files onto a server folder. "download": server files onto a local folder. */
export type DragKind = "upload" | "download";

type DragState = {
  kind: DragKind;
  items: DragItem[];
  x: number;
  y: number;
  /** The folder under the pointer that this drag can drop into, if any. */
  overDir: string | null;
  /** "app": dragged from one of the panels; "system": dragged in from Windows Explorer. */
  source: "app" | "system";
};

type DragApi = {
  drag: DragState | null;
  /** Call from a row's pointerdown: the drag only starts once the pointer actually moves. */
  beginDrag: (event: ReactPointerEvent, items: () => DragItem[], kind: DragKind) => void;
};

const DragContext = createContext<DragApi | null>(null);

/** The current drag, for drop targets to highlight themselves. Null outside the SFTP page. */
export const useDrag = () => useContext(DragContext);

/** Pointer travel before a press becomes a drag, so clicks stay clicks. */
const THRESHOLD = 5;

/** Server folders are marked data-drop-dir, local folders data-drop-local. */
const TARGET: Record<DragKind, { selector: string; read: (el: HTMLElement) => string | undefined }> = {
  upload: { selector: "[data-drop-dir]", read: (el) => el.dataset.dropDir },
  download: { selector: "[data-drop-local]", read: (el) => el.dataset.dropLocal },
};

/** The folder under a point that a drag of this kind can drop into, if any. */
function dropDirAt(x: number, y: number, kind: DragKind): string | null {
  const target = document.elementFromPoint(x, y)?.closest<HTMLElement>(TARGET[kind].selector);
  return (target && TARGET[kind].read(target)) ?? null;
}

const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function setDragging(kind: DragKind | null) {
  if (kind) document.documentElement.dataset.dragging = kind;
  else delete document.documentElement.dataset.dragging;
}

/**
 * Drag-and-drop between the two panels: local files onto server folders (upload) and server
 * files onto local folders (download). Uses pointer events rather than HTML5 drag and drop, which
 * Tauri's own file-drop handling switches off on Windows; files dragged in from Explorer arrive
 * through Tauri's drag-drop events instead.
 */
export function DragProvider({
  onUpload,
  onDownload,
  children,
}: {
  onUpload: (sources: string[], remoteDir: string) => void;
  onDownload: (sources: string[], localDir: string) => void;
  children: ReactNode;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const handlers = useRef({ onUpload, onDownload });
  handlers.current = { onUpload, onDownload };

  const beginDrag = useCallback<DragApi["beginDrag"]>((event, getItems, kind) => {
    if (event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY };
    let items: DragItem[] | null = null;

    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", stop);
      setDragging(null);
      setDrag(null);
    };
    const move = (e: PointerEvent) => {
      if (!items) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < THRESHOLD) return;
        items = getItems();
        if (!items.length) return stop();
        setDragging(kind);
      }
      setDrag({ kind, items, x: e.clientX, y: e.clientY, overDir: dropDirAt(e.clientX, e.clientY, kind), source: "app" });
    };
    const up = (e: PointerEvent) => {
      const dir = items ? dropDirAt(e.clientX, e.clientY, kind) : null;
      const dropped = items;
      stop();
      if (!dropped || !dir) return;
      const sources = dropped.map((i) => i.path);
      if (kind === "upload") handlers.current.onUpload(sources, dir);
      else handlers.current.onDownload(sources, dir);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", stop);
  }, []);

  // Files dragged in from Windows Explorer can only go up to the server.
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") {
        setDragging(null);
        setDrag(null);
        return;
      }
      const scale = window.devicePixelRatio || 1;
      const x = payload.position.x / scale;
      const y = payload.position.y / scale;
      const overDir = dropDirAt(x, y, "upload");
      if (payload.type === "enter") {
        setDragging("upload");
        const items = payload.paths.map((path) => ({ path, name: lastSegment(path), isDir: false }));
        setDrag({ kind: "upload", items, x, y, overDir, source: "system" });
      } else if (payload.type === "over") {
        setDrag((current) => current && { ...current, x, y, overDir });
      } else if (payload.type === "drop") {
        setDragging(null);
        setDrag(null);
        if (overDir && payload.paths.length) handlers.current.onUpload(payload.paths, overDir);
      }
    });
    return () => void unlisten.then((stop) => stop());
  }, []);

  return (
    <DragContext.Provider value={{ drag, beginDrag }}>
      {children}
      {drag?.source === "app" && <DragGhost drag={drag} />}
    </DragContext.Provider>
  );
}

/** The small label that follows the pointer while dragging from one of the panels. */
function DragGhost({ drag }: { drag: DragState }) {
  const single = drag.items.length === 1 ? drag.items[0] : null;
  const Icon = single ? (single.isDir ? Folder : File) : Files;
  const Direction = drag.kind === "upload" ? Upload : Download;
  return (
    <div
      className="drag-ghost"
      data-over={drag.overDir ? "" : undefined}
      style={{ left: drag.x + 14, top: drag.y + 14 }}
      aria-hidden="true"
    >
      <Icon size={15} strokeWidth={1.75} />
      <span className="drag-ghost-name">{single ? single.name : `${drag.items.length} items`}</span>
      {drag.overDir && (
        <span className="drag-ghost-target">
          <Direction size={13} strokeWidth={2} />
          {lastSegment(drag.overDir) || "/"}
        </span>
      )}
    </div>
  );
}

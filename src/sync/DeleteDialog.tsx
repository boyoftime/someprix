import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, File, Folder, TriangleAlert, Zap } from "lucide-react";
import { errorMessage } from "../state/AppData";
import { Dialog } from "../ui/Dialog";

type DeleteDialogProps = {
  /** Where the items live: a server's name, or "this computer". */
  place: string;
  items: { name: string; path: string; isDir: boolean }[];
  /** They go to the Recycle Bin (and can be restored) rather than being deleted for good. */
  recycle?: boolean;
  /** Deletes one item. */
  removeOne: (path: string) => Promise<unknown>;
  /** Fast mode: deletes all of them at once instead. */
  removeAll?: (paths: string[]) => Promise<unknown>;
  onClose: () => void;
  /** Called once everything is gone. */
  onDeleted: () => void;
  /** Called when deleting stopped partway; some items may already be gone. */
  onFailed: () => void;
};

/** Confirms deleting files and folders, then deletes them one by one, showing each as it goes. */
export function DeleteDialog({
  place,
  items,
  recycle = false,
  removeOne,
  removeAll,
  onClose,
  onDeleted,
  onFailed,
}: DeleteDialogProps) {
  const [deleting, setDeleting] = useState(false);
  // How many are gone so far; the next one is the one being deleted.
  const [done, setDone] = useState(0);
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const single = items.length === 1 ? items[0] : null;
  const folders = items.filter((i) => i.isDir).length;
  const what = single ? (single.isDir ? "folder" : "file") : `${items.length} items`;

  // Keep the item being deleted in view.
  useEffect(() => {
    if (deleting) list.current?.children[done]?.scrollIntoView({ block: "nearest" });
  }, [deleting, done]);

  async function run() {
    setDeleting(true);
    setError(null);
    setFailedAt(null);
    if (removeAll) {
      try {
        await removeAll(items.slice(done).map((i) => i.path));
        setDone(items.length);
        onDeleted();
      } catch (e) {
        setError(errorMessage(e));
        setDeleting(false);
        onFailed();
      }
      return;
    }
    // Already-deleted items from an earlier attempt are skipped.
    for (let i = done; i < items.length; i++) {
      try {
        await removeOne(items[i].path);
        setDone(i + 1);
      } catch (e) {
        setError(errorMessage(e));
        setFailedAt(i);
        setDeleting(false);
        onFailed();
        return;
      }
    }
    onDeleted();
  }

  const label = !deleting
    ? `Delete ${single || done === 0 ? what : `${items.length - done} more`}`
    : single
      ? "Deleting…"
      : removeAll
        ? `Deleting ${items.length - done}…`
        : `Deleting ${Math.min(done + 1, items.length)}/${items.length}`;

  return (
    <Dialog
      title={`Delete ${what}?`}
      onClose={onClose}
      locked={deleting}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={deleting}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void run()} disabled={deleting} aria-busy={deleting}>
            {deleting && <span className="btn-spinner" aria-hidden="true" />}
            {label}
          </button>
        </>
      }
    >
      <p className="dialog-text">
        {recycle ? "Moves to Recycle Bin" : `Host: ${place}`}
        {folders ? ", including folder contents" : ""}
      </p>
      {removeAll && (
        <p className="fast-note">
          <Zap size={14} strokeWidth={2} />
          Fast mode (one server command)
        </p>
      )}
      <ul className="delete-list" aria-label="To be deleted" ref={list}>
        {items.map((item, i) => {
          // In fast mode everything left goes at once, so every remaining row is in progress.
          const current = deleting && (removeAll ? i >= done : i === done);
          const state = i < done ? "done" : i === failedAt ? "failed" : current ? "current" : "waiting";
          return (
            <li key={item.path} data-state={state}>
              {item.isDir ? (
                <Folder size={15} strokeWidth={1.75} className="tree-icon folder" />
              ) : (
                <File size={15} strokeWidth={1.75} className="tree-icon" />
              )}
              <span className="mono">{item.path}</span>
              <span className="delete-state">
                {state === "done" ? (
                  <Check size={15} strokeWidth={2.25} aria-label="Deleted" />
                ) : state === "current" ? (
                  <span className="spinner" aria-label="Deleting" />
                ) : state === "failed" ? (
                  <CircleAlert size={15} strokeWidth={2} aria-label="Failed" />
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {(error || !recycle) && (
        <div className="callout callout-danger">
          <TriangleAlert size={18} strokeWidth={1.75} />
          <p>{error ?? "Permanent. Can't be undone."}</p>
        </div>
      )}
    </Dialog>
  );
}

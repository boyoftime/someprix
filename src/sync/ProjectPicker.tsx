import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Folder, FolderOpen, X } from "lucide-react";
import { api, type ProjectPair } from "../lib/api";
import { errorMessage, useAppData } from "../state/AppData";
import { sameLocal } from "../lib/pairs";

type ProjectPickerProps = {
  /** The open project's folder and name. */
  root: string;
  name: string;
  disabled?: boolean;
  /** The server showing: each project shows its folder there. */
  serverId: string | null;
  /** Opens another known project. */
  onOpen: (root: string) => void;
  /** Picks a folder not on the list. */
  onBrowse: () => void;
};

/**
 * The project switcher in the Local pane's header: every project folder opened before, each with
 * the server folder it pushes to, so switching brings both sides along.
 */
export function ProjectPicker({ root, name, disabled = false, serverId, onOpen, onBrowse }: ProjectPickerProps) {
  const { hosts, notify } = useAppData();
  const [open, setOpen] = useState(false);
  const [pairs, setPairs] = useState<ProjectPair[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const options = () => [...(box.current?.querySelectorAll<HTMLButtonElement>(".picker-item:not(:disabled)") ?? [])];

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  // The list is read each time it opens (destinations change on the other pages).
  useEffect(() => {
    if (!open) return;
    let current = true;
    api.projectPairs().then(
      (list) => current && setPairs(list),
      (e) => current && notify(errorMessage(e), "error"),
    );
    return () => {
      current = false;
    };
  }, [open, notify]);

  useEffect(() => {
    if (!open || !pairs) return;
    (box.current?.querySelector<HTMLButtonElement>('.picker-item[aria-selected="true"]') ?? options()[0])?.focus();
  }, [open, pairs]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onBlur = () => setOpen(false);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !box.current?.contains(document.activeElement)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    const list = options();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => list[(to + list.length) % list.length]?.focus();
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") close();
    else if (event.key === "Tab") close(false);
    else return;
    event.preventDefault();
  };

  const choose = (action: () => void) => {
    close();
    action();
  };

  const forget = async (pair: ProjectPair) => {
    try {
      await api.forgetProject(pair.root);
      setPairs((list) => list?.filter((p) => p.root !== pair.root) ?? null);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  /** Where the project goes on the server showing, in a line (a long folder keeps its end in view). */
  const serverLine = (pair: ProjectPair) => {
    if (!pair.exists) return "Folder not found on this computer";
    const host = hosts.find((h) => h.id === (serverId ?? pair.hostId));
    const dir = host ? pair.destinations[host.id] : undefined;
    if (!host) return "No server folder yet";
    if (!dir) return `No folder on ${host.label} yet`;
    return (
      <>
        <span className="picker-host">{host.label}</span>
        <span className="path-tail">
          <bdi>{dir}</bdi>
        </span>
      </>
    );
  };

  return (
    <div className="picker project-picker" ref={box} onKeyDown={open ? onKeyDown : undefined}>
      <button
        ref={trigger}
        type="button"
        className="chip project-chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        data-tip={open ? undefined : `Switch project (${name})`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <FolderOpen size={15} strokeWidth={1.75} />
        <span className="chip-label">{name}</span>
        <ChevronDown size={14} strokeWidth={2} className="picker-chevron" />
      </button>

      {open && (
        <div className="picker-pop project-pop" role="listbox" aria-label="Projects">
          {/* First, so it's there without scrolling past a long list. */}
          <button
            type="button"
            className="picker-item picker-action"
            onClick={() => choose(onBrowse)}
            onMouseEnter={(event) => event.currentTarget.focus()}
          >
            <span className="picker-icon">
              <FolderOpen size={16} strokeWidth={1.75} />
            </span>
            <span className="picker-name">Open folder…</span>
          </button>
          <div className="ctx-sep" role="separator" />
          {pairs === null ? (
            <p className="picker-note">Loading…</p>
          ) : (
            // Folders that are gone go last.
            [...pairs.filter((p) => p.exists), ...pairs.filter((p) => !p.exists)].map((pair) => {
              const selected = sameLocal(pair.root, root);
              const paired = pair.exists && Boolean(pair.destinations[serverId ?? pair.hostId ?? ""]);
              return (
                <div key={pair.root} className="picker-row">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className="picker-item"
                    disabled={!pair.exists}
                    // The full path for a resting pointer only (focus lands here as the list
                    // opens, and a tip then would cover it).
                    data-tip={pair.root}
                    data-tip-on="hover"
                    onClick={() => choose(() => !selected && onOpen(pair.root))}
                    onMouseEnter={(event) => event.currentTarget.focus()}
                  >
                    <span className="picker-icon">
                      <Folder size={16} strokeWidth={1.75} />
                    </span>
                    <span className="picker-text">
                      <span className="picker-name">{pair.name}</span>
                      <span className="picker-sub" data-paired={paired ? "" : undefined}>
                        {serverLine(pair)}
                      </span>
                    </span>
                    <span className="picker-check">{selected && <Check size={16} strokeWidth={2} />}</span>
                  </button>
                  {!selected && (
                    <button
                      type="button"
                      className="icon-btn picker-remove"
                      aria-label={`Remove ${pair.name} from the list`}
                      data-tip="Remove from the list (the folder stays)"
                      onClick={() => void forget(pair)}
                    >
                      <X size={14} strokeWidth={2} />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

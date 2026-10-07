import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ClipboardPaste, Copy, Scissors, TextSelect, type LucideIcon } from "lucide-react";

export type MenuItem =
  | {
      label: string;
      icon?: LucideIcon;
      shortcut?: string;
      onSelect: () => void;
      disabled?: boolean;
      danger?: boolean;
    }
  | "separator";

type OpenMenu = (
  event: { clientX: number; clientY: number; target?: EventTarget | null; preventDefault: () => void; nativeEvent?: Event },
  items: MenuItem[],
) => void;

const ContextMenuContext = createContext<OpenMenu | null>(null);

/** Opens Someprix's own right-click menu; call it from an `onContextMenu` handler. */
export function useContextMenu() {
  const open = useContext(ContextMenuContext);
  if (!open) throw new Error("useContextMenu must be used inside ContextMenuProvider");
  return open;
}

type TextField = HTMLInputElement | HTMLTextAreaElement;

function editableField(target: EventTarget | null): TextField | null {
  if (target instanceof HTMLTextAreaElement) return target.disabled ? null : target;
  if (!(target instanceof HTMLInputElement) || target.disabled) return null;
  return ["text", "password", "search", "url", "email", "tel", "number", ""].includes(target.type) ? target : null;
}

/** Cut / Copy / Paste / Select all for a text field, acting on the selection it had when right-clicked. */
function textFieldItems(field: TextField): MenuItem[] {
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? 0;
  const hasSelection = end > start;
  const secret = field instanceof HTMLInputElement && field.type === "password";
  const readOnly = field.readOnly;
  const restore = () => {
    field.focus();
    field.setSelectionRange(start, end);
  };
  return [
    {
      label: "Cut",
      icon: Scissors,
      shortcut: "Ctrl+X",
      disabled: !hasSelection || secret || readOnly,
      onSelect: () => {
        restore();
        document.execCommand("cut");
      },
    },
    {
      label: "Copy",
      icon: Copy,
      shortcut: "Ctrl+C",
      disabled: !hasSelection || secret,
      onSelect: () => {
        restore();
        document.execCommand("copy");
      },
    },
    {
      label: "Paste",
      icon: ClipboardPaste,
      shortcut: "Ctrl+V",
      disabled: readOnly,
      onSelect: () => {
        void readText()
          .then((text) => {
            restore();
            // insertText goes through the field's normal input path, so React and undo both see it.
            document.execCommand("insertText", false, text);
          })
          .catch(() => restore());
      },
    },
    "separator",
    {
      label: "Select all",
      icon: TextSelect,
      shortcut: "Ctrl+A",
      disabled: field.value.length === 0,
      onSelect: () => {
        field.focus();
        field.select();
      },
    },
  ];
}

/** What a right-click gets when no part of the app asked for its own menu. */
function fallbackItems(event: MouseEvent): MenuItem[] {
  const field = editableField(event.target);
  if (field) return textFieldItems(field);
  const selected = window.getSelection()?.toString() ?? "";
  if (selected.trim()) {
    return [{ label: "Copy", icon: Copy, shortcut: "Ctrl+C", onSelect: () => void writeText(selected) }];
  }
  return [];
}

type MenuState = { x: number; y: number; items: MenuItem[] };

/** Drops separators at the ends and doubled ones left behind by conditional items. */
function tidy(items: MenuItem[]) {
  const out: MenuItem[] = [];
  for (const item of items) {
    if (item === "separator" && (out.length === 0 || out[out.length - 1] === "separator")) continue;
    out.push(item);
  }
  while (out[out.length - 1] === "separator") out.pop();
  return out;
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  // The native event a component already answered, so the window listener leaves it alone.
  const handled = useRef<Event | null>(null);

  const open = useCallback<OpenMenu>((event, items) => {
    event.preventDefault();
    // The innermost element answers; its ancestors' menus (e.g. a pane behind a row) stand down.
    if (event.nativeEvent && handled.current === event.nativeEvent) return;
    handled.current = event.nativeEvent ?? null;
    // Text boxes always get editing commands, whatever surrounds them.
    const field = editableField(event.target ?? null);
    const visible = field ? textFieldItems(field) : tidy(items);
    setMenu(visible.length ? { x: event.clientX, y: event.clientY, items: visible } : null);
  }, []);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      // Developer escape hatch: Shift + right-click still opens the browser menu (Inspect) in dev builds.
      if (import.meta.env.DEV && event.shiftKey) return;
      event.preventDefault();
      if (handled.current === event) return;
      const items = fallbackItems(event);
      setMenu(items.length ? { x: event.clientX, y: event.clientY, items } : null);
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  return (
    <ContextMenuContext.Provider value={open}>
      {children}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </ContextMenuContext.Provider>
  );
}

type Actionable = Exclude<MenuItem, "separator">;

function Menu({ x, y, items, onClose }: MenuState & { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // Keep the menu inside the visible window frame, opening up or left near the edges.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const frame = el.closest(".app")?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
    const { width, height } = el.getBoundingClientRect();
    const margin = 6;
    const left = x + width > frame.right - margin ? Math.max(frame.left + margin, x - width) : x;
    const top = y + height > frame.bottom - margin ? Math.max(frame.top + margin, y - height) : y;
    setPlace({ left, top });
  }, [x, y]);

  const buttons = () => [...(panel.current?.querySelectorAll<HTMLButtonElement>(".ctx-item:not(:disabled)") ?? [])];

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const close = () => onClose();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close);
      if (previous && document.contains(previous) && document.activeElement === document.body) previous.focus();
    };
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent) => {
    const list = buttons();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => list[(to + list.length) % list.length]?.focus();
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index < 0 ? list.length - 1 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape" || event.key === "Tab") onClose();
    else return;
    event.preventDefault();
  };

  const choose = (item: Actionable) => {
    onClose();
    item.onSelect();
  };

  return (
    <div
      ref={panel}
      className="ctx-menu"
      role="menu"
      tabIndex={-1}
      // Transparent (not hidden) while measuring, so it can take keyboard focus straight away.
      style={{ left: place?.left ?? x, top: place?.top ?? y, opacity: place ? undefined : 0 }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={`sep-${i}`} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className="ctx-item"
            data-danger={item.danger ? "" : undefined}
            disabled={item.disabled}
            onClick={() => choose(item)}
            onMouseEnter={(event) => event.currentTarget.focus()}
          >
            <span className="ctx-icon">{item.icon && <item.icon size={15} strokeWidth={1.75} />}</span>
            <span className="ctx-label">{item.label}</span>
            {item.shortcut && <kbd className="ctx-shortcut">{item.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

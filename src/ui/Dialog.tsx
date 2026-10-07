import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

type DialogProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Keeps Escape and the backdrop from closing it, e.g. while a push is running. */
  locked?: boolean;
  width?: number;
};

export function Dialog({ title, onClose, children, footer, locked = false, width = 460 }: DialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Start typing in the first text field; dialogs without one take focus themselves.
    const first = panel.current?.querySelector<HTMLElement>("input:not([type=checkbox]):not([type=radio]), select, textarea");
    (first ?? panel.current)?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [locked, onClose]);

  return (
    <div
      className="dialog-backdrop"
      // Keep the menus of whatever is behind the dialog from answering right-clicks inside it.
      onContextMenu={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !locked) onClose();
      }}
    >
      <div
        ref={panel}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ width }}
        tabIndex={-1}
      >
        <header className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn dialog-close" onClick={onClose} disabled={locked} aria-label="Close">
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}

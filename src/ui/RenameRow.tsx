import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { errorMessage } from "../state/AppData";

/**
 * A file or folder's row while it's being renamed: its name in a box, the part before the
 * extension selected (so typing keeps ".py"). Enter renames, Escape cancels, clicking away keeps
 * the new name. A name that won't do (taken, say) is shown and the box stays.
 */
export function RenameRow({
  name,
  isDir,
  icon,
  onRename,
  onCancel,
  className = "remote-row",
  style,
}: {
  name: string;
  isDir: boolean;
  icon: ReactNode;
  /** Renames it; a failure's message shows beside the box. */
  onRename: (name: string) => Promise<void>;
  onCancel: () => void;
  /** The row style it takes the place of (a list's, or a tree's, with its indent). */
  className?: string;
  style?: CSSProperties;
}) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Finished (renamed or cancelled): a blur on the way out mustn't rename again.
  const over = useRef(false);

  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.focus();
    const dot = isDir ? -1 : name.lastIndexOf(".");
    box.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = () => {
    over.current = true;
    onCancel();
  };

  const commit = async () => {
    if (saving || over.current) return;
    const next = value.trim();
    if (next === name) return cancel();
    setSaving(true);
    setError(null);
    try {
      await onRename(next);
      over.current = true;
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  };

  return (
    <form
      className={`${className} rename-row`}
      style={style}
      onSubmit={(event) => {
        event.preventDefault();
        void commit();
      }}
      // The list's own presses (selection boxes, drags) stay out of it.
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {icon}
      <input
        ref={input}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        }}
        // Clicking away keeps the new name; after a refusal, it leaves the old one.
        onBlur={() => (error ? cancel() : void commit())}
        aria-label={`New name for ${name}`}
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        disabled={saving}
      />
      {error && (
        <span className="rename-error" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

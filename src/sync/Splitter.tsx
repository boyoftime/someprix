import { useCallback, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

/** Neither pane gets narrower than this while dragging. */
export const MIN_PANE = 280;

/** The width a row of items needs on one line: each item (bar the stretchy spacer), the gaps
 *  between them, and the padding. Items must not shrink for this to be their real size. */
export function rowWidth(row: HTMLElement) {
  const style = getComputedStyle(row);
  const gap = parseFloat(style.columnGap) || 0;
  const items = [...row.children] as HTMLElement[];
  // Margins count too (the excluded count sits a little apart from the change counts).
  const widths = items
    .filter((item) => !item.classList.contains("spacer"))
    .reduce((sum, item) => {
      const margins = getComputedStyle(item);
      return sum + item.getBoundingClientRect().width + (parseFloat(margins.marginLeft) || 0) + (parseFloat(margins.marginRight) || 0);
    }, 0);
  return Math.ceil(widths + gap * Math.max(0, items.length - 1) + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0));
}

function savedSplit(key: string) {
  try {
    const value = Number(localStorage.getItem(key));
    if (value > 0 && value < 1) return value;
  } catch {
    // Storage unavailable: start even.
  }
  return 0.5;
}

/** The left pane's share of the width, remembered between launches (per page, by `key`). */
export function useSplit(key = "someprix.split") {
  const [split, setSplitState] = useState(() => savedSplit(key));
  const setSplit = useCallback((value: number) => {
    setSplitState(value);
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // Not remembered; it still applies for now.
    }
  }, [key]);
  return [split, setSplit] as const;
}

type SplitterProps = {
  /** The element whose width is being divided. */
  container: RefObject<HTMLElement | null>;
  split: number;
  onChange: (split: number) => void;
  /** The left pane needs at least this many pixels (its footer, say); the divider stops there. */
  minLeft?: number;
};

export function Splitter({ container, split, onChange, minLeft = 0 }: SplitterProps) {
  const [dragging, setDragging] = useState(false);

  const clamp = (value: number) => {
    const width = container.current?.getBoundingClientRect().width ?? 0;
    if (!width) return value;
    const right = Math.min(MIN_PANE, width / 2);
    // The right pane keeps its minimum even when the left would like more.
    const left = Math.min(Math.max(MIN_PANE, minLeft), width - right);
    return Math.min(1 - right / width, Math.max(left / width, value));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !container.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const box = container.current.getBoundingClientRect();
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    document.documentElement.dataset.resizing = "";

    const move = (e: globalThis.PointerEvent) => onChange(clamp((e.clientX - box.left) / box.width));
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("lostpointercapture", end);
      delete document.documentElement.dataset.resizing;
      setDragging(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("lostpointercapture", end);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const next =
      event.key === "ArrowLeft"
        ? split - step
        : event.key === "ArrowRight"
          ? split + step
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? 1
              : null;
    if (next === null) return;
    event.preventDefault();
    onChange(clamp(next));
  };

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panes"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(split * 100)}
      tabIndex={0}
      data-tip="Resize (double-click: reset)"
      data-dragging={dragging ? "" : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onChange(clamp(0.5))}
      onKeyDown={onKeyDown}
    />
  );
}

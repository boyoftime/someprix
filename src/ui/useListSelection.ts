import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** Pointer travel before a press becomes a selection box. */
const BOX_THRESHOLD = 4;
/** How close to the top or bottom edge the box has to get before the list scrolls. */
const SCROLL_EDGE = 28;

export type SelectionBox = { left: number; top: number; width: number; height: number };

type Modifiers = { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean };

/**
 * Explorer-style selection for a file list: click, Ctrl+click (toggle), Shift+click (range), and
 * a selection box drawn by pressing and dragging. Rows are the elements matching `rowSelector`
 * inside `body`, identified by their `data-path`; `order` gives the list order for ranges.
 */
export function useListSelection(body: RefObject<HTMLElement | null>, rowSelector: string, order: () => string[]) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [box, setBox] = useState<SelectionBox | null>(null);
  const anchor = useRef<string | null>(null);
  // After a selection box, the click that ends it mustn't also select the row under the pointer.
  const swallowClick = useRef(false);

  const only = useCallback((path: string) => {
    setSelected(new Set([path]));
    anchor.current = path;
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
    anchor.current = null;
  }, []);

  const all = useCallback(() => setSelected(new Set(order())), [order]);

  /** A click on a row, with Explorer's modifier keys. False when the click only ended a selection box. */
  const click = (path: string, mods: Modifiers): boolean => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return false;
    }
    if (mods.shiftKey && anchor.current) {
      const list = order();
      const from = list.indexOf(anchor.current);
      const to = list.indexOf(path);
      if (from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        setSelected(new Set(list.slice(a, b + 1)));
        return true;
      }
    }
    if (mods.ctrlKey || mods.metaKey) {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    } else {
      setSelected(new Set([path]));
    }
    anchor.current = path;
    return true;
  };

  /**
   * Starts a selection box from a press; it only appears once the pointer moves. Everything the
   * box touches is selected (Ctrl adds to the selection). A plain click on empty space clears it.
   */
  const beginBox = (event: ReactPointerEvent, onEmptySpace: boolean) => {
    const el = body.current;
    if (!el || event.button !== 0) return;
    swallowClick.current = false;
    const additive = event.ctrlKey || event.metaKey;
    const base = additive ? new Set(selected) : new Set<string>();
    if (onEmptySpace) el.focus({ preventScroll: true });
    const startClient = { x: event.clientX, y: event.clientY };
    const toContent = (x: number, y: number) => {
      const r = el.getBoundingClientRect();
      return { x: x - r.left + el.scrollLeft, y: y - r.top + el.scrollTop };
    };
    const start = toContent(event.clientX, event.clientY);
    let pointer = startClient;
    let active = false;

    const update = () => {
      const r = el.getBoundingClientRect();
      if (pointer.y < r.top + SCROLL_EDGE) el.scrollTop -= 14;
      else if (pointer.y > r.bottom - SCROLL_EDGE) el.scrollTop += 14;
      const now = toContent(pointer.x, pointer.y);
      const next: SelectionBox = {
        left: Math.min(start.x, now.x),
        top: Math.min(start.y, now.y),
        width: Math.abs(now.x - start.x),
        height: Math.abs(now.y - start.y),
      };
      setBox(next);
      const hits = new Set(base);
      for (const row of el.querySelectorAll<HTMLElement>(rowSelector)) {
        const rr = row.getBoundingClientRect();
        const top = rr.top - r.top + el.scrollTop;
        const left = rr.left - r.left + el.scrollLeft;
        const touches =
          top < next.top + next.height && top + rr.height > next.top && left < next.left + next.width && left + rr.width > next.left;
        if (touches && row.dataset.path) hits.add(row.dataset.path);
      }
      setSelected(hits);
    };
    const move = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      if (!active) {
        if (Math.hypot(e.clientX - startClient.x, e.clientY - startClient.y) < BOX_THRESHOLD) return;
        active = true;
        document.documentElement.dataset.selecting = "";
      }
      update();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      delete document.documentElement.dataset.selecting;
      setBox(null);
      if (active) {
        // The click (if any) arrives straight after this; anything later is a fresh click.
        swallowClick.current = true;
        setTimeout(() => (swallowClick.current = false), 0);
      } else if (onEmptySpace && !additive) clear();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return { selected, setSelected, only, clear, all, click, beginBox, box, anchor };
}

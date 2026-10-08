import { useLayoutEffect, useRef } from "react";

/** One step of a path: what it shows, where it opens, and the separator drawn before it. */
export type Crumb = { label: string; path: string; sep?: string };

type CrumbsProps = {
  items: Crumb[];
  /** The whole path, shown on hover. */
  fullPath: string;
  label: string;
  onOpen: (path: string) => void;
};

/**
 * A clickable path. When it's too long for the row, the end (the folder you're in) stays in
 * view and the start fades out; hovering shows the whole path, and the wheel scrolls back to
 * the start.
 */
export function Crumbs({ items, fullPath, label, onOpen }: CrumbsProps) {
  const box = useRef<HTMLElement>(null);

  // Whether the start is scrolled out of view, for the fade.
  const markCut = (el: HTMLElement) => {
    if (el.scrollLeft > 0) el.dataset.cut = "";
    else delete el.dataset.cut;
  };

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const showEnd = () => {
      el.scrollLeft = el.scrollWidth;
      markCut(el);
    };
    showEnd();
    const resized = new ResizeObserver(showEnd);
    resized.observe(el);
    return () => resized.disconnect();
  }, [fullPath]);

  return (
    <nav
      ref={box}
      className="crumbs"
      aria-label={label}
      data-tip={fullPath}
      onScroll={(event) => markCut(event.currentTarget)}
      onWheel={(event) => {
        const delta = event.deltaX || event.deltaY;
        if (delta) event.currentTarget.scrollLeft += delta;
      }}
    >
      {items.map((item, i) => (
        <span key={item.path} className="crumb">
          {item.sep && <span className="crumb-sep">{item.sep}</span>}
          <button
            type="button"
            onClick={() => onOpen(item.path)}
            aria-current={i === items.length - 1 ? "location" : undefined}
          >
            {item.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

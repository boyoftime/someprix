import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * A block whose height eases to fit what's in it, so the dialog around it grows and shrinks
 * smoothly when its fields change (e.g. password or key).
 */
export function SmoothHeight({ children, className }: { children: ReactNode; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const content = inner.current;
    if (!content) return;
    const measure = () => setHeight(content.offsetHeight);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(content);
    return () => watch.disconnect();
  }, []);

  return (
    <div className={className ? `smooth-height ${className}` : "smooth-height"} style={height === null ? undefined : { height }}>
      <div ref={inner}>{children}</div>
    </div>
  );
}

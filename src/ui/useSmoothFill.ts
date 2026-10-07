import { useEffect, useRef } from "react";

/** How far past the last confirmed point the bar may run on the current speed, in seconds. */
const LEAD = 2;
/** How quickly the bar closes a gap to the confirmed point (per second). */
const CATCH_UP = 1.5;

/**
 * A progress bar that fills smoothly instead of jumping between reports. Every frame the bar
 * moves on at the current speed and eases toward the confirmed point, never backwards and never
 * more than a moment ahead of it. `fraction` is the confirmed share (0–1) and `perSecond` the
 * current speed as a share of the whole per second. Attach `fill` to the bar's fill and `label`
 * to an empty element for the percentage; both are drawn here, every frame, outside React.
 */
export function useSmoothFill(fraction: number, perSecond: number, running: boolean, complete = false) {
  const fill = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const input = useRef({ fraction, perSecond, complete });
  input.current = { fraction, perSecond, complete };

  useEffect(() => {
    if (!running) return;
    let shown = 0;
    let last = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      const seconds = Math.min(0.1, (now - last) / 1000);
      last = now;
      const { fraction: confirmed, perSecond: speed, complete: done } = input.current;
      if (done) {
        shown += (1 - shown) * Math.min(1, seconds * 10);
      } else {
        const next = shown + speed * seconds + Math.max(0, confirmed - shown) * Math.min(1, seconds * CATCH_UP);
        // Keep pace with the speed, but don't claim much more than the server has confirmed.
        shown = Math.max(shown, Math.min(next, confirmed + speed * LEAD, 0.99));
      }
      if (fill.current) fill.current.style.width = `${shown * 100}%`;
      if (label.current) label.current.textContent = `${done && shown > 0.995 ? 100 : Math.min(99, Math.floor(shown * 100))}%`;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [running]);

  return { fill, label };
}

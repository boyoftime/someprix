import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import { useAppData } from "../state/AppData";

/** After the pointer leaves a toast, at least this long before it goes by itself. */
const AFTER_HOVER = 1500;

/**
 * Messages in the corner. Each goes by itself after its time, the clock stopping while the
 * pointer is on a toast (to read it). A click anywhere else in the app (the person is getting
 * on with something) sends them all away at once.
 */
export function Toasts() {
  const { toasts, dismiss } = useAppData();
  const box = useRef<HTMLDivElement>(null);
  // The toast the pointer is on, if any.
  const [held, setHeld] = useState<number | null>(null);
  const showing = toasts.filter((toast) => !toast.leaving);
  const showingIds = showing.map((toast) => toast.id).join(",");
  const clocks = useRef(new Map<number, { left: number; since: number; timer?: number }>());

  useEffect(() => {
    const now = Date.now();
    const live = new Map(showing.map((toast) => [toast.id, toast]));
    // A held toast that's gone (its button took it) holds nothing.
    const paused = held !== null && live.has(held);
    for (const [id, clock] of clocks.current) {
      if (live.has(id)) continue;
      window.clearTimeout(clock.timer);
      clocks.current.delete(id);
    }
    for (const toast of live.values()) {
      let clock = clocks.current.get(toast.id);
      if (!clock) {
        clock = { left: toast.duration, since: now };
        clocks.current.set(toast.id, clock);
      }
      if (paused && clock.timer !== undefined) {
        window.clearTimeout(clock.timer);
        clock.timer = undefined;
        clock.left -= now - clock.since;
      } else if (!paused && clock.timer === undefined) {
        clock.left = Math.max(clock.left, AFTER_HOVER);
        clock.since = now;
        clock.timer = window.setTimeout(() => dismiss(toast.id), clock.left);
      }
    }
  }, [showingIds, held, dismiss]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const all = clocks.current;
    return () => {
      all.forEach((clock) => window.clearTimeout(clock.timer));
      all.clear();
    };
  }, []);

  useEffect(() => {
    if (!showingIds) return;
    const ids = showingIds.split(",").map(Number);
    // Before anything else handles the press (some stop it going further), so nothing keeps a
    // toast up. Presses on a toast are its own: reading it, or its button.
    const onPress = (event: PointerEvent) => {
      if (box.current?.contains(event.target as Node)) return;
      ids.forEach((id) => dismiss(id));
    };
    document.addEventListener("pointerdown", onPress, true);
    return () => document.removeEventListener("pointerdown", onPress, true);
  }, [showingIds, dismiss]);

  return (
    <div ref={box} className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.tone}`}
          data-leaving={toast.leaving ? "" : undefined}
          data-held={held === toast.id ? "" : undefined}
          onMouseEnter={() => setHeld(toast.id)}
          onMouseLeave={() => setHeld((now) => (now === toast.id ? null : now))}
        >
          {toast.tone === "error" ? (
            <CircleAlert size={16} strokeWidth={1.75} />
          ) : (
            <CircleCheck size={16} strokeWidth={1.75} />
          )}
          <span>{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              className="btn btn-small toast-action"
              onClick={() => {
                dismiss(toast.id);
                toast.action!.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

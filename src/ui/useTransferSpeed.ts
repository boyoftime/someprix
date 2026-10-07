import { useCallback, useEffect, useRef, useState } from "react";

/** How often the speed is re-measured. */
const TICK = 500;
/** How quickly the shown speed follows a change: about two-thirds of the way in this long. */
const SETTLE = 2500;

/**
 * Live transfer speed in bytes per second from a stream of "bytes done so far" readings. The
 * number is smoothed so it follows the real rate without jumping: it climbs as a transfer gets
 * going, stays steady while it runs, and eases down (rather than dropping to zero) through a
 * brief pause. While `hold` is set (the last data is being confirmed, or files are being packed or
 * unpacked) it keeps its value instead of falling. Returns null until there's a rate to show.
 */
export function useTransferSpeed(active: boolean, hold = false) {
  const latest = useRef<number | null>(null);
  const previous = useRef<{ t: number; bytes: number } | null>(null);
  const smoothed = useRef<number | null>(null);
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const [, setTick] = useState(0);

  const record = useCallback((bytes: number) => {
    latest.current = bytes;
  }, []);

  const reset = useCallback(() => {
    latest.current = null;
    previous.current = null;
    smoothed.current = null;
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const now = performance.now();
      const bytes = latest.current;
      const last = previous.current;
      if (bytes !== null) {
        if (last && !holdRef.current && now > last.t) {
          const seconds = (now - last.t) / 1000;
          const rate = Math.max(0, (bytes - last.bytes) / seconds);
          const follow = 1 - Math.exp(-(now - last.t) / SETTLE);
          // The first real movement sets the speed; after that it eases toward each new rate.
          smoothed.current = smoothed.current === null ? (rate > 0 ? rate : null) : smoothed.current + follow * (rate - smoothed.current);
        }
        previous.current = { t: now, bytes };
      }
      setTick((n) => n + 1);
    }, TICK);
    return () => clearInterval(timer);
  }, [active]);

  return { speed: active ? smoothed.current : null, record, reset };
}

/** Whether a transfer is in a step that moves no data (confirming the last of it, packing or
 *  unpacking), when the speed should hold rather than fall. */
export function settling(progress: { finishing?: boolean; stage?: string; bytesDone?: number; bytesTotal?: number } | null) {
  if (!progress) return false;
  const allSent = Boolean(progress.bytesTotal) && (progress.bytesDone ?? 0) >= (progress.bytesTotal ?? 0);
  return Boolean(progress.finishing || progress.stage || allSent);
}

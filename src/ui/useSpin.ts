import { useCallback, useRef } from "react";

/** One full turn of the icon. */
const TURN_MS = 650;

/**
 * Spins a refresh icon when asked: at least one full turn, then more for as long as `busy` (the
 * reload it started) lasts, always stopping upright. Attach `icon` to the icon's svg.
 */
export function useSpin(busy: boolean) {
  const icon = useRef<SVGSVGElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const turning = useRef(false);

  const spin = useCallback(() => {
    if (turning.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const turn = () => {
      const animation = icon.current?.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
        duration: TURN_MS,
        easing: "linear",
      });
      turning.current = Boolean(animation);
      if (animation) animation.onfinish = () => (busyRef.current ? turn() : (turning.current = false));
    };
    turn();
  }, []);

  return { icon, spin };
}

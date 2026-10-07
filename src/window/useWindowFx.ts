import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import { createWindowFx, inTauri, type WindowFx } from "./windowFx";

/** Window controls with Someprix's own minimize / maximize / restore / close transitions. */
export function useWindowFx(frameRef: RefObject<HTMLElement | null>) {
  const [maximized, setMaximized] = useState(false);
  const fxRef = useRef<WindowFx | null>(null);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!inTauri || !frame) return;
    const fx = createWindowFx(frame, setMaximized);
    fxRef.current = fx;
    return () => {
      fx.dispose();
      fxRef.current = null;
    };
  }, [frameRef]);

  const actions = useMemo(
    () => ({
      minimize: () => void fxRef.current?.minimize(),
      toggleMaximize: () => void fxRef.current?.toggleMaximize(),
      close: () => void fxRef.current?.close(),
      startDrag: (event: MouseEvent) => fxRef.current?.startDrag(event.nativeEvent),
    }),
    [],
  );

  return { maximized, ...actions };
}

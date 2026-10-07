import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** Hover this long before the first tooltip shows. */
const SHOW_DELAY = 450;
/** After a tooltip hides, the next one shows at once for this long (moving along a toolbar). */
const WARM_FOR = 500;
/** Taller targets (like the pane divider) anchor the tooltip at the pointer instead. */
const TALL = 64;

type Anchor = { text: string; rect: DOMRect };

/**
 * App-styled tooltips for any element with a `data-tip` attribute, replacing the browser's
 * native `title` tooltips. Mount once inside the window frame.
 */
export function Tooltips() {
  const [tip, setTip] = useState<Anchor | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    let current: HTMLElement | null = null;
    // A target that was just clicked: no tooltip again until the pointer leaves it.
    let suppressed: HTMLElement | null = null;
    let visible = false;
    let warmUntil = 0;

    const target = (node: EventTarget | null) =>
      node instanceof Element ? node.closest<HTMLElement>("[data-tip]") : null;

    const anchorFor = (el: HTMLElement, pointerY?: number) => {
      const rect = el.getBoundingClientRect();
      return rect.height > TALL && pointerY !== undefined ? new DOMRect(rect.left, pointerY - 10, rect.width, 20) : rect;
    };

    const show = (el: HTMLElement, pointerY?: number) => {
      const text = el.dataset.tip;
      if (!text || !document.contains(el)) return;
      visible = true;
      setTip({ text, rect: anchorFor(el, pointerY) });
    };

    const hide = () => {
      window.clearTimeout(timer);
      if (visible) warmUntil = performance.now() + WARM_FOR;
      visible = false;
      current = null;
      setTip(null);
    };

    const schedule = (el: HTMLElement, pointerY?: number) => {
      if (el === current) return;
      hide();
      current = el;
      const delay = performance.now() < warmUntil ? 0 : SHOW_DELAY;
      timer = window.setTimeout(() => show(el, pointerY), delay);
    };

    const onOver = (event: PointerEvent) => {
      const el = target(event.target);
      if (el && el === suppressed) return;
      suppressed = null;
      if (el) schedule(el, event.clientY);
      else if (current) hide();
    };
    const onFocus = (event: FocusEvent) => {
      const el = target(event.target);
      if (el && el.matches(":focus-visible")) schedule(el);
    };
    const onPress = (event: PointerEvent) => {
      suppressed = target(event.target);
      hide();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    document.addEventListener("pointerover", onOver);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
    };
  }, []);

  return tip ? <Tip key={`${tip.text}-${tip.rect.x}-${tip.rect.y}`} {...tip} /> : null;
}

function Tip({ text, rect }: Anchor) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; arrow: number; side: "below" | "above" } | null>(null);

  // Below the target if it fits, else above; centred on it but kept inside the window frame.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const frame = el.closest(".app")?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
    const { width, height } = el.getBoundingClientRect();
    const gap = 8;
    const edge = 6;
    const side = rect.bottom + gap + height <= frame.bottom - edge ? "below" : "above";
    const top = side === "below" ? rect.bottom + gap : rect.top - gap - height;
    const center = rect.left + rect.width / 2;
    const left = Math.min(Math.max(center - width / 2, frame.left + edge), frame.right - edge - width);
    setPlace({ left, top, side, arrow: Math.min(Math.max(center - left, 10), width - 10) });
  }, [rect]);

  return (
    <div
      ref={box}
      role="tooltip"
      className="tip"
      data-side={place?.side}
      style={
        {
          left: place?.left ?? rect.left,
          top: place?.top ?? rect.bottom,
          opacity: place ? undefined : 0,
          "--arrow-x": `${place?.arrow ?? 0}px`,
        } as CSSProperties
      }
    >
      {text}
    </div>
  );
}

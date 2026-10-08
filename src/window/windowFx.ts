import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { isWindows } from "../lib/platform";

export const inTauri = isTauri();

/** Checks run before the window closes; one that returns true keeps it open (e.g. unsaved files). */
export const closeGuards = new Set<() => boolean>();

// The controller holds live window state and listeners; reload the page rather than hot-swap it.
if (import.meta.hot) {
  import.meta.hot.accept(() => location.reload());
}

// On Windows the window is transparent; the visible frame sits inside a gutter that holds its
// shadow and the resize handles. On Mac and Linux, and in a plain browser tab, there is no gutter.
document.documentElement.dataset.window = inTauri ? "normal" : "browser";

/** Match --gutter and --frame-radius in styles.css. */
const GUTTER = 14;
const RADIUS = 8;

// Leaving the screen accelerates away; arriving decelerates into place.
const ACCELERATE = "cubic-bezier(0.3, 0, 0.8, 0.15)";
const DECELERATE = "cubic-bezier(0.05, 0.7, 0.1, 1)";
/** Even in-and-out, so a zoom is visible the whole way through. */
const ZOOM = "cubic-bezier(0.4, 0, 0.2, 1)";

/** How small the window gets as it drops into the taskbar. */
const MINIMIZED_SCALE = 0.3;

type Rect = { x: number; y: number; w: number; h: number };
type FrameBox = { left: string; top: string; width: string; height: string; borderRadius: string };

const FULL: FrameBox = { left: "0px", top: "0px", width: "100vw", height: "100vh", borderRadius: "0px" };

/** Frame geometry for a rect in viewport coordinates, with the normal window corners. */
const boxAt = (r: Rect): FrameBox => ({
  left: `${r.x}px`,
  top: `${r.y}px`,
  width: `${r.w}px`,
  height: `${r.h}px`,
  borderRadius: `${RADIUS}px`,
});

/** The frame animates itself only on Windows, inside its transparent window; Mac and Linux
 *  windows are opaque and play the system's own transitions. */
const motionAllowed = () => isWindows && !matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Keyframe that draws a frame laid out at `from` into the rect `to` (viewport coordinates). */
function mapRect(from: Rect, to: Rect, radius: number): Keyframe {
  const sx = to.w / from.w;
  const sy = to.h / from.h;
  return {
    transformOrigin: "0 0",
    transform: `translate(${to.x - from.x}px, ${to.y - from.y}px) scale(${sx}, ${sy})`,
    borderRadius: `${radius / sx}px / ${radius / sy}px`,
  };
}

async function clientRect(): Promise<Rect> {
  const win = getCurrentWindow();
  const [scale, pos, size] = await Promise.all([win.scaleFactor(), win.innerPosition(), win.innerSize()]);
  return { x: pos.x / scale, y: pos.y / scale, w: size.width / scale, h: size.height / scale };
}

async function workArea(): Promise<Rect | null> {
  const monitor = await currentMonitor();
  if (!monitor) return null;
  const { position, size } = monitor.workArea;
  const s = monitor.scaleFactor;
  return { x: position.x / s, y: position.y / s, w: size.width / s, h: size.height / s };
}

/** Where the window returns to when un-maximized, as Windows has it recorded. */
async function restoreRect(): Promise<Rect | null> {
  const rect = await invoke<[number, number, number, number] | null>("window_fx_normal_rect");
  if (!rect) return null;
  const scale = await getCurrentWindow().scaleFactor();
  const [x, y, w, h] = rect.map((v) => v / scale);
  return { x, y, w, h };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Resolves once the webview has been laid out at a new viewport size, or after a timeout. */
function viewportChange(from: { w: number; h: number }, timeout = 500): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      const changed = innerWidth !== from.w || innerHeight !== from.h;
      if (changed || performance.now() - start > timeout) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Snaps the window (maximize / unmaximize) under a still screenshot of the screen. WebView2
 * shows its previous picture for a frame or two after the window changes size, offset to the
 * new position; the screenshot covers that. `settle` puts the frame back exactly where the
 * screenshot shows it, and the screenshot is lifted once that has been drawn, so nothing on
 * screen changes until the animation starts.
 */
async function frozenSnap(snap: () => Promise<void>, settle: () => void) {
  const viewport = { w: innerWidth, h: innerHeight };
  await invoke("window_fx_freeze");
  try {
    await snap();
    await viewportChange(viewport);
    settle();
    for (let i = 0; i < 3; i++) await nextFrame();
  } finally {
    await invoke("window_fx_thaw");
  }
}

/** Resolves true once the window reports minimized; polls with timers since rAF stops then. */
async function confirmMinimized(timeout = 1000): Promise<boolean> {
  const win = getCurrentWindow();
  const start = performance.now();
  while (performance.now() - start < timeout) {
    if (await win.isMinimized()) return true;
    await new Promise((r) => setTimeout(r, 16));
  }
  return false;
}

export type WindowFx = ReturnType<typeof createWindowFx>;

export function createWindowFx(frame: HTMLElement, onMaximizedChange: (maximized: boolean) => void) {
  const win = getCurrentWindow();

  let maximized = false;
  let busy = false;
  // Keeps the frame in its shrunken pose while the window is minimized, so it can rise back out.
  let hidden: { animation: Animation; pose: Keyframe; confirmed: boolean } | null = null;

  /** The frame's resting corner radius in its current state. */
  const restingRadius = () => (maximized ? "0px" : `${RADIUS}px`);

  function applyMaximized(value: boolean) {
    maximized = value;
    document.documentElement.dataset.window = value ? "maximized" : "normal";
    onMaximizedChange(value);
  }

  /** The pose the frame shrinks into on minimize: small, at the bottom edge, toward the taskbar. */
  async function minimizedPose(): Promise<Keyframe> {
    const [client, area] = await Promise.all([clientRect(), workArea()]);
    const r = frame.getBoundingClientRect();
    const w = r.width * MINIMIZED_SCALE;
    const h = r.height * MINIMIZED_SCALE;
    // Aim for the middle of the taskbar, but stay inside the window: nothing outside it is drawn.
    const towardTaskbar = area ? area.x + area.w / 2 - client.x : innerWidth / 2;
    const x = Math.min(Math.max(towardTaskbar - w / 2, 0), innerWidth - w);
    const y = innerHeight - h;
    return { ...mapRect({ x: r.x, y: r.y, w: r.width, h: r.height }, { x, y, w, h }, RADIUS), opacity: 0 };
  }

  function reveal() {
    if (!hidden) return;
    const { animation, pose } = hidden;
    hidden = null;
    if (motionAllowed()) {
      const rest: Keyframe = { ...pose, transform: "none", borderRadius: restingRadius(), opacity: 1 };
      frame.animate([pose, { opacity: 1, offset: 0.45 }, rest], { duration: 420, easing: DECELERATE });
    }
    animation.cancel();
  }

  /** Drops any pose left by an earlier transition, so a new one starts from the plain frame. */
  function clearPose() {
    hidden = null;
    for (const animation of frame.getAnimations()) animation.cancel();
  }

  let syncing = false;
  let syncAgain = false;

  /** Reconciles with the real window state after anything the OS or the user did. */
  async function sync() {
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    try {
      do {
        syncAgain = false;
        const [isMin, isMax] = await Promise.all([win.isMinimized(), win.isMaximized()]);
        if (isMin) continue;
        if (hidden?.confirmed) reveal();
        if (busy) continue;
        if (isMax !== maximized) applyMaximized(isMax);
      } while (syncAgain);
    } finally {
      syncing = false;
    }
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    try {
      await action();
    } finally {
      busy = false;
      void sync();
    }
  }

  const minimize = () =>
    run(async () => {
      clearPose();
      if (!motionAllowed()) {
        await win.minimize();
        return;
      }
      const pose = await minimizedPose();
      const start: Keyframe = { ...pose, transform: "none", borderRadius: restingRadius(), opacity: 1 };
      const animation = frame.animate([start, { opacity: 1, offset: 0.35 }, pose], {
        duration: 340,
        easing: ACCELERATE,
        fill: "forwards",
      });
      hidden = { animation, pose, confirmed: false };
      await animation.finished;
      // Let the vanished pose reach the screen, so restoring never shows a half-gone frame.
      await nextFrame();
      await nextFrame();
      await win.minimize();
      if (hidden && (await confirmMinimized())) hidden.confirmed = true;
      else reveal();
    });

  const maximize = () =>
    run(async () => {
      clearPose();
      const [now, area] = await Promise.all([clientRect(), workArea()]);
      if (!motionAllowed() || !area) {
        await win.maximize();
        applyMaximized(true);
        return;
      }

      // Where the frame is now, in the coordinates of the maximized window.
      const was = boxAt({
        x: now.x - area.x + GUTTER,
        y: now.y - area.y + GUTTER,
        w: now.w - GUTTER * 2,
        h: now.h - GUTTER * 2,
      });
      await frozenSnap(
        () => win.maximize(),
        () => Object.assign(frame.style, was),
      );

      // Then grow from there to fill the screen.
      const grow = frame.animate([was, FULL], { duration: 420, easing: ZOOM, fill: "forwards" });
      frame.removeAttribute("style");
      await grow.finished;
      applyMaximized(true);
      grow.cancel();
    });

  const restore = () =>
    run(async () => {
      clearPose();
      const [now, target] = await Promise.all([clientRect(), restoreRect()]);
      if (!motionAllowed() || !target) {
        await win.unmaximize();
        applyMaximized(false);
        return;
      }

      // Shrink to where the frame will sit once restored (in the maximized window's coordinates)...
      const landing = boxAt({
        x: target.x - now.x + GUTTER,
        y: target.y - now.y + GUTTER,
        w: target.w - GUTTER * 2,
        h: target.h - GUTTER * 2,
      });
      const shrink = frame.animate([FULL, landing], { duration: 400, easing: ZOOM, fill: "forwards" });
      applyMaximized(false);
      await shrink.finished;

      // ...then snap the window under it; its normal layout lands on the same spot.
      await frozenSnap(
        () => win.unmaximize(),
        () => shrink.cancel(),
      );
    });

  const toggleMaximize = () => (maximized ? restore() : maximize());

  const close = () => win.close();

  /** Title bar mousedown: drag the window, or toggle maximize on double-click. */
  function startDrag(event: MouseEvent) {
    if (event.button !== 0) return;
    if (event.detail === 2) void toggleMaximize();
    else void win.startDragging();
  }

  if (motionAllowed()) {
    frame.animate(
      [
        { transformOrigin: "50% 50%", transform: "scale(0.92)", opacity: 0 },
        { transformOrigin: "50% 50%", transform: "none", opacity: 1 },
      ],
      { duration: 420, easing: DECELERATE },
    );
  }

  const listeners: Promise<UnlistenFn>[] = [
    win.onResized(() => void sync()),
    win.onMoved(() => void sync()),
    win.onFocusChanged(({ payload: focused }) => {
      if (focused) void sync();
    }),
    win.onCloseRequested(async (event) => {
      if ([...closeGuards].some((blocks) => blocks())) {
        event.preventDefault();
        return;
      }
      if (!motionAllowed()) return;
      await frame.animate(
        [
          { transformOrigin: "50% 50%", transform: "none", opacity: 1 },
          { transformOrigin: "50% 50%", transform: "scale(0.92)", opacity: 0 },
        ],
        { duration: 200, easing: ACCELERATE, fill: "forwards" },
      ).finished;
    }),
    listen<string>("window-fx://request", ({ payload }) => {
      if (payload === "minimize") void minimize();
      else if (payload === "maximize") void maximize();
      else if (payload === "restore") void restore();
    }),
  ];
  void Promise.all(listeners).then(() => invoke("window_fx_ready"));
  void sync();

  return {
    minimize,
    toggleMaximize,
    close,
    startDrag,
    dispose() {
      for (const unlisten of listeners) void unlisten.then((stop) => stop());
    },
  };
}

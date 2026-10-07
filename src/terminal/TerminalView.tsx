import { useEffect, useRef } from "react";
import { Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { ClipboardPaste, Copy, Eraser, Plus, RotateCw, TextSelect, X } from "lucide-react";
import { api, type TerminalEnded } from "../lib/api";
import { errorMessage, useAppData } from "../state/AppData";
import { useContextMenu } from "../ui/ContextMenu";
import { useTerminals, type Session } from "./TerminalProvider";

/** ANSI colours for each app theme; background, text and cursor come from the app's tokens. */
const PALETTES: Record<"dark" | "light", ITheme> = {
  dark: {
    black: "#2a2d3d",
    red: "#f47067",
    green: "#a6d189",
    yellow: "#e3b341",
    blue: "#74b3ff",
    magenta: "#c49bff",
    cyan: "#7dd3e0",
    white: "#c9cde0",
    brightBlack: "#6a7090",
    brightRed: "#ff8b8f",
    brightGreen: "#bde3a5",
    brightYellow: "#f0c674",
    brightBlue: "#8fb0ff",
    brightMagenta: "#d6b8ff",
    brightCyan: "#9fe6ef",
    brightWhite: "#f1f3f9",
    selectionBackground: "#4a7dff55",
  },
  light: {
    black: "#1b1e2c",
    red: "#cf222e",
    green: "#1f883d",
    yellow: "#9a6b00",
    blue: "#2d63ee",
    magenta: "#8a3ffc",
    cyan: "#08799a",
    white: "#8b90a3",
    brightBlack: "#5f6579",
    brightRed: "#e5484d",
    brightGreen: "#2f9e4f",
    brightYellow: "#c27c0e",
    brightBlue: "#4a7dff",
    brightMagenta: "#a35cff",
    brightCyan: "#0e9fbf",
    brightWhite: "#3a3f52",
    selectionBackground: "#2d63ee40",
  },
};

function themeNow(): ITheme {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const muted = token("--text-muted");
  return {
    ...PALETTES[root.dataset.theme === "light" ? "light" : "dark"],
    background: token("--editor-bg"),
    foreground: token("--text"),
    cursor: token("--accent"),
    cursorAccent: token("--editor-bg"),
    scrollbarSliderBackground: `${muted}55`,
    scrollbarSliderHoverBackground: `${muted}88`,
    scrollbarSliderActiveBackground: `${muted}aa`,
  };
}

const encoder = new TextEncoder();
/** Dim text, for the lines the app itself writes into the terminal. */
const note = (text: string) => `\x1b[2m${text}\x1b[0m`;

type TerminalViewProps = { session: Session; active: boolean; shown: boolean };

/** One terminal tab: an xterm.js screen wired to a shell on the server. */
export function TerminalView({ session, active, shown }: TerminalViewProps) {
  const { hosts, connected, connect, refreshConnections } = useAppData();
  const terminals = useTerminals();
  const openMenu = useContextMenu();
  const screen = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const live = useRef({ hosts, connected, connect, refreshConnections, terminals });
  live.current = { hosts, connected, connect, refreshConnections, terminals };
  // Wired up once the terminal exists.
  const actions = useRef({ start: () => {}, copy: () => {}, paste: () => {} });

  useEffect(() => {
    const { key, hostId } = session;
    const xterm = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13.5,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      allowProposedApi: true,
      theme: themeNow(),
    });
    const fitter = new FitAddon();
    xterm.loadAddon(fitter);
    xterm.loadAddon(new WebLinksAddon((_event, uri) => void openUrl(uri).catch(() => {})));
    xterm.open(screen.current!);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      xterm.loadAddon(gl);
    } catch {
      // No WebGL: the default renderer draws it instead.
    }
    term.current = xterm;
    fit.current = fitter;
    // Lets automated checks read the screen in development builds.
    if (import.meta.env.DEV) Object.assign(screen.current!, { xterm });

    let phase: "idle" | "connecting" | "live" | "ended" = "idle";
    let remote: number | null = null;
    let disposed = false;
    const fitNow = () => {
      const el = screen.current;
      if (el && el.clientWidth > 0 && el.clientHeight > 0) fitter.fit();
    };

    // Keys go out in order, one call at a time; whatever's typed meanwhile goes in the next one.
    let queued: number[] = [];
    let sending = false;
    const sendKeys = async (bytes: Uint8Array) => {
      for (const b of bytes) queued.push(b);
      if (sending) return;
      sending = true;
      while (queued.length && remote !== null) {
        const chunk = queued;
        queued = [];
        try {
          await api.writeTerminal(remote, chunk);
        } catch {
          break;
        }
      }
      queued = [];
      sending = false;
    };

    const end = (how: TerminalEnded) => {
      if (phase === "ended" || disposed) return;
      phase = "ended";
      remote = null;
      live.current.terminals.update(key, { status: "ended" });
      const why = how.reason ?? (how.exitCode !== null && how.exitCode !== 0 ? `exit ${how.exitCode}` : null);
      xterm.write(`\r\n${note(`[Session ended${why ? `: ${why}` : ""}] Press Enter to reconnect`)}\r\n`);
    };

    const start = async () => {
      if (phase === "connecting" || phase === "live") return;
      phase = "connecting";
      live.current.terminals.update(key, { status: "connecting" });
      const host = live.current.hosts.find((h) => h.id === hostId);
      xterm.write(note(`Connecting to ${host ? `${host.username}@${host.host}` : "server"}…`) + "\r\n");
      if (!live.current.connected.has(hostId) && !(await live.current.connect(hostId))) {
        end({ exitCode: null, reason: "not connected" });
        return;
      }
      const output = new Channel<ArrayBuffer | TerminalEnded>();
      output.onmessage = (message) => {
        if (message instanceof ArrayBuffer) xterm.write(new Uint8Array(message));
        else end(message);
      };
      try {
        fitNow();
        const id = await api.openTerminal(hostId, xterm.cols, xterm.rows, output);
        if (disposed) {
          void api.closeTerminal(id);
          return;
        }
        // It may already have ended (a server that refuses shells answers at once).
        if (phase !== "connecting") return;
        remote = id;
        phase = "live";
        live.current.terminals.update(key, { status: "live" });
      } catch (e) {
        end({ exitCode: null, reason: errorMessage(e) });
        void live.current.refreshConnections();
      }
    };

    const copy = () => {
      const text = xterm.getSelection();
      if (text) void writeText(text).catch(() => {});
      xterm.clearSelection();
      xterm.focus();
    };
    const paste = () =>
      void readText()
        .then((text) => text && xterm.paste(text))
        .catch(() => {})
        .finally(() => xterm.focus());
    actions.current = { start: () => void start(), copy, paste };

    xterm.onData((data) => {
      if (phase === "live") void sendKeys(encoder.encode(data));
      else if (phase === "ended" && data === "\r") void start();
    });
    xterm.onBinary((data) => {
      if (phase === "live") void sendKeys(Uint8Array.from(data, (c) => c.charCodeAt(0) & 255));
    });
    xterm.onResize(({ cols, rows }) => {
      if (remote !== null) void api.resizeTerminal(remote, cols, rows).catch(() => {});
    });
    xterm.onTitleChange((title) => live.current.terminals.update(key, { title: title || null }));
    // Ctrl+C copies when there's a selection (else it interrupts, as usual); Ctrl+V pastes.
    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !event.ctrlKey || event.altKey || event.metaKey) return true;
      const k = event.key.toLowerCase();
      if (k === "c" && (event.shiftKey || xterm.hasSelection())) {
        event.preventDefault();
        copy();
        return false;
      }
      if (k === "v") {
        event.preventDefault();
        paste();
        return false;
      }
      // Ctrl+Tab belongs to the tab strip.
      return event.key !== "Tab";
    });

    // Follow the pane's size, and the app's theme.
    let frame = 0;
    const resized = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitNow);
    });
    resized.observe(screen.current!);
    const themed = new MutationObserver(() => (xterm.options.theme = themeNow()));
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    void start();

    return () => {
      disposed = true;
      if (remote !== null) void api.closeTerminal(remote);
      resized.disconnect();
      themed.disconnect();
      cancelAnimationFrame(frame);
      xterm.dispose();
      term.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The tab in front gets the keyboard, sized to the space it now has.
  useEffect(() => {
    if (!active || !shown) return;
    const frame = requestAnimationFrame(() => {
      const el = screen.current;
      if (el && el.clientWidth > 0) fit.current?.fit();
      term.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, shown]);

  const menu = (event: React.MouseEvent) => {
    const xterm = term.current;
    if (!xterm) return;
    openMenu(event, [
      { label: "Copy", icon: Copy, onSelect: actions.current.copy, disabled: !xterm.hasSelection() },
      { label: "Paste", icon: ClipboardPaste, onSelect: actions.current.paste },
      { label: "Select all", icon: TextSelect, onSelect: () => xterm.selectAll() },
      { label: "Clear", icon: Eraser, onSelect: () => xterm.clear() },
      "separator",
      session.status === "ended"
        ? { label: "Reconnect", icon: RotateCw, onSelect: actions.current.start }
        : { label: "New terminal", icon: Plus, onSelect: () => terminals.open(session.hostId, true) },
      { label: "Close", icon: X, onSelect: () => terminals.close(session.key) },
    ]);
  };

  return (
    <div className="term-view" hidden={!active} onContextMenu={menu}>
      <div className="term-screen" ref={screen} />
    </div>
  );
}

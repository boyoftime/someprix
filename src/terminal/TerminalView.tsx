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
import { TypeAhead } from "./typeahead";

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

/** The 256-colour slot plain shell prompts are drawn in, and its deep orange-yellow per theme. */
const PROMPT_COLOUR = 214;
const PROMPT_SHADE = { dark: "#ffa630", light: "#b45f00" };

function themeNow(): ITheme {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const muted = token("--text-muted");
  const mode = root.dataset.theme === "light" ? "light" : "dark";
  // Only the prompt's slot is set; the other extended colours keep their usual values.
  const extendedAnsi: string[] = [];
  extendedAnsi[PROMPT_COLOUR - 16] = PROMPT_SHADE[mode];
  return {
    ...PALETTES[mode],
    extendedAnsi,
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

/** A plain prompt starting a line ("root@vps:~/apps# "): after a newline, or after the window-title
 *  code shells print just before it. */
const PLAIN_PROMPT = /(^|\n|\x07)([a-z_][\w.-]*@[\w.-]+:(?:~|\/)[^\x00-\x1f\x7f#$]*[#$] )/gi;
const PROMPT_ON = `\x1b[1;38;5;${PROMPT_COLOUR}m`;
const PROMPT_OFF = "\x1b[0m";

/** Shell output with plain prompts drawn in the prompt colour, so they stand out from what
 *  commands print. Prompts the server already colours don't match and are left alone. */
function colourPrompts(bytes: Uint8Array): Uint8Array {
  if (!bytes.includes(0x40)) return bytes; // No "@": no prompt.
  // One character per byte, so multi-byte text passes through untouched.
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  const coloured = text.replace(PLAIN_PROMPT, `$1${PROMPT_ON}$2${PROMPT_OFF}`);
  return coloured === text ? bytes : Uint8Array.from(coloured, (c) => c.charCodeAt(0));
}

/** The folder in a prompt or window title, like "root@vps:~/apps# ls" or "root@vps: ~/apps". */
function folderIn(text: string) {
  return /^[^\s@]+@[^\s:]+:\s?(~[^\s#$]*|\/[^\s#$]*)/.exec(text.trim())?.[1] ?? null;
}

/** A shell prompt line ("root@vps:~/apps# ") and whatever is typed after it. */
const PROMPT_LINE = /^[^\s@]+@[^\s:]+:\s?(?:~[^\s#$]*|\/[^\s#$]*)[#$] (.*)$/;
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
      // A touch bolder than the default hairline.
      cursorWidth: 2,
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

    let phase: "idle" | "connecting" | "live" | "reconnecting" | "ended" = "idle";
    let remote: number | null = null;
    let disposed = false;
    // Each opened shell gets a number; output from an older one is ignored.
    let generation = 0;
    // The folder the shell was in, to carry on there after a reconnect.
    let lastDir: string | null = null;
    // Where the next Enter-started session opens (a reconnect that stopped at the login).
    let resumeDir: string | null = null;
    // The command being typed when the connection dropped: put back at the new prompt, never run.
    let restoreLine = "";
    // The last key sent on this line was Enter, so the command may already have run.
    let submitted = false;
    // Cuts a reconnect wait short (the network came back, or Enter was pressed).
    let retryNow: (() => void) | null = null;
    const typeahead = new TypeAhead(xterm);
    const fitNow = () => {
      const el = screen.current;
      if (el && el.clientWidth > 0 && el.clientHeight > 0) fitter.fit();
    };
    const cursorLine = () => {
      const buffer = xterm.buffer.active;
      return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? "";
    };
    /** What's typed at a shell prompt (a long line's wrapped rows joined); null when not at one. */
    const typedAtPrompt = () => {
      const buffer = xterm.buffer.active;
      if (buffer.type !== "normal") return null;
      let row = buffer.baseY + buffer.cursorY;
      let line = buffer.getLine(row);
      if (!line) return null;
      let text = line.translateToString(true);
      while (line.isWrapped && row > 0) {
        row--;
        line = buffer.getLine(row);
        if (!line) break;
        text = line.translateToString(false) + text;
      }
      return PROMPT_LINE.exec(text)?.[1].trimEnd() ?? null;
    };
    /** Types `text` at the new shell's prompt once it's there, without pressing Enter. */
    const putBack = async (text: string) => {
      for (let waited = 0; waited < 8000 && typedAtPrompt() !== ""; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (disposed || phase !== "live") return;
      }
      if (typedAtPrompt() !== "") return;
      submitted = false;
      void sendKeys(encoder.encode(text));
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

    /** Opens a shell (in `dir`, if given), first replacing a connection that has gone. */
    const open = async (dir: string | null, quiet: boolean): Promise<"live" | "failed" | "ended"> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0 || !live.current.connected.has(hostId)) {
          if (!(await live.current.connect(hostId, quiet))) return "failed";
        }
        const token = ++generation;
        let endedEarly = false;
        const output = new Channel<ArrayBuffer | TerminalEnded>();
        output.onmessage = (message) => {
          if (token !== generation || disposed) return;
          if (message instanceof ArrayBuffer) {
            typeahead.received(colourPrompts(new Uint8Array(message)));
          } else {
            endedEarly = remote === null;
            ended(message);
          }
        };
        try {
          fitNow();
          const id = await api.openTerminal(hostId, xterm.cols, xterm.rows, output, dir);
          if (disposed || token !== generation) {
            void api.closeTerminal(id);
            return "ended";
          }
          // A server that refuses shells answers at once; that's already been handled.
          if (endedEarly) return "ended";
          remote = id;
          return "live";
        } catch {
          // Usually a connection that died while idle: connect again and retry once.
          await live.current.refreshConnections();
        }
      }
      return "failed";
    };

    /** A session ended: a lost connection comes back by itself, anything else waits for Enter. */
    const ended = (how: TerminalEnded) => {
      if (disposed) return;
      remote = null;
      // A command typed at the prompt but not run yet comes back after reconnecting (read before
      // rubbing out anything drawn early: that's typed too).
      if (how.lost) restoreLine = submitted ? "" : (typedAtPrompt() ?? "");
      typeahead.clear();
      if (how.lost) {
        // Tell the rest of the app too, so the file panes start coming back as well.
        void live.current.refreshConnections();
        void reconnect();
        return;
      }
      phase = "ended";
      live.current.terminals.update(key, { status: "ended" });
      const why = how.reason ?? (how.exitCode !== null && how.exitCode !== 0 ? `exit ${how.exitCode}` : null);
      xterm.write(`\r\n${note(`[Session ended${why ? `: ${why}` : ""}] Press Enter to reconnect`)}\r\n`);
    };

    const start = async () => {
      if (phase !== "idle" && phase !== "ended") return;
      phase = "connecting";
      live.current.terminals.update(key, { status: "connecting" });
      const host = live.current.hosts.find((h) => h.id === hostId);
      xterm.write(note(`Connecting to ${host ? `${host.username}@${host.host}` : "server"}…`) + "\r\n");
      const dir = resumeDir;
      resumeDir = null;
      const result = await open(dir, false);
      if (result === "ended" || disposed) return;
      if (result === "live") {
        phase = "live";
        live.current.terminals.update(key, { status: "live" });
        if (restoreLine) void putBack(restoreLine);
        restoreLine = "";
      } else {
        phase = "ended";
        live.current.terminals.update(key, { status: "ended" });
        xterm.write(`${note("[Not connected] Press Enter to try again")}\r\n`);
      }
    };

    /**
     * The connection dropped (network gone, laptop asleep): keep trying in the background, sooner
     * once Windows says the network is back, and carry on in the same folder. A rejected login
     * stops it, so a changed password can't get the address blocked by the server.
     */
    const reconnect = async () => {
      if (phase === "reconnecting" || disposed) return;
      phase = "reconnecting";
      live.current.terminals.update(key, { status: "connecting" });
      lastDir = folderIn(cursorLine()) ?? lastDir;
      xterm.write(`\r\n${note("Reconnecting…")}\r\n`);
      let wait = 1000;
      while (!disposed && phase === "reconnecting") {
        try {
          const result = await open(lastDir, true);
          if (result === "ended" || disposed) return;
          if (result === "live") {
            phase = "live";
            live.current.terminals.update(key, { status: "live" });
            if (restoreLine) void putBack(restoreLine);
            restoreLine = "";
            return;
          }
        } catch (error) {
          const why = errorMessage(error);
          if (/auth|login|password|key/i.test(why)) {
            resumeDir = lastDir;
            phase = "ended";
            live.current.terminals.update(key, { status: "ended" });
            xterm.write(`${note(`[${why}] Press Enter to try again`)}\r\n`);
            return;
          }
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait);
          retryNow = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        retryNow = null;
        wait = Math.min(wait * 2, 15000);
      }
    };
    const networkBack = () => retryNow?.();
    window.addEventListener("online", networkBack);

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
      if (phase === "live") {
        // Each command line shows the folder it ran in: remember it for a reconnect.
        if (data.includes("\r")) lastDir = folderIn(cursorLine()) ?? lastDir;
        submitted = data.includes("\r");
        typeahead.typed(data);
        void sendKeys(encoder.encode(data));
      } else if (phase === "reconnecting") {
        // Enter tries again now; anything typed meanwhile joins the line that comes back.
        if (data === "\r") {
          retryNow?.();
        } else if (data === "\x7f") {
          if (restoreLine) {
            restoreLine = restoreLine.slice(0, -1);
            xterm.write("\b \b");
          }
        } else if (/^[\x20-\x7e]+$/.test(data)) {
          restoreLine += data;
          xterm.write(note(data));
        }
      } else if (data === "\r" && phase === "ended") {
        void start();
      }
    });
    xterm.onBinary((data) => {
      if (phase === "live") void sendKeys(Uint8Array.from(data, (c) => c.charCodeAt(0) & 255));
    });
    xterm.onResize(({ cols, rows }) => {
      typeahead.clear();
      if (remote !== null) void api.resizeTerminal(remote, cols, rows).catch(() => {});
    });
    xterm.onTitleChange((title) => {
      lastDir = folderIn(title) ?? lastDir;
      live.current.terminals.update(key, { title: title || null });
    });
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
      window.removeEventListener("online", networkBack);
      retryNow?.();
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

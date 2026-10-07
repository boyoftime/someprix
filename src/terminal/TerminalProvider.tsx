import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { markRecent } from "./recent";

/** One terminal tab: a shell on a host, and where its connection stands. */
export type Session = {
  key: number;
  hostId: string;
  status: "connecting" | "live" | "ended";
  /** The title the shell sets (e.g. "root@vps: ~"), if any. */
  title: string | null;
};

type Terminals = {
  sessions: Session[];
  activeKey: number | null;
  /** Shows the host's terminal, opening one if it has none running (or always, with `fresh`). */
  open: (hostId: string, fresh?: boolean) => void;
  close: (key: number) => void;
  activate: (key: number) => void;
  update: (key: number, changes: Partial<Session>) => void;
};

const TerminalContext = createContext<Terminals | null>(null);
const OpenContext = createContext<((hostId: string, fresh?: boolean) => void) | null>(null);

export function useTerminals() {
  const terminals = useContext(TerminalContext);
  if (!terminals) throw new Error("useTerminals needs a TerminalProvider");
  return terminals;
}

/** Opens a host's terminal. Stable, so lists can use it without re-rendering. */
export function useOpenTerminal() {
  return useContext(OpenContext);
}

/** Open terminal tabs. `onShow` brings the terminal page forward. */
export function TerminalProvider({ onShow, children }: { onShow: () => void; children: ReactNode }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeKey, setActiveKey] = useState<number | null>(null);
  // The list as of now (React state lags a render behind).
  const current = useRef<Session[]>([]);
  const nextKey = useRef(0);
  const showRef = useRef(onShow);
  showRef.current = onShow;

  const commit = (next: Session[]) => {
    current.current = next;
    setSessions(next);
  };

  const actions = useMemo(() => {
    const activate = (key: number) => setActiveKey(key);
    return {
      open: (hostId: string, fresh = false) => {
        showRef.current();
        markRecent(hostId);
        const running = !fresh && current.current.find((s) => s.hostId === hostId && s.status !== "ended");
        if (running) {
          activate(running.key);
          return;
        }
        const key = ++nextKey.current;
        commit([...current.current, { key, hostId, status: "connecting", title: null }]);
        activate(key);
      },
      close: (key: number) => {
        const list = current.current;
        const at = list.findIndex((s) => s.key === key);
        if (at < 0) return;
        const next = list[at + 1] ?? list[at - 1] ?? null;
        commit(list.filter((s) => s.key !== key));
        setActiveKey((active) => (active === key ? (next?.key ?? null) : active));
      },
      activate,
      update: (key: number, changes: Partial<Session>) =>
        commit(current.current.map((s) => (s.key === key ? { ...s, ...changes } : s))),
    };
  }, []);

  const terminals = useMemo<Terminals>(() => ({ ...actions, sessions, activeKey }), [actions, sessions, activeKey]);

  return (
    <OpenContext.Provider value={actions.open}>
      <TerminalContext.Provider value={terminals}>{children}</TerminalContext.Provider>
    </OpenContext.Provider>
  );
}

import { useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Plus, Server, SquareTerminal, X } from "lucide-react";
import { useAppData } from "../state/AppData";
import { useTerminals, type Session } from "./TerminalProvider";
import { TerminalView } from "./TerminalView";

const STATUS_LABEL: Record<Session["status"], string> = {
  connecting: "Connecting",
  live: "Connected",
  ended: "Ended",
};

/** Terminal tabs: a shell on a server in each, already logged in. */
export function TerminalPage({ shown }: { shown: boolean }) {
  const { sessions, activeKey, open, close, activate } = useTerminals();
  const { hosts } = useAppData();
  const active = sessions.find((s) => s.key === activeKey) ?? null;

  const hostOf = (session: Session) => hosts.find((h) => h.id === session.hostId);
  /** The host's name, numbered when it has more than one tab. */
  const label = (session: Session) => {
    const name = hostOf(session)?.label ?? "Server";
    const same = sessions.filter((s) => s.hostId === session.hostId);
    return same.length > 1 ? `${name} (${same.indexOf(session) + 1})` : name;
  };
  const tip = (session: Session) => {
    const host = hostOf(session);
    const address = host ? `${host.username}@${host.host}${host.port !== 22 ? `:${host.port}` : ""}` : "";
    return `${session.title ?? address} (${STATUS_LABEL[session.status]})`;
  };

  // Ctrl+Tab moves between tabs.
  useEffect(() => {
    if (!shown || sessions.length < 2) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key !== "Tab") return;
      event.preventDefault();
      const at = sessions.findIndex((s) => s.key === activeKey);
      activate(sessions[(at + (event.shiftKey ? -1 : 1) + sessions.length) % sessions.length].key);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown, sessions, activeKey, activate]);

  const onTabKey = (event: ReactKeyboardEvent, session: Session) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(session.key);
    } else if (event.key === "Delete") {
      close(session.key);
    }
  };

  return (
    <section className="term-page" hidden={!shown} aria-label="Terminal">
      {sessions.length > 0 && (
        <div className="editor-tabs term-tabs" role="tablist" aria-label="Terminals">
          {sessions.map((session) => (
            <div
              key={session.key}
              role="tab"
              tabIndex={session.key === activeKey ? 0 : -1}
              className="editor-tab"
              aria-selected={session.key === activeKey}
              data-tip={tip(session)}
              onClick={() => activate(session.key)}
              onKeyDown={(event) => onTabKey(event, session)}
              onMouseDown={(event) => event.button === 1 && event.preventDefault()}
              onAuxClick={(event) => event.button === 1 && close(session.key)}
            >
              <span className="term-status" data-status={session.status} aria-label={STATUS_LABEL[session.status]} />
              <span className="editor-tab-name">{label(session)}</span>
              <button
                type="button"
                className="editor-tab-close"
                tabIndex={-1}
                aria-label={`Close ${label(session)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  close(session.key);
                }}
              >
                <X size={14} strokeWidth={2} />
              </button>
            </div>
          ))}
          {active && (
            <button
              type="button"
              className="icon-btn term-new"
              onClick={() => open(active.hostId, true)}
              aria-label="New terminal"
              data-tip="New terminal"
            >
              <Plus size={16} strokeWidth={2} />
            </button>
          )}
        </div>
      )}

      <div className="term-views">
        {sessions.map((session) => (
          <TerminalView key={session.key} session={session} active={session.key === activeKey} shown={shown} />
        ))}
      </div>

      {sessions.length === 0 && (
        <div className="pane-empty term-empty">
          <SquareTerminal size={30} strokeWidth={1.5} />
          <h2>No terminals</h2>
          {hosts.length ? (
            <>
              <p>Pick a host</p>
              <div className="term-hosts">
                {hosts.map((host) => (
                  <button key={host.id} type="button" className="btn" onClick={() => open(host.id)}>
                    <Server size={15} strokeWidth={1.75} />
                    {host.label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p>Add a host in Hosts</p>
          )}
        </div>
      )}
    </section>
  );
}

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CornerDownLeft, Plus, Search, Server } from "lucide-react";
import { useAppData } from "../state/AppData";
import { HostDialog } from "../hosts/HostDialog";
import { recentHosts } from "./recent";
import type { Host } from "../lib/api";

type HostPickProps = {
  /** On screen: the search box takes the keyboard each time it appears. */
  shown: boolean;
  /** Opens a terminal on this host. */
  onPick: (hostId: string) => void;
  /** Leaves the picker (Esc); left out when there's nothing to go back to. */
  onCancel?: () => void;
};

/** A new terminal tab: search the saved hosts and open one, by mouse or keyboard. */
export function HostPick({ shown, onPick, onCancel }: HostPickProps) {
  const { hosts, connected, reconnecting } = useAppData();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [adding, setAdding] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!shown) return;
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [shown]);

  // Recently used first, then the rest by name; a search keeps that order.
  const groups = useMemo(() => {
    const recent = recentHosts();
    const rank = (host: Host) => {
      const at = recent.indexOf(host.id);
      return at < 0 ? Number.MAX_SAFE_INTEGER : at;
    };
    const q = query.trim().toLowerCase();
    const matches = hosts
      .filter((h) => !q || [h.label, h.host, h.username].some((v) => v.toLowerCase().includes(q)))
      .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
    if (q) return [{ title: "Results", hosts: matches }];
    const used = matches.filter((h) => recent.includes(h.id));
    const others = matches.filter((h) => !recent.includes(h.id));
    return [
      { title: "Recent connections", hosts: used },
      { title: used.length ? "Other hosts" : "Hosts", hosts: others },
    ].filter((g) => g.hosts.length);
  }, [hosts, query]);
  const flat = groups.flatMap((g) => g.hosts);
  const current = Math.min(index, Math.max(flat.length - 1, 0));

  // Keep the highlighted row in view while moving with the keyboard.
  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const pick = (host: Host | undefined) => {
    if (host) onPick(host.id);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((current + 1) % Math.max(flat.length, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((current - 1 + flat.length) % Math.max(flat.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(flat[current]);
    } else if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      onCancel();
    }
  };

  let row = 0;
  return (
    <div className="pick" onKeyDown={onKey}>
      <label className="pick-search">
        <Search size={17} strokeWidth={1.75} />
        <input
          ref={input}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          placeholder="Search hosts"
          aria-label="Search hosts"
          spellCheck={false}
        />
      </label>

      <div className="pick-card" ref={list}>
        {hosts.length === 0 ? (
          <p className="pick-empty">No hosts yet. Add one to open a terminal on it.</p>
        ) : flat.length === 0 ? (
          <p className="pick-empty">No hosts match “{query.trim()}”</p>
        ) : (
          groups.map((group) => (
            <section key={group.title} className="pick-group">
              <h2 className="pick-title">{group.title}</h2>
              <div role="listbox" aria-label={group.title}>
                {group.hosts.map((host) => {
                  const i = row++;
                  const live = connected.has(host.id);
                  return (
                    <button
                      key={host.id}
                      type="button"
                      role="option"
                      className="pick-row"
                      data-index={i}
                      aria-selected={i === current}
                      onMouseMove={() => i !== current && setIndex(i)}
                      onClick={() => pick(host)}
                    >
                      <span className="pick-icon">
                        <Server size={16} strokeWidth={1.75} />
                      </span>
                      <span className="pick-text">
                        <span className="pick-name">{host.label}</span>
                        <span className="pick-address">
                          {host.username}@{host.host}
                          {host.port !== 22 ? `:${host.port}` : ""}
                        </span>
                      </span>
                      {live ? (
                        <span className="status-dot" aria-label="Connected" />
                      ) : reconnecting.has(host.id) ? (
                        <span className="status-dot" data-state="reconnecting" aria-label="Reconnecting" />
                      ) : null}
                      <span className="pick-enter" aria-hidden="true">
                        <CornerDownLeft size={14} strokeWidth={2} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        )}
        <button type="button" className="pick-new" onClick={() => setAdding(true)}>
          <Plus size={16} strokeWidth={2} />
          New host
        </button>
      </div>

      {adding && (
        <HostDialog
          onClose={() => {
            setAdding(false);
            input.current?.focus();
          }}
          onSaved={(saved) => pick(saved)}
        />
      )}
    </div>
  );
}

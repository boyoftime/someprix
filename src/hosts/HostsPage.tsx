import { useMemo, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ArrowLeftRight, Copy, Pencil, Plus, Search, Server, SquareTerminal, Unplug } from "lucide-react";
import { errorMessage, useAppData } from "../state/AppData";
import { useContextMenu, type MenuItem } from "../ui/ContextMenu";
import { HostDialog } from "./HostDialog";
import { Lottie } from "../ui/Lottie";
import connectingAnimation from "../assets/lottie/connecting.json";
import type { Host } from "../lib/api";
import { useOpenTerminal } from "../terminal/TerminalProvider";

type HostsPageProps = {
  /** Opens the host in the Sync view. */
  onOpenInSync: (host: Host) => void;
};

export function HostsPage({ onOpenInSync }: HostsPageProps) {
  const { hosts, connected, connecting, disconnect, notify } = useAppData();
  const openMenu = useContextMenu();
  const openTerminal = useOpenTerminal();

  const hostMenu = (host: Host, isConnected: boolean): MenuItem[] => [
    { label: "Open terminal", icon: SquareTerminal, onSelect: () => openTerminal?.(host.id) },
    { label: "New terminal", icon: Plus, onSelect: () => openTerminal?.(host.id, true) },
    { label: "Open in Sync", icon: ArrowLeftRight, onSelect: () => onOpenInSync(host) },
    "separator",
    { label: "Edit", icon: Pencil, onSelect: () => setEditing(host) },
    ...(isConnected ? [{ label: "Disconnect", icon: Unplug, onSelect: () => void disconnect(host.id) }] : []),
    "separator",
    {
      label: "Copy address",
      icon: Copy,
      onSelect: () =>
        void writeText(`${host.username}@${host.host}`).catch((e) => notify(errorMessage(e), "error")),
    },
  ];
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Host | "new" | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return hosts;
    return hosts.filter((h) => [h.label, h.host, h.username].some((v) => v.toLowerCase().includes(q)));
  }, [hosts, query]);

  return (
    <div
      className="page"
      onContextMenu={(event) => openMenu(event, [{ label: "New host", icon: Plus, onSelect: () => setEditing("new") }])}
    >
      <div className="search-bar">
        <Search size={16} strokeWidth={1.75} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          aria-label="Search hosts"
        />
      </div>

      <div className="toolbar">
        <button type="button" className="btn btn-raised" onClick={() => setEditing("new")}>
          <Plus size={16} strokeWidth={2} />
          New host
        </button>
      </div>

      <section className="page-section">
        <h2 className="section-title">Hosts</h2>
        {hosts.length === 0 ? (
          <div className="empty">
            <Server size={28} strokeWidth={1.5} />
            <h3>No hosts</h3>
            <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
              <Plus size={16} strokeWidth={2} />
              New host
            </button>
          </div>
        ) : shown.length === 0 ? (
          <p className="muted">No matches</p>
        ) : (
          <div className="host-grid">
            {shown.map((host) => {
              const state = connecting.has(host.id) ? "connecting" : connected.has(host.id) ? "connected" : "idle";
              return (
                <div
                  key={host.id}
                  className="host-card"
                  data-state={state}
                  onContextMenu={(event) => openMenu(event, hostMenu(host, state === "connected"))}
                >
                  <button
                    type="button"
                    className="host-card-main"
                    onClick={() => (openTerminal ? openTerminal(host.id) : onOpenInSync(host))}
                  >
                    <span className="host-icon">
                      {state === "connecting" ? (
                        <Lottie data={connectingAnimation} size={40} />
                      ) : (
                        <Server size={20} strokeWidth={1.75} />
                      )}
                    </span>
                    <span className="host-text">
                      <span className="host-name">{host.label}</span>
                      <span className="host-meta">
                        ssh, {host.username}
                        {state === "connected" && <span className="status-dot" aria-label="Connected" />}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn host-edit"
                    onClick={() => setEditing(host)}
                    aria-label={`Edit ${host.label}`}
                    data-tip="Edit"
                  >
                    <Pencil size={15} strokeWidth={1.75} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {editing && <HostDialog host={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

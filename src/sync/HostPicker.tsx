import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Plus, Server } from "lucide-react";
import type { Host } from "../lib/api";
import { Lottie } from "../ui/Lottie";
import connectingAnimation from "../assets/lottie/connecting.json";

type HostPickerProps = {
  hosts: Host[];
  value: string | null;
  connected: ReadonlySet<string>;
  connecting: ReadonlySet<string>;
  onSelect: (hostId: string) => void;
  onAddHost: () => void;
};

/** The server switcher in the Server pane's header: a button that opens a list of saved hosts. */
export function HostPicker({ hosts, value, connected, connecting, onSelect, onAddHost }: HostPickerProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = hosts.find((h) => h.id === value) ?? null;

  const options = () => [...(root.current?.querySelectorAll<HTMLButtonElement>(".picker-item") ?? [])];

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // Start on the selected server so Enter keeps it and the arrows move from there.
    (root.current?.querySelector<HTMLButtonElement>('.picker-item[aria-selected="true"]') ?? options()[0])?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onBlur = () => setOpen(false);
    // Escape works even if focus wandered out of the list.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !root.current?.contains(document.activeElement)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    const list = options();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => list[(to + list.length) % list.length]?.focus();
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") close();
    else if (event.key === "Tab") close(false);
    else return;
    event.preventDefault();
  };

  const choose = (action: () => void) => {
    close();
    action();
  };

  return (
    <div className="picker" ref={root} onKeyDown={open ? onKeyDown : undefined}>
      <button
        ref={trigger}
        type="button"
        className="chip picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Server size={15} strokeWidth={1.75} />
        <span className="picker-current">{current?.label ?? "Select host"}</span>
        <ChevronDown size={14} strokeWidth={2} className="picker-chevron" />
      </button>

      {open && (
        <div className="picker-pop" role="listbox" aria-label="Servers">
          {hosts.map((host) => {
            const selected = host.id === value;
            const state = connecting.has(host.id) ? "connecting" : connected.has(host.id) ? "connected" : "idle";
            return (
              <button
                key={host.id}
                type="button"
                role="option"
                aria-selected={selected}
                className="picker-item"
                onClick={() => choose(() => onSelect(host.id))}
                onMouseEnter={(event) => event.currentTarget.focus()}
              >
                <span className="picker-icon">
                  {state === "connecting" ? (
                    <Lottie data={connectingAnimation} size={24} />
                  ) : (
                    <Server size={16} strokeWidth={1.75} />
                  )}
                </span>
                <span className="picker-text">
                  <span className="picker-name">
                    {host.label}
                    {state === "connected" && <span className="status-dot" aria-label="Connected" />}
                  </span>
                  <span className="picker-sub">
                    {host.username}@{host.host}
                    {host.port !== 22 ? `:${host.port}` : ""}
                  </span>
                </span>
                <span className="picker-check">{selected && <Check size={16} strokeWidth={2} />}</span>
              </button>
            );
          })}
          <div className="ctx-sep" role="separator" />
          <button
            type="button"
            className="picker-item picker-action"
            onClick={() => choose(onAddHost)}
            onMouseEnter={(event) => event.currentTarget.focus()}
          >
            <span className="picker-icon">
              <Plus size={16} strokeWidth={2} />
            </span>
            <span className="picker-name">New host</span>
          </button>
        </div>
      )}
    </div>
  );
}

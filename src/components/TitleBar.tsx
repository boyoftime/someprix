import type { MouseEvent } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { useContextMenu } from "../ui/ContextMenu";
import { Logo } from "./Logo";
import { inTauri } from "../window/windowFx";
import { isMac } from "../lib/platform";

type TitleBarProps = {
  maximized: boolean;
  onDragStart: (event: MouseEvent) => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
};

export function TitleBar({
  maximized,
  onDragStart,
  onMinimize,
  onToggleMaximize,
  onClose,
}: TitleBarProps) {
  const openMenu = useContextMenu();

  return (
    <header
      className="titlebar"
      onMouseDown={(event) => {
        if (event.button === 0 && !(event.target as HTMLElement).closest("button")) onDragStart(event);
      }}
      onContextMenu={(event) =>
        openMenu(event, [
          { label: "Minimize", icon: Minus, onSelect: onMinimize, disabled: !inTauri },
          {
            label: maximized ? "Restore" : "Maximize",
            icon: maximized ? Copy : Square,
            onSelect: onToggleMaximize,
            disabled: !inTauri,
          },
          "separator",
          { label: "Close", icon: X, shortcut: isMac ? "⌘Q" : "Alt+F4", onSelect: onClose, disabled: !inTauri },
        ])
      }
    >
      <div className="tab" aria-current="page">
        <Logo size={20} />
        <span>Someprix</span>
      </div>

      <div className="titlebar-drag" />

      {/* A Mac has its own buttons at the left of the title bar. */}
      {inTauri && !isMac && (
        <div className="win-controls">
          <button type="button" className="win-btn" onClick={onMinimize} aria-label="Minimize" data-tip="Minimize">
            <Minus size={16} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="win-btn"
            onClick={onToggleMaximize}
            aria-label={maximized ? "Restore" : "Maximize"}
            data-tip={maximized ? "Restore" : "Maximize"}
          >
            {maximized ? (
              <Copy size={13} strokeWidth={1.5} className="flip-x" />
            ) : (
              <Square size={13} strokeWidth={1.5} />
            )}
          </button>
          <button type="button" className="win-btn win-close" onClick={onClose} aria-label="Close" data-tip="Close">
            <X size={17} strokeWidth={1.5} />
          </button>
        </div>
      )}
    </header>
  );
}

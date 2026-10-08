import type { MouseEvent } from "react";
import { Copy, Minus, Moon, Square, Sun, X } from "lucide-react";
import { useContextMenu } from "../ui/ContextMenu";
import { Logo } from "./Logo";
import { inTauri } from "../window/windowFx";
import { isMac } from "../lib/platform";
import type { ResolvedTheme } from "../theme";

type TitleBarProps = {
  theme: ResolvedTheme;
  maximized: boolean;
  onToggleTheme: () => void;
  onDragStart: (event: MouseEvent) => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
};

export function TitleBar({
  theme,
  maximized,
  onToggleTheme,
  onDragStart,
  onMinimize,
  onToggleMaximize,
  onClose,
}: TitleBarProps) {
  const nextTheme = theme === "dark" ? "light" : "dark";
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
          { label: `${nextTheme === "light" ? "Light" : "Dark"} theme`, icon: theme === "dark" ? Sun : Moon, onSelect: onToggleTheme },
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

      <button
        type="button"
        className="tb-btn"
        onClick={onToggleTheme}
        aria-label={`${nextTheme === "light" ? "Light" : "Dark"} theme`}
        data-tip={`${nextTheme === "light" ? "Light" : "Dark"} theme`}
      >
        {theme === "dark" ? (
          <Sun size={17} strokeWidth={1.75} />
        ) : (
          <Moon size={17} strokeWidth={1.75} />
        )}
      </button>

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

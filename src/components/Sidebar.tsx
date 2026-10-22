import { useState, type CSSProperties } from "react";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ChevronsLeft,
  ChevronsRight,
  FileCode,
  FolderUp,
  Info,
  RefreshCw,
  Server,
  Settings,
  SquareTerminal,
} from "lucide-react";
import { version } from "../../package.json";
import { useEditor } from "../editor/EditorProvider";
import { useUpdates } from "../update/UpdateProvider";
import { useSpin } from "../ui/useSpin";
import { useActivity, type Activity } from "../state/activity";
import { AboutDialog } from "./AboutDialog";

/** A push or transfer still running on that page: a ring that fills (or spins until there's a
 *  measure), with what it's doing on hover. */
function ActivityRing({ activity }: { activity: Activity }) {
  const R = 7;
  const around = 2 * Math.PI * R;
  const label = activity.percent === null ? activity.label : `${activity.label}, ${activity.percent}%`;
  return (
    <span className="nav-activity" data-tip={label} aria-label={label} role="status" data-spinning={activity.percent === null ? "" : undefined}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={R} className="nav-activity-track" />
        <circle
          cx="9"
          cy="9"
          r={R}
          className="nav-activity-fill"
          strokeDasharray={around}
          strokeDashoffset={around * (1 - (activity.percent ?? 25) / 100)}
        />
      </svg>
    </span>
  );
}

export type Page = "sync" | "sftp" | "hosts" | "terminal" | "editor" | "settings";

/** Where the update button's sparks twinkle (across its width), when, and how big. */
const SPARKS = [
  { x: "10%", y: "22%", delay: "0s", size: "11px" },
  { x: "36%", y: "80%", delay: "0.7s", size: "8px" },
  { x: "60%", y: "16%", delay: "1.3s", size: "12px" },
  { x: "82%", y: "74%", delay: "0.35s", size: "9px" },
  { x: "93%", y: "26%", delay: "1.8s", size: "7px" },
];

const ITEMS: { page: Page; label: string; Icon: typeof Server }[] = [
  { page: "sync", label: "Sync", Icon: ArrowLeftRight },
  { page: "sftp", label: "SFTP", Icon: FolderUp },
  { page: "hosts", label: "Hosts", Icon: Server },
  { page: "terminal", label: "SSH Terminal", Icon: SquareTerminal },
  { page: "editor", label: "Editor", Icon: FileCode },
];

type SidebarProps = {
  page: Page;
  onNavigate: (page: Page) => void;
  /** Number of local changes waiting to be pushed, shown next to Sync. */
  pending: number;
  /** Icons only: names appear as tooltips instead. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
};

export function Sidebar({ page, onNavigate, pending, collapsed, onToggleCollapsed }: SidebarProps) {
  const unsaved = useEditor().tabs.filter((tab) => tab.dirty).length;
  const updates = useUpdates();
  const checkSpin = useSpin(updates.checking);
  const busy = useActivity();
  const [about, setAbout] = useState(false);
  return (
    <nav className="sidebar" aria-label="Main">
      {ITEMS.map(({ page: target, label, Icon }) => (
        <button
          key={target}
          type="button"
          className="nav-item"
          aria-current={page === target ? "page" : undefined}
          aria-label={collapsed ? label : undefined}
          onClick={() => onNavigate(target)}
          data-tip={collapsed ? label : undefined}
        >
          <Icon size={18} strokeWidth={1.75} />
          <span className="nav-label">{label}</span>
          {(target === "sync" || target === "sftp") && busy[target] && <ActivityRing activity={busy[target]} />}
          {target === "sync" && pending > 0 && !busy.sync && (
            <span className="nav-badge" aria-label={`${pending} changes to push`}>
              {pending}
            </span>
          )}
          {target === "editor" && unsaved > 0 && (
            <span className="nav-dot" aria-label={`${unsaved} unsaved ${unsaved === 1 ? "file" : "files"}`} />
          )}
        </button>
      ))}

      <button
        type="button"
        className="nav-item nav-about"
        aria-haspopup="dialog"
        aria-label={collapsed ? "About" : undefined}
        onClick={() => setAbout(true)}
        data-tip={collapsed ? "About" : undefined}
      >
        <Info size={18} strokeWidth={1.75} />
        <span className="nav-label">About</span>
      </button>

      <button
        type="button"
        className="nav-item nav-settings"
        aria-current={page === "settings" ? "page" : undefined}
        aria-label={collapsed ? "Settings" : undefined}
        onClick={() => onNavigate("settings")}
        data-tip={collapsed ? "Settings" : undefined}
      >
        <Settings size={18} strokeWidth={1.75} />
        <span className="nav-label">Settings</span>
      </button>

      {updates.available && (
        <button
          type="button"
          className="nav-item sidebar-update"
          onClick={updates.open}
          aria-label={`Update to ${updates.available}`}
          data-tip={collapsed ? `Update to ${updates.available}` : undefined}
        >
          <ArrowDownToLine size={18} strokeWidth={1.75} />
          <span className="nav-label">Update to {updates.available}</span>
          <span className="update-sparks" aria-hidden="true">
            {SPARKS.map((spark, i) => (
              <svg
                key={i}
                className="spark"
                viewBox="0 0 12 12"
                style={{ "--x": spark.x, "--y": spark.y, "--d": spark.delay, "--s": spark.size } as CSSProperties}
              >
                <path d="M6 0C6.5 3.6 8.4 5.5 12 6 8.4 6.5 6.5 8.4 6 12 5.5 8.4 3.6 6.5 0 6 3.6 5.5 5.5 3.6 6 0Z" />
              </svg>
            ))}
          </span>
        </button>
      )}

      <div className="sidebar-foot">
        <span className="nav-label">Version {version}</span>
        <button
          type="button"
          className="icon-btn sidebar-check"
          onClick={() => {
            checkSpin.spin();
            updates.check();
          }}
          aria-label="Check for updates"
          data-tip="Check for updates"
        >
          <RefreshCw ref={checkSpin.icon} size={14} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="icon-btn sidebar-toggle"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand menu" : "Collapse menu"}
          aria-expanded={!collapsed}
          data-tip={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? <ChevronsRight size={16} strokeWidth={1.75} /> : <ChevronsLeft size={16} strokeWidth={1.75} />}
        </button>
      </div>

      {about && <AboutDialog onClose={() => setAbout(false)} />}
    </nav>
  );
}

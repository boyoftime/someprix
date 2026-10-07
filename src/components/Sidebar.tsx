import { ArrowLeftRight, ChevronsLeft, ChevronsRight, FileCode, FolderUp, Server, SquareTerminal } from "lucide-react";
import { version } from "../../package.json";
import { useEditor } from "../editor/EditorProvider";

export type Page = "sync" | "sftp" | "hosts" | "terminal" | "editor";

const ITEMS: { page: Page; label: string; Icon: typeof Server }[] = [
  { page: "sync", label: "Sync", Icon: ArrowLeftRight },
  { page: "sftp", label: "SFTP", Icon: FolderUp },
  { page: "hosts", label: "Hosts", Icon: Server },
  { page: "terminal", label: "Terminal", Icon: SquareTerminal },
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
          {target === "sync" && pending > 0 && (
            <span className="nav-badge" aria-label={`${pending} changes to push`}>
              {pending}
            </span>
          )}
          {target === "editor" && unsaved > 0 && (
            <span className="nav-dot" aria-label={`${unsaved} unsaved ${unsaved === 1 ? "file" : "files"}`} />
          )}
        </button>
      ))}

      <div className="sidebar-foot">
        <span className="nav-label">Version {version}</span>
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
    </nav>
  );
}

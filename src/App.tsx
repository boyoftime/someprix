import { useRef, useState } from "react";
import { TitleBar } from "./components/TitleBar";
import { Sidebar, type Page } from "./components/Sidebar";
import { useTheme } from "./theme";
import { useWindowFx } from "./window/useWindowFx";
import { ResizeHandles } from "./window/ResizeHandles";
import { inTauri } from "./window/windowFx";
import { AppDataProvider, useAppData } from "./state/AppData";
import { SyncPage } from "./sync/SyncPage";
import { HostsPage } from "./hosts/HostsPage";
import { SftpPage } from "./sftp/SftpPage";
import { TrustDialog } from "./hosts/TrustDialog";
import { Toasts } from "./ui/Toasts";
import { ContextMenuProvider } from "./ui/ContextMenu";
import { Tooltips } from "./ui/Tooltips";
import { EditorProvider } from "./editor/EditorProvider";
import { EditorPage } from "./editor/EditorPage";
import { TerminalProvider } from "./terminal/TerminalProvider";
import { TerminalPage } from "./terminal/TerminalPage";
import { UpdateProvider } from "./update/UpdateProvider";

/** Whether the sidebar is folded to icons, kept between launches. */
const SIDEBAR = "someprix.sidebar";
const remembered = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; it still applies until the app closes.
  }
};

type Overlay = "editor" | "terminal";
type BasePage = Exclude<Page, Overlay>;

function Workspace() {
  const { project } = useAppData();
  // The editor and terminal show over the current page, which stays mounted meanwhile so
  // transfers and folders carry on where they were.
  const [page, setPage] = useState<BasePage>("sync");
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [requestedHostId, setRequestedHostId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => remembered(SIDEBAR) === "collapsed");
  const toggleCollapsed = () => {
    setCollapsed(!collapsed);
    remember(SIDEBAR, collapsed ? "open" : "collapsed");
  };
  const navigate = (next: Page) => {
    if (next === "editor" || next === "terminal") {
      setOverlay(next);
    } else {
      setOverlay(null);
      setPage(next);
    }
  };

  return (
    <EditorProvider onShow={() => setOverlay("editor")}>
      <TerminalProvider onShow={() => setOverlay("terminal")}>
        <UpdateProvider>
          <div className="app-body" data-sidebar={collapsed ? "collapsed" : "open"}>
            <Sidebar
              page={overlay ?? page}
              onNavigate={navigate}
              pending={project?.changes.length ?? 0}
              collapsed={collapsed}
              onToggleCollapsed={toggleCollapsed}
            />
            <main className="canvas">
              <div className="page-host" inert={overlay !== null}>
                {page === "sync" ? (
                  <SyncPage requestedHostId={requestedHostId} onRequestHandled={() => setRequestedHostId(null)} />
                ) : page === "sftp" ? (
                  <SftpPage />
                ) : (
                  <HostsPage
                    onOpenInSync={(host) => {
                      setRequestedHostId(host.id);
                      navigate("sync");
                    }}
                  />
                )}
              </div>
              <TerminalPage shown={overlay === "terminal"} />
              <EditorPage shown={overlay === "editor"} />
            </main>
            <TrustDialog />
            <Toasts />
          </div>
        </UpdateProvider>
      </TerminalProvider>
    </EditorProvider>
  );
}

export default function App() {
  const { resolved, setPref } = useTheme();
  const frameRef = useRef<HTMLDivElement>(null);
  const windowFx = useWindowFx(frameRef);

  return (
    <AppDataProvider>
      <div ref={frameRef} className="app">
        <ContextMenuProvider>
          <TitleBar
            theme={resolved}
            maximized={windowFx.maximized}
            onToggleTheme={() => setPref(resolved === "dark" ? "light" : "dark")}
            onDragStart={windowFx.startDrag}
            onMinimize={windowFx.minimize}
            onToggleMaximize={windowFx.toggleMaximize}
            onClose={windowFx.close}
          />
          <Workspace />
          <Tooltips />
        </ContextMenuProvider>
      </div>
      {inTauri && !windowFx.maximized && <ResizeHandles />}
    </AppDataProvider>
  );
}

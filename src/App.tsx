import { useRef, useState } from "react";
import { TitleBar } from "./components/TitleBar";
import { Sidebar, type Page } from "./components/Sidebar";
import { useTheme } from "./theme";
import { useWindowFx } from "./window/useWindowFx";
import { ResizeHandles } from "./window/ResizeHandles";
import { inTauri } from "./window/windowFx";
import { isMac } from "./lib/platform";
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
import { SettingsPage } from "./settings/SettingsPage";
import type { ThemePref } from "./theme";
import { remember, remembered } from "./lib/storage";
import { BusyGuard } from "./window/BusyGuard";

/** Whether the sidebar is folded to icons, kept between launches. */
const SIDEBAR = "someprix.sidebar";

type Overlay = "editor" | "terminal";
type BasePage = Exclude<Page, Overlay>;

function Workspace({ theme, onThemeChange }: { theme: ThemePref; onThemeChange: (pref: ThemePref) => void }) {
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
  // Pages open the first time they're visited, then stay open behind the others, so a push or a
  // transfer (and its progress, the folders, the selection) is still there when you come back.
  const [visited, setVisited] = useState<Set<BasePage>>(() => new Set(["sync"]));
  const navigate = (next: Page) => {
    if (next === "editor" || next === "terminal") {
      setOverlay(next);
    } else {
      setOverlay(null);
      setPage(next);
      setVisited((now) => (now.has(next) ? now : new Set(now).add(next)));
    }
  };
  const showing = (which: BasePage) => page === which && overlay === null;

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
                {visited.has("sync") && (
                  <div className="page-slot" hidden={page !== "sync"}>
                    <SyncPage
                      requestedHostId={requestedHostId}
                      onRequestHandled={() => setRequestedHostId(null)}
                      onShow={() => navigate("sync")}
                    />
                  </div>
                )}
                {visited.has("sftp") && (
                  <div className="page-slot" hidden={page !== "sftp"}>
                    <SftpPage shown={showing("sftp")} />
                  </div>
                )}
                {visited.has("hosts") && (
                  <div className="page-slot" hidden={page !== "hosts"}>
                    <HostsPage
                      onOpenInSync={(host) => {
                        setRequestedHostId(host.id);
                        navigate("sync");
                      }}
                    />
                  </div>
                )}
                {/* Settings reads everything fresh each time it opens. */}
                {page === "settings" && <SettingsPage theme={theme} onThemeChange={onThemeChange} />}
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
  const { pref, resolved, setPref } = useTheme();
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
          <Workspace theme={pref} onThemeChange={setPref} />
          <BusyGuard />
          <Tooltips />
        </ContextMenuProvider>
      </div>
      {/* A Mac window has its own edges to resize by. */}
      {inTauri && !isMac && !windowFx.maximized && <ResizeHandles />}
    </AppDataProvider>
  );
}

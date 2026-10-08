import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { open as pickFiles } from "@tauri-apps/plugin-dialog";
import { EditorView } from "@codemirror/view";
import {
  Check,
  Container,
  FileCode,
  FileCog,
  FileJson,
  FileTerminal,
  FileText,
  FolderOpen,
  Laptop,
  Lock,
  RotateCw,
  Save,
  Server,
  X,
  type LucideProps,
} from "lucide-react";
import { useAppData } from "../state/AppData";
import { CopyButton } from "../ui/CopyButton";
import { Dialog } from "../ui/Dialog";
import { Loading } from "../ui/Loading";
import { useEditor, type Cursor, type Tab } from "./EditorProvider";
import { shortcut } from "../lib/platform";

const ICONS: Record<string, ComponentType<LucideProps>> = {
  JSON: FileJson,
  Markdown: FileText,
  "Plain text": FileText,
  Config: FileCog,
  TOML: FileCog,
  Nginx: FileCog,
  YAML: FileCog,
  Shell: FileTerminal,
  PowerShell: FileTerminal,
  Dockerfile: Container,
};

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.loading) return <span className="spinner editor-tab-spinner" aria-hidden="true" />;
  const Icon = ICONS[tab.language] ?? FileCode;
  return <Icon size={14} strokeWidth={1.75} className="editor-tab-icon" />;
}

const indentLabel = (indent: string) => (indent === "\t" ? "Tabs" : `Spaces: ${indent.length}`);

/** Open files, one tab each: edit with code colours and indenting, save back where they came from. */
export function EditorPage({ shown }: { shown: boolean }) {
  const editor = useEditor();
  const { tabs, activeId, prompt, justSaved } = editor;
  const { hosts } = useAppData();
  const surface = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<Cursor>({ line: 1, col: 1, selected: 0 });
  const active = tabs.find((tab) => tab.id === activeId) ?? null;

  // One CodeMirror view for the page; each tab's state takes turns in it.
  useEffect(() => {
    const view = new EditorView({ parent: surface.current! });
    editor.onCursor(setCursor);
    editor.attach(view);
    return () => {
      editor.attach(null);
      editor.onCursor(null);
      view.destroy();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Coming back to the page: measure again (it was hidden) and carry on typing.
  useEffect(() => {
    if (shown) editor.focus();
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the active tab in view in a long strip.
  useEffect(() => {
    if (!activeId) return;
    strip.current
      ?.querySelector(`[data-tab="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  // Ctrl+S saves, Ctrl+W closes, Ctrl+Tab moves between tabs.
  useEffect(() => {
    if (!shown || prompt) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        if (activeId) void editor.save(activeId);
      } else if (key === "w") {
        event.preventDefault();
        if (activeId) editor.close(activeId);
      } else if (event.key === "Tab" && tabs.length > 1) {
        event.preventDefault();
        const at = tabs.findIndex((tab) => tab.id === activeId);
        const next = tabs[(at + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
        editor.activate(next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, prompt, tabs, activeId, editor]);

  const hostLabel = (tab: Tab) =>
    tab.source.kind === "remote" ? (hosts.find((h) => h.id === (tab.source as { hostId: string }).hostId)?.label ?? "Server") : null;
  const where = (tab: Tab) => {
    const host = hostLabel(tab);
    return host ? `${host}: ${tab.source.path}` : tab.source.path;
  };

  const openFromDisk = async () => {
    const picked = await pickFiles({ title: "Open file", multiple: true, directory: false });
    for (const path of Array.isArray(picked) ? picked : picked ? [picked] : []) editor.open({ kind: "local", path });
  };

  const onTabKey = (event: ReactKeyboardEvent, tab: Tab) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      editor.activate(tab.id);
    } else if (event.key === "Delete") {
      editor.close(tab.id);
    }
  };

  const promptTab = prompt && prompt.kind !== "quit" ? tabs.find((tab) => tab.id === prompt.id) : null;
  const unsaved = tabs.filter((tab) => tab.dirty);
  const ready = active && !active.loading;

  return (
    <section className="editor" hidden={!shown} aria-label="Editor">
      {tabs.length > 0 && (
        <div className="editor-tabs" role="tablist" aria-label="Open files" ref={strip}>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              tabIndex={tab.id === activeId ? 0 : -1}
              className="editor-tab"
              aria-selected={tab.id === activeId}
              data-tab={tab.id}
              data-dirty={tab.dirty ? "" : undefined}
              data-tip={where(tab)}
              onClick={() => editor.activate(tab.id)}
              onKeyDown={(event) => onTabKey(event, tab)}
              onMouseDown={(event) => event.button === 1 && event.preventDefault()}
              onAuxClick={(event) => event.button === 1 && editor.close(tab.id)}
            >
              <TabIcon tab={tab} />
              <span className="editor-tab-name">{tab.name}</span>
              <button
                type="button"
                className="editor-tab-close"
                tabIndex={-1}
                aria-label={tab.dirty ? `Close ${tab.name} (unsaved)` : `Close ${tab.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  editor.close(tab.id);
                }}
              >
                {tab.dirty && <span className="dirty-dot" aria-hidden="true" />}
                <X size={14} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}

      {active && (
        <div className="editor-bar">
          {active.source.kind === "remote" ? (
            <Server size={14} strokeWidth={1.75} className="editor-bar-icon" />
          ) : (
            <Laptop size={14} strokeWidth={1.75} className="editor-bar-icon" />
          )}
          {hostLabel(active) && <span className="editor-host">{hostLabel(active)}</span>}
          <span className="editor-path path-tail">
            <bdi>{active.source.path}</bdi>
          </span>
          <CopyButton text={active.source.path} label="Copy path" />
          <span className="spacer" />
          {active.readonly && (
            <span className="editor-flag">
              <Lock size={13} strokeWidth={2} />
              Read-only
            </span>
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={() => void editor.reload(active.id)}
            disabled={!ready}
            aria-label="Reload"
            data-tip="Reload"
          >
            <RotateCw size={15} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="btn btn-small btn-primary editor-save"
            onClick={() => void editor.save(active.id)}
            disabled={!ready || !active.dirty || active.saving || active.readonly}
            aria-busy={active.saving}
            data-tip={`Save (${shortcut("Ctrl+S")})`}
          >
            {active.saving ? <span className="btn-spinner" aria-hidden="true" /> : <Save size={14} strokeWidth={2} />}
            Save
          </button>
        </div>
      )}

      <div className="editor-surface" ref={surface} hidden={!ready} />
      {active?.loading && (
        <div className="editor-placeholder">
          <Loading label={`Opening ${active.name}…`} />
        </div>
      )}
      {!active && (
        <div className="pane-empty editor-empty">
          <FileCode size={30} strokeWidth={1.5} />
          <h2>No open files</h2>
          <p>Double-click a file in SFTP or Sync</p>
          <button type="button" className="btn" onClick={() => void openFromDisk()}>
            <FolderOpen size={15} strokeWidth={1.75} />
            Open file
          </button>
        </div>
      )}

      {ready && (
        <footer className="editor-status">
          <span>
            Ln {cursor.line}, Col {cursor.col}
            {cursor.selected > 0 && <span className="muted"> ({cursor.selected} selected)</span>}
          </span>
          <span className="spacer" />
          <span>{indentLabel(active.indent)}</span>
          <span>{active.eol}</span>
          <span>{active.bom ? "UTF-8 BOM" : "UTF-8"}</span>
          <span>{active.language}</span>
          <span className="editor-state" data-state={active.saving ? "saving" : justSaved === active.id ? "saved" : active.dirty ? "unsaved" : undefined}>
            {active.saving ? (
              "Saving…"
            ) : justSaved === active.id ? (
              <>
                <Check size={13} strokeWidth={2.25} />
                Saved
              </>
            ) : active.dirty ? (
              "Unsaved"
            ) : null}
          </span>
        </footer>
      )}

      {prompt?.kind === "close" && promptTab && (
        <Dialog
          title="Unsaved changes"
          onClose={() => editor.setPrompt(null)}
          footer={
            <>
              <button
                type="button"
                className="btn btn-ghost btn-danger-text"
                onClick={() => {
                  editor.setPrompt(null);
                  editor.close(promptTab.id, true);
                }}
              >
                Discard
              </button>
              <span className="spacer" />
              <button type="button" className="btn btn-ghost" onClick={() => editor.setPrompt(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                autoFocus
                onClick={async () => {
                  editor.setPrompt(null);
                  if (await editor.save(promptTab.id)) editor.close(promptTab.id, true);
                }}
              >
                Save
              </button>
            </>
          }
        >
          <p className="dialog-text">
            Save changes to <strong>{promptTab.name}</strong>?
          </p>
        </Dialog>
      )}

      {prompt?.kind === "changed" && promptTab && (
        <Dialog
          title="File changed"
          onClose={() => editor.setPrompt(null)}
          footer={
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  editor.setPrompt(null);
                  void editor.reload(promptTab.id, true);
                }}
              >
                Reload
              </button>
              <span className="spacer" />
              <button type="button" className="btn btn-ghost" onClick={() => editor.setPrompt(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  editor.setPrompt(null);
                  void editor.save(promptTab.id, true);
                }}
              >
                Overwrite
              </button>
            </>
          }
        >
          <p className="dialog-text">
            <strong>{promptTab.name}</strong> changed {promptTab.source.kind === "remote" ? "on the server" : "on disk"} since
            it was opened.
          </p>
        </Dialog>
      )}

      {prompt?.kind === "reload" && promptTab && (
        <Dialog
          title="Reload file"
          onClose={() => editor.setPrompt(null)}
          footer={
            <>
              <span className="spacer" />
              <button type="button" className="btn btn-ghost" onClick={() => editor.setPrompt(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  editor.setPrompt(null);
                  void editor.reload(promptTab.id, true);
                }}
              >
                Discard and reload
              </button>
            </>
          }
        >
          <p className="dialog-text">
            Unsaved changes to <strong>{promptTab.name}</strong> will be lost.
          </p>
        </Dialog>
      )}

      {prompt?.kind === "quit" && (
        <Dialog
          title="Unsaved changes"
          onClose={() => editor.setPrompt(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost btn-danger-text" onClick={() => void editor.quit(false)}>
                Quit without saving
              </button>
              <span className="spacer" />
              <button type="button" className="btn btn-ghost" onClick={() => editor.setPrompt(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" autoFocus onClick={() => void editor.quit(true)}>
                Save all
              </button>
            </>
          }
        >
          <ul className="editor-unsaved">
            {unsaved.map((tab) => (
              <li key={tab.id}>
                <span className="dirty-dot" aria-hidden="true" />
                <span className="editor-unsaved-name">{tab.name}</span>
                <span className="editor-unsaved-where">{hostLabel(tab) ?? "Local"}</span>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </section>
  );
}

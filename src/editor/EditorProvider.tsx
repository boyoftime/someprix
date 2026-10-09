import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { countColumn, EditorState, Text, type Extension, type StateEffect, type TransactionSpec } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { api, type TextFile } from "../lib/api";
import { errorMessage, useAppData } from "../state/AppData";
import { closeGuards } from "../window/windowFx";
import { detectIndent, languageFor } from "./languages";
import { DRAFTS, isOn } from "../settings/SettingsPage";
import { codeColours, editorChrome } from "./theme";

/** Where an open file lives. */
export type Source = { kind: "local"; path: string } | { kind: "remote"; hostId: string; path: string };

export type Tab = {
  id: string;
  source: Source;
  name: string;
  /** Still being read; the editor shows it once it arrives. */
  loading: boolean;
  /** Differs from what was last opened or saved. */
  dirty: boolean;
  saving: boolean;
  readonly: boolean;
  /** The language's name, for the status bar. */
  language: string;
  /** One level of indent: a tab, or some spaces. */
  indent: string;
  eol: "LF" | "CRLF";
  bom: boolean;
};

export type Cursor = { line: number; col: number; selected: number };

/** A question the editor is waiting on. */
export type Prompt =
  | { kind: "close"; id: string }
  | { kind: "changed"; id: string }
  | { kind: "reload"; id: string }
  | { kind: "quit" };

/** What's kept for each open file outside React: its editor state while another tab shows, the
 *  text as last saved (to tell whether it's changed), and the file version that text came from. */
type Doc = { state: EditorState; saved: Text; version: string; scroll?: StateEffect<unknown> };

type Actions = {
  open: (source: Source) => void;
  activate: (id: string) => void;
  /** Closes a tab, asking first if it has unsaved changes (unless `discard`). */
  close: (id: string, discard?: boolean) => void;
  /** Saves; `overwrite` writes even if the file changed since it was opened. True once saved. */
  save: (id: string, overwrite?: boolean) => Promise<boolean>;
  /** Reads the file again, asking first if that would discard changes (unless `discard`). */
  reload: (id: string, discard?: boolean) => Promise<void>;
  /** Answers the quit question: save everything first, or not, then close the window. */
  quit: (saveFirst: boolean) => Promise<void>;
  setPrompt: (prompt: Prompt | null) => void;
  /** The page hands over its CodeMirror view (null when it goes). */
  attach: (view: EditorView | null) => void;
  /** Where cursor moves are reported. */
  onCursor: (sink: ((cursor: Cursor) => void) | null) => void;
  focus: () => void;
};

type Editor = Actions & {
  tabs: Tab[];
  activeId: string | null;
  prompt: Prompt | null;
  /** The tab a save just finished on, for a moment. */
  justSaved: string | null;
};

const EditorContext = createContext<Editor | null>(null);
const OpenContext = createContext<((source: Source) => void) | null>(null);

export function useEditor() {
  const editor = useContext(EditorContext);
  if (!editor) throw new Error("useEditor needs an EditorProvider");
  return editor;
}

/** Opens a file in the editor. Changes only when the provider does, so lists can use it freely. */
export function useOpenInEditor() {
  return useContext(OpenContext);
}

const BLANK = EditorState.create({ extensions: [editorChrome, EditorState.readOnly.of(true)] });

const keyOf = (source: Source) =>
  source.kind === "local" ? `local:${source.path.toLowerCase()}` : `remote:${source.hostId}:${source.path}`;
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const sameText = (a: Text, b: Text) => a.length === b.length && a.eq(b);
const read = (source: Source): Promise<TextFile> =>
  source.kind === "local" ? api.readLocalText(source.path) : api.readRemoteText(source.hostId, source.path);

/** Unsaved text kept on disk, so it comes back after a crash or a power cut. */
type Draft = {
  key: string;
  source: Source;
  text: string;
  eol: "LF" | "CRLF";
  bom: boolean;
  indent: string;
  /** The file version the text started from: saving still notices changes made since. */
  version: string;
  savedAt: number;
};

/** How long typing has to pause before the draft is written. */
const DRAFT_PAUSE = 800;

function cursorOf(state: EditorState): Cursor {
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  return {
    line: line.number,
    col: countColumn(line.text.slice(0, main.head - line.from), state.tabSize) + 1,
    selected: state.selection.ranges.reduce((n, r) => n + r.to - r.from, 0),
  };
}

/** A chevron for the fold gutter: points right when folded, down when open. */
function foldMarker(open: boolean) {
  const marker = document.createElement("span");
  marker.className = "cm-fold-marker";
  if (open) marker.dataset.open = "";
  marker.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
  return marker;
}

/** Open files and everything done to them. `onShow` brings the editor page forward. */
export function EditorProvider({ onShow, children }: { onShow: () => void; children: ReactNode }) {
  const { connected, connect, notify, recordPush } = useAppData();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [justSaved, setJustSaved] = useState<string | null>(null);

  // The tab list as of now (React state lags a render behind).
  const tabsRef = useRef<Tab[]>([]);
  const docs = useRef(new Map<string, Doc>());
  const view = useRef<EditorView | null>(null);
  const active = useRef<string | null>(null);
  // The tab whose state the view is showing.
  const mounted = useRef<string | null>(null);
  const cursorSink = useRef<((cursor: Cursor) => void) | null>(null);
  const live = useRef({ onShow, connected });
  live.current = { onShow, connected };

  const commit = (next: Tab[]) => {
    tabsRef.current = next;
    setTabs(next);
  };
  const patch = (id: string, changes: Partial<Tab>) =>
    commit(tabsRef.current.map((tab) => (tab.id === id ? { ...tab, ...changes } : tab)));
  const find = (id: string) => tabsRef.current.find((tab) => tab.id === id);
  const stateOf = (id: string) => (id === mounted.current && view.current ? view.current.state : docs.current.get(id)?.state);

  // Drafts: written a moment after typing stops, dropped once the file is saved or closed.
  const draftTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const dropDraft = (id: string) => {
    clearTimeout(draftTimers.current.get(id));
    draftTimers.current.delete(id);
    void api.dropDraft(id).catch(() => {});
  };
  const keepDraft = (id: string) => {
    if (!isOn(DRAFTS)) return;
    clearTimeout(draftTimers.current.get(id));
    draftTimers.current.set(
      id,
      setTimeout(() => {
        draftTimers.current.delete(id);
        const tab = find(id);
        const doc = docs.current.get(id);
        const state = stateOf(id);
        if (!tab || !doc || !state || !tab.dirty) return;
        const draft: Draft = {
          key: id,
          source: tab.source,
          text: state.doc.toString(),
          eol: tab.eol,
          bom: tab.bom,
          indent: tab.indent,
          version: doc.version,
          savedAt: Date.now(),
        };
        void api.putDraft(id, JSON.stringify(draft)).catch(() => {});
      }, DRAFT_PAUSE),
    );
  };

  const onUpdate = (id: string, update: ViewUpdate) => {
    if (update.docChanged) {
      const doc = docs.current.get(id);
      const tab = find(id);
      const dirty = doc ? !sameText(update.state.doc, doc.saved) : false;
      if (tab && tab.dirty !== dirty) patch(id, { dirty });
      if (dirty) keepDraft(id);
      else dropDraft(id);
    }
    if ((update.docChanged || update.selectionSet) && id === mounted.current) cursorSink.current?.(cursorOf(update.state));
  };
  const updates = useRef(onUpdate);
  updates.current = onUpdate;

  const makeState = (id: string, text: string, colours: Extension | null, indent: string, readonly: boolean) =>
    EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter({ markerDOM: foldMarker }),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
        indentUnit.of(indent),
        EditorState.tabSize.of(indent === "\t" ? 4 : indent.length),
        EditorState.readOnly.of(readonly),
        indentationMarkers({
          highlightActiveBlock: true,
          markerType: "codeOnly",
          thickness: 1,
          colors: {
            light: "var(--editor-guide)",
            dark: "var(--editor-guide)",
            activeLight: "var(--editor-guide-active)",
            activeDark: "var(--editor-guide-active)",
          },
        }),
        syntaxHighlighting(codeColours),
        colours ?? [],
        editorChrome,
        EditorView.updateListener.of((update) => updates.current(id, update)),
      ],
    });

  /** Shows the active tab in the view, where it was scrolled to before. */
  const mount = () => {
    const v = view.current;
    if (!v) return;
    const doc = active.current ? docs.current.get(active.current) : undefined;
    mounted.current = doc ? active.current : null;
    v.setState(doc?.state ?? BLANK);
    if (doc?.scroll) v.dispatch({ effects: doc.scroll });
    if (doc) cursorSink.current?.(cursorOf(doc.state));
  };

  /** Keeps the showing tab's state and scroll, before another takes the view. */
  const park = () => {
    const v = view.current;
    const doc = mounted.current ? docs.current.get(mounted.current) : undefined;
    if (v && doc) {
      doc.state = v.state;
      doc.scroll = v.scrollSnapshot();
    }
    mounted.current = null;
  };

  const focus = () =>
    requestAnimationFrame(() => {
      view.current?.requestMeasure();
      if (mounted.current) view.current?.focus();
    });

  const activate = (id: string) => {
    if (id === active.current) return;
    park();
    active.current = id;
    setActiveId(id);
    mount();
    focus();
  };

  /** Removes a tab without asking; the next one along takes its place. */
  const drop = (id: string) => {
    const list = tabsRef.current;
    const at = list.findIndex((tab) => tab.id === id);
    if (at < 0) return;
    const next = list[at + 1] ?? list[at - 1] ?? null;
    if (mounted.current === id) mounted.current = null;
    docs.current.delete(id);
    dropDraft(id);
    commit(list.filter((tab) => tab.id !== id));
    if (active.current !== id) return;
    active.current = null;
    if (next) {
      activate(next.id);
    } else {
      setActiveId(null);
      mount();
    }
  };

  const open = async (source: Source) => {
    live.current.onShow();
    const id = keyOf(source);
    if (find(id)) {
      activate(id);
      focus();
      return;
    }
    const language = languageFor(source.path);
    commit([
      ...tabsRef.current,
      {
        id,
        source,
        name: baseName(source.path),
        loading: true,
        dirty: false,
        saving: false,
        readonly: false,
        language: language.label,
        indent: " ".repeat(language.indent ?? 4),
        eol: "LF",
        bom: false,
      },
    ]);
    activate(id);
    try {
      const [file, colours] = await Promise.all([read(source), language.load?.().catch(() => null) ?? null]);
      // Closed while it was loading.
      if (!find(id)) return;
      const indent = detectIndent(file.text) ?? " ".repeat(language.indent ?? 4);
      const state = makeState(id, file.text, colours, indent, file.readonly);
      docs.current.set(id, { state, saved: state.doc, version: file.version });
      patch(id, {
        loading: false,
        readonly: file.readonly,
        indent,
        eol: file.text.includes("\r\n") ? "CRLF" : "LF",
        bom: file.bom,
      });
      if (active.current === id) {
        mount();
        focus();
      }
    } catch (e) {
      drop(id);
      const message = errorMessage(e);
      // Not text after all: a file on this computer opens in its own app instead.
      if (source.kind === "local" && message.startsWith("Binary file")) {
        void openPath(source.path).catch((err) => notify(errorMessage(err), "error"));
      } else {
        notify(message, "error");
      }
    }
  };

  const close = (id: string, discard = false) => {
    const tab = find(id);
    if (!tab) return;
    if (tab.dirty && !discard) {
      activate(id);
      setPrompt({ kind: "close", id });
      return;
    }
    drop(id);
  };

  const save = async (id: string, overwrite = false) => {
    const tab = find(id);
    const doc = docs.current.get(id);
    const state = stateOf(id);
    if (!tab || !doc || !state || tab.loading || tab.saving || tab.readonly) return false;
    // What's saved is the text as of now; typing during the save makes it unsaved again.
    const snapshot = state.doc;
    const plain = snapshot.toString();
    const text = tab.eol === "CRLF" ? plain.replace(/\n/g, "\r\n") : plain;
    const { source } = tab;
    patch(id, { saving: true });
    try {
      if (source.kind === "remote" && !live.current.connected.has(source.hostId) && !(await connect(source.hostId))) {
        throw new Error("Not connected");
      }
      const expected = overwrite ? null : doc.version;
      const outcome =
        source.kind === "local"
          ? await api.saveLocalText(source.path, text, tab.bom, expected)
          : await api.saveRemoteText(source.hostId, source.path, text, tab.bom, expected);
      if (outcome.status === "changed") {
        setPrompt({ kind: "changed", id });
        return false;
      }
      doc.saved = snapshot;
      doc.version = outcome.version;
      const now = stateOf(id);
      const still = now ? !sameText(now.doc, snapshot) : false;
      patch(id, { dirty: still });
      if (still) keepDraft(id);
      else dropDraft(id);
      setJustSaved(id);
      // Server listings showing this file reload and point it out.
      if (source.kind === "remote") recordPush([source.path]);
      return true;
    } catch (e) {
      notify(errorMessage(e), "error");
      return false;
    } finally {
      patch(id, { saving: false });
    }
  };

  const reload = async (id: string, discard = false) => {
    const tab = find(id);
    const doc = docs.current.get(id);
    if (!tab || !doc || tab.loading) return;
    if (tab.dirty && !discard) {
      setPrompt({ kind: "reload", id });
      return;
    }
    try {
      const file = await read(tab.source);
      const state = stateOf(id);
      if (!state || !docs.current.has(id)) return;
      const next = state.toText(file.text);
      // One change for the whole text, so Ctrl+Z can bring back what was there.
      const spec: TransactionSpec = {
        changes: { from: 0, to: state.doc.length, insert: next },
        selection: { anchor: Math.min(state.selection.main.head, next.length) },
      };
      if (id === mounted.current && view.current) {
        view.current.dispatch(spec);
        doc.saved = view.current.state.doc;
      } else {
        doc.state = doc.state.update(spec).state;
        doc.saved = doc.state.doc;
      }
      doc.version = file.version;
      patch(id, { dirty: false, readonly: file.readonly, bom: file.bom, eol: file.text.includes("\r\n") ? "CRLF" : "LF" });
      dropDraft(id);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const quit = async (saveFirst: boolean) => {
    setPrompt(null);
    if (saveFirst) {
      for (const tab of tabsRef.current.filter((t) => t.dirty)) {
        activate(tab.id);
        if (!(await save(tab.id))) return;
      }
    } else {
      // Closing without saving: those changes were let go on purpose.
      await Promise.all(tabsRef.current.map((tab) => api.dropDraft(tab.id).catch(() => {})));
    }
    await getCurrentWindow().destroy();
  };

  /** Reopens the files that had unsaved changes when the app last stopped (a crash, a power cut). */
  const recovering = useRef(false);
  const recover = async () => {
    // Once per launch (development runs effects twice).
    if (recovering.current || !isOn(DRAFTS)) return;
    recovering.current = true;
    const drafts: Draft[] = [];
    for (const body of await api.drafts().catch(() => [] as string[])) {
      try {
        drafts.push(JSON.parse(body) as Draft);
      } catch {
        // Unreadable: skipped.
      }
    }
    let recovered = 0;
    for (const draft of drafts.sort((a, b) => a.savedAt - b.savedAt)) {
      const id = draft.key;
      if (find(id)) continue;
      // A file here that already has this text: nothing was lost.
      let saved: Text = Text.empty;
      if (draft.source.kind === "local") {
        const now = await api.readLocalText(draft.source.path).catch(() => null);
        if (now && now.text.replace(/\r\n/g, "\n") === draft.text) {
          void api.dropDraft(id).catch(() => {});
          continue;
        }
        if (now) saved = Text.of(now.text.replace(/\r\n/g, "\n").split("\n"));
      }
      const language = languageFor(draft.source.path);
      const colours = (await language.load?.().catch(() => null)) ?? null;
      // Opened meanwhile (by hand): that tab wins.
      if (find(id)) continue;
      const state = makeState(id, draft.text, colours, draft.indent, false);
      docs.current.set(id, { state, saved, version: draft.version });
      commit([
        ...tabsRef.current,
        {
          id,
          source: draft.source,
          name: baseName(draft.source.path),
          loading: false,
          dirty: true,
          saving: false,
          readonly: false,
          language: language.label,
          indent: draft.indent,
          eol: draft.eol,
          bom: draft.bom,
        },
      ]);
      if (!active.current) activate(id);
      recovered++;
    }
    if (recovered) {
      notify(`Recovered ${recovered === 1 ? "1 unsaved file" : `${recovered} unsaved files`} in the Editor`, "info", {
        label: "Show",
        run: () => live.current.onShow(),
      });
    }
  };

  const attach = (next: EditorView | null) => {
    view.current = next;
    mounted.current = null;
    if (next) mount();
  };

  const impl = { open, activate, close, save, reload, quit, attach, focus, recover };
  const latest = useRef(impl);
  latest.current = impl;
  // Stable wrappers around the latest versions, so consumers never re-render for them.
  const actions = useMemo<Actions>(
    () => ({
      open: (source) => void latest.current.open(source),
      activate: (id) => latest.current.activate(id),
      close: (id, discard) => latest.current.close(id, discard),
      save: (id, overwrite) => latest.current.save(id, overwrite),
      reload: (id, discard) => latest.current.reload(id, discard),
      quit: (saveFirst) => latest.current.quit(saveFirst),
      setPrompt,
      attach: (next) => latest.current.attach(next),
      onCursor: (sink) => {
        cursorSink.current = sink;
      },
      focus: () => void latest.current.focus(),
    }),
    [],
  );

  // Unsaved work from last time comes back.
  useEffect(() => {
    void latest.current.recover();
  }, []);

  // Closing the window with unsaved files asks first.
  useEffect(() => {
    const guard = () => {
      if (!tabsRef.current.some((tab) => tab.dirty)) return false;
      live.current.onShow();
      setPrompt({ kind: "quit" });
      return true;
    };
    closeGuards.add(guard);
    return () => {
      closeGuards.delete(guard);
    };
  }, []);

  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(null), 2200);
    return () => clearTimeout(timer);
  }, [justSaved]);

  const editor = useMemo<Editor>(
    () => ({ ...actions, tabs, activeId, prompt, justSaved }),
    [actions, tabs, activeId, prompt, justSaved],
  );

  return (
    <OpenContext.Provider value={actions.open}>
      <EditorContext.Provider value={editor}>{children}</EditorContext.Provider>
    </OpenContext.Provider>
  );
}

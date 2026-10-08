import { useEffect, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { MergeView } from "@codemirror/merge";
import { Dialog } from "../ui/Dialog";
import { Loading } from "../ui/Loading";
import { api, type Conflict } from "../lib/api";
import { formatAgo } from "../lib/format";
import { errorMessage } from "../state/AppData";
import { languageFor } from "../editor/languages";
import { codeColours } from "../editor/theme";

export type Choice = "overwrite" | "skip" | "server";

type CompareDialogProps = {
  conflict: Conflict;
  hostId: string;
  /** Where the file is on the server, and on this computer. */
  remotePath: string;
  localPath: string;
  choice: Choice | undefined;
  onChoose: (choice: Choice) => void;
  onClose: () => void;
};

/** Both sides read-only and in the app's colours: the server's lines in amber (changed there),
 *  this computer's in blue (what a push would send). */
const compareLook = EditorView.theme({
  "&": { color: "var(--text)", backgroundColor: "var(--editor-bg)", fontSize: "12.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", fontVariantLigatures: "none" },
  ".cm-content": { padding: "6px 0" },
  ".cm-line": { padding: "0 14px 0 6px" },
  ".cm-gutters": { backgroundColor: "var(--editor-bg)", color: "var(--editor-gutter)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "34px", padding: "0 6px 0 10px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--editor-selection) !important" },
  "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: "var(--compare-server-line) !important" },
  "&.cm-merge-b .cm-changedLine": { backgroundColor: "var(--compare-local-line) !important" },
  "&.cm-merge-a .cm-changedText": { background: "var(--compare-server-text) !important", borderRadius: "2px" },
  "&.cm-merge-b .cm-changedText": { background: "var(--compare-local-text) !important", borderRadius: "2px" },
  "&.cm-merge-a .cm-changedLineGutter": { background: "var(--modified) !important" },
  "&.cm-merge-b .cm-changedLineGutter": { background: "var(--accent) !important" },
  ".cm-collapsedLines": {
    padding: "4px 10px !important",
    background: "var(--raised) !important",
    color: "var(--text-muted) !important",
    fontFamily: "var(--font-ui)",
    fontSize: "12px",
  },
});

const sideExtensions = (language: Extension): Extension[] => [
  lineNumbers(),
  EditorView.lineWrapping,
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  syntaxHighlighting(codeColours),
  compareLook,
  language,
];

type Loaded = { status: "loading" } | { status: "failed"; error: string } | { status: "ready"; sameText: boolean };

/** The server's copy of a conflicting file next to this computer's, differences marked. */
export function CompareDialog({ conflict, hostId, remotePath, localPath, choice, onChoose, onClose }: CompareDialogProps) {
  const host = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    let view: MergeView | null = null;
    let gone = false;
    (async () => {
      try {
        const [server, local, language] = await Promise.all([
          api.readRemoteText(hostId, remotePath),
          api.readLocalText(localPath),
          languageFor(conflict.path).load?.() ?? Promise.resolve([]),
        ]);
        if (gone || !host.current) return;
        view = new MergeView({
          a: { doc: server.text, extensions: sideExtensions(language) },
          b: { doc: local.text, extensions: sideExtensions(language) },
          parent: host.current,
          collapseUnchanged: { margin: 3, minSize: 6 },
        });
        const plain = (text: string) => text.replace(/\r\n?/g, "\n");
        setLoaded({ status: "ready", sameText: plain(server.text) === plain(local.text) });
      } catch (error) {
        if (!gone) setLoaded({ status: "failed", error: errorMessage(error) });
      }
    })();
    return () => {
      gone = true;
      view?.destroy();
    };
  }, [conflict.path, hostId, remotePath, localPath]);

  const pick = (next: Choice) => {
    onChoose(next);
    onClose();
  };

  return (
    <Dialog
      title="Compare"
      onClose={onClose}
      width={1080}
      footer={
        <>
          <span className="spacer" />
          {(
            [
              ["overwrite", "Overwrite"],
              ["skip", "Skip"],
              ["server", "Get server version"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`btn ${choice === value ? "btn-primary" : ""}`}
              aria-pressed={choice === value}
              onClick={() => pick(value)}
            >
              {label}
            </button>
          ))}
        </>
      }
    >
      <p className="dialog-text mono compare-path">{conflict.path}</p>
      <div className="compare-heads" aria-hidden={loaded.status !== "ready"}>
        <span className="compare-head" data-side="server">
          Server
          <span className="compare-when">
            {conflict.reason === "exists" ? "modified" : "changed"} {formatAgo(conflict.serverModified)}
          </span>
        </span>
        <span className="compare-head" data-side="local">
          This computer
          <span className="compare-when">your version</span>
        </span>
      </div>
      <div className="compare-view" data-status={loaded.status}>
        <div ref={host} className="compare-host" />
        {loaded.status === "loading" && <Loading label="Loading both versions…" />}
        {loaded.status === "failed" && <p className="pane-message muted">Can't compare: {loaded.error}</p>}
      </div>
      {loaded.status === "ready" && loaded.sameText && (
        <p className="hint">Same text: only the line endings or encoding differ.</p>
      )}
    </Dialog>
  );
}

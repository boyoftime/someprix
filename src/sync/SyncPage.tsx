import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Target } from "lucide-react";
import { useAppData } from "../state/AppData";
import type { MenuItem } from "../ui/ContextMenu";
import { HostDialog } from "../hosts/HostDialog";
import { useFast } from "../ui/FastToggle";
import { LocalPane } from "./LocalPane";
import { ServerPane } from "./ServerPane";
import { PushDialog } from "./PushDialog";
import { HistoryDialog } from "./HistoryDialog";
import { Splitter, useSplit } from "./Splitter";
import { api } from "../lib/api";
import { lastOn, sameLocal } from "../lib/pairs";

const FAST_PUSH = "someprix.push.fast";

function inScope(path: string, scope: "all" | string[]) {
  return scope === "all" || scope.some((p) => path === p || path.startsWith(`${p}/`));
}

type SyncPageProps = {
  /** A host picked on the Hosts page, to show (and connect) here. */
  requestedHostId: string | null;
  onRequestHandled: () => void;
  /** Brings this page forward (Undo from a toast while another page shows). */
  onShow: () => void;
};

export function SyncPage({ requestedHostId, onRequestHandled, onShow }: SyncPageProps) {
  const { project, hosts, connected, connectionsKnown, connecting, reconnecting, connect, setTarget, openProject, notify } =
    useAppData();
  // The server shown when there's no project to remember it.
  const [looseHostId, setLooseHostId] = useState<string | null>(null);
  const [addingHost, setAddingHost] = useState(false);
  // What the push dialog covers: every change, or only those under some paths. Null when closed.
  const [pushScope, setPushScope] = useState<"all" | string[] | null>(null);
  // The push history, open; with the push to undo when it came from a push's Undo.
  const [history, setHistory] = useState<{ undoId?: string } | null>(null);
  const panes = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useSplit();
  // What the local pane's footer needs (counts, history, fast mode, Push): the divider stops there.
  const [footWidth, setFootWidth] = useState(0);
  // Fast mode: push changes as one compressed archive that the server unpacks.
  const [fast, changeFast] = useFast(FAST_PUSH);

  const hostId = project?.hostId ?? looseHostId ?? (hosts.length === 1 ? hosts[0].id : null);
  const host = hosts.find((h) => h.id === hostId) ?? null;
  const destination = project && host && project.hostId === host.id ? project.remoteDir : null;

  const selectHost = (id: string) => void switchServer(id);
  /** Another server picked: if this project has a folder there, it comes back; if not, the project
   *  last used with that server opens instead, so both sides match (or stays, if asked). */
  const switchServer = async (id: string) => {
    setLooseHostId(id);
    if (project?.hostId === id) return;
    const pairs = await api.projectPairs().catch(() => []);
    const mine = project ? pairs.find((p) => sameLocal(p.root, project.root)) : undefined;
    const other = lastOn(pairs, id);
    if (other && !mine?.destinations[id] && !(project && sameLocal(other.root, project.root))) {
      const from = project;
      const opened = await openProject(other.root);
      if (!opened) return;
      if (opened.hostId !== id) await setTarget(id, null);
      const server = hosts.find((h) => h.id === id)?.label ?? "that server";
      notify(
        `Opened ${other.name}, the project on ${server}`,
        "info",
        from ? { label: `Stay on ${from.name}`, run: () => void stay(from.root, id) } : undefined,
      );
      return;
    }
    if (project) await setTarget(id, null);
  };
  /** Back to the project that was open, on the server picked (to give it a folder there). */
  const stay = async (root: string, id: string) => {
    if (await openProject(root)) await setTarget(id, null);
  };

  useEffect(() => {
    if (!requestedHostId) return;
    selectHost(requestedHostId);
    if (!connected.has(requestedHostId)) void connect(requestedHostId);
    onRequestHandled();
  }, [requestedHostId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconnect to the project's server when the app opens (once we know it isn't already connected).
  useEffect(() => {
    if (!connectionsKnown || !host || project?.hostId !== host.id) return;
    if (!connected.has(host.id) && !connecting.has(host.id)) void connect(host.id);
  }, [connectionsKnown, project?.root, host?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const setDestination = project && host ? (path: string) => void setTarget(host.id, path) : null;

  /** "Push to this folder" for a server folder (rows, and the open folder). */
  const pushHere = (path: string): MenuItem[] => [
    {
      label: path === destination ? "Current destination" : "Set as destination",
      icon: Target,
      onSelect: () => setDestination?.(path),
      disabled: !setDestination || path === destination,
    },
  ];

  const destinationFooter = (cwd: string | null) => (
    <footer className="pane-foot">
      <span className="dest">
        <span className="dest-label">Destination</span>
        <span className="dest-path" data-tip={destination ?? undefined}>
          {destination ?? "Not set"}
        </span>
      </span>
      <span className="spacer" />
      {cwd !== null && cwd === destination ? (
        <span className="dest-done">
          <Check size={15} strokeWidth={2} />
          Current
        </span>
      ) : (
        <span className="tip-wrap" data-tip={setDestination ? undefined : "No project open"}>
          <button type="button" className="btn" onClick={() => cwd && setDestination?.(cwd)} disabled={!setDestination || !cwd}>
            <Target size={15} strokeWidth={1.75} />
            Set destination
          </button>
        </span>
      )}
    </footer>
  );

  const pushBlocker = !host
    ? "No server selected"
    : !connected.has(host.id)
      ? reconnecting.has(host.id)
        ? "Reconnecting…"
        : "Not connected"
      : !destination
        ? "No destination set"
        : null;

  return (
    <div className="sync" ref={panes} style={{ "--split": `${split * 100}%`, "--left-min": `${footWidth}px` } as CSSProperties}>
      <LocalPane
        pushBlocker={pushBlocker}
        onPush={() => setPushScope("all")}
        onPushPaths={setPushScope}
        fast={fast}
        onFastChange={changeFast}
        onShowHistory={() => setHistory({})}
        onFootWidth={setFootWidth}
      />
      <Splitter container={panes} split={split} onChange={setSplit} minLeft={footWidth} />
      <ServerPane
        hostId={hostId}
        fastDelete={fast}
        onSelectHost={selectHost}
        onAddHost={() => setAddingHost(true)}
        startDir={destination}
        // Each project has its own place on the server: its destination, else where it was last.
        rememberAs={project ? `sync.${project.root}` : "sync"}
        startFirst
        markedDir={destination}
        folderMenu={pushHere}
        footer={destinationFooter}
      />

      {addingHost && (
        <HostDialog
          onClose={() => setAddingHost(false)}
          onSaved={(saved) => {
            selectHost(saved.id);
            void connect(saved.id);
          }}
        />
      )}
      {pushScope && project && host && destination && (
        <PushDialog
          host={host}
          remoteDir={destination}
          changes={project.changes.filter((c) => inScope(c.path, pushScope))}
          only={pushScope === "all" ? undefined : pushScope}
          fast={fast}
          onClose={() => setPushScope(null)}
          onUndo={(undoId) => {
            onShow();
            setHistory({ undoId });
          }}
        />
      )}
      {history && project && <HistoryDialog undoId={history.undoId} onClose={() => setHistory(null)} />}
    </div>
  );
}

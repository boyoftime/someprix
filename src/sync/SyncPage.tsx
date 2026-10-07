import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Target } from "lucide-react";
import { useAppData } from "../state/AppData";
import type { MenuItem } from "../ui/ContextMenu";
import { HostDialog } from "../hosts/HostDialog";
import { loadFast, saveFast } from "../ui/FastToggle";
import { LocalPane } from "./LocalPane";
import { ServerPane } from "./ServerPane";
import { PushDialog } from "./PushDialog";
import { Splitter, useSplit } from "./Splitter";

const FAST_PUSH = "someprix.push.fast";

function inScope(path: string, scope: "all" | string[]) {
  return scope === "all" || scope.some((p) => path === p || path.startsWith(`${p}/`));
}

type SyncPageProps = {
  /** A host picked on the Hosts page, to show (and connect) here. */
  requestedHostId: string | null;
  onRequestHandled: () => void;
};

export function SyncPage({ requestedHostId, onRequestHandled }: SyncPageProps) {
  const { project, hosts, connected, connectionsKnown, connecting, connect, setTarget } = useAppData();
  // The server shown when there's no project to remember it.
  const [looseHostId, setLooseHostId] = useState<string | null>(null);
  const [addingHost, setAddingHost] = useState(false);
  // What the push dialog covers: every change, or only those under some paths. Null when closed.
  const [pushScope, setPushScope] = useState<"all" | string[] | null>(null);
  const panes = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useSplit();
  // Fast mode: push changes as one compressed archive that the server unpacks.
  const [fast, setFast] = useState(() => loadFast(FAST_PUSH));
  const changeFast = (on: boolean) => {
    setFast(on);
    saveFast(FAST_PUSH, on);
  };

  const hostId = project?.hostId ?? looseHostId ?? (hosts.length === 1 ? hosts[0].id : null);
  const host = hosts.find((h) => h.id === hostId) ?? null;
  const destination = project && host && project.hostId === host.id ? project.remoteDir : null;

  const selectHost = (id: string) => {
    setLooseHostId(id);
    if (project) void setTarget(id, project.hostId === id ? project.remoteDir : null);
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
      ? "Not connected"
      : !destination
        ? "No destination set"
        : null;

  return (
    <div className="sync" ref={panes} style={{ "--split": `${split * 100}%` } as CSSProperties}>
      <LocalPane
        pushBlocker={pushBlocker}
        onPush={() => setPushScope("all")}
        onPushPaths={setPushScope}
        fast={fast}
        onFastChange={changeFast}
      />
      <Splitter container={panes} split={split} onChange={setSplit} />
      <ServerPane
        hostId={hostId}
        fastDelete={fast}
        onSelectHost={selectHost}
        onAddHost={() => setAddingHost(true)}
        startDir={destination}
        rememberAs="sync"
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
        />
      )}
    </div>
  );
}

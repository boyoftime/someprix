import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
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
import { api, onGithub, type GithubAccount, type GithubStatus, type PushTarget } from "../lib/api";
import { GitHubPushDialog } from "../github/GitHubPushDialog";
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
  const { project, hosts, connected, connectionsKnown, connecting, reconnecting, connect, setTarget, openProject } = useAppData();
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
  /** Another server picked (only ever by hand): its own state comes back, the project last open
   *  with it, at its folder there. With none on record, this project stays if it has a folder
   *  there, else the most recent one that has opens. */
  const switchServer = async (id: string) => {
    setLooseHostId(id);
    if (project?.hostId === id) return;
    const pairs = await api.projectPairs().catch(() => []);
    const here = project ? pairs.find((p) => sameLocal(p.root, project.root)) : undefined;
    const last = pairs.find((p) => p.exists && p.lastFor.includes(id));
    const other = last ?? (here?.destinations[id] ? undefined : lastOn(pairs, id));
    if (other && !(project && sameLocal(other.root, project.root))) {
      await openProject(other.root, id);
      return;
    }
    if (project) await setTarget(id, null);
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

  // ---------- GitHub, for a project connected to it ----------
  const target: PushTarget = project?.pushTarget ?? "server";
  // What GitHub is missing (its own count, apart from the server's).
  const [ghStatus, setGhStatus] = useState<GithubStatus | null>(null);
  const [ghAccount, setGhAccount] = useState<GithubAccount | null>(null);
  const [githubPushing, setGithubPushing] = useState(false);
  useEffect(() => {
    const load = () => void api.githubState().then((state) => setGhAccount(state.account), () => setGhAccount(null));
    load();
    // Signing in or out happens in Settings (or while connecting).
    window.addEventListener("someprix:github", load);
    return () => window.removeEventListener("someprix:github", load);
  }, []);
  const refreshGithub = useCallback(() => {
    if (!project?.github) return setGhStatus(null);
    api.githubStatus().then(setGhStatus, () => setGhStatus(null));
  }, [project?.root, project?.github]); // eslint-disable-line react-hooks/exhaustive-deps
  // Again whenever files change (a moment later, once edits settle).
  useEffect(() => {
    const timer = window.setTimeout(refreshGithub, 400);
    return () => window.clearTimeout(timer);
  }, [refreshGithub, project?.changes]);
  const githubBlocker =
    project?.github && onGithub(project.github) && !ghAccount ? "Sign in to GitHub first (Settings › GitHub)" : null;

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

  const serverBlocker = !host
    ? "No server selected"
    : !connected.has(host.id)
      ? reconnecting.has(host.id)
        ? "Reconnecting…"
        : "Not connected"
      : !destination
        ? "No destination set"
        : null;
  // What stops the Push button, for where it goes.
  const pushBlocker = target === "github" ? githubBlocker : target === "both" ? (serverBlocker ?? githubBlocker) : serverBlocker;

  return (
    <div className="sync" ref={panes} style={{ "--split": `${split * 100}%`, "--left-min": `${footWidth}px` } as CSSProperties}>
      <LocalPane
        pushBlocker={pushBlocker}
        serverBlocker={serverBlocker}
        githubChanges={ghStatus?.changes ?? null}
        onPush={() => (target === "github" ? setGithubPushing(true) : setPushScope("all"))}
        onPushPaths={setPushScope}
        fast={fast}
        onFastChange={changeFast}
        onShowHistory={() => setHistory({})}
        onFootWidth={setFootWidth}
        serverId={hostId}
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

      {githubPushing && project && <GitHubPushDialog onClose={() => setGithubPushing(false)} onPushed={refreshGithub} />}
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
          github={target === "both" && pushScope === "all"}
          onGithubPushed={refreshGithub}
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

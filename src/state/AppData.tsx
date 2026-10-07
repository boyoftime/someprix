import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, type Host, type HostInput, type ProjectInfo } from "../lib/api";

/** A server key the user has to confirm before the connection continues. */
export type TrustRequest = {
  host: Host;
  fingerprint: string;
  /** Set when the server's key differs from the one trusted before. */
  expected?: string;
  answer: (trusted: boolean) => void;
};

export type Toast = { id: number; text: string; tone: "info" | "error" };

/** The latest push: when it finished and which server paths it wrote. */
export type PushRecord = { at: number; paths: string[] };

type AppData = {
  hosts: Host[];
  saveHost: (input: HostInput) => Promise<Host>;
  deleteHost: (id: string) => Promise<void>;

  connected: ReadonlySet<string>;
  /** False until the app has asked which connections are already open. */
  connectionsKnown: boolean;
  connecting: ReadonlySet<string>;
  /** Each connected host's home folder, where browsing starts. */
  homes: ReadonlyMap<string, string>;
  /** Connects (asking the user to trust the server if needed). Resolves to the home folder, or null. */
  connect: (hostId: string) => Promise<string | null>;
  disconnect: (hostId: string) => Promise<void>;
  /** Re-reads which connections are still alive, e.g. after a server call failed. */
  refreshConnections: () => Promise<void>;
  trustRequest: TrustRequest | null;

  project: ProjectInfo | null;
  projectLoading: boolean;
  /** Opens a project folder; resolves to the opened project, or null if it failed (already reported). */
  openProject: (root: string) => Promise<ProjectInfo | null>;
  closeProject: () => Promise<void>;
  setTarget: (hostId: string | null, remoteDir: string | null) => Promise<void>;
  /** Set after every push so server views refresh and can point out what was written. */
  lastPush: PushRecord | null;
  recordPush: (paths: string[]) => void;

  toasts: Toast[];
  notify: (text: string, tone?: Toast["tone"]) => void;
};

const AppDataContext = createContext<AppData | null>(null);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function withItem(set: ReadonlySet<string>, item: string, present: boolean) {
  const next = new Set(set);
  if (present) next.add(item);
  else next.delete(item);
  return next;
}

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [connected, setConnected] = useState<ReadonlySet<string>>(new Set());
  const [connectionsKnown, setConnectionsKnown] = useState(false);
  const [connecting, setConnecting] = useState<ReadonlySet<string>>(new Set());
  const [homes, setHomes] = useState<ReadonlyMap<string, string>>(new Map());
  const [trustRequest, setTrustRequest] = useState<TrustRequest | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [projectLoading, setProjectLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lastPush, setLastPush] = useState<PushRecord | null>(null);
  const recordPush = useCallback((paths: string[]) => setLastPush({ at: Date.now(), paths }), []);
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const toastId = useRef(0);

  const notify = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = ++toastId.current;
    setToasts((list) => [...list, { id, text, tone }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === "error" ? 7000 : 4000);
  }, []);

  useEffect(() => {
    void api.hosts().then(setHosts).catch((e) => notify(message(e), "error"));
    void api
      .connected()
      .then((ids) => setConnected(new Set(ids)))
      .finally(() => setConnectionsKnown(true));
    void api
      .currentProject()
      .then(setProject)
      .catch((e) => notify(message(e), "error"))
      .finally(() => setProjectLoading(false));
    const unlisten = api.onChanges((changes) => setProject((p) => (p ? { ...p, changes } : p)));
    return () => void unlisten.then((stop) => stop());
  }, [notify]);

  const saveHost = useCallback(async (input: HostInput) => {
    const host = await api.saveHost(input);
    setHosts((list) => (list.some((h) => h.id === host.id) ? list.map((h) => (h.id === host.id ? host : h)) : [...list, host]));
    return host;
  }, []);

  const deleteHost = useCallback(async (id: string) => {
    await api.deleteHost(id);
    setHosts((list) => list.filter((h) => h.id !== id));
    setConnected((set) => withItem(set, id, false));
  }, []);

  const askTrust = (request: Omit<TrustRequest, "answer">) =>
    new Promise<boolean>((resolve) =>
      setTrustRequest({
        ...request,
        answer: (trusted) => {
          setTrustRequest(null);
          resolve(trusted);
        },
      }),
    );

  const connect = useCallback(
    async (hostId: string) => {
      const host = hostsRef.current.find((h) => h.id === hostId);
      if (!host) return null;
      setConnecting((set) => withItem(set, hostId, true));
      try {
        // At most one trust prompt: after the user accepts the key, the retry must succeed.
        for (let attempt = 0; attempt < 2; attempt++) {
          const outcome = await api.connect(hostId);
          if (outcome.status === "connected") {
            setHomes((map) => new Map(map).set(hostId, outcome.home));
            setConnected((set) => withItem(set, hostId, true));
            return outcome.home;
          }
          const trusted = await askTrust({
            host,
            fingerprint: outcome.fingerprint,
            expected: outcome.status === "changedHost" ? outcome.expected : undefined,
          });
          if (!trusted) return null;
          await api.trust(hostId, outcome.fingerprint);
        }
        return null;
      } catch (error) {
        setConnected((set) => withItem(set, hostId, false));
        notify(message(error), "error");
        return null;
      } finally {
        setConnecting((set) => withItem(set, hostId, false));
      }
    },
    [notify],
  );

  const disconnect = useCallback(async (hostId: string) => {
    await api.disconnect(hostId);
    setConnected((set) => withItem(set, hostId, false));
  }, []);

  const refreshConnections = useCallback(async () => {
    setConnected(new Set(await api.connected()));
  }, []);

  const openProject = useCallback(
    async (root: string) => {
      setProjectLoading(true);
      try {
        const opened = await api.openProject(root);
        setProject(opened);
        return opened;
      } catch (error) {
        notify(message(error), "error");
        return null;
      } finally {
        setProjectLoading(false);
      }
    },
    [notify],
  );

  const closeProject = useCallback(async () => {
    await api.closeProject();
    setProject(null);
  }, []);

  const setTarget = useCallback(async (hostId: string | null, remoteDir: string | null) => {
    await api.setTarget(hostId, remoteDir);
    setProject((p) => (p ? { ...p, hostId, remoteDir } : p));
  }, []);

  const value = useMemo<AppData>(
    () => ({
      hosts,
      saveHost,
      deleteHost,
      connected,
      connectionsKnown,
      connecting,
      homes,
      connect,
      disconnect,
      refreshConnections,
      trustRequest,
      project,
      projectLoading,
      openProject,
      closeProject,
      setTarget,
      lastPush,
      recordPush,
      toasts,
      notify,
    }),
    [
      hosts,
      saveHost,
      deleteHost,
      connected,
      connectionsKnown,
      connecting,
      homes,
      connect,
      disconnect,
      refreshConnections,
      trustRequest,
      project,
      projectLoading,
      openProject,
      closeProject,
      setTarget,
      lastPush,
      recordPush,
      toasts,
      notify,
    ],
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData() {
  const data = useContext(AppDataContext);
  if (!data) throw new Error("useAppData must be used inside AppDataProvider");
  return data;
}

export { message as errorMessage };

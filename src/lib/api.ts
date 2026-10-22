import { invoke, type Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { pathSeparator } from "./platform";

export type AuthMethod = "password" | "key";

export type Host = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyPath: string | null;
};

export type HostInput = Omit<Host, "id"> & {
  id?: string;
  /** New password or key passphrase; leave out to keep the saved one. */
  secret?: string;
};

export type ConnectOutcome =
  | { status: "connected"; home: string }
  | { status: "unknownHost"; fingerprint: string }
  | { status: "changedHost"; fingerprint: string; expected: string };

export type RemoteEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number | null;
};

export type ChangeKind = "added" | "modified" | "deleted";
export type Change = { path: string; kind: ChangeKind };

export type LocalEntry = { name: string; path: string; isDir: boolean };

export type ProjectInfo = {
  root: string;
  name: string;
  hostId: string | null;
  remoteDir: string | null;
  changes: Change[];
  /** Project paths (files or folders) excluded from pushing. */
  excluded: string[];
  /** Pushes keep a backup on the server of what they replace or delete. */
  backup: boolean;
  /** This project's own choice; null follows the setting for all projects. */
  backupChoice: boolean | null;
  /** The GitHub repository it's connected to ("owner/name", or an address for another host). */
  github: string | null;
  /** Where Push goes. */
  pushTarget: PushTarget;
};

export type PushTarget = "server" | "github" | "both";

/** Whether a connected repository is on GitHub (it needs signing in), not some other host. */
export const onGithub = (repo: string) =>
  repo.split("/").length === 2 && !repo.includes(":") && !repo.includes("\\") && !repo.startsWith("git@");

export type GithubAccount = { login: string; name: string | null; id: number };
export type GithubState = { account: GithubAccount | null; deviceFlow: boolean };
export type DeviceCode = { deviceCode: string; userCode: string; verificationUri: string; interval: number };
export type DevicePoll = { status: "waiting" } | { status: "slowDown" } | { status: "done"; account: GithubAccount };
/** The project against GitHub: what a push would send. */
export type GithubStatus = {
  repo: string;
  /** Its page on GitHub (null for another host). */
  url: string | null;
  branch: string;
  changes: Change[];
  /** About to go and looking like secrets (.env, keys…). */
  secrets: string[];
};
export type GithubPushed =
  | { outcome: "pushed"; files: number; branch: string; commit: string }
  | { outcome: "nothing" }
  | { outcome: "behind" };
export type GithubPulled = { outcome: "upToDate" } | { outcome: "merged"; files: number };
export type GithubProgress = { stage: "fetching" | "committing" | "uploading" | "merging"; done: number; total: number };

export type PushProgress = {
  done: number;
  total: number;
  path: string | null;
  /** Missing from older builds; the bar then counts files. */
  bytesDone?: number;
  bytesTotal?: number;
  /** Everything has arrived and is being moved into place; too late to cancel. */
  finishing?: boolean;
  /** Extra steps: packing the files here, unpacking them on the server, putting them in place. */
  stage?: "packing" | "unpacking" | "placing";
};
/** `fast`: the files went as one compressed archive. */
/** One item in the Properties dialog; folders are counted through. */
export type ItemProps = {
  name: string;
  path: string;
  isDir: boolean;
  link: boolean;
  size: number;
  files: number;
  folders: number;
  modified: number | null;
  created: number | null;
  /** Server only, e.g. "drwxr-xr-x (755)". */
  mode: string | null;
  /** Server only, "user:group". */
  owner: string | null;
  readonly: boolean | null;
  hidden: boolean | null;
  /** Some contents couldn't be read; totals may be low. */
  partial: boolean;
};
export type PushReport = {
  uploaded: number;
  deleted: number;
  fast?: boolean;
  /** Stopped by Cancel before anything changed on the server. */
  cancelled?: boolean;
  /** Old copies kept in the backup, and ones replaced or deleted without one. */
  backedUp?: number;
  notBackedUp?: number;
  /** The history entry Undo takes back; none when nothing changed. */
  history?: string | null;
};

/** A server file's size and modified time (seconds). */
export type ServerSig = { size: number; mtime: number };

/** One push or SFTP upload, as it changed the server. */
export type HistoryEntry = {
  id: string;
  /** Seconds since 1970. */
  at: number;
  hostId: string;
  remoteDir: string;
  /** Where the old copies are on the server; null when there's no backup. */
  backupDir: string | null;
  files: {
    path: string;
    action: "added" | "changed" | "deleted";
    /** The old copy is in the backup. */
    backedUp: boolean;
    size: number;
    after: ServerSig | null;
  }[];
  createdDirs: string[];
};

export type UndoReport = {
  /** Files changed on the server since: nothing was undone yet. Ask, then undo with force. */
  changedSince: string[];
  done: boolean;
  restored: number;
  removed: number;
  /** Files with no backup, left as they are. */
  missed: number;
};

export type BackupMode = "all" | "chosen" | "off";

export type Settings = {
  backups: BackupMode;
  backupSftp: boolean;
  keepPushes: number;
  keepDays: number;
  maxBackupMb: number;
  skipOverMb: number;
  backupRoot: string;
};

/** A project folder Someprix knows, and its own backup choice (null: the setting for all). */
export type ProjectChoice = { root: string; name: string; backup: boolean | null };

/** A folder on this computer Someprix knows, and the server folder it's paired with. */
export type ProjectPair = {
  root: string;
  name: string;
  /** The server and folder in use. */
  hostId: string | null;
  remoteDir: string | null;
  /** Its folder on each server it was paired with (host id → folder), the one in use included. */
  destinations: Record<string, string>;
  /** The servers it was the project last open with in Sync. */
  lastFor: string[];
  /** Last opened in Sync (Unix milliseconds); 0 if never. */
  opened: number;
  /** Still there on this computer. */
  exists: boolean;
};

/** A file a push would send (or delete) whose server copy changed since it was last pushed. */
export type Conflict = {
  path: string;
  /** The local change the push would send. */
  kind: ChangeKind;
  /** "changed": changed on the server since the last push. "exists": new here, but the server has a different file by that name. */
  reason: "changed" | "exists";
  serverSize: number;
  /** Seconds since 1970. */
  serverModified: number;
};

/** A file or folder anywhere on this computer (the SFTP page's local side). */
export type LocalFsEntry = { name: string; path: string; isDir: boolean; size: number; modified: number | null };
export type UploadReport = {
  /** Went as one compressed archive (fast mode). */
  fast?: boolean;
  files: number;
  folders: number;
  bytes: number;
  written: string[];
  /** The upload was cancelled and what it had sent was removed again. */
  cancelled: boolean;
  /** Items a cancelled upload couldn't remove from the server. */
  leftovers: number;
  /** The history entry Undo takes back (uploads that changed anything). */
  history?: string | null;
  /** Old copies of replaced files kept in the backup. */
  backedUp?: number;
};

/** A text file opened in the editor. */
export type TextFile = {
  text: string;
  /** Starts with a UTF-8 byte order mark; saving keeps it. */
  bom: boolean;
  /** Which version of the file this is; handed back on save to catch changes made meanwhile. */
  version: string;
  /** This computer only: the file is marked read-only. */
  readonly: boolean;
};

/** How a terminal session ended: the shell's exit code, or why it stopped otherwise. */
export type TerminalEnded = {
  exitCode: number | null;
  reason: string | null;
  /** The connection went (the shell didn't exit and nobody closed it). */
  lost: boolean;
};

/** A save either wrote the file, or found someone else had changed it since it was opened. */
export type SaveOutcome = { status: "saved"; version: string } | { status: "changed" };

/** Tauri rejects with the Rust error string; surface it as a normal Error. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(typeof error === "string" ? error : String(error));
  }
}

export const api = {
  hosts: () => call<Host[]>("hosts_list"),
  saveHost: (input: HostInput) => call<Host>("host_save", { input }),
  deleteHost: (id: string) => call<void>("host_delete", { id }),

  connect: (hostId: string) => call<ConnectOutcome>("ssh_connect", { hostId }),
  trust: (hostId: string, fingerprint: string) => call<void>("ssh_trust", { hostId, fingerprint }),
  disconnect: (hostId: string) => call<void>("ssh_disconnect", { hostId }),
  connected: () => call<string[]>("ssh_connected"),
  listRemote: (hostId: string, path: string) => call<RemoteEntry[]>("ssh_list", { hostId, path }),
  makeRemoteDir: (hostId: string, path: string) => call<void>("ssh_mkdir", { hostId, path }),
  /** Creates an empty file; fails rather than replace an existing one. */
  createRemoteFile: (hostId: string, path: string) => call<void>("ssh_create_file", { hostId, path }),
  /** Deletes files and folders (with everything inside); returns how many items went. */
  deleteRemote: (hostId: string, paths: string[], fast = false) => call<number>("ssh_delete", { hostId, paths, fast }),

  /** With `hostId`, on that server (switching projects keeps the server); without, on the one it had. */
  openProject: (root: string, hostId?: string | null) => call<ProjectInfo>("project_open", { root, hostId: hostId ?? null }),
  currentProject: () => call<ProjectInfo | null>("project_current"),
  closeProject: () => call<void>("project_close"),
  listLocal: (dir: string) => call<LocalEntry[]>("project_list", { dir }),
  /** The open project's server and folder; with no folder, the one it had on that server before. */
  setTarget: (hostId: string | null, remoteDir: string | null) =>
    call<ProjectInfo>("project_set_target", { hostId, remoteDir }),
  /** Every project folder on the list, most recently opened first, with its server folders. */
  projectPairs: () => call<ProjectPair[]>("project_pairs"),
  /** Pairs any local folder with a folder on that server (null folder: unpairs it from that server). */
  pairFolder: (root: string, hostId: string, remoteDir: string | null) =>
    call<void>("project_pair_set", { root, hostId, remoteDir }),
  /** Takes a folder off the list of projects; opening it again puts it back. */
  forgetProject: (root: string) => call<void>("project_forget", { root }),
  /** Clears the project's changes (all, or those at or under `paths`): the folder as it is now
   *  counts as what's on the server. Files aren't touched, here or there. */
  clearChanges: (paths?: string[]) => call<ProjectInfo>("project_accept", { paths: paths ?? null }),
  /** Refresh: reads the whole project folder again (for anything the watcher missed). */
  rescanProject: () => call<ProjectInfo>("project_rescan"),

  githubState: () => call<GithubState>("github_state"),
  githubDeviceStart: () => call<DeviceCode>("github_device_start"),
  githubDevicePoll: (deviceCode: string) => call<DevicePoll>("github_device_poll", { deviceCode }),
  githubSignInToken: (token: string) => call<GithubAccount>("github_sign_in_token", { token }),
  githubSignOut: () => call<void>("github_sign_out"),
  /** The address the open project's folder already pushes to with git, if any. */
  githubDetect: () => call<string | null>("github_detect"),
  /** Connects the open project: a new repository (`create`), or an existing one ("owner/name" or an address). */
  githubConnect: (repo: string, create: boolean, isPrivate: boolean) =>
    call<ProjectInfo>("github_connect", { repo, create, private: isPrivate }),
  githubDisconnect: () => call<ProjectInfo>("github_disconnect"),
  setPushTarget: (target: PushTarget) => call<ProjectInfo>("project_push_target", { target }),
  githubStatus: () => call<GithubStatus>("github_status"),
  githubPush: (message: string) => call<GithubPushed>("github_push", { message }),
  githubPull: () => call<GithubPulled>("github_pull"),
  /** Keeps files off GitHub: into .gitignore (and out of git; they stay on disk). */
  githubIgnore: (paths: string[]) => call<void>("github_ignore", { paths }),
  /** Excludes project paths from pushing (or, with `exclude` false, includes them again). */
  excludeFromPush: (paths: string[], exclude: boolean) => call<ProjectInfo>("project_exclude", { paths, exclude }),
  /** Pushes every change, or with `only`, the changes at or under those project paths; `skip` stays behind. */
  push: (includeDeletions: boolean, only?: string[], fast = false, skip: string[] = []) =>
    call<PushReport>("project_push", { includeDeletions, only: only ?? null, fast, skip }),
  /** Stops the running push; what it sent is removed again (too late once files are being placed). */
  cancelPush: () => call<void>("project_push_cancel"),
  /** The open project's pushes, newest first. */
  pushHistory: () => call<HistoryEntry[]>("project_history"),
  /** Undoes the latest push; without `force` it first reports files changed on the server since. */
  undoPush: (id: string, force = false) => call<UndoReport>("project_undo", { id, force }),
  /** Deletes the open project's backups on its server (the history stays). */
  clearPushBackups: () => call<HistoryEntry[]>("project_backups_clear"),
  sftpHistory: () => call<HistoryEntry[]>("sftp_history"),
  undoUpload: (id: string, force = false) => call<UndoReport>("sftp_undo", { id, force }),
  clearUploadBackups: (hostId: string) => call<HistoryEntry[]>("sftp_backups_clear", { hostId }),

  settings: () => call<Settings>("settings_get"),
  saveSettings: (settings: Settings) => call<void>("settings_set", { settings }),
  backupProjects: () => call<ProjectChoice[]>("backup_projects"),
  setProjectBackup: (root: string, backup: boolean | null) => call<void>("project_backup_set", { root, backup }),

  /** Unsaved editor text kept on disk (each a JSON string the editor wrote). */
  drafts: () => call<string[]>("drafts_list"),
  putDraft: (key: string, body: string) => call<void>("draft_put", { key, body }),
  dropDraft: (key: string) => call<void>("draft_drop", { key }),
  clearDrafts: () => call<void>("drafts_clear"),

  /** The files a push would send that someone changed on the server since they were last pushed. */
  conflicts: (includeDeletions: boolean, only?: string[]) =>
    call<Conflict[]>("project_conflicts", { includeDeletions, only: only ?? null }),
  /** Replaces project files with the server copies; the local ones go to the Recycle Bin (Trash). */
  takeServer: (paths: string[]) => call<number>("project_take_server", { paths }),

  localHome: () => call<string>("local_home"),
  /** Lists a folder on this computer; an empty path lists the drives (Windows) or "/". */
  localList: (path: string) => call<LocalFsEntry[]>("local_list", { path }),
  /** Uploads files and folders (with everything inside) into a server folder. */
  upload: (hostId: string, sources: string[], remoteDir: string, fast = false) =>
    call<UploadReport>("sftp_upload", { hostId, sources, remoteDir, fast }),
  /** Stops the running upload; it removes what it already put on the server. */
  localProperties: (paths: string[]) => call<ItemProps[]>("local_properties", { paths }),
  remoteProperties: (hostId: string, paths: string[]) => call<ItemProps[]>("ssh_properties", { hostId, paths }),
  /** Stops a Properties count that's still running. */
  cancelProperties: () => call<void>("properties_cancel"),
  /** The user's Downloads folder. */
  localDownloads: () => call<string>("local_downloads"),
  /** Moves files and folders on this computer to the Recycle Bin (Trash). */
  trashLocal: (paths: string[]) => call<number>("local_delete", { paths }),
  /** Downloads server files and folders into a folder on this computer. */
  download: (hostId: string, sources: string[], localDir: string, fast = false) =>
    call<UploadReport>("sftp_download", { hostId, sources, localDir, fast }),
  /** Stops the running upload or download, which then undoes itself. */
  cancelTransfer: () => call<void>("sftp_cancel"),
  onTransferProgress: (handler: (progress: PushProgress) => void): Promise<UnlistenFn> =>
    listen<PushProgress>("sftp://transfer-progress", (event) => handler(event.payload)),

  /** Opens a shell on a connected host, in `startDir` if given. `output` gets raw bytes, then one
   *  TerminalEnded. With `motd`, the server's login message comes first. */
  openTerminal: (
    hostId: string,
    cols: number,
    rows: number,
    output: Channel<ArrayBuffer | TerminalEnded>,
    startDir: string | null = null,
    motd = false,
  ) => call<number>("terminal_open", { hostId, cols, rows, output, startDir, motd }),
  writeTerminal: (id: number, data: number[]) => call<void>("terminal_write", { id, data }),
  resizeTerminal: (id: number, cols: number, rows: number) => call<void>("terminal_resize", { id, cols, rows }),
  closeTerminal: (id: number) => call<void>("terminal_close", { id }),

  readLocalText: (path: string) => call<TextFile>("local_read_text", { path }),
  /** `expected`: the version that was opened; null writes whatever is there now. */
  saveLocalText: (path: string, text: string, bom: boolean, expected: string | null) =>
    call<SaveOutcome>("local_save_text", { path, text, bom, expected }),
  readRemoteText: (hostId: string, path: string) => call<TextFile>("ssh_read_text", { hostId, path }),
  saveRemoteText: (hostId: string, path: string, text: string, bom: boolean, expected: string | null) =>
    call<SaveOutcome>("ssh_save_text", { hostId, path, text, bom, expected }),

  onChanges: (handler: (changes: Change[]) => void): Promise<UnlistenFn> =>
    listen<Change[]>("project://changes", (event) => handler(event.payload)),
  /** The excluded list, when a .git, .venv or node_modules folder comes or goes (they start out excluded). */
  onExcluded: (handler: (excluded: string[]) => void): Promise<UnlistenFn> =>
    listen<string[]>("project://excluded", (event) => handler(event.payload)),
  onGithubProgress: (handler: (progress: GithubProgress) => void): Promise<UnlistenFn> =>
    listen<GithubProgress>("github://progress", (event) => handler(event.payload)),
  onPushProgress: (handler: (progress: PushProgress) => void): Promise<UnlistenFn> =>
    listen<PushProgress>("project://push-progress", (event) => handler(event.payload)),
};

/** A project-relative path ("src/app.js") as a full path under the project folder on this computer. */
export function localPath(root: string, rel: string) {
  if (!rel) return root;
  const base = root.replace(/[\\/]+$/, "");
  return `${base}${pathSeparator}${pathSeparator === "/" ? rel : rel.replace(/\//g, "\\")}`;
}

export function joinRemote(dir: string, name: string) {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

export function parentRemote(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

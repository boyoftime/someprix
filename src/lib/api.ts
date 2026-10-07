import { invoke, type Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
};

export type PushProgress = {
  done: number;
  total: number;
  path: string | null;
  /** Missing from older builds; the bar then counts files. */
  bytesDone?: number;
  bytesTotal?: number;
  /** Everything has arrived and is being moved into place; too late to cancel. */
  finishing?: boolean;
  /** Fast mode's extra steps: packing the files here, unpacking them on the server. */
  stage?: "packing" | "unpacking";
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
export type PushReport = { uploaded: number; deleted: number; fast?: boolean };

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

  openProject: (root: string) => call<ProjectInfo>("project_open", { root }),
  currentProject: () => call<ProjectInfo | null>("project_current"),
  closeProject: () => call<void>("project_close"),
  listLocal: (dir: string) => call<LocalEntry[]>("project_list", { dir }),
  setTarget: (hostId: string | null, remoteDir: string | null) =>
    call<void>("project_set_target", { hostId, remoteDir }),
  /** Excludes project paths from pushing (or, with `exclude` false, includes them again). */
  excludeFromPush: (paths: string[], exclude: boolean) => call<ProjectInfo>("project_exclude", { paths, exclude }),
  /** Pushes every change, or with `only`, the changes at or under those project paths. */
  push: (includeDeletions: boolean, only?: string[], fast = false) =>
    call<PushReport>("project_push", { includeDeletions, only: only ?? null, fast }),

  localHome: () => call<string>("local_home"),
  /** Lists a folder on this computer; an empty path lists the drives. */
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
  /** Moves files and folders on this computer to the Recycle Bin. */
  trashLocal: (paths: string[]) => call<number>("local_delete", { paths }),
  /** Downloads server files and folders into a folder on this computer. */
  download: (hostId: string, sources: string[], localDir: string, fast = false) =>
    call<UploadReport>("sftp_download", { hostId, sources, localDir, fast }),
  /** Stops the running upload or download, which then undoes itself. */
  cancelTransfer: () => call<void>("sftp_cancel"),
  onTransferProgress: (handler: (progress: PushProgress) => void): Promise<UnlistenFn> =>
    listen<PushProgress>("sftp://transfer-progress", (event) => handler(event.payload)),

  /** Opens a shell on a connected host, in `startDir` if given. `output` gets raw bytes, then one TerminalEnded. */
  openTerminal: (
    hostId: string,
    cols: number,
    rows: number,
    output: Channel<ArrayBuffer | TerminalEnded>,
    startDir: string | null = null,
  ) => call<number>("terminal_open", { hostId, cols, rows, output, startDir }),
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
  onPushProgress: (handler: (progress: PushProgress) => void): Promise<UnlistenFn> =>
    listen<PushProgress>("project://push-progress", (event) => handler(event.payload)),
};

/** A project-relative path ("src/app.js") as a full Windows path under the project folder. */
export function localPath(root: string, rel: string) {
  if (!rel) return root;
  return `${root.replace(/[\\/]+$/, "")}\\${rel.replace(/\//g, "\\")}`;
}

export function joinRemote(dir: string, name: string) {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

export function parentRemote(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

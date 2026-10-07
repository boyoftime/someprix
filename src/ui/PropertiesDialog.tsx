import { useEffect, useState, type ReactNode } from "react";
import { File, Files, Folder } from "lucide-react";
import { api, type ItemProps } from "../lib/api";
import { formatSize } from "../lib/format";
import { errorMessage } from "../state/AppData";
import { Dialog } from "./Dialog";

type PropertiesDialogProps = {
  items: { name: string; path: string; isDir: boolean }[];
  /** Gets the properties (folders counted through), in the same order as `items`. */
  load: () => Promise<ItemProps[]>;
  onClose: () => void;
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const when = (seconds: number | null | undefined) => (seconds ? dateFormat.format(new Date(seconds * 1000)) : "—");
const count = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const sizeText = (bytes: number) => `${formatSize(bytes)} (${bytes.toLocaleString()} bytes)`;

/** The folder a path sits in, for Windows or server paths alike. */
function parentOf(path: string) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? path.slice(0, cut + 1) || "/" : path.slice(0, cut);
}

function typeOf(item: { name: string; isDir: boolean }, link: boolean) {
  if (item.isDir) return link ? "Folder (link)" : "Folder";
  const dot = item.name.lastIndexOf(".");
  const ext = dot > 0 ? item.name.slice(dot + 1).toUpperCase() : "";
  return `${ext ? `${ext} file` : "File"}${link ? " (link)" : ""}`;
}

function Calculating() {
  return (
    <span className="props-calculating">
      <span className="spinner" aria-hidden="true" />
      Calculating…
    </span>
  );
}

/** Size, contents, dates and access details for one or more files and folders. */
export function PropertiesDialog({ items, load, onClose }: PropertiesDialogProps) {
  const [props, setProps] = useState<ItemProps[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    load().then(
      (loaded) => live && setProps(loaded),
      (e) => live && setError(errorMessage(e)),
    );
    // Closing stops a count that's still walking a big folder.
    return () => {
      live = false;
      void api.cancelProperties().catch(() => undefined);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const single = items.length === 1 ? items[0] : null;
  const one = single && props ? props[0] : null;
  const parents = new Set(items.map((i) => parentOf(i.path)));
  const location = parents.size === 1 ? [...parents][0] : "Multiple folders";
  const partial = props?.some((p) => p.partial) ?? false;

  const totalSize = props?.reduce((n, p) => n + p.size, 0) ?? 0;
  const totalFiles = props?.reduce((n, p) => n + p.files, 0) ?? 0;
  const dirsSelected = items.filter((i) => i.isDir).length;
  const totalFolders = (props?.reduce((n, p) => n + p.folders, 0) ?? 0) + (single ? 0 : dirsSelected);

  const Icon = single ? (single.isDir ? Folder : File) : Files;
  const rows: [string, ReactNode][] = [];
  rows.push(["Type", single ? typeOf(single, one?.link ?? false) : `${count(dirsSelected, "folder")}, ${count(items.length - dirsSelected, "file")}`]);
  rows.push(["Location", <span className="mono">{location}</span>]);
  rows.push(["Size", props ? sizeText(totalSize) : error ? "—" : <Calculating />]);
  if (!single || single.isDir) {
    rows.push(["Contains", props ? `${count(totalFiles, "file")}, ${count(totalFolders, "folder")}` : error ? "—" : <Calculating />]);
  }
  if (one) {
    rows.push(["Modified", when(one.modified)]);
    if (one.created) rows.push(["Created", when(one.created)]);
    if (one.mode) rows.push(["Permissions", <span className="mono">{one.mode}</span>]);
    if (one.owner) rows.push(["Owner", <span className="mono">{one.owner}</span>]);
    const flags = [one.readonly && "Read-only", one.hidden && "Hidden"].filter(Boolean);
    if (flags.length) rows.push(["Attributes", flags.join(", ")]);
  }

  return (
    <Dialog
      title="Properties"
      onClose={onClose}
      width={520}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="props-head">
        <Icon size={28} strokeWidth={1.5} className={single?.isDir ? "tree-icon folder" : "tree-icon"} />
        <span className="props-name">{single ? single.name : `${items.length} items`}</span>
      </div>
      <dl className="props-grid">
        {rows.map(([label, value]) => (
          <div key={label} className="props-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {!single && (
        <ul className="props-list" aria-label="Items">
          {items.map((item, i) => (
            <li key={item.path}>
              {item.isDir ? (
                <Folder size={15} strokeWidth={1.75} className="tree-icon folder" />
              ) : (
                <File size={15} strokeWidth={1.75} className="tree-icon" />
              )}
              <span className="props-item-name">{item.name}</span>
              <span className="props-item-size">{props ? formatSize(props[i]?.size ?? 0) : error ? "—" : <span className="spinner" />}</span>
            </li>
          ))}
        </ul>
      )}
      {partial && <p className="muted props-note">Some folders couldn't be read; totals may be low.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

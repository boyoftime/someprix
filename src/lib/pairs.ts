import { joinRemote, type ProjectPair } from "./api";
import { isWindows } from "./platform";

/** A local path in a form to compare by: no trailing separator; on Windows, backslashes and any case. */
function comparable(path: string) {
  if (!isWindows) return path.replace(/\/+$/, "");
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

const separator = isWindows ? "\\" : "/";

/** Whether two local paths are the same folder. */
export function sameLocal(a: string, b: string) {
  return comparable(a) === comparable(b);
}

/** Where `path` is inside `root`, as "a/b" ("" for the root itself), or null if it isn't. */
function inside(root: string, path: string): string | null {
  const top = comparable(root);
  const here = comparable(path);
  if (here === top) return "";
  if (!here.startsWith(top + separator)) return null;
  return path
    .slice(top.length + 1)
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("/");
}

/** The pair a local folder belongs to (it, or the nearest folder it's in that's paired with a server folder). */
export function pairFor(pairs: ProjectPair[], path: string): ProjectPair | null {
  let best: ProjectPair | null = null;
  for (const pair of pairs) {
    if (!pair.hostId || !pair.remoteDir || inside(pair.root, path) === null) continue;
    if (!best || comparable(pair.root).length > comparable(best.root).length) best = pair;
  }
  return best;
}

/** The server folder that matches a local folder in `pair`: its server folder, plus the same way down. */
export function mirror(pair: ProjectPair, path: string): string {
  const rest = inside(pair.root, path);
  const top = pair.remoteDir ?? "/";
  return rest ? joinRemote(top, rest) : top;
}

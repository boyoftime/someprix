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
    if (!Object.keys(pair.destinations).length || inside(pair.root, path) === null) continue;
    if (!best || comparable(pair.root).length > comparable(best.root).length) best = pair;
  }
  return best;
}

/** Where a pair goes: its folder on `hostId` if it has one there, else on the server it uses. */
export function placeFor(pair: ProjectPair, hostId: string | null): { hostId: string; dir: string } | null {
  if (hostId && pair.destinations[hostId]) return { hostId, dir: pair.destinations[hostId] };
  if (pair.hostId && pair.remoteDir) return { hostId: pair.hostId, dir: pair.remoteDir };
  const [first] = Object.entries(pair.destinations);
  return first ? { hostId: first[0], dir: first[1] } : null;
}

/** The project last used with a server: one using it now (most recently opened first), else any
 *  with a folder there. `pairs` comes most recently opened first. */
export function lastOn(pairs: ProjectPair[], hostId: string): ProjectPair | null {
  return (
    pairs.find((p) => p.exists && p.hostId === hostId && p.remoteDir) ??
    pairs.find((p) => p.exists && p.destinations[hostId]) ??
    null
  );
}

/** The server folder that matches a local folder in `pair`: `dir` (its folder there), plus the same way down. */
export function mirror(pair: ProjectPair, dir: string, path: string): string {
  const rest = inside(pair.root, path);
  return rest ? joinRemote(dir, rest) : dir;
}

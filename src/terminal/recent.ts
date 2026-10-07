import { remember, remembered } from "../lib/storage";

/** Host ids, most recently opened in a terminal first. */
const RECENT = "someprix.terminal.recent";

export function recentHosts(): string[] {
  try {
    const list = JSON.parse(remembered(RECENT) ?? "[]");
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Puts a host at the front of the recent list. */
export function markRecent(hostId: string) {
  remember(RECENT, JSON.stringify([hostId, ...recentHosts().filter((id) => id !== hostId)].slice(0, 20)));
}

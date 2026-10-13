import { useSyncExternalStore } from "react";

/** Work that keeps running while you look at another page: a push, an SFTP transfer. */
export type Activity = {
  /** What it's doing, e.g. "Pushing 4 files". */
  label: string;
  /** 0–100, or null while there's nothing to measure yet. */
  percent: number | null;
};

export type ActivityKey = "sync" | "sftp";

// A store of its own (not app state), so progress ticks only redraw what shows them.
let state: Partial<Record<ActivityKey, Activity>> = {};
const listeners = new Set<() => void>();

/** Reports (or with null, clears) what a page is busy with. Only real changes notify. */
export function setActivity(key: ActivityKey, activity: Activity | null) {
  const now = state[key];
  const next = activity ? { ...activity, percent: activity.percent === null ? null : Math.floor(activity.percent) } : undefined;
  if (now?.label === next?.label && now?.percent === next?.percent) return;
  state = { ...state, [key]: next };
  for (const listener of listeners) listener();
}

export function busyWith(): Partial<Record<ActivityKey, Activity>> {
  return state;
}

export function useActivity() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

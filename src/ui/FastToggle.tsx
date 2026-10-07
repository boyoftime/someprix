import { Zap } from "lucide-react";

/** The ⚡ switch for fast mode: transfers go as one compressed archive the other end unpacks. */
export function FastToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className="fast-toggle"
      aria-pressed={on}
      aria-label="Fast mode"
      onClick={() => onChange(!on)}
      data-tip={on ? "Fast mode: on" : "Fast mode: off"}
    >
      <Zap size={16} strokeWidth={2} />
    </button>
  );
}

/** Fast mode's setting for one place in the app, remembered between runs. */
export function loadFast(key: string) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function saveFast(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Not remembered; fine.
  }
}

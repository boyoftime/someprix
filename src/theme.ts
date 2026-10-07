import { useEffect, useState } from "react";

export type ThemePref = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "someprix.theme";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

function readPref(): ThemePref {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light" || saved === "system") return saved;
  } catch {
    // Storage unavailable: fall through to the default.
  }
  return "dark";
}

function resolve(pref: ThemePref): ResolvedTheme {
  if (pref === "system") return matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
  return pref;
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(pref));

  useEffect(() => {
    const apply = () => {
      const next = resolve(pref);
      setResolved(next);
      document.documentElement.dataset.theme = next;
    };
    apply();

    try {
      localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      // Not persisted; the choice still applies for this session.
    }

    if (pref !== "system") return;
    const query = matchMedia(LIGHT_QUERY);
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [pref]);

  return { pref, resolved, setPref };
}

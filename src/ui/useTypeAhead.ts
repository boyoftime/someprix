import { useCallback, useRef, type KeyboardEvent } from "react";

/** A pause this long starts a new search instead of extending the current one. */
const RESET_AFTER = 900;

/**
 * Explorer-style "type to jump" for a list of rows. Pressing a letter moves focus to the next
 * row whose name starts with it; pressing it again cycles through those rows; typing several
 * letters quickly narrows to the first name that starts with all of them.
 *
 * Rows are found in the DOM (`rowSelector` inside `container`), named by their `.tree-name`.
 */
export function useTypeAhead() {
  const query = useRef("");
  const typedAt = useRef(0);

  const onKey = useCallback((event: KeyboardEvent, container: HTMLElement | null, rowSelector: string) => {
    if (!container || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return null;
    if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return null;

    const now = performance.now();
    const continuing = now - typedAt.current < RESET_AFTER && query.current !== "";
    // A space only counts inside a name being typed ("program f…"), never to start one.
    if (event.key === " " && !continuing) return null;
    query.current = (continuing ? query.current : "") + event.key.toLowerCase();
    typedAt.current = now;

    const rows = [...container.querySelectorAll<HTMLElement>(rowSelector)];
    if (!rows.length) return null;
    const active = document.activeElement;
    const current = rows.findIndex((row) => row === active || row.contains(active));
    // "ppp" means "the third p", not "a name starting with ppp".
    const sameLetter = [...query.current].every((c) => c === query.current[0]);
    const needle = sameLetter ? query.current[0] : query.current;
    // One letter moves past the current row; a longer prefix may still match it.
    const start = current < 0 ? 0 : current + (needle.length === 1 ? 1 : 0);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[(start + i) % rows.length];
      const name = row.querySelector(".tree-name")?.textContent?.trim().toLowerCase() ?? "";
      if (name.startsWith(needle)) {
        event.preventDefault();
        row.focus();
        row.scrollIntoView({ block: "nearest" });
        return row;
      }
    }
    return null;
  }, []);

  return { onKey };
}

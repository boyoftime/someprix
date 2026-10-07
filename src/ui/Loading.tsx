/** A list's "Loading…" line, with a spinning ring in front of it. */
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="pane-message muted pane-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

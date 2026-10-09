/** An on/off switch with its label (and an optional line under it), the whole row clickable. */
export function Switch({
  on,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className="switch-row"
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {hint && <span className="switch-hint">{hint}</span>}
      </span>
      <span className="switch" aria-hidden="true">
        <span className="switch-knob" />
      </span>
    </button>
  );
}

import { Ban } from "lucide-react";
import { Dialog } from "../ui/Dialog";

type ExcludedDialogProps = {
  excluded: string[];
  /** Puts paths back into pushing. */
  onInclude: (paths: string[]) => void;
  onClose: () => void;
};

/** Everything left out of pushing in this project, with a way to put each back. */
export function ExcludedDialog({ excluded, onInclude, onClose }: ExcludedDialogProps) {
  return (
    <Dialog
      title="Excluded from push"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onInclude(excluded)}
            disabled={excluded.length === 0}
          >
            Include all
          </button>
          <span className="spacer" />
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {excluded.length === 0 ? (
        <p className="dialog-text muted">Nothing excluded. Right-click a file or folder to exclude it.</p>
      ) : (
        <ul className="excluded-list">
          {excluded.map((path) => (
            <li key={path}>
              <Ban size={14} strokeWidth={2} className="excluded-icon" />
              <span className="excluded-path" data-tip={path}>
                {path}
              </span>
              <button type="button" className="btn btn-small" onClick={() => onInclude([path])}>
                Include
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

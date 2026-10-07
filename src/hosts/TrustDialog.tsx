import { TriangleAlert } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { useAppData } from "../state/AppData";

/** Asks the user to confirm a server's key the first time (or when it has changed). */
export function TrustDialog() {
  const { trustRequest } = useAppData();
  if (!trustRequest) return null;
  const { host, fingerprint, expected, answer } = trustRequest;
  const changed = Boolean(expected);

  return (
    <Dialog
      title={changed ? "Host key changed" : "Unknown host"}
      onClose={() => answer(false)}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={() => answer(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={changed ? "btn btn-danger" : "btn btn-primary"}
            onClick={() => answer(true)}
          >
            {changed ? "Trust new key" : "Trust"}
          </button>
        </>
      }
    >
      {changed ? (
        <div className="callout callout-danger">
          <TriangleAlert size={18} strokeWidth={1.75} />
          <p>Key mismatch: {host.host}. Possible reinstall or interception.</p>
        </div>
      ) : (
        <p className="dialog-text">
          First connection: <strong>{host.host}</strong>
        </p>
      )}
      <dl className="fingerprints">
        {changed && (
          <>
            <dt>Saved</dt>
            <dd>{expected}</dd>
          </>
        )}
        <dt>{changed ? "Received" : "Fingerprint"}</dt>
        <dd>{fingerprint}</dd>
      </dl>
    </Dialog>
  );
}

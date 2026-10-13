import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Dialog } from "../ui/Dialog";
import { busyWith } from "../state/activity";
import { closeGuards } from "./windowFx";

/** Asks before the window closes while a push or a transfer is still running. */
export function BusyGuard() {
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const guard = () => {
      const running = Object.values(busyWith()).filter((a) => a !== undefined);
      if (!running.length) return false;
      setBusy(running.map((a) => a.label.charAt(0).toLowerCase() + a.label.slice(1)).join(", and "));
      return true;
    };
    closeGuards.add(guard);
    return () => {
      closeGuards.delete(guard);
    };
  }, []);

  if (!busy) return null;
  return (
    <Dialog
      title="Quit while it's still working?"
      onClose={() => setBusy(null)}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={() => setBusy(null)}>
            Keep working
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void getCurrentWindow().destroy()}>
            Quit anyway
          </button>
        </>
      }
    >
      <p className="dialog-text">
        Someprix is still {busy}. Quitting stops it partway: nothing half-sent replaces a file, but what didn't finish has to go
        again next time.
      </p>
    </Dialog>
  );
}

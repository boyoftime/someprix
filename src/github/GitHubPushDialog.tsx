import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Dialog } from "../ui/Dialog";
import { useAppData } from "../state/AppData";
import { GithubPushPanel, type GithubPhase } from "./GithubPushPanel";

/** How long "Pushed" stays before the dialog closes. */
const DONE_PAUSE = 900;

/** Push to GitHub: what goes, a message for it, then up it goes. */
export function GitHubPushDialog({ onClose, onPushed }: { onClose: () => void; onPushed: () => void }) {
  const { notify } = useAppData();
  const [go, setGo] = useState(0);
  const [phase, setPhase] = useState<GithubPhase>({ phase: "loading" });

  useEffect(() => {
    if (phase.phase !== "done") return;
    onPushed();
    const timer = window.setTimeout(() => {
      const url = phase.url;
      notify(phase.text, "info", url ? { label: "Open on GitHub", run: () => void openUrl(url) } : undefined);
      onClose();
    }, DONE_PAUSE);
    return () => window.clearTimeout(timer);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = phase.phase === "pushing";
  const action =
    phase.phase === "ready"
      ? { label: phase.files ? `Push ${phase.files} ${phase.files === 1 ? "file" : "files"}` : "Nothing to push", disabled: !phase.canPush || !phase.files }
      : phase.phase === "failed"
        ? { label: "Try again", disabled: false }
        : phase.phase === "done"
          ? { label: "Pushed", disabled: true }
          : { label: phase.phase === "loading" ? "Checking…" : "Pushing…", disabled: true };

  return (
    <Dialog
      title="Push to GitHub"
      onClose={onClose}
      locked={busy}
      width={560}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {phase.phase === "done" ? "Close" : "Cancel"}
          </button>
          {phase.phase !== "behind" && (
            <button type="button" className="btn btn-primary" onClick={() => setGo((n) => n + 1)} disabled={action.disabled}>
              {action.label}
            </button>
          )}
        </>
      }
    >
      <GithubPushPanel go={go} onPhase={setPhase} />
    </Dialog>
  );
}

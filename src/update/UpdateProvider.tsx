import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { version as currentVersion } from "../../package.json";
import { errorMessage, useAppData } from "../state/AppData";
import { useEditor } from "../editor/EditorProvider";
import { formatSize } from "../lib/format";
import { Dialog } from "../ui/Dialog";
import { Loading } from "../ui/Loading";
import { inTauri } from "../window/windowFx";
import { AUTO_UPDATES, isOn } from "../settings/SettingsPage";

/** First look for a new version this long after launch, then this often while the app is open. */
const FIRST_CHECK = 4000;
const CHECK_EVERY = 6 * 60 * 60 * 1000;

type Step = "closed" | "checking" | "latest" | "available" | "saving" | "downloading" | "installing" | "failed";

type Updates = {
  /** The newer version found on GitHub, if any. */
  available: string | null;
  checking: boolean;
  /** Looks for a new version and shows what it found. */
  check: () => void;
  /** Shows the update that was found. */
  open: () => void;
};

const UpdatesContext = createContext<Updates | null>(null);

export function useUpdates() {
  const updates = useContext(UpdatesContext);
  if (!updates) throw new Error("useUpdates needs an UpdateProvider");
  return updates;
}

/** The updater's errors, in words a person can act on. */
function describe(error: unknown) {
  const text = errorMessage(error);
  if (/valid release JSON|404/i.test(text)) return "No update info on GitHub yet.";
  if (/signature/i.test(text)) return "The download isn't signed by Someprix, so it wasn't installed.";
  if (/sending request|dns|connect|timed? ?out|network/i.test(text)) return "Can't reach GitHub. Check the connection.";
  return text;
}

/**
 * Keeps Someprix up to date from its GitHub releases: checks on launch and every few hours, and
 * on demand. Updating saves open editor files, downloads the new installer (checked against
 * Someprix's signing key), installs it and opens the app again. Hosts, saved passwords and
 * settings live outside the app folder, so an update never touches them.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const { notify } = useAppData();
  const editor = useEditor();
  const [found, setFound] = useState<Update | null>(null);
  const [checking, setChecking] = useState(false);
  const [step, setStep] = useState<Step>("closed");
  const [progress, setProgress] = useState<{ done: number; total: number | null }>({ done: 0, total: null });
  const [problem, setProblem] = useState("");
  const busy = useRef(false);
  const live = useRef({ notify, found, editor });
  live.current = { notify, found, editor };

  const run = async (manual: boolean) => {
    if (busy.current) {
      if (manual) setStep("checking");
      return;
    }
    busy.current = true;
    setChecking(true);
    if (manual) setStep("checking");
    try {
      const update = await check({ timeout: 30000 });
      const previous = live.current.found;
      if (previous && previous !== update) void previous.close().catch(() => {});
      setFound(update);
      if (manual) setStep(update ? "available" : "latest");
      else if (update && update.version !== previous?.version) live.current.notify(`Update ${update.version} available`);
    } catch (error) {
      // A background check that fails (offline, say) just tries again later.
      if (manual) {
        setProblem(describe(error));
        setStep("failed");
      }
    } finally {
      busy.current = false;
      setChecking(false);
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!inTauri) return;
    // Unless switched off in Settings (the button still checks).
    const auto = () => isOn(AUTO_UPDATES) && void runRef.current(false);
    const first = setTimeout(auto, FIRST_CHECK);
    const every = setInterval(auto, CHECK_EVERY);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);

  const install = async () => {
    const update = found;
    if (!update) return;
    // The update closes the app at once, so open files are saved first.
    const unsaved = editor.tabs.filter((tab) => tab.dirty);
    if (unsaved.length) {
      setStep("saving");
      for (const tab of unsaved) {
        if (!(await editor.save(tab.id))) {
          setProblem(`${tab.name} wasn't saved, so the update was stopped. Save or close it, then try again.`);
          setStep("failed");
          return;
        }
      }
    }
    setProgress({ done: 0, total: null });
    setStep("downloading");
    try {
      let done = 0;
      await update.download((event) => {
        if (event.event === "Started") {
          setProgress({ done: 0, total: event.data.contentLength ?? null });
        } else if (event.event === "Progress") {
          done += event.data.chunkLength;
          setProgress((p) => ({ ...p, done }));
        }
      });
      setStep("installing");
      // On Windows the app closes here; the installer finishes and opens it again.
      await update.install();
    } catch (error) {
      setProblem(describe(error));
      setStep("failed");
    }
  };

  const updates = useMemo<Updates>(
    () => ({
      available: found?.version ?? null,
      checking,
      check: () => void runRef.current(true),
      open: () => setStep(live.current.found ? "available" : "closed"),
    }),
    [found, checking],
  );

  const close = () => setStep("closed");
  const working = step === "saving" || step === "downloading" || step === "installing";
  const unsaved = editor.tabs.filter((tab) => tab.dirty).length;
  const percent = progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  return (
    <UpdatesContext.Provider value={updates}>
      {children}
      {step !== "closed" && (
        <Dialog
          title={
            step === "checking"
              ? "Check for updates"
              : step === "latest"
                ? "Up to date"
                : step === "available"
                  ? "Update available"
                  : step === "failed"
                    ? "Update stopped"
                    : "Updating"
          }
          onClose={close}
          locked={working}
          footer={
            step === "available" ? (
              <>
                <span className="spacer" />
                <button type="button" className="btn btn-ghost" onClick={close}>
                  Later
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void install()}>
                  Update now
                </button>
              </>
            ) : step === "failed" ? (
              <>
                <span className="spacer" />
                <button type="button" className="btn btn-ghost" onClick={close}>
                  Close
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void (found ? install() : run(true))}>
                  Try again
                </button>
              </>
            ) : working ? null : (
              <>
                <span className="spacer" />
                <button type="button" className="btn btn-primary" onClick={close}>
                  OK
                </button>
              </>
            )
          }
        >
          {step === "checking" && <Loading label="Checking GitHub…" />}
          {step === "latest" && <p className="dialog-text">Someprix {currentVersion} is the latest version.</p>}
          {step === "available" && found && (
            <div className="update-body">
              <p className="update-version">
                Someprix {found.version}
                <span className="muted"> (you have {found.currentVersion})</span>
              </p>
              {found.body?.trim() && <div className="update-notes">{found.body.trim()}</div>}
              <p className="dialog-text muted">
                Someprix closes, installs the update and opens again. Hosts, passwords and settings are kept.
                {unsaved > 0 && ` ${unsaved} unsaved ${unsaved === 1 ? "file is" : "files are"} saved first.`}
              </p>
            </div>
          )}
          {step === "saving" && <Loading label="Saving open files…" />}
          {step === "downloading" && (
            <div className="update-progress" role="status">
              <div className="update-track">
                <div className="update-fill" style={{ width: `${percent ?? 0}%` }} />
              </div>
              <p className="update-progress-text">
                <span>Downloading</span>
                <span className="muted">
                  {formatSize(progress.done)}
                  {progress.total ? ` of ${formatSize(progress.total)}` : ""}
                </span>
              </p>
            </div>
          )}
          {step === "installing" && <Loading label="Installing. Someprix restarts in a moment…" />}
          {step === "failed" && <p className="dialog-text">{problem}</p>}
        </Dialog>
      )}
    </UpdatesContext.Provider>
  );
}

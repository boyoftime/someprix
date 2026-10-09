import { useEffect, useState } from "react";
import { api, type BackupMode, type ProjectChoice, type Settings } from "../lib/api";
import { remember, remembered } from "../lib/storage";
import { errorMessage, useAppData } from "../state/AppData";
import type { ThemePref } from "../theme";
import { loadFast, saveFast } from "../ui/FastToggle";
import { Loading } from "../ui/Loading";
import { Switch } from "../ui/Switch";

/** Settings kept in this window (the rest live with the app's data). */
export const DRAFTS = "someprix.editor.drafts";
export const AUTO_UPDATES = "someprix.updates.auto";
const FAST_PUSH = "someprix.push.fast";
const FAST_SFTP = "someprix.sftp.fast";

/** On unless switched off. */
export const isOn = (key: string) => remembered(key) !== "off";

const MODES: [BackupMode, string][] = [
  ["all", "Every project"],
  ["chosen", "Projects I choose"],
  ["off", "Off"],
];

const THEMES: [ThemePref, string][] = [
  ["system", "Match system"],
  ["light", "Light"],
  ["dark", "Dark"],
];

/** A whole number setting, saved when the field is left (or Enter). */
function NumberField({
  label,
  unit,
  value,
  min,
  max,
  onSave,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  onSave: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const parsed = Math.round(Number(text));
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : value;
    setText(String(next));
    if (next !== value) onSave(next);
  };
  return (
    <label className="field settings-number">
      <span>{label}</span>
      <span className="settings-number-input">
        <input
          type="number"
          min={min}
          max={max}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
        <span className="settings-unit">{unit}</span>
      </span>
    </label>
  );
}

export function SettingsPage({ theme, onThemeChange }: { theme: ThemePref; onThemeChange: (pref: ThemePref) => void }) {
  const { notify, refreshProject } = useAppData();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [root, setRoot] = useState("");
  // The ones kept in this window, mirrored so the switches move at once.
  const [local, setLocal] = useState(() => ({
    drafts: isOn(DRAFTS),
    updates: isOn(AUTO_UPDATES),
    fastPush: loadFast(FAST_PUSH),
    fastSftp: loadFast(FAST_SFTP),
  }));

  useEffect(() => {
    void api
      .settings()
      .then((s) => {
        setSettings(s);
        setRoot(s.backupRoot);
      })
      .catch((e) => notify(errorMessage(e), "error"));
    void api.backupProjects().then(setProjects).catch(() => setProjects([]));
  }, [notify]);

  const save = (changes: Partial<Settings>) => {
    if (!settings) return;
    const next = { ...settings, ...changes };
    setSettings(next);
    void api
      .saveSettings(next)
      .then(refreshProject)
      .catch((e) => notify(errorMessage(e), "error"));
  };

  const setProject = (project: ProjectChoice, on: boolean) => {
    setProjects((list) => list.map((p) => (p.root === project.root ? { ...p, backup: on } : p)));
    void api
      .setProjectBackup(project.root, on)
      .then(refreshProject)
      .catch((e) => notify(errorMessage(e), "error"));
  };

  const setLocalSwitch = (name: keyof typeof local, on: boolean) => {
    setLocal((now) => ({ ...now, [name]: on }));
    if (name === "drafts") {
      remember(DRAFTS, on ? "on" : "off");
      if (!on) void api.clearDrafts();
    }
    if (name === "updates") remember(AUTO_UPDATES, on ? "on" : "off");
    if (name === "fastPush") saveFast(FAST_PUSH, on);
    if (name === "fastSftp") saveFast(FAST_SFTP, on);
  };

  const off = settings?.backups === "off";

  return (
    <div className="page settings-page">
      <h1 className="settings-title">Settings</h1>

      <section className="settings-section" aria-labelledby="set-look">
        <h2 id="set-look" className="section-title">
          Appearance
        </h2>
        <div className="settings-row">
          <span className="settings-label">Theme</span>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {THEMES.map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={theme === value} onClick={() => onThemeChange(value)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="set-backups">
        <h2 id="set-backups" className="section-title">
          Backups on the server
        </h2>
        <p className="hint settings-intro">
          Before a push replaces or deletes files on the server, Someprix keeps the old copies there, so you can undo the push
          from Push history in Sync. They take no extra space until a file is replaced, and the oldest are removed by
          themselves.
        </p>
        {!settings ? (
          <Loading />
        ) : (
          <>
            <div className="settings-row">
              <span className="settings-label">Back up</span>
              <div className="segmented" role="radiogroup" aria-label="Back up">
                {MODES.map(([value, label]) => (
                  <button key={value} type="button" role="radio" aria-checked={settings.backups === value} onClick={() => save({ backups: value })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {!off && projects.length > 0 && (
              <div className="settings-list" aria-label="Projects">
                {projects.map((project) => (
                  <Switch
                    key={project.root}
                    on={project.backup ?? settings.backups === "all"}
                    onChange={(on) => setProject(project, on)}
                    label={project.name}
                    hint={project.root}
                  />
                ))}
              </div>
            )}

            <div className="settings-list">
              <Switch
                on={!off && settings.backupSftp}
                disabled={off}
                onChange={(on) => save({ backupSftp: on })}
                label="Also back up files that SFTP uploads replace"
                hint="An upload on the SFTP page can then be undone too."
              />
            </div>

            <div className="settings-grid">
              <NumberField label="Keep the last" unit="pushes" value={settings.keepPushes} min={1} max={1000} onSave={(v) => save({ keepPushes: v })} />
              <NumberField label="For at most" unit="days" value={settings.keepDays} min={1} max={3650} onSave={(v) => save({ keepDays: v })} />
              <NumberField label="Up to" unit="MB per project" value={settings.maxBackupMb} min={1} max={1_000_000} onSave={(v) => save({ maxBackupMb: v })} />
              <NumberField label="Skip files over" unit="MB" value={settings.skipOverMb} min={0} max={1_000_000} onSave={(v) => save({ skipOverMb: v })} />
            </div>

            <label className="field settings-root">
              <span>Backup folder on the server</span>
              <input
                value={root}
                spellCheck={false}
                onChange={(e) => setRoot(e.target.value)}
                onBlur={() => root.trim() !== settings.backupRoot && save({ backupRoot: root.trim() || "~/.someprix/backups" })}
                onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
              />
              <span className="hint">~ is your login's home folder. Keep it outside your website's folder, so visitors can't reach it.</span>
            </label>
          </>
        )}
      </section>

      <section className="settings-section" aria-labelledby="set-transfers">
        <h2 id="set-transfers" className="section-title">
          Transfers
        </h2>
        <div className="settings-list">
          <Switch
            on={local.fastPush}
            onChange={(on) => setLocalSwitch("fastPush", on)}
            label="Fast mode for pushes"
            hint="Many files travel as one compressed archive. Needs tar on the server."
          />
          <Switch
            on={local.fastSftp}
            onChange={(on) => setLocalSwitch("fastSftp", on)}
            label="Fast mode for SFTP uploads and downloads"
          />
        </div>
      </section>

      <section className="settings-section" aria-labelledby="set-editor">
        <h2 id="set-editor" className="section-title">
          Editor
        </h2>
        <div className="settings-list">
          <Switch
            on={local.drafts}
            onChange={(on) => setLocalSwitch("drafts", on)}
            label="Keep drafts of unsaved files"
            hint="Text you haven't saved comes back after a crash or a power cut."
          />
        </div>
      </section>

      <section className="settings-section" aria-labelledby="set-updates">
        <h2 id="set-updates" className="section-title">
          Updates
        </h2>
        <div className="settings-list">
          <Switch
            on={local.updates}
            onChange={(on) => setLocalSwitch("updates", on)}
            label="Check for updates by itself"
            hint="When it's off, check with the button next to the version number."
          />
        </div>
      </section>
    </div>
  );
}

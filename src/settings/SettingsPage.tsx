import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArchiveRestore, Download, FileCode, Monitor, Moon, Palette, RefreshCw, Search, Sun, Zap, type LucideIcon } from "lucide-react";
import { version } from "../../package.json";
import { api, type BackupMode, type ProjectChoice, type Settings } from "../lib/api";
import { remember, remembered } from "../lib/storage";
import { errorMessage, useAppData } from "../state/AppData";
import type { ThemePref } from "../theme";
import { loadFast, saveFast } from "../ui/FastToggle";
import { Loading } from "../ui/Loading";
import { Switch } from "../ui/Switch";
import { useUpdates } from "../update/UpdateProvider";
import { useSpin } from "../ui/useSpin";

/** Settings kept in this window (the rest live with the app's data). */
export const DRAFTS = "someprix.editor.drafts";
export const AUTO_UPDATES = "someprix.updates.auto";
const FAST_PUSH = "someprix.push.fast";
const FAST_SFTP = "someprix.sftp.fast";

/** On unless switched off. */
export const isOn = (key: string) => remembered(key) !== "off";

const MODES: [BackupMode, string][] = [
  ["off", "Off"],
  ["all", "Every project"],
  ["chosen", "Projects I choose"],
];

const THEMES: [ThemePref, string, LucideIcon][] = [
  ["system", "System", Monitor],
  ["light", "Light", Sun],
  ["dark", "Dark", Moon],
];

/** One group of settings: an icon, a title, a line on what it's for, then its rows. */
function Card({ icon: Icon, tone, title, about, children }: { icon: LucideIcon; tone: string; title: string; about: string; children: ReactNode }) {
  return (
    <section className="set-card" aria-label={title}>
      <header className="set-card-head">
        <span className="set-icon" data-tone={tone} aria-hidden="true">
          <Icon size={18} strokeWidth={1.9} />
        </span>
        <span className="set-card-text">
          <h2>{title}</h2>
          <p>{about}</p>
        </span>
      </header>
      <div className="set-card-body">{children}</div>
    </section>
  );
}

/** A labelled row: what it is on the left, the control on the right. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <span className="set-row-text">
        <span className="set-row-label">{label}</span>
        {hint && <span className="set-row-hint">{hint}</span>}
      </span>
      <span className="set-row-control">{children}</span>
    </div>
  );
}

/** A whole number, saved when the field is left (or Enter). */
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
    <label className="set-number">
      <span className="set-number-label">{label}</span>
      <span className="set-number-field">
        <input
          type="number"
          min={min}
          max={max}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
        <span>{unit}</span>
      </span>
    </label>
  );
}

export function SettingsPage({ theme, onThemeChange }: { theme: ThemePref; onThemeChange: (pref: ThemePref) => void }) {
  const { notify, refreshProject } = useAppData();
  const updates = useUpdates();
  const checkSpin = useSpin(updates.checking);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [filter, setFilter] = useState("");
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

  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase();
    return words ? projects.filter((p) => `${p.name} ${p.root}`.toLowerCase().includes(words)) : projects;
  }, [projects, filter]);
  const on = settings !== null && settings.backups !== "off";
  const backedUp = (project: ProjectChoice) => project.backup ?? settings?.backups === "all";

  return (
    <div className="page settings-page">
      <div className="settings-inner">
        <header className="settings-head">
          <h1>Settings</h1>
          <p>Changes take effect as you make them.</p>
        </header>

        <Card icon={Palette} tone="violet" title="Appearance" about="How Someprix looks.">
          <Row label="Theme">
            <div className="segmented set-segmented" role="radiogroup" aria-label="Theme">
              {THEMES.map(([value, label, Icon]) => (
                <button key={value} type="button" role="radio" aria-checked={theme === value} onClick={() => onThemeChange(value)}>
                  <Icon size={14} strokeWidth={2} />
                  {label}
                </button>
              ))}
            </div>
          </Row>
        </Card>

        <Card
          icon={ArchiveRestore}
          tone="green"
          title="Backups on the server"
          about="Keep the files a push replaces or deletes, so the push can be undone from Push history."
        >
          {!settings ? (
            <Loading />
          ) : (
            <>
              <Row label="Back up before pushing">
                <div className="segmented set-segmented" role="radiogroup" aria-label="Back up before pushing">
                  {MODES.map(([value, label]) => (
                    <button key={value} type="button" role="radio" aria-checked={settings.backups === value} onClick={() => save({ backups: value })}>
                      {label}
                    </button>
                  ))}
                </div>
              </Row>

              {!on ? (
                <p className="set-note">
                  Pushes replace files on the server without keeping the old ones. Turn backups on to be able to undo a push.
                </p>
              ) : (
                <>
                  <div className="set-projects">
                    <div className="set-projects-head">
                      <span className="set-row-label">
                        Projects <span className="set-count">{projects.filter(backedUp).length} of {projects.length} backed up</span>
                      </span>
                      {projects.length > 5 && (
                        <label className="set-filter">
                          <Search size={14} strokeWidth={2} aria-hidden="true" />
                          <input
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            placeholder="Filter by name"
                            aria-label="Filter projects by name"
                            spellCheck={false}
                          />
                        </label>
                      )}
                    </div>
                    {projects.length === 0 ? (
                      <p className="set-note">No projects yet. Open a folder in Sync and it shows here.</p>
                    ) : shown.length === 0 ? (
                      <p className="set-note">No project matches “{filter.trim()}”.</p>
                    ) : (
                      <div className="set-project-list">
                        {shown.map((project) => (
                          <Switch
                            key={project.root}
                            on={backedUp(project)}
                            onChange={(value) => setProject(project, value)}
                            label={project.name}
                            hint={project.root}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  <Switch
                    on={settings.backupSftp}
                    onChange={(value) => save({ backupSftp: value })}
                    label="SFTP uploads too"
                    hint="Files an upload replaces are kept, and the upload can be undone."
                  />

                  <div className="set-limits">
                    <span className="set-row-label">Keep</span>
                    <div className="set-limit-grid">
                      <NumberField label="The last" unit="pushes" value={settings.keepPushes} min={1} max={1000} onSave={(v) => save({ keepPushes: v })} />
                      <NumberField label="For at most" unit="days" value={settings.keepDays} min={1} max={3650} onSave={(v) => save({ keepDays: v })} />
                      <NumberField label="Up to" unit="MB a project" value={settings.maxBackupMb} min={1} max={1_000_000} onSave={(v) => save({ maxBackupMb: v })} />
                      <NumberField label="Skip files over" unit="MB" value={settings.skipOverMb} min={0} max={1_000_000} onSave={(v) => save({ skipOverMb: v })} />
                    </div>
                  </div>

                  <label className="set-folder">
                    <span className="set-row-label">Backup folder on the server</span>
                    <input
                      value={root}
                      spellCheck={false}
                      onChange={(e) => setRoot(e.target.value)}
                      onBlur={() => root.trim() !== settings.backupRoot && save({ backupRoot: root.trim() || "~/.someprix/backups" })}
                      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
                    />
                    <span className="set-row-hint">~ is your login's home folder. Keep it outside your website, so visitors can't reach it.</span>
                  </label>
                </>
              )}
            </>
          )}
        </Card>

        <Card icon={Zap} tone="amber" title="Transfers" about="Fast mode sends many files as one compressed archive. It needs tar on the server.">
          <Switch on={local.fastPush} onChange={(value) => setLocalSwitch("fastPush", value)} label="Fast mode for pushes" />
          <Switch on={local.fastSftp} onChange={(value) => setLocalSwitch("fastSftp", value)} label="Fast mode for SFTP uploads and downloads" />
        </Card>

        <Card icon={FileCode} tone="blue" title="Editor" about="Files you open from your computer or the server.">
          <Switch
            on={local.drafts}
            onChange={(value) => setLocalSwitch("drafts", value)}
            label="Keep drafts of unsaved files"
            hint="Text you haven't saved comes back after a crash or a power cut."
          />
        </Card>

        <Card icon={Download} tone="sky" title="Updates" about={`You have Someprix ${version}.`}>
          <Switch
            on={local.updates}
            onChange={(value) => setLocalSwitch("updates", value)}
            label="Check for updates by itself"
            hint="Every few hours while Someprix is open."
          />
          <Row label={updates.available ? `Someprix ${updates.available} is ready` : "Check now"}>
            {updates.available ? (
              <button type="button" className="btn btn-primary btn-small" onClick={updates.open}>
                Update
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  checkSpin.spin();
                  updates.check();
                }}
                disabled={updates.checking}
              >
                <RefreshCw ref={checkSpin.icon} size={13} strokeWidth={2} />
                {updates.checking ? "Checking…" : "Check for updates"}
              </button>
            )}
          </Row>
        </Card>
      </div>
    </div>
  );
}

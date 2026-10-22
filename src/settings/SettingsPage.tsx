import { useEffect, useMemo, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import { ArchiveRestore, Download, FileCode, FolderSync, Monitor, Moon, Palette, RefreshCw, Search, SquareTerminal, Sun, Zap, type LucideIcon } from "lucide-react";
import { version } from "../../package.json";
import { api, type BackupMode, type GithubState, type ProjectChoice, type Settings } from "../lib/api";
import { GitHubSignIn, announceGithub } from "../github/GitHubSignIn";
import { GithubMark } from "../github/GithubMark";
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
/** Show the server's login message in a new terminal (off unless switched on). */
export const MOTD = "someprix.terminal.motd";
/** SFTP shows what Sync switches to: its project and server (off unless switched on). */
export const SFTP_FOLLOWS_SYNC = "someprix.sftp.followSync";
const FAST_PUSH = "someprix.push.fast";
const FAST_SFTP = "someprix.sftp.fast";

const LAST_SECTION = "someprix.settings.section";

type SectionId = "appearance" | "backups" | "transfers" | "sftp" | "github" | "terminal" | "editor" | "updates";
type SectionIcon = LucideIcon | ComponentType<{ size?: number; strokeWidth?: number }>;

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
  // The section showing, remembered between visits.
  const [section, setSection] = useState<SectionId>(() => (remembered(LAST_SECTION) as SectionId | null) ?? "appearance");
  const openSection = (id: SectionId) => {
    setSection(id);
    remember(LAST_SECTION, id);
  };
  // The GitHub account (null: signed out), once known.
  const [github, setGithub] = useState<GithubState | null>(null);
  const signOut = async () => {
    try {
      await api.githubSignOut();
      setGithub((g) => g && { ...g, account: null });
      announceGithub();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };
  const [root, setRoot] = useState("");
  // The ones kept in this window, mirrored so the switches move at once.
  const [local, setLocal] = useState(() => ({
    drafts: isOn(DRAFTS),
    updates: isOn(AUTO_UPDATES),
    motd: remembered(MOTD) === "on",
    sftpFollows: remembered(SFTP_FOLLOWS_SYNC) === "on",
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
    void api.githubState().then(setGithub).catch(() => setGithub({ account: null, deviceFlow: false }));
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
    if (name === "motd") remember(MOTD, on ? "on" : "off");
    if (name === "sftpFollows") remember(SFTP_FOLLOWS_SYNC, on ? "on" : "off");
    if (name === "fastPush") saveFast(FAST_PUSH, on);
    if (name === "fastSftp") saveFast(FAST_SFTP, on);
  };

  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase();
    return words ? projects.filter((p) => `${p.name} ${p.root}`.toLowerCase().includes(words)) : projects;
  }, [projects, filter]);
  const on = settings !== null && settings.backups !== "off";
  const backedUp = (project: ProjectChoice) => project.backup ?? settings?.backups === "all";

  const sections: { id: SectionId; title: string; about: string; icon: SectionIcon; tone: string; body: ReactNode }[] = [
    {
      id: "appearance",
      title: "Appearance",
      about: "How Someprix looks.",
      icon: Palette,
      tone: "violet",
      body: (
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
      ),
    },
    {
      id: "backups",
      title: "Backups",
      about: "Keep the files a push replaces or deletes on the server, so the push can be undone from Push history.",
      icon: ArchiveRestore,
      tone: "green",
      body: !settings ? (
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
            <p className="set-note">Pushes replace files on the server without keeping the old ones. Turn backups on to be able to undo a push.</p>
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
      ),
    },
    {
      id: "transfers",
      title: "Transfers",
      about: "Fast mode sends many files as one compressed archive. It needs tar on the server.",
      icon: Zap,
      tone: "amber",
      body: (
        <>
          <Switch on={local.fastPush} onChange={(value) => setLocalSwitch("fastPush", value)} label="Fast mode for pushes" />
          <Switch on={local.fastSftp} onChange={(value) => setLocalSwitch("fastSftp", value)} label="Fast mode for SFTP uploads and downloads" />
        </>
      ),
    },
    {
      id: "sftp",
      title: "SFTP",
      about: "Moving files between this computer and a server.",
      icon: FolderSync,
      tone: "teal",
      body: (
        <Switch
          on={local.sftpFollows}
          onChange={(value) => setLocalSwitch("sftpFollows", value)}
          label="Follow Sync"
          hint="Switching project or server in Sync switches SFTP too: the same project on the left, the same server on the right, at the project's folder there."
        />
      ),
    },
    {
      id: "github",
      title: "GitHub",
      about: "Push projects to GitHub too, or instead of a server. .gitignore decides what goes there.",
      icon: GithubMark,
      tone: "ink",
      body:
        github === null ? (
          <Loading label="Checking GitHub" />
        ) : github.account ? (
          <Row label={`Signed in as ${github.account.login}`} hint={github.account.name ?? undefined}>
            <button type="button" className="btn" onClick={() => void signOut()}>
              Sign out
            </button>
          </Row>
        ) : (
          <GitHubSignIn deviceFlow={github.deviceFlow} onSignedIn={(account) => setGithub((g) => ({ deviceFlow: g?.deviceFlow ?? false, account }))} />
        ),
    },
    {
      id: "terminal",
      title: "SSH Terminal",
      about: "The shell on your server.",
      icon: SquareTerminal,
      tone: "rose",
      body: (
        <Switch
          on={local.motd}
          onChange={(value) => setLocalSwitch("motd", value)}
          label="Show the server's welcome message"
          hint="What the server says at login: system load, disk and memory use, updates waiting, notices from your host."
        />
      ),
    },
    {
      id: "editor",
      title: "Editor",
      about: "Files you open from your computer or the server.",
      icon: FileCode,
      tone: "blue",
      body: (
        <Switch
          on={local.drafts}
          onChange={(value) => setLocalSwitch("drafts", value)}
          label="Keep drafts of unsaved files"
          hint="Text you haven't saved comes back after a crash or a power cut."
        />
      ),
    },
    {
      id: "updates",
      title: "Updates",
      about: `You have Someprix ${version}.`,
      icon: Download,
      tone: "sky",
      body: (
        <>
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
        </>
      ),
    },
  ];
  const current = sections.find((s) => s.id === section) ?? sections[0];
  const CurrentIcon = current.icon;

  /** Up and Down move along the sections (opening each), as in a list. */
  const onNavKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const at = sections.findIndex((s) => s.id === current.id);
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + sections.length) % sections.length;
    openSection(sections[next].id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>(".settings-nav-item")[next]?.focus();
  };

  return (
    <div className="page settings-page settings-split">
      <nav className="settings-nav" aria-label="Settings" onKeyDown={onNavKey}>
        <h1 className="settings-nav-title">Settings</h1>
        {sections.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              type="button"
              className="settings-nav-item"
              aria-current={s.id === current.id ? "page" : undefined}
              tabIndex={s.id === current.id ? 0 : -1}
              data-tip={s.title}
              data-tip-on="hover"
              onClick={() => openSection(s.id)}
            >
              <span className="set-icon" data-tone={s.tone} aria-hidden="true">
                <Icon size={15} strokeWidth={2} />
              </span>
              <span className="settings-nav-label">{s.title}</span>
            </button>
          );
        })}
        <p className="settings-nav-note">Changes take effect as you make them.</p>
      </nav>

      <div className="settings-main">
        <div className="settings-inner" key={current.id}>
          <header className="settings-section-head">
            <span className="set-icon" data-tone={current.tone} aria-hidden="true">
              <CurrentIcon size={20} strokeWidth={1.9} />
            </span>
            <span>
              <h2>{current.title}</h2>
              <p>{current.about}</p>
            </span>
          </header>
          <section className="set-card" aria-label={current.title}>
            <div className="set-card-body">{current.body}</div>
          </section>
        </div>
      </div>
    </div>
  );
}

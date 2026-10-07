import { useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Dialog } from "../ui/Dialog";
import { errorMessage, useAppData } from "../state/AppData";
import type { AuthMethod, Host } from "../lib/api";

type HostDialogProps = {
  /** The host to edit; left out to add a new one. */
  host?: Host;
  onClose: () => void;
  onSaved?: (host: Host) => void;
};

export function HostDialog({ host, onClose, onSaved }: HostDialogProps) {
  const { saveHost, deleteHost, notify } = useAppData();
  const [label, setLabel] = useState(host?.label ?? "");
  const [address, setAddress] = useState(host?.host ?? "");
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [username, setUsername] = useState(host?.username ?? "root");
  const [auth, setAuth] = useState<AuthMethod>(host?.auth ?? "password");
  const [keyPath, setKeyPath] = useState(host?.keyPath ?? "");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const editing = Boolean(host);

  async function chooseKey() {
    const picked = await open({ title: "Select private key", multiple: false, directory: false });
    if (typeof picked === "string") setKeyPath(picked);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await saveHost({
        id: host?.id,
        label,
        host: address,
        port: Number(port) || 0,
        username,
        auth,
        keyPath: auth === "key" ? keyPath : null,
        secret: secret || undefined,
      });
      notify(editing ? `Saved ${saved.label}` : `Added ${saved.label}`);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!host) return;
    // First click arms the button; the second deletes.
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await deleteHost(host.id);
    notify(`Deleted ${host.label}`);
    onClose();
  }

  return (
    <Dialog
      title={editing ? "Edit host" : "New host"}
      onClose={onClose}
      footer={
        <>
          {editing && (
            <button
              type="button"
              className={confirmDelete ? "btn btn-danger" : "btn btn-ghost btn-danger-text"}
              onClick={remove}
              onBlur={() => setConfirmDelete(false)}
            >
              {confirmDelete ? "Confirm delete" : "Delete host"}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="host-form" className="btn btn-primary" disabled={saving}>
            {saving ? "Saving…" : editing ? "Save" : "Add host"}
          </button>
        </>
      }
    >
      <form id="host-form" className="form" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Production" />
        </label>

        <div className="field-row">
          <label className="field grow">
            <span>Address</span>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="hostname or IP"
              required
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>
          <label className="field port">
            <span>Port</span>
            <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} inputMode="numeric" required />
          </label>
        </div>

        <label className="field">
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} required autoCapitalize="off" spellCheck={false} />
        </label>

        <div className="field">
          <span id="auth-label">Auth</span>
          <div className="segmented" role="radiogroup" aria-labelledby="auth-label">
            {(["password", "key"] as const).map((method) => (
              <button
                key={method}
                type="button"
                role="radio"
                aria-checked={auth === method}
                onClick={() => setAuth(method)}
              >
                {method === "password" ? "Password" : "Private key"}
              </button>
            ))}
          </div>
        </div>

        {auth === "password" ? (
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={editing ? "Unchanged" : ""}
              required={!editing}
            />
          </label>
        ) : (
          <>
            <div className="field">
              <span>Key file</span>
              <div className="file-pick">
                <input
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="C:\Users\you\.ssh\id_ed25519"
                  spellCheck={false}
                  required
                />
                <button type="button" className="btn" onClick={chooseKey}>
                  Browse
                </button>
              </div>
            </div>
            <label className="field">
              <span>Passphrase</span>
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={editing ? "Unchanged" : "Optional"}
              />
            </label>
          </>
        )}

        <p className="hint">Passwords and passphrases are kept in Windows Credential Manager.</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

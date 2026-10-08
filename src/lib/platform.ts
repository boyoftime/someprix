/** Which desktop the app runs on. Sets `data-platform` on <html> for the styles. */
export type Platform = "windows" | "macos" | "linux";

function detect(): Platform {
  // Development builds can pretend to be another system, to check its layout.
  if (import.meta.env.DEV) {
    try {
      const forced = localStorage.getItem("someprix.dev.platform");
      if (forced === "windows" || forced === "macos" || forced === "linux") return forced;
    } catch {
      // No storage: go by the real system.
    }
  }
  const agent = navigator.userAgent;
  if (/Windows/.test(agent)) return "windows";
  if (/Macintosh|Mac OS X/.test(agent)) return "macos";
  return "linux";
}

export const platform = detect();
export const isWindows = platform === "windows";
export const isMac = platform === "macos";

document.documentElement.dataset.platform = platform;

/** A keyboard shortcut as this system writes it: "Ctrl+S" on Windows and Linux, "⌘S" on a Mac. */
export function shortcut(keys: string) {
  return isMac ? keys.replace(/^Ctrl\+/, "⌘") : keys;
}

/** The app that shows files and folders: "Show in Explorer", "Show in Finder"… */
export const fileManager = isWindows ? "Explorer" : isMac ? "Finder" : "Files";

/** Where deleted files go, as this system calls it. */
export const trashName = isWindows ? "Recycle Bin" : "Trash";

/** Where saved passwords are kept on this system. */
export const passwordStore = isWindows
  ? "Windows Credential Manager"
  : isMac
    ? "your Mac's Keychain"
    : "your system keyring";

/** Separates folders in paths on this computer. */
export const pathSeparator = isWindows ? "\\" : "/";

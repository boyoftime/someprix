import { openUrl } from "@tauri-apps/plugin-opener";
import { version } from "../../package.json";
import { Dialog } from "../ui/Dialog";
import { Logo } from "./Logo";
import { GithubMark } from "../github/GithubMark";
import photo from "../assets/about-photo.jpg";
import studio from "../assets/someless-tricks.png";

const REPOSITORY = "https://github.com/boyoftime/someprix";

/** About Someprix: the studio's logo over a sunrise, the app, its version, who made it. */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Someprix"
      onClose={onClose}
      width={460}
      className="about-dialog"
      hero={
        <>
          <div className="about-photo">
            <img src={photo} alt="" draggable={false} />
            <img className="about-studio" src={studio} alt="Someless Tricks" draggable={false} />
          </div>
          <span className="about-icon">
            <Logo size={60} />
          </span>
        </>
      }
    >
      <div className="about-body">
        <span className="about-version">
          Version <span className="about-version-number">{version}</span>
        </span>
        <p className="about-tagline">An open-source, modern SSH client, with Sync, SFTP, a terminal and an editor in one app.</p>
        <div className="about-maker">
          <span>
            Made by <strong>Someless Ado</strong>
          </span>
          <button type="button" className="btn about-github" onClick={() => void openUrl(REPOSITORY).catch(() => {})}>
            <GithubMark size={16} />
            View on GitHub
          </button>
        </div>
        <p className="about-credit">Photo from Unsplash</p>
      </div>
    </Dialog>
  );
}

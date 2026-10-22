import { openUrl } from "@tauri-apps/plugin-opener";
import { version } from "../../package.json";
import { Logo } from "./Logo";
import { GithubMark } from "../github/GithubMark";
import photo from "../assets/about-photo.jpg";
import studio from "../assets/someless-tricks.png";

const REPOSITORY = "https://github.com/boyoftime/someprix";

/** About Someprix, across the whole page: the studio's logo in a sunrise sky, the app along the foot. */
export function AboutPage() {
  return (
    <div className="about-page">
      <img className="about-backdrop" src={photo} alt="" draggable={false} />
      <div className="about-sky">
        <img className="about-studio" src={studio} alt="Someless Tricks" draggable={false} />
      </div>
      <div className="about-panel">
        <div className="about-app">
          <Logo size={68} className="about-icon" />
          <div className="about-app-text">
            <h1 className="about-name">Someprix</h1>
            <p className="about-version">Version {version}</p>
            <p className="about-tagline">An open-source, modern SSH client, with Sync, SFTP, a terminal and an editor in one app.</p>
          </div>
        </div>
        <div className="about-maker">
          <span>
            Made by <strong>Someless Ado</strong>
          </span>
          <button type="button" className="btn about-github" onClick={() => void openUrl(REPOSITORY).catch(() => {})}>
            <GithubMark size={16} />
            View on GitHub
          </button>
        </div>
      </div>
    </div>
  );
}

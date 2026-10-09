// Publishes a Someprix release on GitHub for Windows, Mac and Linux, together with the update
// file (latest.json) that installed copies check for new versions.
//
//   npm run release -- --notes "What changed"     build and publish v<version>
//   npm run release -- --windows-only --notes …   leave Mac and Linux out of this release
//   npm run release -- --no-publish               build and sign everything, publish nothing
//   npm run release -- --publish-only --notes …   publish what's already built (after a failed
//                                                 upload, say), without building again
//
// Windows is built here. Mac and Linux are built on GitHub (.github/workflows/build.yml) from the
// same commit, so push first; this waits for that build and downloads it. Every update file is
// signed here with the private key in keys/someprix.key (kept out of git), else
// ~/.tauri/someprix.key, or the TAURI_SIGNING_PRIVATE_KEY environment variable. The key never
// goes to GitHub.
//
// The version comes from package.json; raise it there, in src-tauri/tauri.conf.json and in
// src-tauri/Cargo.toml first.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = "boyoftime/someprix";
const WORKFLOW = "build.yml";
const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const publish = !args.includes("--no-publish");
const buildFirst = !args.includes("--publish-only");
const withCi = !args.includes("--windows-only");

const fail = (message) => {
  console.error(`\nRelease stopped: ${message}`);
  process.exit(1);
};
const run = (command, commandArgs, options = {}) =>
  spawnSync(command, commandArgs, { cwd: root, encoding: "utf8", ...options });
const gh = (...ghArgs) => run("gh", [...ghArgs, "--repo", REPO]);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The three version numbers must agree, or the app would report the wrong one.
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const cargo = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8").match(/^version = "(.+)"/m)?.[1];
if (conf !== version || cargo !== version) {
  fail(`versions differ: package.json ${version}, tauri.conf.json ${conf}, Cargo.toml ${cargo}`);
}
const tag = `v${version}`;

const keyFiles = [join(root, "keys", "someprix.key"), join(homedir(), ".tauri", "someprix.key")];
const key = process.env.TAURI_SIGNING_PRIVATE_KEY ?? keyFiles.find((file) => existsSync(file));
if (!key) fail(`signing key not found in ${keyFiles.join(" or ")}`);
const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";

if (run("gh", ["--version"]).error) fail("GitHub CLI (gh) not found");
if (publish) {
  const released = gh("release", "view", tag).status === 0;
  // Publishing what's already built may finish a release whose upload broke off.
  if (released && buildFirst) fail(`${tag} is already on GitHub; raise the version first`);
}

// What gets published, under names that stay the same from version to version, so the
// download buttons in the README can always point at the latest one.
const out = join(root, "src-tauri", "target", "release", "publish");
const ciDir = join(out, "ci");
const FILES = {
  windows: "Someprix_x64-setup.exe",
  dmg: "Someprix_universal.dmg",
  macUpdate: "Someprix_universal.app.tar.gz",
  deb: "Someprix_amd64.deb",
  appImage: "Someprix_amd64.AppImage",
};

// ---------- GitHub's Mac and Linux builds ----------
const TRIES = 4;
const notes = option("--notes") ?? `Someprix ${version}`;

/** GitHub's builds of a commit that are running or succeeded, newest first. */
const runsFor = (sha) => {
  const list = gh("run", "list", "--workflow", WORKFLOW, "--commit", sha, "--limit", "10", "--json", "databaseId,status,conclusion,createdAt");
  if (list.status !== 0) return [];
  return JSON.parse(list.stdout || "[]").filter((r) => r.status !== "completed" || r.conclusion === "success");
};

/** Waits for a GitHub build to finish; stops the release if it failed. */
const waitForBuild = (ciRun) => {
  if (ciRun.status === "completed") return;
  console.log("\nWaiting for the Mac and Linux build on GitHub...");
  const watched = spawnSync("gh", ["run", "watch", String(ciRun.databaseId), "--repo", REPO, "--exit-status", "--interval", "20"], {
    cwd: root,
    stdio: "inherit",
  });
  if (watched.status !== 0) {
    fail(`the Mac and Linux build failed: https://github.com/${REPO}/actions/runs/${ciRun.databaseId}
  Windows is built. To publish it alone: npm run release -- --publish-only --windows-only --notes "${notes}"`);
  }
};

/** Downloads a finished GitHub build (trying again after a network hiccup), signs its update
 *  files here, and puts everything with the Windows files. */
const fetchBuild = (runId) => {
  let got = null;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    if (attempt > 1) {
      console.log(`Download broke off; trying again in ${5 * (attempt - 1)} s (${attempt}/${TRIES})...`);
      pause(5000 * (attempt - 1));
    }
    console.log("\nDownloading the Mac and Linux build from GitHub...");
    rmSync(ciDir, { recursive: true, force: true });
    got = gh("run", "download", String(runId), "--dir", ciDir);
    if (got.status === 0) break;
  }
  if (got.status !== 0) {
    fail(`couldn't download the Mac and Linux build:\n${got.stderr}
  Everything is built. When the connection is back, run
  npm run release -- --publish-only --notes "${notes}"`);
  }
  const tauri = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  // The key goes in as an argument; leftovers in the environment would override it.
  const signEnv = { ...process.env };
  delete signEnv.TAURI_SIGNING_PRIVATE_KEY;
  delete signEnv.TAURI_SIGNING_PRIVATE_KEY_PATH;
  delete signEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  for (const [folder, name] of [
    ["macos", FILES.macUpdate],
    ["linux", FILES.appImage],
    ["linux", FILES.deb],
  ]) {
    const file = join(ciDir, folder, name);
    if (!existsSync(file)) fail(`the GitHub build has no ${name}`);
    // Signed for this version only, like `tauri build` does for Windows.
    const keyArgs = existsSync(key) ? ["--private-key-path", key] : ["--private-key", key];
    const signed = spawnSync(process.execPath, [tauri, "signer", "sign", ...keyArgs, "--password", password, "--app-version", version, file], {
      cwd: root,
      encoding: "utf8",
      env: signEnv,
    });
    if (signed.status !== 0 || !existsSync(`${file}.sig`)) fail(`signing ${name} failed:\n${signed.stderr || signed.stdout}`);
  }
  mkdirSync(out, { recursive: true });
  for (const [folder, name] of [
    ["macos", FILES.dmg],
    ["macos", FILES.macUpdate],
    ["linux", FILES.deb],
    ["linux", FILES.appImage],
  ]) {
    copyFileSync(join(ciDir, folder, name), join(out, name));
    if (existsSync(join(ciDir, folder, `${name}.sig`))) copyFileSync(join(ciDir, folder, `${name}.sig`), join(out, `${name}.sig`));
  }
};

// Find (or start) GitHub's build of this exact commit.
let ciRun = null;
if (withCi && buildFirst) {
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"]).stdout.trim();
  if (dirty) fail("there are uncommitted changes. Commit them, push, and run this again.");
  run("git", ["fetch", "origin", "main", "--quiet"]);
  const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  const remote = run("git", ["rev-parse", "origin/main"]).stdout.trim();
  if (head !== remote) fail("this commit isn't on GitHub yet. Run `git push` first, then run this again.");

  // A push starts the build by itself; give a fresh one a moment to show up before starting another.
  ciRun = runsFor(head)[0] ?? null;
  for (let i = 0; i < 5 && !ciRun; i++) {
    pause(4000);
    ciRun = runsFor(head)[0] ?? null;
  }
  if (!ciRun) {
    console.log("Starting the Mac and Linux build on GitHub...");
    const started = gh("workflow", "run", WORKFLOW, "--ref", "main");
    if (started.status !== 0 && /404|not found/i.test(started.stderr)) {
      fail(`GitHub doesn't know the Mac and Linux build yet. It learns about it from a push, so push
  a new commit (git commit --allow-empty -m "Build" && git push) and run this again.`);
    }
    if (started.status !== 0) fail(`couldn't start the Mac and Linux build:\n${started.stderr}`);
    for (let i = 0; i < 30 && !ciRun; i++) {
      pause(3000);
      ciRun = runsFor(head)[0] ?? null;
    }
    if (!ciRun) fail("the Mac and Linux build didn't start on GitHub");
  }
  console.log(`Mac and Linux are building on GitHub: https://github.com/${REPO}/actions/runs/${ciRun.databaseId}\n`);
}

// ---------- Windows: built here ----------
if (buildFirst) {
  // A fresh start, so nothing from an earlier version can be published by mistake.
  rmSync(out, { recursive: true, force: true });
  console.log(`Building Someprix ${version} for Windows...\n`);
  const build = spawnSync("npm run tauri build", {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password },
  });
  if (build.status !== 0) fail("Windows build failed");
  const nsis = join(root, "src-tauri", "target", "release", "bundle", "nsis");
  const built = join(nsis, `Someprix_${version}_x64-setup.exe`);
  if (!existsSync(built) || !existsSync(`${built}.sig`)) fail(`${built} or its signature is missing`);
  mkdirSync(out, { recursive: true });
  copyFileSync(built, join(out, FILES.windows));
  copyFileSync(`${built}.sig`, join(out, `${FILES.windows}.sig`));
} else {
  console.log(`Publishing the Someprix ${version} files already built.`);
}

// ---------- Mac and Linux: wait, download, sign the update files here ----------
if (withCi && buildFirst) {
  waitForBuild(ciRun);
  fetchBuild(ciRun.databaseId);
}
// Publishing what's built, but GitHub's part isn't here yet (its download broke off, say):
// fetch the build of the commit that's on GitHub.
const macLinux = [FILES.dmg, FILES.macUpdate, `${FILES.macUpdate}.sig`, FILES.deb, `${FILES.deb}.sig`, FILES.appImage, `${FILES.appImage}.sig`];
if (withCi && !buildFirst && macLinux.some((name) => !existsSync(join(out, name)))) {
  run("git", ["fetch", "origin", "main", "--quiet"]);
  const pushed = run("git", ["rev-parse", "origin/main"]).stdout.trim();
  const found = runsFor(pushed)[0];
  if (!found) fail("GitHub has no Mac and Linux build of the commit on GitHub. Run the release without --publish-only.");
  waitForBuild(found);
  fetchBuild(found.databaseId);
}

// ---------- What installed copies read to find, download and check the new version ----------
const have = (name) => existsSync(join(out, name));
const required = [FILES.windows, `${FILES.windows}.sig`];
if (withCi) required.push(FILES.dmg, FILES.macUpdate, `${FILES.macUpdate}.sig`, FILES.deb, `${FILES.deb}.sig`, FILES.appImage, `${FILES.appImage}.sig`);
const missing = required.filter((name) => !have(name));
if (missing.length) {
  fail(`not built yet: ${missing.join(", ")}${withCi ? " (or add --windows-only)" : ""}`);
}
const entry = (name) => ({
  signature: readFileSync(join(out, `${name}.sig`), "utf8").trim(),
  url: `https://github.com/${REPO}/releases/download/${tag}/${name}`,
});
const platforms = { "windows-x86_64": entry(FILES.windows) };
if (withCi) {
  // One app for both kinds of Mac.
  platforms["darwin-aarch64"] = entry(FILES.macUpdate);
  platforms["darwin-x86_64"] = entry(FILES.macUpdate);
  // Each Linux install updates with the same kind of package it came from.
  platforms["linux-x86_64-deb"] = entry(FILES.deb);
  platforms["linux-x86_64-appimage"] = entry(FILES.appImage);
  platforms["linux-x86_64"] = entry(FILES.appImage);
}
const latest = join(out, "latest.json");
writeFileSync(latest, JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2));

const assets = [FILES.windows, ...(withCi ? [FILES.dmg, FILES.macUpdate, FILES.deb, FILES.appImage] : []), "latest.json"].map(
  (name) => join(out, name),
);
if (!publish) {
  console.log(`\nBuilt and signed, not published:\n${assets.map((a) => `  ${a}`).join("\n")}`);
  process.exit(0);
}

// The release page says which file is for whom.
const body = `${notes}

**Download**
- Windows 10 and 11: [${FILES.windows}](https://github.com/${REPO}/releases/download/${tag}/${FILES.windows})${
  withCi
    ? `
- Mac (Apple Silicon and Intel): [${FILES.dmg}](https://github.com/${REPO}/releases/download/${tag}/${FILES.dmg})
- Ubuntu and Debian: [${FILES.deb}](https://github.com/${REPO}/releases/download/${tag}/${FILES.deb})
- Other Linux: [${FILES.appImage}](https://github.com/${REPO}/releases/download/${tag}/${FILES.appImage})`
    : ""
}

Already installed? Someprix offers this update by itself.`;

// A network hiccup shouldn't sink a release: try a few times. A failed try leaves either no
// release (gh removes it) or one whose files can simply be uploaded again.
let published = false;
for (let attempt = 1; attempt <= TRIES && !published; attempt++) {
  if (attempt > 1) {
    console.log(`\nTrying again in ${5 * (attempt - 1)} s (${attempt}/${TRIES})...`);
    pause(5000 * (attempt - 1));
  }
  console.log(`\nPublishing ${tag} on GitHub...`);
  const exists = gh("release", "view", tag).status === 0;
  const step = exists
    ? spawnSync("gh", ["release", "upload", tag, ...assets, "--repo", REPO, "--clobber"], { cwd: root, stdio: "inherit" })
    : spawnSync("gh", ["release", "create", tag, ...assets, "--repo", REPO, "--title", `Someprix ${version}`, "--notes", body], {
        cwd: root,
        stdio: "inherit",
      });
  published = step.status === 0;
}
if (!published) {
  fail(`publishing failed. Everything is built: when the connection is back, run
  npm run release -- --publish-only${withCi ? "" : " --windows-only"} --notes "${notes}"`);
}
console.log(`\nReleased: https://github.com/${REPO}/releases/tag/${tag}`);
console.log("Installed copies will offer this update on their next check.");


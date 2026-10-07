// Builds the signed Someprix installer and publishes it as a GitHub release, together with the
// update file (latest.json) that installed copies check for new versions.
//
//   npm run release -- --notes "What changed"    build, then publish v<version> on GitHub
//   npm run release -- --no-publish              build and write latest.json only
//   npm run release -- --publish-only --notes …   publish the installer already built (after a
//                                                 failed upload, say), without building again
//
// The version comes from package.json; raise it there, in src-tauri/tauri.conf.json and in
// src-tauri/Cargo.toml first. Signing uses the private key in keys/someprix.key (kept out of git),
// else ~/.tauri/someprix.key, or the TAURI_SIGNING_PRIVATE_KEY environment variable. Without that
// key, updates can't be published.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = "boyoftime/someprix";
const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const publish = !args.includes("--no-publish");
const buildFirst = !args.includes("--publish-only");

const fail = (message) => {
  console.error(`\nRelease stopped: ${message}`);
  process.exit(1);
};

// The three version numbers must agree, or the app would report the wrong one.
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const cargo = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8").match(/^version = "(.+)"/m)?.[1];
if (conf !== version || cargo !== version) {
  fail(`versions differ: package.json ${version}, tauri.conf.json ${conf}, Cargo.toml ${cargo}`);
}
const notes = option("--notes") ?? `Someprix ${version}`;

const keyFiles = [join(root, "keys", "someprix.key"), join(homedir(), ".tauri", "someprix.key")];
const key = process.env.TAURI_SIGNING_PRIVATE_KEY ?? keyFiles.find((file) => existsSync(file));
if (!key) fail(`signing key not found in ${keyFiles.join(" or ")}`);

if (publish) {
  const released = spawnSync("gh", ["release", "view", `v${version}`, "--repo", REPO], { stdio: "ignore" });
  if (released.error) fail("GitHub CLI (gh) not found");
  // Publishing what's already built may finish a release whose upload broke off.
  if (released.status === 0 && buildFirst) fail(`v${version} is already on GitHub; raise the version first`);
}

if (buildFirst) {
  console.log(`Building Someprix ${version}...\n`);
  const build = spawnSync("npm run tauri build", {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: key,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
    },
  });
  if (build.status !== 0) fail("build failed");
} else {
  console.log(`Publishing the Someprix ${version} installer already built.`);
}

const name = `Someprix_${version}_x64-setup.exe`;
const dir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const installer = join(dir, name);
if (!existsSync(installer) || !existsSync(`${installer}.sig`)) fail(`${name} or its signature is missing`);

// What installed copies read to find, download and check the new version.
const latest = join(dir, "latest.json");
writeFileSync(
  latest,
  JSON.stringify(
    {
      version,
      notes,
      pub_date: new Date().toISOString(),
      platforms: {
        "windows-x86_64": {
          signature: readFileSync(`${installer}.sig`, "utf8").trim(),
          url: `https://github.com/${REPO}/releases/download/v${version}/${name}`,
        },
      },
    },
    null,
    2,
  ),
);

if (!publish) {
  console.log(`\nBuilt, not published:\n  ${installer}\n  ${latest}`);
  process.exit(0);
}

// A network hiccup shouldn't sink a release: try a few times. A failed try leaves either no
// release (gh removes it) or one whose files can simply be uploaded again.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const TRIES = 4;
let published = false;
for (let attempt = 1; attempt <= TRIES && !published; attempt++) {
  if (attempt > 1) {
    console.log(`\nTrying again in ${5 * (attempt - 1)} s (${attempt}/${TRIES})...`);
    pause(5000 * (attempt - 1));
  }
  console.log(`\nPublishing v${version} on GitHub...`);
  const exists = spawnSync("gh", ["release", "view", `v${version}`, "--repo", REPO], { stdio: "ignore" }).status === 0;
  const step = exists
    ? spawnSync("gh", ["release", "upload", `v${version}`, installer, latest, "--repo", REPO, "--clobber"], {
        cwd: root,
        stdio: "inherit",
      })
    : spawnSync(
        "gh",
        ["release", "create", `v${version}`, installer, latest, "--repo", REPO, "--title", `Someprix ${version}`, "--notes", notes],
        { cwd: root, stdio: "inherit" },
      );
  published = step.status === 0;
}
if (!published) {
  fail(`publishing failed. The installer is built: when the connection is back, run
  npm run release -- --publish-only --notes "${notes}"`);
}
console.log(`\nReleased: https://github.com/${REPO}/releases/tag/v${version}`);
console.log("Installed copies will offer this update on their next check.");

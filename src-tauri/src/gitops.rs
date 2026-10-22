//! The project's git repository, for pushing to GitHub: what's changed since GitHub's copy,
//! committing and pushing it, and getting GitHub's newer work. `.gitignore` decides what's in it
//! (unlike Sync, which shows everything). Git is built in: nothing to install.

use std::{cell::Cell, ffi::OsStr, fs, io::Write, path::Path};

use git2::{
    build::CheckoutBuilder, BranchType, Cred, CredentialType, Delta, DiffOptions, ErrorCode, FetchOptions, IndexAddOption,
    PushOptions, RemoteCallbacks, Repository, RepositoryInitOptions, RepositoryOpenFlags, ResetType, Signature,
    StatusOptions,
};
use serde::Serialize;

use crate::project::{Change, ChangeKind};

const REMOTE: &str = "origin";

/// Signing in to the remote: the account name and its token (GitHub takes the token as the password).
pub type Login = Option<(String, String)>;

/// Who a commit is by, when git on this computer doesn't say.
pub struct Author {
    pub name: String,
    pub email: String,
}

/// What a push or a pull is doing, for its progress.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: &'static str,
    pub done: usize,
    pub total: usize,
}

fn text(error: git2::Error) -> String {
    error.message().to_string()
}

/// The repository right at `root` (not one in a folder above it), if there is one.
pub fn open(root: &Path) -> Option<Repository> {
    Repository::open_ext(root, RepositoryOpenFlags::NO_SEARCH, std::iter::empty::<&OsStr>()).ok()
}

/// The address the project's repository pushes to ("origin"), if it has one.
pub fn remote_url(root: &Path) -> Option<String> {
    let repo = open(root)?;
    let remote = repo.find_remote(REMOTE).ok()?;
    remote.url().ok().map(str::to_string)
}

/// Makes `root` a repository (if it isn't one) that pushes to `url`.
pub fn connect(root: &Path, url: &str) -> Result<(), String> {
    let repo = match open(root) {
        Some(repo) => repo,
        None => Repository::init_opts(root, RepositoryInitOptions::new().initial_head("main")).map_err(text)?,
    };
    if repo.find_remote(REMOTE).is_ok() {
        repo.remote_set_url(REMOTE, url).map_err(text)?;
    } else {
        repo.remote(REMOTE, url).map_err(text)?;
    }
    Ok(())
}

/// The branch being worked on (also before its first commit).
fn branch(repo: &Repository) -> Result<String, String> {
    match repo.head() {
        Ok(head) if head.is_branch() => Ok(head.shorthand().unwrap_or("main").to_string()),
        Ok(_) => Err("The repository isn't on a branch (detached HEAD). Check one out with git first.".into()),
        Err(e) if e.code() == ErrorCode::UnbornBranch => {
            let head = repo.find_reference("HEAD").map_err(text)?;
            let target = head.symbolic_target().ok().flatten().unwrap_or("refs/heads/main");
            Ok(target.strip_prefix("refs/heads/").unwrap_or("main").to_string())
        }
        Err(e) => Err(text(e)),
    }
}

/// GitHub's copy of the branch, as last fetched.
fn remote_commit<'r>(repo: &'r Repository, branch: &str) -> Option<git2::Commit<'r>> {
    repo.find_reference(&format!("refs/remotes/{REMOTE}/{branch}"))
        .ok()?
        .peel_to_commit()
        .ok()
}

fn head_commit(repo: &Repository) -> Option<git2::Commit<'_>> {
    repo.head().ok()?.peel_to_commit().ok()
}

/// Where the project stands against GitHub.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub branch: String,
    /// Files that differ from GitHub's copy (committed here or not): what a push sends.
    pub changes: Vec<Change>,
}

/// What differs from GitHub's copy of the branch (all of it, before anything is on GitHub).
pub fn status(root: &Path) -> Result<Status, String> {
    let repo = open(root).ok_or("This folder isn't connected to GitHub")?;
    let branch = branch(&repo)?;
    let base = remote_commit(&repo, &branch).and_then(|c| c.tree().ok());
    let mut options = DiffOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true).include_typechange(true);
    let diff = repo.diff_tree_to_workdir_with_index(base.as_ref(), Some(&mut options)).map_err(text)?;
    let mut changes = Vec::new();
    let path = |file: git2::DiffFile<'_>| file.path().map(|p| p.to_string_lossy().replace('\\', "/"));
    for delta in diff.deltas() {
        match delta.status() {
            Delta::Added | Delta::Untracked | Delta::Copied => {
                if let Some(p) = path(delta.new_file()) {
                    changes.push(Change { path: p, kind: ChangeKind::Added });
                }
            }
            Delta::Deleted => {
                if let Some(p) = path(delta.old_file()) {
                    changes.push(Change { path: p, kind: ChangeKind::Deleted });
                }
            }
            Delta::Renamed => {
                if let Some(p) = path(delta.old_file()) {
                    changes.push(Change { path: p, kind: ChangeKind::Deleted });
                }
                if let Some(p) = path(delta.new_file()) {
                    changes.push(Change { path: p, kind: ChangeKind::Added });
                }
            }
            Delta::Modified | Delta::Typechange | Delta::Conflicted => {
                if let Some(p) = path(delta.new_file()) {
                    changes.push(Change { path: p, kind: ChangeKind::Modified });
                }
            }
            _ => {}
        }
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Status { branch, changes })
}

/// Files that look like secrets: the push asks before sending them to GitHub.
pub fn looks_secret(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let examples = [".example", ".sample", ".template", ".dist"];
    (name == ".env" || name.starts_with(".env.")) && !examples.iter().any(|e| name.ends_with(e))
        || [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"].iter().any(|ext| name.ends_with(ext))
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name.starts_with("id_ecdsa")
        || (name.ends_with(".json") && (name.contains("service-account") || name.contains("credentials")))
}

/// Adds lines to the project's .gitignore (so those files stay off GitHub).
pub fn ignore(root: &Path, paths: &[String]) -> Result<(), String> {
    let file = root.join(".gitignore");
    let existing = fs::read_to_string(&file).unwrap_or_default();
    let have: Vec<&str> = existing.lines().map(str::trim).collect();
    let mut out = fs::OpenOptions::new().create(true).append(true).open(&file).map_err(|e| e.to_string())?;
    if !existing.is_empty() && !existing.ends_with('\n') {
        writeln!(out).map_err(|e| e.to_string())?;
    }
    for path in paths {
        let line = format!("/{}", path.trim_start_matches('/'));
        if !have.contains(&line.as_str()) {
            writeln!(out, "{line}").map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// A file that was being tracked stops being (it stays on disk): for files just added to .gitignore.
pub fn untrack(root: &Path, paths: &[String]) -> Result<(), String> {
    let Some(repo) = open(root) else { return Ok(()) };
    let mut index = repo.index().map_err(text)?;
    for path in paths {
        let _ = index.remove_path(Path::new(path));
    }
    index.write().map_err(text)
}

/// Credentials and progress for talking to the remote. A rejected sign-in is tried once only.
fn callbacks<'a>(login: &'a Login, progress: &'a dyn Fn(Progress), rejected: &'a Cell<Option<String>>) -> RemoteCallbacks<'a> {
    let tried = Cell::new(false);
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |_url, _user, allowed| {
        if tried.replace(true) {
            return Err(git2::Error::from_str("GitHub didn't accept the sign-in. Sign in again in Settings."));
        }
        match login {
            Some((user, token)) if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) => Cred::userpass_plaintext(user, token),
            _ => Err(git2::Error::from_str("Sign in to GitHub first (Settings › GitHub)")),
        }
    });
    callbacks.transfer_progress(move |stats| {
        progress(Progress {
            stage: "fetching",
            done: stats.received_objects(),
            total: stats.total_objects(),
        });
        true
    });
    callbacks.push_transfer_progress(move |done, total, _bytes| progress(Progress { stage: "uploading", done, total }));
    callbacks.push_update_reference(move |_name, status| {
        if let Some(message) = status {
            rejected.set(Some(message.to_string()));
        }
        Ok(())
    });
    callbacks
}

/// Gets GitHub's latest copy of every branch (what's there, not merged into anything).
fn fetch(repo: &Repository, login: &Login, progress: &dyn Fn(Progress)) -> Result<(), String> {
    let rejected = Cell::new(None);
    let mut options = FetchOptions::new();
    options.remote_callbacks(callbacks(login, progress, &rejected));
    let mut remote = repo.find_remote(REMOTE).map_err(|_| "This folder isn't connected to GitHub".to_string())?;
    remote.fetch::<&str>(&[], Some(&mut options), None).map_err(text)
}

fn signature(repo: &Repository, author: &Author) -> Result<Signature<'static>, String> {
    // Git's own name and email on this computer win, if set up.
    repo.signature().or_else(|_| Signature::now(&author.name, &author.email)).map_err(text)
}

/// How a push went.
#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum Pushed {
    /// Sent: `files` changed, on `branch`, as `commit`.
    Pushed { files: usize, branch: String, commit: String },
    /// GitHub already has all of it.
    Nothing,
    /// GitHub has newer work (from somewhere else): get it first. The commit is made already.
    Behind,
}

/// Commits everything that differs from GitHub (as `.gitignore` allows) and pushes it.
pub fn push(root: &Path, message: &str, author: &Author, login: &Login, progress: &dyn Fn(Progress)) -> Result<Pushed, String> {
    let repo = open(root).ok_or("This folder isn't connected to GitHub")?;
    let branch = branch(&repo)?;
    let files = status(root)?.changes.len();

    progress(Progress { stage: "fetching", done: 0, total: 0 });
    fetch(&repo, login, progress)?;
    let theirs = remote_commit(&repo, &branch).map(|c| c.id());

    // First push from a folder linked to a repository that has work already: start from it,
    // leaving the files here as they are (they show as changes against it).
    if head_commit(&repo).is_none() {
        if let Some(oid) = theirs {
            repo.reference(&format!("refs/heads/{branch}"), oid, true, "Someprix: start from GitHub's copy")
                .map_err(text)?;
            repo.set_head(&format!("refs/heads/{branch}")).map_err(text)?;
            let commit = repo.find_object(oid, None).map_err(text)?;
            repo.reset(&commit, ResetType::Mixed, None).map_err(text)?;
        }
    }

    // Everything .gitignore allows, deletions included.
    progress(Progress { stage: "committing", done: 0, total: 0 });
    let mut index = repo.index().map_err(text)?;
    index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None).map_err(text)?;
    index.update_all(["*"].iter(), None).map_err(text)?;
    index.write().map_err(text)?;
    let tree_id = index.write_tree().map_err(text)?;
    let parent = head_commit(&repo);
    if parent.as_ref().map(|p| p.tree_id()) != Some(tree_id) {
        let message = message.trim();
        if message.is_empty() {
            return Err("Write a short message saying what changed".into());
        }
        let tree = repo.find_tree(tree_id).map_err(text)?;
        let sig = signature(&repo, author)?;
        let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).map_err(text)?;
    }

    let ours = head_commit(&repo).ok_or("Nothing to push yet: the folder is empty")?.id();
    if let Some(theirs) = theirs {
        if theirs == ours {
            return Ok(Pushed::Nothing);
        }
        let (_ahead, behind) = repo.graph_ahead_behind(ours, theirs).map_err(|_| unrelated())?;
        if behind > 0 {
            return Ok(Pushed::Behind);
        }
    }

    progress(Progress { stage: "uploading", done: 0, total: 0 });
    let rejected = Cell::new(None);
    let mut options = PushOptions::new();
    options.remote_callbacks(callbacks(login, progress, &rejected));
    let mut remote = repo.find_remote(REMOTE).map_err(text)?;
    let spec = format!("refs/heads/{branch}:refs/heads/{branch}");
    remote.push(&[spec.as_str()], Some(&mut options)).map_err(text)?;
    if let Some(why) = rejected.take() {
        return Err(format!("GitHub refused the push: {why}"));
    }
    // GitHub's copy is now this one; and the branch follows it from here.
    repo.reference(&format!("refs/remotes/{REMOTE}/{branch}"), ours, true, "Someprix: pushed")
        .map_err(text)?;
    if let Ok(mut local) = repo.find_branch(&branch, BranchType::Local) {
        let _ = local.set_upstream(Some(&format!("{REMOTE}/{branch}")));
    }
    Ok(Pushed::Pushed {
        files,
        branch,
        commit: ours.to_string()[..7].to_string(),
    })
}

fn unrelated() -> String {
    "This folder's history and the GitHub repository's don't share a beginning. Connect it to an empty repository, \
     or to the one it came from."
        .into()
}

/// How getting GitHub's newer work went.
#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum Pulled {
    /// Nothing new on GitHub.
    UpToDate,
    /// GitHub's work is in: `files` changed here.
    Merged { files: usize },
}

/// Gets GitHub's newer work and joins it with the work here (as a merge). Only with nothing
/// left uncommitted (a push commits first), so nothing here can be overwritten; if the two
/// changed the same lines, nothing changes and it says where.
pub fn pull(root: &Path, author: &Author, login: &Login, progress: &dyn Fn(Progress)) -> Result<Pulled, String> {
    let repo = open(root).ok_or("This folder isn't connected to GitHub")?;
    let branch = branch(&repo)?;
    let mut status = StatusOptions::new();
    status.include_untracked(false).include_ignored(false);
    if !repo.statuses(Some(&mut status)).map_err(text)?.is_empty() {
        return Err("Push your changes first: getting GitHub's work needs them committed".into());
    }

    progress(Progress { stage: "fetching", done: 0, total: 0 });
    fetch(&repo, login, progress)?;
    let Some(theirs) = remote_commit(&repo, &branch) else {
        return Ok(Pulled::UpToDate);
    };
    let ours = head_commit(&repo);
    let before = ours.as_ref().and_then(|c| c.tree().ok());
    let changed = |repo: &Repository| -> usize {
        let after = head_commit(repo).and_then(|c| c.tree().ok());
        repo.diff_tree_to_tree(before.as_ref(), after.as_ref(), None)
            .map(|d| d.deltas().len())
            .unwrap_or(0)
    };

    progress(Progress { stage: "merging", done: 0, total: 0 });
    let annotated = repo.find_annotated_commit(theirs.id()).map_err(text)?;
    let (analysis, _) = repo.merge_analysis(&[&annotated]).map_err(text)?;
    if analysis.is_up_to_date() {
        return Ok(Pulled::UpToDate);
    }
    if analysis.is_fast_forward() || ours.is_none() {
        repo.reference(&format!("refs/heads/{branch}"), theirs.id(), true, "Someprix: GitHub's newer work")
            .map_err(text)?;
        repo.set_head(&format!("refs/heads/{branch}")).map_err(text)?;
        repo.checkout_head(Some(CheckoutBuilder::new().safe())).map_err(text)?;
        return Ok(Pulled::Merged { files: changed(&repo) });
    }
    let ours = ours.expect("checked above");
    if repo.merge_base(ours.id(), theirs.id()).is_err() {
        return Err(unrelated());
    }
    repo.merge(&[&annotated], None, Some(CheckoutBuilder::new().safe())).map_err(text)?;
    let mut index = repo.index().map_err(text)?;
    if index.has_conflicts() {
        let mut both: Vec<String> = index
            .conflicts()
            .map_err(text)?
            .filter_map(|c| c.ok())
            .filter_map(|c| c.our.or(c.their))
            .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
            .collect();
        both.sort();
        both.dedup();
        // Back to how it was (nothing here was uncommitted, so nothing is lost).
        let _ = repo.cleanup_state();
        let head = repo.find_object(ours.id(), None).map_err(text)?;
        repo.reset(&head, ResetType::Hard, None).map_err(text)?;
        return Err(format!(
            "Your work and GitHub's changed the same lines in {}. Join them with git (or an editor that does), then push again.",
            both.join(", ")
        ));
    }
    let tree_id = index.write_tree_to(&repo).map_err(text)?;
    let tree = repo.find_tree(tree_id).map_err(text)?;
    let sig = signature(&repo, author)?;
    let message = format!("Merge GitHub's changes into {branch}");
    repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &[&ours, &theirs]).map_err(text)?;
    repo.cleanup_state().map_err(text)?;
    Ok(Pulled::Merged { files: changed(&repo) })
}

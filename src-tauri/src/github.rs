//! GitHub: signing in (GitHub's device flow, or a token), the account, and its repositories.
//! The token is kept in the system's credential store, like server passwords (see store.rs).

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Someprix's OAuth app on GitHub: a public id, with Device Flow switched on. While it's empty,
/// signing in takes a token instead.
const CLIENT_ID: &str = "";

/// The app id in use (tests set their own).
pub fn client_id() -> String {
    std::env::var("SOMEPRIX_GITHUB_CLIENT_ID").unwrap_or_else(|_| CLIENT_ID.to_string())
}

/// GitHub's website and API; tests point these at a stand-in.
fn web() -> String {
    std::env::var("SOMEPRIX_GITHUB_WEB").unwrap_or_else(|_| "https://github.com".into())
}

fn api() -> String {
    std::env::var("SOMEPRIX_GITHUB_API").unwrap_or_else(|_| "https://api.github.com".into())
}

fn client() -> Result<reqwest::Client, String> {
    // The same TLS setup the updater uses.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .user_agent(concat!("Someprix/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

fn unreachable(error: reqwest::Error) -> String {
    format!("GitHub couldn't be reached: {error}")
}

/// GitHub's own words for what went wrong, when it gives them.
async fn complaint(response: reqwest::Response) -> String {
    let status = response.status();
    #[derive(Deserialize)]
    struct Body {
        message: Option<String>,
        errors: Option<Vec<Detail>>,
    }
    #[derive(Deserialize)]
    struct Detail {
        message: Option<String>,
    }
    match response.json::<Body>().await {
        Ok(body) => {
            let detail = body.errors.and_then(|list| list.into_iter().find_map(|d| d.message));
            detail.or(body.message).unwrap_or_else(|| status.to_string())
        }
        Err(_) => status.to_string(),
    }
}

/// Who's signed in.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub login: String,
    pub name: Option<String>,
    pub id: u64,
}

impl Account {
    /// Commits made from Someprix carry this name, unless git has one set up already.
    pub fn display_name(&self) -> &str {
        self.name.as_deref().filter(|n| !n.trim().is_empty()).unwrap_or(&self.login)
    }

    /// GitHub's private address for the account, so commits don't publish a real one.
    pub fn email(&self) -> String {
        format!("{}+{}@users.noreply.github.com", self.id, self.login)
    }
}

/// The account a token belongs to (which also checks that it works).
pub async fn account(token: &str) -> Result<Account, String> {
    let response = client()?
        .get(format!("{}/user", api()))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(unreachable)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("GitHub didn't accept that token".into());
    }
    if !response.status().is_success() {
        return Err(complaint(response).await);
    }
    #[derive(Deserialize)]
    struct User {
        login: String,
        name: Option<String>,
        id: u64,
    }
    let user: User = response.json().await.map_err(unreachable)?;
    Ok(Account {
        login: user.login,
        name: user.name,
        id: user.id,
    })
}

/// A sign-in on its way: the code to enter on GitHub's page.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// Seconds to wait between checks.
    pub interval: u64,
}

pub async fn device_start() -> Result<DeviceCode, String> {
    let client_id = client_id();
    if client_id.is_empty() {
        return Err("Signing in through GitHub's page isn't set up in this version: use a token".into());
    }
    let response = client()?
        .post(format!("{}/login/device/code", web()))
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.as_str()), ("scope", "repo")])
        .send()
        .await
        .map_err(unreachable)?;
    if !response.status().is_success() {
        return Err(complaint(response).await);
    }
    #[derive(Deserialize)]
    struct Started {
        device_code: String,
        user_code: String,
        verification_uri: String,
        interval: Option<u64>,
    }
    let started: Started = response.json().await.map_err(unreachable)?;
    Ok(DeviceCode {
        device_code: started.device_code,
        user_code: started.user_code,
        verification_uri: started.verification_uri,
        interval: started.interval.unwrap_or(5),
    })
}

/// Where a sign-in stands.
pub enum Poll {
    Waiting,
    /// Asked too often: wait longer between checks.
    SlowDown,
    Token(String),
}

pub async fn device_poll(device_code: &str) -> Result<Poll, String> {
    let response = client()?
        .post(format!("{}/login/oauth/access_token", web()))
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id().as_str()),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(unreachable)?;
    #[derive(Deserialize)]
    struct Answer {
        access_token: Option<String>,
        error: Option<String>,
        error_description: Option<String>,
    }
    let answer: Answer = response.json().await.map_err(unreachable)?;
    if let Some(token) = answer.access_token {
        return Ok(Poll::Token(token));
    }
    match answer.error.as_deref() {
        Some("authorization_pending") => Ok(Poll::Waiting),
        Some("slow_down") => Ok(Poll::SlowDown),
        Some("expired_token") => Err("The code expired before it was entered. Start again.".into()),
        Some("access_denied") => Err("Sign-in was cancelled on GitHub".into()),
        _ => Err(answer.error_description.unwrap_or_else(|| "GitHub didn't finish the sign-in".into())),
    }
}

/// A repository on GitHub.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct Repo {
    pub full_name: String,
    pub clone_url: String,
    pub html_url: String,
    pub private: bool,
}

/// Makes a new, empty repository on the signed-in account (empty, so the project's files are
/// its first commit).
pub async fn create_repo(token: &str, name: &str, private: bool) -> Result<Repo, String> {
    let response = client()?
        .post(format!("{}/user/repos", api()))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .json(&serde_json::json!({ "name": name, "private": private, "auto_init": false }))
        .send()
        .await
        .map_err(unreachable)?;
    if response.status() == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
        let why = complaint(response).await;
        return Err(if why.contains("already exists") {
            format!("You already have a repository called {name} on GitHub. Use it, or pick another name.")
        } else {
            why
        });
    }
    if !response.status().is_success() {
        return Err(complaint(response).await);
    }
    response.json().await.map_err(unreachable)
}

/// An existing repository, "owner/name".
pub async fn find_repo(token: Option<&str>, full_name: &str) -> Result<Repo, String> {
    let mut request = client()?
        .get(format!("{}/repos/{full_name}", api()))
        .header("Accept", "application/vnd.github+json");
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(unreachable)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("No repository {full_name} on GitHub (or this account can't see it)"));
    }
    if !response.status().is_success() {
        return Err(complaint(response).await);
    }
    response.json().await.map_err(unreachable)
}

/// "owner/name" for a GitHub address (https or ssh form), or None for any other.
pub fn full_name_of(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = rest.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(owner), Some(name), None) if !owner.is_empty() && !name.is_empty() => Some(format!("{owner}/{name}")),
        _ => None,
    }
}

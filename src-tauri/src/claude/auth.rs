//! Claude Code login state.
//!
//! Runs `claude auth status`, which prints JSON containing `loggedIn`. Every command that would
//! start Claude checks this (and `locate`) first and rejects with `claudeNotInstalled` or
//! `claudeNotLoggedIn`. Opening a terminal for `claude auth login` or for the install command
//! goes through `platform`.
//!
//! Only the `loggedIn` field is read; the rest of the output (account details) is never stored,
//! logged or passed on.
//!
//! A positive answer is remembered for [`POSITIVE_TTL`] so [`ensure_ready`] is cheap enough to
//! call before every job start. A negative answer is never remembered, so the app recovers the
//! moment the user logs in.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use super::{env, locate};
use crate::error::{AppError, AppResult};
use crate::platform;

/// How long a successful login check is trusted.
pub const POSITIVE_TTL: Duration = Duration::from_secs(120);

/// How long `claude auth status` may take.
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);

/// Remembers the executable that was last seen logged in, and when.
struct LoginCache(Mutex<Option<(PathBuf, Instant)>>);

impl LoginCache {
    const fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn is_fresh(&self, bin: &Path) -> bool {
        let cache = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        cache
            .as_ref()
            .is_some_and(|(path, at)| path == bin && at.elapsed() < POSITIVE_TTL)
    }

    fn forget(&self) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    fn record(&self, bin: &Path, logged_in: bool) {
        let mut cache = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        *cache = logged_in.then(|| (bin.to_path_buf(), Instant::now()));
    }
}

static LOGGED_IN: LoginCache = LoginCache::new();

/// Forgets a remembered positive login check, for example after a job found Claude Code logged
/// out, so the next [`ensure_ready`] asks `claude auth status` again.
pub fn forget_login() {
    LOGGED_IN.forget();
}

/// Checks that Claude Code is installed and logged in, and returns the executable to run.
///
/// Errors: `claudeNotInstalled`, `claudeNotLoggedIn`. Called by every command that starts Claude.
pub async fn ensure_ready() -> AppResult<PathBuf> {
    tauri::async_runtime::spawn_blocking(ensure_ready_blocking)
        .await
        .map_err(|e| AppError::internal(format!("Checking Claude Code failed: {e}")))?
}

/// [`ensure_ready`] for code that already runs on a blocking thread.
pub fn ensure_ready_blocking() -> AppResult<PathBuf> {
    let bin = locate::find().ok_or_else(AppError::claude_not_installed)?;
    let env = env::child_env();
    check_prerequisites(&env)?;
    if LOGGED_IN.is_fresh(&bin) {
        return Ok(bin);
    }
    if check_logged_in(&bin, &env)? {
        Ok(bin)
    } else {
        Err(AppError::claude_not_logged_in())
    }
}

/// Checks that Claude Code is installed (and its prerequisites), without asking about the
/// login: what a job on OpenCode needs, since OpenCode supplies the model and its own key.
///
/// Errors: `claudeNotInstalled` (and `gitBashMissing` on Windows).
pub fn ensure_installed_blocking() -> AppResult<PathBuf> {
    let bin = locate::find().ok_or_else(AppError::claude_not_installed)?;
    check_prerequisites(&env::child_env())?;
    Ok(bin)
}

/// What Claude Code needs besides itself to run VidAI edits.
///
/// Windows: Git for Windows (Git Bash). Claude Code can work without it (with PowerShell only),
/// but the toolkit and the editing notes are written for Bash, so VidAI requires it, and says so
/// with its own error (`gitBashMissing`) before anything starts. Nothing on macOS.
pub fn check_prerequisites(env: &HashMap<String, String>) -> AppResult<()> {
    #[cfg(windows)]
    if platform::windows::git_bash(env).is_none() {
        return Err(AppError::git_bash_missing());
    }
    let _ = env;
    Ok(())
}

/// Runs `claude auth status` now (no cache) and remembers the answer for [`ensure_ready`].
///
/// Output that is not the expected JSON (for example from a Claude Code too old to have
/// `auth status`) counts as not logged in. Errors only when the command cannot run at all.
pub fn check_logged_in(bin: &Path, env: &HashMap<String, String>) -> AppResult<bool> {
    let mut cmd = platform::launch::command(bin, env, ["auth", "status"])
        .map_err(|e| AppError::internal(format!("Checking the Claude Code login failed: {e}")))?;
    cmd.env_clear().envs(env);
    let output = platform::output_with_timeout(&mut cmd, STATUS_TIMEOUT)
        .map_err(|e| AppError::internal(format!("Checking the Claude Code login failed: {e}")))?;
    let logged_in = parse_status(&String::from_utf8_lossy(&output.stdout)).unwrap_or(false);
    LOGGED_IN.record(bin, logged_in);
    Ok(logged_in)
}

/// The `loggedIn` value of `claude auth status` output, or `None` when it is not that JSON.
/// Tolerates text before or after the JSON object.
pub fn parse_status(stdout: &str) -> Option<bool> {
    let start = stdout.find('{')?;
    let end = stdout.rfind('}')?;
    let value: serde_json::Value = serde_json::from_str(stdout.get(start..=end)?).ok()?;
    value.get("loggedIn")?.as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_logged_in_and_out() {
        let fixture = include_str!("../../tests/fixtures/claude-control/auth_status.json");
        assert_eq!(parse_status(fixture), Some(true));
        assert_eq!(
            parse_status("{\n  \"loggedIn\": false,\n  \"authMethod\": \"none\"\n}\n"),
            Some(false)
        );
    }

    #[test]
    fn tolerates_noise_and_rejects_other_output() {
        assert_eq!(
            parse_status("warning: something\n{\"loggedIn\":true}\n"),
            Some(true)
        );
        assert_eq!(parse_status("Not logged in. Run claude auth login."), None);
        assert_eq!(parse_status("{\"loggedIn\":\"yes\"}"), None);
        assert_eq!(parse_status("{broken"), None);
        assert_eq!(parse_status(""), None);
    }

    #[test]
    fn caches_only_positive_answers() {
        let cache = LoginCache::new();
        let bin = Path::new("/test/claude");
        assert!(!cache.is_fresh(bin));
        cache.record(bin, true);
        assert!(cache.is_fresh(bin));
        assert!(!cache.is_fresh(Path::new("/test/other")));
        cache.record(bin, false);
        assert!(!cache.is_fresh(bin));
        cache.record(bin, true);
        cache.forget();
        assert!(!cache.is_fresh(bin));
    }
}

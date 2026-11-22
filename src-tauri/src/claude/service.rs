//! Keeps `ClaudeInfo` and `UsageStatus` fresh (SPEC section 6, "Models, effort and usage
//! limits"): the cached values, the reused usage helper process, and the refresh schedule.
//!
//! - Usage: at startup, every [`USAGE_INTERVAL_VISIBLE`] while the main window is visible, every
//!   [`USAGE_INTERVAL_JOBS`] while it is hidden but a job runs, on demand, and from every
//!   `rate_limit_event` of a running job. One helper Claude Code process is reused for the
//!   periodic `get_usage` requests: every `get_usage` is a live request to the server (verified
//!   against Claude Code 2.1.319: a long-lived helper reports changes exactly when a fresh process
//!   does), so reuse costs no freshness. The helper is replaced after [`HELPER_MAX_AGE`] (so a
//!   Claude Code update or a new login is picked up), and closed after [`HELPER_IDLE`] without use.
//! - Info: at startup, on demand, and when the cached list is older than a day. Every fetch uses a
//!   fresh short-lived process, so the model list and the defaults reflect the current settings.
//!
//! Both exist for the Claude subscription only (its model and effort pickers and its usage
//! meters, SPEC section 7a): on any other setup nothing here starts a Claude Code process (an
//! OpenCode 2 setup never needs Claude Code at all), see [`meters_wanted`].
//!
//! All work here blocks; commands call it through `spawn_blocking`, and the schedule runs on its
//! own thread. Concurrent refreshes of the same kind are merged into one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use super::control::ControlClient;
use super::{auth, env, info, locate, normalize_selection, usage};
use crate::error::{AppError, AppResult};
use crate::events::{ClaudeInfoUpdated, UsageUpdated};
use crate::model::{ClaudeInfo, JobState, ModelSelection, Setup, UsageLimit, UsageStatus, now_iso};
use crate::store::Store;

/// Usage refresh interval while the main window is visible.
pub const USAGE_INTERVAL_VISIBLE: Duration = Duration::from_secs(60);
/// Usage refresh interval while the window is hidden but a job runs.
pub const USAGE_INTERVAL_JOBS: Duration = Duration::from_secs(5 * 60);
/// The reused helper is replaced when it is older than this.
pub const HELPER_MAX_AGE: Duration = Duration::from_secs(60 * 60);
/// The reused helper is closed when it was not used for this long.
pub const HELPER_IDLE: Duration = Duration::from_secs(10 * 60);
/// How long `get_usage` may take (about 2 seconds normally, it asks the server).
pub const USAGE_TIMEOUT: Duration = Duration::from_secs(30);
/// How often the schedule looks at what is due.
const TICK: Duration = Duration::from_secs(5);
/// After a failed info fetch, when to try again: soon while no list was ever fetched (for example
/// right after the user installed Claude Code), otherwise hourly.
const INFO_RETRY_EMPTY: Duration = Duration::from_secs(60);
const INFO_RETRY: Duration = Duration::from_secs(60 * 60);
/// Label of the window whose visibility drives the usage refresh.
const MAIN_WINDOW: &str = "main";
/// Working folder of the helper processes, inside the app data directory.
const HELPER_DIR: &str = "claude-helper";

/// Managed state (`app.manage`) of the Claude Code environment.
pub struct ClaudeService {
    helper_dir: PathBuf,
    usage: Mutex<UsageStatus>,
    /// Held for the whole usage refresh, so concurrent refreshes wait and reuse the result.
    helper: Mutex<HelperSlot>,
    /// Held for the whole info fetch, for the same reason.
    info: Mutex<InfoSlot>,
}

#[derive(Default)]
struct HelperSlot {
    client: Option<(PathBuf, ControlClient)>,
    last_used: Option<Instant>,
    last_attempt: Option<Instant>,
    last_finished: Option<Instant>,
}

impl HelperSlot {
    /// `get_usage` on the reused helper, starting a new one when there is none, it stopped, it is
    /// older than [`HELPER_MAX_AGE`] or `bin` changed. A failure of a reused helper is retried
    /// once on a fresh process.
    fn get_usage(
        &mut self,
        bin: &Path,
        env: &HashMap<String, String>,
        cwd: &Path,
    ) -> AppResult<(bool, Vec<UsageLimit>)> {
        let reusable = self.client.as_mut().is_some_and(|(path, client)| {
            path == bin && client.is_alive() && client.started().elapsed() < HELPER_MAX_AGE
        });
        if !reusable {
            self.client = None;
        }
        for attempt in 0..2 {
            if self.client.is_none() {
                let mut client = ControlClient::spawn(bin, env, cwd)?;
                client.request("initialize", info::INITIALIZE_TIMEOUT)?;
                self.client = Some((bin.to_path_buf(), client));
            }
            let fresh = !reusable || attempt > 0;
            let (_, client) = self.client.as_mut().expect("helper was just set");
            self.last_used = Some(Instant::now());
            match client.request("get_usage", USAGE_TIMEOUT) {
                Ok(answer) => return Ok(usage::parse_usage(&answer)),
                Err(err) => {
                    self.client = None;
                    if fresh {
                        return Err(err);
                    }
                }
            }
        }
        Err(AppError::internal("Claude Code did not report usage."))
    }
}

#[derive(Default)]
struct InfoSlot {
    last_attempt: Option<Instant>,
    last_finished: Option<Instant>,
}

/// Whether the Claude Code helper is asked for the model list and the usage limits on `setup`:
/// only the Claude subscription shows them (the pickers and the meters). The other three setups
/// choose their model in Settings, Harness + API Keys, and show their own quota, so a helper
/// process for them would be wasted work, and an error (Claude Code is not installed) that no
/// one asked for.
pub fn meters_wanted(setup: Setup) -> bool {
    setup == Setup::ClaudeSubscription
}

fn wanted<R: Runtime>(app: &AppHandle<R>) -> bool {
    meters_wanted(app.state::<Store>().settings().setup)
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl ClaudeService {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            helper_dir: data_dir.join(HELPER_DIR),
            usage: Mutex::new(UsageStatus::default()),
            helper: Mutex::new(HelperSlot::default()),
            info: Mutex::new(InfoSlot::default()),
        }
    }

    /// The working folder of the helper processes.
    pub fn helper_dir(&self) -> &Path {
        &self.helper_dir
    }

    /// The last known usage status.
    pub fn usage(&self) -> UsageStatus {
        lock(&self.usage).clone()
    }

    /// Asks Claude Code for the usage limits now and returns the new status. A failure keeps the
    /// last values and sets `error`. Emits `UsageUpdated`.
    pub fn refresh_usage<R: Runtime>(&self, app: &AppHandle<R>) -> UsageStatus {
        if !wanted(app) {
            return self.usage();
        }
        let asked = Instant::now();
        let mut slot = lock(&self.helper);
        if slot.last_finished.is_some_and(|t| t >= asked) {
            return self.usage(); // another refresh finished while this one waited
        }
        slot.last_attempt = Some(Instant::now());
        let result = auth::ensure_ready_blocking()
            .and_then(|bin| slot.get_usage(&bin, &env::child_env(), &self.helper_dir));
        slot.last_finished = Some(Instant::now());
        drop(slot);
        let status = {
            let mut status = lock(&self.usage);
            match result {
                Ok((available, limits)) => {
                    *status = UsageStatus {
                        available,
                        limits,
                        fetched_at: Some(now_iso()),
                        error: None,
                    };
                }
                Err(err) => status.error = Some(err.message),
            }
            status.clone()
        };
        emit(app, UsageUpdated(status.clone()));
        status
    }

    /// Closes the reused helper when it has not been used for [`HELPER_IDLE`]. Does not wait for
    /// a refresh that is running.
    fn close_idle_helper(&self) {
        let Ok(mut slot) = self.helper.try_lock() else {
            return;
        };
        if slot.last_used.is_none_or(|t| t.elapsed() >= HELPER_IDLE)
            && let Some((_, client)) = slot.client.take()
        {
            client.close();
        }
    }

    /// Applies the 5-hour and weekly limits of a `rate_limit_event`. Emits `UsageUpdated` when
    /// anything changed.
    fn record_limits<R: Runtime>(&self, app: &AppHandle<R>, limits: Vec<UsageLimit>) {
        if limits.is_empty() {
            return;
        }
        let status = {
            let mut status = lock(&self.usage);
            let changed = usage::merge(&mut status.limits, limits) || !status.available;
            if !changed {
                return;
            }
            status.available = true;
            status.fetched_at = Some(now_iso());
            status.error = None;
            status.clone()
        };
        emit(app, UsageUpdated(status));
    }

    /// Fetches `ClaudeInfo` from a fresh helper process, caches it in the store, re-applies the
    /// model selection rules when the list changed, and emits `ClaudeInfoUpdated`. On failure the
    /// cache is kept.
    pub fn refresh_info<R: Runtime>(&self, app: &AppHandle<R>) -> AppResult<ClaudeInfo> {
        let store = app.state::<Store>();
        if !wanted(app) {
            return Ok(store.claude_info().unwrap_or_default());
        }
        let asked = Instant::now();
        let mut slot = lock(&self.info);
        if slot.last_finished.is_some_and(|t| t >= asked)
            && let Some(info) = store.claude_info().filter(|i| i.fetched_at.is_some())
        {
            return Ok(info);
        }
        slot.last_attempt = Some(Instant::now());
        let result = self.fetch_info();
        slot.last_finished = Some(Instant::now());
        drop(slot);
        let info = result?;
        let previous = store.claude_info();
        store.set_claude_info(info.clone())?;
        let list_changed = previous
            .is_none_or(|p| p.models != info.models || p.default_model != info.default_model);
        if list_changed {
            store.update_settings(|s| {
                let selection = normalize_selection(
                    ModelSelection {
                        model: s.model.clone(),
                        effort: s.effort.clone(),
                    },
                    Some(&info),
                );
                s.model = selection.model;
                s.effort = selection.effort;
                Ok(())
            })?;
        }
        emit(app, ClaudeInfoUpdated(info.clone()));
        Ok(info)
    }

    fn fetch_info(&self) -> AppResult<ClaudeInfo> {
        let bin = locate::find().ok_or_else(AppError::claude_not_installed)?;
        let mut client = ControlClient::spawn(&bin, &env::child_env(), &self.helper_dir)?;
        let info = info::fetch(&mut client, now_iso());
        client.close();
        info
    }

    /// Whether the cached info is due for its unprompted refresh.
    fn info_due(&self, cached: Option<&ClaudeInfo>) -> bool {
        let fetched = cached
            .and_then(|i| i.fetched_at.as_deref())
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok());
        let stale = fetched.is_none_or(|t| {
            (chrono::Utc::now() - t.with_timezone(&chrono::Utc))
                .to_std()
                .is_ok_and(|age| age >= info::MAX_AGE)
        });
        if !stale {
            return false;
        }
        let retry = if fetched.is_none() {
            INFO_RETRY_EMPTY
        } else {
            INFO_RETRY
        };
        let Ok(slot) = self.info.try_lock() else {
            return false; // a fetch is running
        };
        slot.last_attempt.is_none_or(|t| t.elapsed() >= retry)
    }

    /// Whether the usage is due for its periodic refresh.
    fn usage_due(&self, visible: bool, jobs_running: bool) -> bool {
        let interval = if visible {
            USAGE_INTERVAL_VISIBLE
        } else if jobs_running {
            USAGE_INTERVAL_JOBS
        } else {
            return false;
        };
        let Ok(slot) = self.helper.try_lock() else {
            return false; // a refresh is running
        };
        slot.last_attempt.is_none_or(|t| t.elapsed() >= interval)
    }
}

/// See `usage::record_rate_limit_event`. Does nothing before `claude::setup` ran.
pub(super) fn record_rate_limit_limits<R: Runtime>(app: &AppHandle<R>, limits: Vec<UsageLimit>) {
    if let Some(service) = app.try_state::<ClaudeService>() {
        service.record_limits(app, limits);
    }
}

/// Starts the background work: the first info and usage fetches, then the schedule.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    spawn("vidai-claude-info", move || {
        if let Err(err) = handle.state::<ClaudeService>().refresh_info(&handle) {
            eprintln!("vidai: fetching the Claude Code model list failed: {err}");
        }
    });
    let handle = app.clone();
    spawn("vidai-claude-usage", move || {
        let service = handle.state::<ClaudeService>();
        service.refresh_usage(&handle);
        loop {
            thread::sleep(TICK);
            let visible = main_window_visible(&handle);
            let jobs_running = handle.state::<Store>().latest_jobs().iter().any(|j| {
                matches!(
                    j.state,
                    JobState::Running | JobState::Pausing | JobState::Stopping
                )
            });
            // On the other setups the top bar shows their own quota (`opencode::usage`) or none,
            // and the Claude helper is not asked.
            if wanted(&handle) && service.usage_due(visible, jobs_running) {
                service.refresh_usage(&handle);
            } else {
                service.close_idle_helper();
            }
            if wanted(&handle) && service.info_due(handle.state::<Store>().claude_info().as_ref()) {
                let handle = handle.clone();
                spawn("vidai-claude-info", move || {
                    let _ = handle.state::<ClaudeService>().refresh_info(&handle);
                });
            }
        }
    });
}

fn main_window_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(MAIN_WINDOW)
        .is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
}

fn emit<R: Runtime, E: Event + serde::Serialize + Clone>(app: &AppHandle<R>, event: E) {
    if let Err(err) = event.emit(app) {
        eprintln!("vidai: could not send {}: {err}", E::NAME);
    }
}

fn spawn(name: &str, f: impl FnOnce() + Send + 'static) {
    if let Err(err) = thread::Builder::new().name(name.into()).spawn(f) {
        eprintln!("vidai: could not start {name}: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn only_the_claude_subscription_asks_the_helper() {
        // The model pickers and the meters are the subscription's; an OpenCode 2 setup (or an API
        // key) never starts Claude Code for them.
        assert!(meters_wanted(Setup::ClaudeSubscription));
        assert!(!meters_wanted(Setup::OpencodeGo));
        assert!(!meters_wanted(Setup::AnthropicApi));
        assert!(!meters_wanted(Setup::OpenaiApi));
    }

    /// The fake claude of `tests/fixtures/claude-control`, copied into `dir` as an executable.
    fn fake_claude(dir: &Path) -> (PathBuf, HashMap<String, String>) {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-control");
        let bin = dir.join("claude");
        fs::copy(fixtures.join("fake-claude.sh"), &bin).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut env: HashMap<String, String> = std::env::vars().collect();
        env.insert(
            "FAKE_CLAUDE_FIXTURES".into(),
            fixtures.to_string_lossy().into_owned(),
        );
        env.insert(
            "FAKE_CLAUDE_LOG".into(),
            dir.join("log").to_string_lossy().into_owned(),
        );
        (bin, env)
    }

    fn starts(dir: &Path) -> usize {
        fs::read_to_string(dir.join("log"))
            .unwrap_or_default()
            .lines()
            .filter(|l| l.starts_with("start "))
            .count()
    }

    #[test]
    fn reuses_one_helper_and_replaces_a_dead_one() {
        let tmp = tempfile::TempDir::new().unwrap();
        let (bin, mut env) = fake_claude(tmp.path());
        let switch = tmp.path().join("die-once");
        env.insert(
            "FAKE_CLAUDE_EXIT_ONCE".into(),
            switch.to_string_lossy().into_owned(),
        );
        let cwd = tmp.path().join("helper");
        let mut slot = HelperSlot::default();

        let (available, limits) = slot.get_usage(&bin, &env, &cwd).unwrap();
        assert!(available);
        assert_eq!(limits.len(), 3);
        slot.get_usage(&bin, &env, &cwd).unwrap();
        assert_eq!(
            starts(tmp.path()),
            1,
            "the second refresh reuses the helper"
        );

        // The reused helper dies on the next request (for example Claude Code was updated under
        // it): the refresh still succeeds, on a fresh helper.
        fs::write(&switch, "").unwrap();
        let (available, _) = slot.get_usage(&bin, &env, &cwd).unwrap();
        assert!(available);
        assert_eq!(starts(tmp.path()), 2);
        let log = fs::read_to_string(tmp.path().join("log")).unwrap();
        assert_eq!(log.matches("request initialize").count(), 2);
        assert_eq!(log.matches("request get_usage").count(), 4);
        #[cfg(unix)]
        assert!(log.contains(&format!("cwd={}", cwd.canonicalize().unwrap().display())));
        // Git Bash prints the folder as `/c/Users/...`.
        #[cfg(windows)]
        assert!(log.contains(&format!(
            "/{} args=",
            cwd.file_name().unwrap().to_string_lossy()
        )));
        for flag in [
            "--no-session-persistence",
            "--strict-mcp-config",
            "disableAllHooks",
        ] {
            assert!(log.contains(flag), "helper started without {flag}");
        }

        // A different executable (for example after a reinstall) gets its own helper.
        let other = tmp.path().join("claude2");
        fs::copy(&bin, &other).unwrap();
        slot.get_usage(&other, &env, &cwd).unwrap();
        assert_eq!(starts(tmp.path()), 3);
    }

    #[test]
    fn a_failing_helper_reports_the_error_and_is_dropped() {
        let tmp = tempfile::TempDir::new().unwrap();
        let (bin, mut env) = fake_claude(tmp.path());
        env.insert("FAKE_CLAUDE_EXIT_ON".into(), "get_usage".into());
        let mut slot = HelperSlot::default();
        let err = slot
            .get_usage(&bin, &env, &tmp.path().join("helper"))
            .unwrap_err();
        assert!(
            err.message.contains("fake claude stopped on get_usage"),
            "{}",
            err.message
        );
        assert!(slot.client.is_none());
        // A fresh helper fails once; it is not retried in a loop.
        assert_eq!(starts(tmp.path()), 1);
    }
}

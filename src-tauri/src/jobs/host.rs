//! The small dependency interface of the job engine.
//!
//! The job manager never talks to Tauri, the scanner, the keychain or the clock directly; it goes
//! through [`JobHost`]. The app uses `jobs::AppHost` (Tauri state, the real seams); the
//! integration tests use a fake with a temporary store, a fake `claude` executable and a recording
//! of every [`Notice`], so they run fully without the rest of the app.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};

use crate::error::AppResult;
use crate::events::JobLog;
use crate::model::{ApiOption, JobView, Setup, VideoOutput};
use crate::opencode::ApiSetup;
use crate::platform::machine::MachineFacts;
use crate::scanner::VideoContext;
use crate::store::Store;

/// Something the job engine wants the outside world to know or do. Delivered synchronously from
/// whatever thread produced it; implementations must not block and must not call back into the
/// job manager.
#[derive(Debug, Clone)]
pub enum Notice {
    /// `events::JobUpdated` (boxed: a `JobView` is much larger than the other notices).
    JobUpdated(Box<JobView>),
    /// `events::JobLog` (already batched).
    JobLog(JobLog),
    /// A job changed state: rescan the library (`scanner::request_rescan`).
    LibraryChanged,
    /// The `rate_limit_info` object of a `rate_limit_event` (`claude::usage`).
    RateLimit(serde_json::Value),
    /// A system notification (job completed or failed).
    Notify { title: String, body: String },
    /// Keep the machine awake (`true` while at least one job runs).
    KeepAwake(bool),
    /// Whether any job is still being edited (`model::jobs_active`: queued, running, retrying,
    /// pausing or stopping; not paused or ended). The No Sleep setting keeps the machine awake
    /// while this holds (`sleep::SleepPrevention`).
    EditingActive(bool),
    /// A job found Claude Code logged out: a remembered positive login check is stale
    /// (`claude::auth::forget_login`), so the next command reports `claudeNotLoggedIn`.
    LoginLost,
}

/// Everything the job engine needs from the rest of the app.
pub trait JobHost: Send + Sync + 'static {
    /// Settings, per-video state and job logs.
    fn store(&self) -> &Store;
    /// `scanner::resolve_video`.
    fn resolve_video(&self, video_id: &str) -> AppResult<VideoContext>;
    /// `scanner::scan_output`.
    fn scan_output(&self, video_dir: &Path) -> VideoOutput;
    /// Checks that Claude Code can run a job on `setup` and returns the executable: installed
    /// and logged in for the Claude subscription (`claude::auth::ensure_ready`), installed for
    /// an API option (`claude::auth::ensure_installed_blocking`). Blocking; called from job
    /// threads only.
    fn claude_program(&self, setup: Setup) -> AppResult<PathBuf>;
    /// Checks that the OpenCode 2 program (`opencode2`) can run a job and returns the
    /// executable. By default it does not exist here.
    fn opencode2_program(&self) -> AppResult<PathBuf> {
        Err(crate::error::AppError::invalid_input(
            "The OpenCode 2 program is not available on this computer.",
        ))
    }
    /// The base environment of a Claude process (`claude::env::child_env`), before the OpenCode
    /// variables are applied.
    fn child_env(&self) -> HashMap<String, String>;
    /// What VidAI knows about one API option now (`opencode::ApiSetup`). By default nothing is
    /// saved: no key, no model.
    fn api_setup(&self, option: ApiOption) -> ApiSetup {
        ApiSetup::new(option, &crate::model::Settings::default(), None, None)
    }
    /// Whether a running job keeps itself going when a turn ends before its work is done
    /// (`opencode::keeps_jobs_going`, SPEC section 6, "Keeping a job going"). Off by default:
    /// the job then finishes, or fails, when Claude goes quiet, as everywhere else.
    fn keeps_jobs_going(&self) -> bool {
        false
    }
    /// Delivers a notice (events, rescans, notifications, sleep prevention).
    fn notify(&self, notice: Notice);
    /// The current time.
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
    /// The computer the jobs run on (`platform::machine::facts`). Blocking the first time.
    fn machine_facts(&self) -> &MachineFacts {
        crate::platform::machine::facts()
    }
}

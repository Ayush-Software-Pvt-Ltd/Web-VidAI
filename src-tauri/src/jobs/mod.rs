//! Jobs: start, pause, continue, stop, re-edit and render (SPEC section 6).
//!
//! - [`manager`]: the job manager (managed Tauri state), owner of every job's state machine.
//! - [`driver`]: one thread per running job, driving its Claude Code process.
//! - [`queue`]: the FIFO queue, the `maxConcurrentEdits` slot rule and the start delay.
//! - [`timer`]: wakes the queue up when the start delay of a waiting job runs out.
//! - [`progress`]: the progress bar of a running job (milestones, evidence, pacing).
//! - [`keepgoing`]: whether a job whose model went idle is done, what to send next, or whether it
//!   is stuck (pure, free of Claude Code types, SPEC section 6, "Keeping a job going").
//! - [`locks`]: the machine locks a killed job leaves behind in the Editing Folder.
//! - [`work`]: what the files of the video's working folder say about the job's progress.
//! - [`prompt`]: composition of the first message and the follow-up messages (exact text).
//! - [`log`]: readable log entries from the stream, and their batched delivery.
//! - [`errors`]: the user-readable `error` texts.
//! - [`host`]: the dependency interface ([`host::JobHost`]); [`AppHost`] is the real one.
//!
//! Hooks called from `lib.rs`: [`setup`] at startup (manage the job manager, recover persisted
//! jobs, start the orphan watchdog) and [`on_run_event`] for every app run event (quit
//! confirmation via `events::QuitRequested`, final cleanup on exit).

pub mod backup;
pub mod driver;
pub mod errors;
pub mod host;
pub mod keepgoing;
pub mod locks;
pub mod log;
pub mod manager;
pub mod progress;
pub mod prompt;
pub mod queue;
pub mod retry;
pub mod runner;
pub mod timer;
pub mod work;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use tauri::plugin::PermissionState;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_specta::Event;

use crate::error::AppResult;
use crate::events::{JobUpdated, QuitRequested};
use crate::model::{ApiOption, JobState, Platform, Setup, VideoOutput};
use crate::scanner::{self, VideoContext};
use crate::secrets::Secrets;
use crate::sleep::SleepPrevention;
use crate::store::Store;

pub use host::{JobHost, Notice};
pub use manager::{JobManager, Timings};

/// Side effects that may take a moment (starting `caffeinate`, showing a notification). They run
/// in order on one worker thread, because notices are delivered while the job manager holds its
/// lock.
enum SideEffect {
    /// Asks for the notification permission when it was never asked for (first job start).
    PrepareNotifications,
    Notify {
        title: String,
        body: String,
    },
    KeepAwake(bool),
    EditingActive(bool),
}

/// Whether notifications may be shown. With `ask`, a permission that was never decided is
/// requested first. Anything but a grant (denied, unknown, an error) means no notifications,
/// silently: a missing notification is never an error for the user.
fn notifications_allowed(app: &AppHandle, ask: bool) -> bool {
    let notification = app.notification();
    match notification.permission_state() {
        Ok(PermissionState::Granted) => true,
        Ok(PermissionState::Prompt | PermissionState::PromptWithRationale) if ask => matches!(
            notification.request_permission(),
            Ok(PermissionState::Granted)
        ),
        _ => false,
    }
}

/// The real [`JobHost`]: Tauri state, the scanner, Claude Code, the keychain, events and
/// notifications.
pub struct AppHost {
    app: AppHandle,
    side_effects: Mutex<Sender<SideEffect>>,
    /// Set once the notification permission was taken care of (at the first job start).
    notifications_prepared: AtomicBool,
}

impl AppHost {
    pub fn new(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<SideEffect>();
        let worker_app = app.clone();
        let sleep = Arc::clone(&*app.state::<Arc<SleepPrevention>>());
        let spawned = thread::Builder::new()
            .name("vidai-job-effects".into())
            .spawn(move || {
                // Shared with the No Sleep setting: this thread only reports that jobs run.
                for effect in rx {
                    match effect {
                        SideEffect::KeepAwake(on) => sleep.set_running(on),
                        SideEffect::EditingActive(on) => sleep.set_editing(on),
                        SideEffect::PrepareNotifications => {
                            notifications_allowed(&worker_app, true);
                        }
                        SideEffect::Notify { title, body } => {
                            #[cfg(debug_assertions)]
                            if crate::e2e::capture_notification(&title, &body) {
                                continue;
                            }
                            if !notifications_allowed(&worker_app, false) {
                                continue;
                            }
                            if let Err(err) = worker_app
                                .notification()
                                .builder()
                                .title(title)
                                .body(body)
                                .show()
                            {
                                eprintln!("vidai: could not show a notification: {err}");
                            }
                        }
                    }
                }
            });
        if let Err(err) = spawned {
            eprintln!("vidai: could not start the job side effect thread: {err}");
        }
        Self {
            app,
            side_effects: Mutex::new(tx),
            notifications_prepared: AtomicBool::new(false),
        }
    }

    fn side_effect(&self, effect: SideEffect) {
        let tx = self
            .side_effects
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let _ = tx.send(effect);
    }
}

impl JobHost for AppHost {
    fn store(&self) -> &Store {
        self.app.state::<Store>().inner()
    }

    fn resolve_video(&self, video_id: &str) -> AppResult<VideoContext> {
        scanner::resolve_video(self.store(), video_id)
    }

    fn scan_output(&self, video_dir: &Path) -> VideoOutput {
        scanner::scan_output(video_dir)
    }

    fn claude_program(&self, setup: Setup) -> AppResult<PathBuf> {
        match setup {
            Setup::ClaudeSubscription => crate::claude::auth::ensure_ready_blocking(),
            _ => crate::claude::auth::ensure_installed_blocking(),
        }
    }

    fn opencode2_program(&self) -> AppResult<PathBuf> {
        crate::opencode::harness::locate2::ready()
    }

    fn keeps_jobs_going(&self) -> bool {
        crate::opencode::keeps_jobs_going()
    }

    fn api_setup(&self, option: ApiOption) -> crate::opencode::ApiSetup {
        let key = self.app.try_state::<Secrets>().and_then(|secrets| {
            match crate::opencode::saved_key(secrets.inner(), option) {
                Ok(key) => key,
                Err(err) => {
                    eprintln!("vidai: could not read the API key: {err}");
                    None
                }
            }
        });
        crate::opencode::ApiSetup::new(
            option,
            &self.store().settings(),
            key,
            self.store().api_models(option).as_ref(),
        )
    }

    fn child_env(&self) -> HashMap<String, String> {
        crate::claude::env::child_env()
    }

    fn notify(&self, notice: Notice) {
        let result = match notice {
            Notice::JobUpdated(job) => {
                // The first job start of this run is the moment to ask for the notification
                // permission: the user is at the Mac and just asked for work that will notify.
                if job.state == JobState::Queued
                    && !self.notifications_prepared.swap(true, Ordering::Relaxed)
                {
                    self.side_effect(SideEffect::PrepareNotifications);
                }
                JobUpdated(*job).emit(&self.app)
            }
            Notice::JobLog(log) => log.emit(&self.app),
            Notice::LibraryChanged => {
                scanner::request_rescan(&self.app);
                Ok(())
            }
            Notice::RateLimit(info) => {
                crate::claude::usage::record_rate_limit_event(&self.app, &info);
                Ok(())
            }
            Notice::Notify { title, body } => {
                self.side_effect(SideEffect::Notify { title, body });
                Ok(())
            }
            Notice::KeepAwake(on) => {
                self.side_effect(SideEffect::KeepAwake(on));
                Ok(())
            }
            Notice::EditingActive(on) => {
                self.side_effect(SideEffect::EditingActive(on));
                Ok(())
            }
            Notice::LoginLost => {
                crate::claude::auth::forget_login();
                Ok(())
            }
        };
        if let Err(err) = result {
            eprintln!("vidai: could not emit a job event: {err}");
        }
    }
}

/// Startup hook: create and manage the job manager, recover persisted jobs (ending process
/// trees a crashed VidAI left behind), and start the orphan watchdog.
pub fn setup(app: &AppHandle) -> AppResult<()> {
    let timings = Timings::default();
    #[cfg(debug_assertions)]
    let timings = Timings {
        start_delay_minute: delay_minute_override().unwrap_or(timings.start_delay_minute),
        retry_second: retry_second_override().unwrap_or(timings.retry_second),
        ..timings
    };
    let manager = JobManager::new(Arc::new(AppHost::new(app.clone())), timings);
    manager.recover();
    manager.start_orphan_watchdog();
    app.manage(manager);
    Ok(())
}

/// Debug builds only: how many milliseconds one minute of the start delay lasts, so the
/// end-to-end runner can test the delay without waiting minutes (SPEC section 3, environment
/// overrides).
#[cfg(debug_assertions)]
pub const DELAY_MINUTE_ENV: &str = "VIDAI_E2E_DELAY_MINUTE_MS";

#[cfg(debug_assertions)]
fn delay_minute_override() -> Option<Duration> {
    let value = std::env::var(DELAY_MINUTE_ENV).ok()?;
    match value.trim().parse::<u64>() {
        Ok(ms) if ms > 0 => Some(Duration::from_millis(ms)),
        _ => {
            eprintln!("vidai: ignoring {DELAY_MINUTE_ENV}={value:?}: not a positive whole number");
            None
        }
    }
}

/// Debug builds only: how many milliseconds one second of the retry schedule after a model error
/// lasts, so the end-to-end runner can test the retries without waiting minutes.
#[cfg(debug_assertions)]
pub const RETRY_SECOND_ENV: &str = "VIDAI_E2E_RETRY_SECOND_MS";

#[cfg(debug_assertions)]
fn retry_second_override() -> Option<Duration> {
    let value = std::env::var(RETRY_SECOND_ENV).ok()?;
    match value.trim().parse::<u64>() {
        Ok(ms) if ms > 0 => Some(Duration::from_millis(ms)),
        _ => {
            eprintln!("vidai: ignoring {RETRY_SECOND_ENV}={value:?}: not a positive whole number");
            None
        }
    }
}

/// How long an ending that cannot wait for a confirmation waits for running jobs to pause:
/// quitting through AppKit (Dock menu Quit, logout, a quit Apple event) on macOS, signing out,
/// shutting down or the Restart Manager on Windows. Logout and shutdown must not hang: Windows
/// treats an app that takes longer than about 5 seconds to end its session as not responding,
/// so it gets less time. Whatever is left is ended by the orphan watchdog (macOS) or the job
/// objects (Windows); `state.json` is written atomically either way, so it is never half written.
pub const fn terminate_pause_timeout(platform: Platform) -> Duration {
    match platform {
        Platform::Macos => Duration::from_secs(10),
        Platform::Windows => Duration::from_secs(4),
    }
}

/// What a request to quit does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitDecision {
    /// Nothing is busy (or a confirmed quit is already under way): exit now.
    Exit,
    /// Jobs are busy: show the window and ask the UI to confirm (`quit-requested`).
    Confirm { busy: u32 },
}

/// The decision for a request to quit with `busy` jobs (`JobManager::busy_count`), while a
/// confirmed quit is or is not already under way.
pub const fn quit_decision(busy: u32, quitting: bool) -> QuitDecision {
    if busy > 0 && !quitting {
        QuitDecision::Confirm { busy }
    } else {
        QuitDecision::Exit
    }
}

/// Quit from the app menu or Cmd+Q (macOS), or closing the window (Windows): asks the UI to
/// confirm while jobs are busy (the window is shown first, it may be hidden or minimized),
/// otherwise exits at once.
pub fn request_quit(app: &AppHandle) {
    let decision = match app.try_state::<JobManager>() {
        Some(manager) => quit_decision(manager.busy_count(), manager.is_quitting()),
        None => QuitDecision::Exit,
    };
    match decision {
        QuitDecision::Confirm { busy } => ask_to_confirm_quit(app, busy),
        QuitDecision::Exit => app.exit(0),
    }
}

fn ask_to_confirm_quit(app: &AppHandle, busy: u32) {
    crate::lifecycle::show_main_window(app);
    if let Err(err) = (QuitRequested { running: busy }).emit(app) {
        eprintln!("vidai: could not ask to confirm quitting: {err}");
    }
}

/// App run event hook. An exit request while jobs are busy is held back and the UI is asked to
/// confirm (`quit-requested`); `confirm_quit` then pauses everything and exits. On exit, pending
/// log entries are written and sleep prevention ends.
///
/// AppKit's own termination (Dock menu Quit, logout) and the end of a Windows session (sign-out,
/// shutdown, the Restart Manager) skip `ExitRequested` and arrive here as `Exit` directly;
/// running jobs are then paused without asking, within [`terminate_pause_timeout`].
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    let Some(manager) = app.try_state::<JobManager>() else {
        return;
    };
    match event {
        RunEvent::ExitRequested { api, .. } => {
            if manager.is_quitting() {
                return;
            }
            let busy = manager.busy_count();
            if busy > 0 {
                api.prevent_exit();
                ask_to_confirm_quit(app, busy);
            }
        }
        RunEvent::Exit => {
            if !manager.is_quitting()
                && manager.busy_count() > 0
                && !manager.pause_all_for_quit(terminate_pause_timeout(Platform::current()))
            {
                eprintln!("vidai: some jobs did not pause in time; exiting anyway");
            }
            manager.shutdown();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quitting_asks_only_while_jobs_are_busy() {
        assert_eq!(quit_decision(0, false), QuitDecision::Exit);
        assert_eq!(quit_decision(2, false), QuitDecision::Confirm { busy: 2 });
        // A confirmed quit is already pausing everything: a second request just exits.
        assert_eq!(quit_decision(2, true), QuitDecision::Exit);
        assert_eq!(quit_decision(0, true), QuitDecision::Exit);
    }

    #[test]
    fn an_ending_session_waits_less_on_windows() {
        assert_eq!(
            terminate_pause_timeout(Platform::Macos),
            Duration::from_secs(10)
        );
        assert!(terminate_pause_timeout(Platform::Windows) < Duration::from_secs(5));
    }
}

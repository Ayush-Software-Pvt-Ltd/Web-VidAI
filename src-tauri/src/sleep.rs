//! Sleep prevention (SPEC section 11, Sleep prevention): the one owner of the machine's
//! "do not sleep" state.
//!
//! Two modes, chosen by `Settings.noSleep` (the No Sleep checkbox in the main window's sidebar):
//!
//! - Off: the machine is kept awake while at least one edit runs (the job manager reports it
//!   through `Notice::KeepAwake`).
//! - On: the machine is kept awake until every edit has ended, so also while a job is queued,
//!   waits out the start delay or waits to retry after a model error (the job manager reports
//!   it through `Notice::EditingActive`, from `model::jobs_active`). A paused job counts as
//!   ended. When nothing is being edited the hold is released even though the box is checked.
//!
//! The OS-specific part is `platform::power::KeepAwake`.

use std::sync::{Arc, Mutex, PoisonError};

use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::platform::power::KeepAwake;
use crate::store::Store;

/// The facts that decide whether the machine is kept awake.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Reasons {
    /// At least one edit runs.
    pub running: bool,
    /// At least one job is still being edited (`model::jobs_active`): a superset of `running`
    /// that also holds queued and waiting jobs.
    pub editing: bool,
    /// No Sleep is checked.
    pub no_sleep: bool,
}

impl Reasons {
    /// Whether sleep prevention must be on.
    pub fn wanted(self) -> bool {
        self.running || (self.no_sleep && self.editing)
    }
}

/// Combines the reasons and drives one [`KeepAwake`]. Shared (`Arc`) between the job manager's
/// side-effect worker and the `set_no_sleep` command; it is Tauri state.
#[derive(Default)]
pub struct SleepPrevention {
    reasons: Mutex<Reasons>,
    awake: KeepAwake,
}

impl SleepPrevention {
    /// A job runs or the last running one ended.
    pub fn set_running(&self, on: bool) {
        self.update(|r| r.running = on);
    }

    /// A job is being edited or the last one ended (or was paused).
    pub fn set_editing(&self, on: bool) {
        self.update(|r| r.editing = on);
    }

    /// The user turned No Sleep on or off.
    pub fn set_no_sleep(&self, on: bool) {
        self.update(|r| r.no_sleep = on);
    }

    /// The facts as they are right now.
    pub fn reasons(&self) -> Reasons {
        *self.reasons.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether the machine is kept awake right now.
    pub fn is_on(&self) -> bool {
        self.awake.is_on()
    }

    fn update(&self, change: impl FnOnce(&mut Reasons)) {
        // Held while switching, so two changes at once cannot apply out of order.
        let mut reasons = self.reasons.lock().unwrap_or_else(PoisonError::into_inner);
        change(&mut reasons);
        self.awake.set(reasons.wanted());
    }
}

/// Startup hook: creates the shared [`SleepPrevention`] as Tauri state (before `jobs::setup`,
/// which hands it to the job manager's host) and applies the saved No Sleep setting.
pub fn setup(app: &AppHandle) -> AppResult<()> {
    let prevention = Arc::new(SleepPrevention::default());
    prevention.set_no_sleep(app.state::<Store>().settings().no_sleep);
    app.manage(prevention);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{JobState, jobs_active};

    fn wanted(running: bool, editing: bool, no_sleep: bool) -> bool {
        Reasons {
            running,
            editing,
            no_sleep,
        }
        .wanted()
    }

    #[test]
    fn unchecked_keeps_awake_only_while_a_job_runs() {
        assert!(wanted(true, true, false));
        // Queued or waiting jobs do not hold the machine: that is the checked mode.
        assert!(!wanted(false, true, false));
        assert!(!wanted(false, false, false));
    }

    #[test]
    fn checked_stays_awake_for_queued_and_waiting_jobs() {
        assert!(wanted(false, true, true));
        assert!(wanted(true, true, true));
    }

    #[test]
    fn checked_releases_when_nothing_is_edited() {
        assert!(!wanted(false, false, true));
    }

    #[test]
    fn editing_follows_the_job_states() {
        let active = |states: &[JobState]| jobs_active(states.iter().copied());
        // A queued job, also one that waits out the start delay (it is `queued` too).
        assert!(active(&[JobState::Queued]));
        assert!(active(&[JobState::Completed, JobState::Queued]));
        // Running covers the waits to retry and the keep-going states.
        assert!(active(&[JobState::Running]));
        assert!(active(&[JobState::Pausing]));
        assert!(active(&[JobState::Stopping]));
        // Paused counts as ended, like every finished state.
        assert!(!active(&[JobState::Paused]));
        assert!(!active(&[
            JobState::Paused,
            JobState::Stopped,
            JobState::Failed,
            JobState::Completed,
        ]));
        assert!(!active(&[]));
    }

    #[test]
    fn the_modes_combine_without_disturbing_each_other() {
        let prevention = SleepPrevention::default();
        prevention.set_no_sleep(true);
        prevention.set_editing(true);
        assert!(prevention.reasons().wanted());
        // A job starts running, then nothing is edited any more: released although checked.
        prevention.set_running(true);
        prevention.set_running(false);
        prevention.set_editing(false);
        assert!(!prevention.reasons().wanted());
        // Unchecking while a job queues does not hold; a running job does.
        prevention.set_editing(true);
        prevention.set_no_sleep(false);
        assert!(!prevention.reasons().wanted());
        prevention.set_running(true);
        assert!(prevention.reasons().wanted());
        // Checking while it runs, then the run ends but the job is only waiting: still held.
        prevention.set_no_sleep(true);
        prevention.set_running(false);
        assert!(prevention.reasons().wanted());
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn the_machine_is_awake_exactly_while_the_rules_say() {
        let prevention = SleepPrevention::default();
        assert!(!prevention.is_on());
        prevention.set_no_sleep(true);
        assert!(!prevention.is_on(), "checked but nothing is edited");
        prevention.set_editing(true);
        assert!(prevention.is_on(), "checked with a queued job");
        prevention.set_editing(false);
        assert!(!prevention.is_on(), "all jobs done or paused");
        prevention.set_no_sleep(false);
        prevention.set_running(true);
        assert!(prevention.is_on(), "unchecked, a job runs");
        prevention.set_running(false);
        assert!(!prevention.is_on());
    }
}

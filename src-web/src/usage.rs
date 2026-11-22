//! The usage meters (Claude plan and OpenCode Go) while a page is open (SPEC section 12, What runs
//! where).
//!
//! The core refreshes them by looking at its main window: every
//! [`USAGE_INTERVAL_VISIBLE`] while the window is visible, but only every
//! [`USAGE_INTERVAL_JOBS`] while it is hidden and an edit runs, and never while it is hidden and
//! nothing runs (`claude::service::start`, `opencode::usage::start`). Here the window is never
//! shown, so this task plays the visible case itself: while at least one page is connected to the
//! event stream, each meter that the setup shows is refreshed with the core's own function when
//! its last attempt is [`USAGE_INTERVAL_VISIBLE`] old. A page that connects after a quiet time
//! therefore gets a refresh at once (the core does the same when its window is shown), and a page
//! that connects right after the startup refresh waits for the next due time.
//!
//! The requests are never doubled. Both core loops decide by the time of their own last attempt,
//! and every refresh made here sets that time, so while this task refreshes every minute the
//! core's slower loop (5 minutes while edits run) never finds its meter due. When this task
//! starts, the age of the last attempt is not readable from here, so the age of the last
//! successful answer (`fetched_at`, also set by the core's own refreshes) stands in for it, and
//! this task's own attempts cover the failures.
//!
//! Which meter is asked follows the core: the Claude helper only on the Claude subscription
//! (`claude::service::meters_wanted`), the OpenCode quota only on OpenCode Go
//! (`opencode::usage::selected`).

use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use tauri::{AppHandle, Manager};
use tokio::time::MissedTickBehavior;
use vidai_lib::claude::service::{self, ClaudeService, USAGE_INTERVAL_VISIBLE};
use vidai_lib::opencode::usage::{self as opencode_usage, UsageService};
use vidai_lib::store::Store;

use crate::events::Hub;

/// How often this task looks at who is connected and what is due. The core looks every 5 seconds;
/// a second makes a page that connects wait less.
const TICK: Duration = Duration::from_secs(1);

/// The time of the last attempt of one meter, made here.
#[derive(Debug, Default)]
struct Meter {
    last_attempt: Option<Instant>,
}

impl Meter {
    /// Whether the meter is due: no attempt and no answer is younger than
    /// [`USAGE_INTERVAL_VISIBLE`]. `answered` is the age of the last answer, when there was one.
    fn due(&self, now: Instant, answered: Option<Duration>) -> bool {
        let own = self.last_attempt.map(|t| now.saturating_duration_since(t));
        own.into_iter()
            .chain(answered)
            .min()
            .is_none_or(|age| age >= USAGE_INTERVAL_VISIBLE)
    }
}

/// How long ago `fetched_at` (RFC 3339, as the core writes it) was; `None` when there is none or
/// it cannot be read. A time in the future counts as now.
fn age_of(fetched_at: Option<&str>, now: DateTime<Utc>) -> Option<Duration> {
    let at = DateTime::parse_from_rfc3339(fetched_at?).ok()?;
    Some(
        now.signed_duration_since(at)
            .to_std()
            .unwrap_or(Duration::ZERO),
    )
}

/// Starts the task (once, from `app.rs`, after the hub exists and the core's startup hooks ran).
pub fn start(app: &AppHandle, hub: Hub) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut claude = Meter::default();
        let mut opencode = Meter::default();
        let mut ticker = tokio::time::interval(TICK);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if hub.connected() == 0 {
                continue;
            }
            let (now, utc) = (Instant::now(), Utc::now());
            let claude_due = claude_wanted(&app) && claude.due(now, claude_answer_age(&app, utc));
            let opencode_due =
                opencode_usage::selected(&app) && opencode.due(now, opencode_answer_age(&app, utc));
            if claude_due {
                claude.last_attempt = Some(now);
            }
            if opencode_due {
                opencode.last_attempt = Some(now);
            }
            // Both at once: a slow one does not hold up the other.
            tokio::join!(
                refresh_if(claude_due, &app, refresh_claude),
                refresh_if(opencode_due, &app, refresh_opencode),
            );
        }
    });
}

fn claude_wanted(app: &AppHandle) -> bool {
    service::meters_wanted(app.state::<Store>().settings().setup)
}

fn claude_answer_age(app: &AppHandle, now: DateTime<Utc>) -> Option<Duration> {
    let service = app.try_state::<ClaudeService>()?;
    age_of(service.usage().fetched_at.as_deref(), now)
}

fn opencode_answer_age(app: &AppHandle, now: DateTime<Utc>) -> Option<Duration> {
    let service = app.try_state::<UsageService>()?;
    age_of(service.usage().fetched_at.as_deref(), now)
}

fn refresh_claude(app: &AppHandle) {
    if let Some(service) = app.try_state::<ClaudeService>() {
        service.refresh_usage(app);
    }
}

fn refresh_opencode(app: &AppHandle) {
    if let Some(service) = app.try_state::<UsageService>() {
        service.refresh(app);
    }
}

/// Runs `refresh` off the async runtime when `due` (both refreshes block).
async fn refresh_if(due: bool, app: &AppHandle, refresh: fn(&AppHandle)) {
    if !due {
        return;
    }
    let app = app.clone();
    if let Err(err) = tokio::task::spawn_blocking(move || refresh(&app)).await {
        eprintln!("vidai-web: a usage refresh failed: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn the_schedule_is_the_core_s_visible_one() {
        assert_eq!(USAGE_INTERVAL_VISIBLE, secs(60));
    }

    #[test]
    fn a_meter_nobody_asked_yet_is_due() {
        assert!(Meter::default().due(Instant::now(), None));
    }

    #[test]
    fn a_recent_attempt_or_answer_is_not_due_an_old_one_is() {
        let now = Instant::now();
        let started = now
            .checked_sub(secs(30))
            .expect("the clock has run for 30 seconds");
        let old = now.checked_sub(secs(61)).unwrap();
        let recent = Meter {
            last_attempt: Some(started),
        };
        let stale = Meter {
            last_attempt: Some(old),
        };
        assert!(!recent.due(now, None));
        assert!(stale.due(now, None));
        // The younger of the two counts: the core refreshed 10 seconds ago.
        assert!(!stale.due(now, Some(secs(10))));
        assert!(!Meter::default().due(now, Some(secs(59))));
        // A failed attempt of ours 30 seconds ago holds off an answer that is an hour old.
        assert!(!recent.due(now, Some(secs(3600))));
        assert!(Meter::default().due(now, Some(secs(60))));
        assert!(stale.due(now, Some(secs(3600))));
    }

    #[test]
    fn the_age_of_an_answer_is_read_from_the_core_s_timestamp() {
        let now = Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 30).unwrap();
        assert_eq!(
            age_of(Some("2026-01-01T12:00:00.000Z"), now),
            Some(secs(30))
        );
        assert_eq!(
            age_of(Some("2026-01-01T12:01:00.000Z"), now),
            Some(Duration::ZERO)
        );
        assert_eq!(age_of(Some("not a time"), now), None);
        assert_eq!(age_of(None, now), None);
        let own = vidai_lib::model::now_iso();
        assert!(age_of(Some(&own), Utc::now()).unwrap() < secs(5));
    }
}

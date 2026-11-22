//! The OpenCode quota in the top bar (SPEC section 6, "OpenCode quota").
//!
//! What OpenCode's source shows (see SPEC section 7a for the references): the Go plan has three
//! windows (5-hour, weekly, monthly) and reports them at `GET <Go root>/v1/usage` (for the
//! default address `https://opencode.ai/inference/go/v1/usage`) as
//! `{"usage":{"rolling"|"weekly"|"monthly":{"status":"ok"|"rate-limited","percent":0..100,
//! "resetsAt":ISO}}}`, a share of each window and when it resets, no dollar amounts. Inference
//! answers carry no rate-limit headers, so Claude Code reports nothing about these windows
//! itself. That endpoint is the only source used: when it does not answer for the saved key, or
//! the address is not a Go address, the meters say so ([`OpencodeUsage::unavailable`]) instead of
//! showing a number VidAI made up.
//!
//! [`UsageService`] keeps the last answer and refreshes it on the schedule of the Claude limits
//! (`claude::service`): at startup, every minute while the window is visible, every 5 minutes
//! while it is hidden and a job runs, on demand, and when the provider, the key or the address
//! changes. It only asks while edits run on OpenCode.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use super::http;
use crate::events::OpencodeUsageUpdated;
use crate::model::{ApiOption, JobState, OpencodeUsage, Setup, UsageLimit, now_iso};
use crate::secrets::Secrets;
use crate::store::Store;

/// The Go root's usage path, after the address without its `/anthropic`.
const USAGE_PATH: &str = "/v1/usage";
/// How often the schedule looks at what is due.
const TICK: Duration = Duration::from_secs(5);

/// Why there are no meters for an address that is not an OpenCode Go address.
pub const NOT_GO: &str = "OpenCode reports 5-hour, weekly and monthly limits for Go subscriptions only. Spending and budgets of a balance are in the OpenCode console.";
/// Why there are no meters when the usage endpoint refuses the key.
pub const NOT_FOR_THIS_KEY: &str = "OpenCode does not report usage to this API key. A key may need the Usage: Read permission, which you can give it in the OpenCode console.";
/// Why there are no meters for a workspace without Go.
pub const NO_GO_PLAN: &str =
    "This key's workspace has no OpenCode Go subscription, so there are no Go limits to show.";
/// Why there are no meters without a key.
pub const NO_KEY: &str = "Save an OpenCode API key to see its usage.";

/// The usage address of an OpenCode Go address: `<…>/go/anthropic` becomes `<…>/go/v1/usage`.
/// `None` for any other address (pay-as-you-go, another gateway).
pub fn usage_url(base_url: &str) -> Option<String> {
    let url = reqwest::Url::parse(base_url).ok()?;
    let path = url.path().trim_end_matches('/');
    let root = path.strip_suffix("/anthropic")?;
    if !root.to_ascii_lowercase().ends_with("/go") {
        return None;
    }
    let mut usage = url.clone();
    usage.set_path(&format!("{root}{USAGE_PATH}"));
    Some(usage.to_string())
}

/// The windows of a Go usage answer, `fiveHour`, `weekly`, `monthly` (those present). `None` when
/// the answer is not that shape. A window marked `rate-limited` counts as used up.
pub fn parse_go_usage(body: &[u8]) -> Option<Vec<UsageLimit>> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let windows = value.get("usage").unwrap_or(&value);
    let windows = windows.as_object()?;
    let mut limits = Vec::new();
    for (name, key, label) in [
        ("rolling", "fiveHour", "5-hour limit"),
        ("weekly", "weekly", "Weekly limit"),
        ("monthly", "monthly", "Monthly limit"),
    ] {
        let Some(window) = windows.get(name).filter(|w| w.is_object()) else {
            continue;
        };
        let Some(percent) = window
            .get("percent")
            .and_then(Value::as_f64)
            .filter(|p| p.is_finite())
        else {
            continue;
        };
        let limited = window.get("status").and_then(Value::as_str) == Some("rate-limited");
        let used = if limited {
            100.0
        } else {
            percent.clamp(0.0, 100.0)
        };
        limits.push(UsageLimit {
            key: key.into(),
            label: label.into(),
            used_percent: (used * 100.0).round() / 100.0,
            resets_at: window
                .get("resetsAt")
                .and_then(Value::as_str)
                .and_then(|t| DateTime::parse_from_rfc3339(t.trim()).ok())
                .map(|t| {
                    t.with_timezone(&Utc)
                        .to_rfc3339_opts(SecondsFormat::Millis, true)
                }),
        });
    }
    (!limits.is_empty()).then_some(limits)
}

/// What one refresh found.
#[derive(Debug, Clone, PartialEq)]
pub enum Reading {
    Limits(Vec<UsageLimit>),
    /// Nothing to show, and why (not an error: it stays so until something changes).
    Unavailable(String),
    /// The refresh failed; the last values stay.
    Failed(String),
}

/// What an answer of the usage endpoint means.
pub fn reading_of(answer: &http::Answer) -> Reading {
    match answer.status {
        200 => match parse_go_usage(&answer.body) {
            Some(limits) => Reading::Limits(limits),
            None => Reading::Failed(
                "OpenCode answered, but not with usage limits. Try again later.".into(),
            ),
        },
        401 => Reading::Unavailable(NOT_FOR_THIS_KEY.into()),
        403 => {
            let error = http::parse_error(&String::from_utf8_lossy(&answer.body));
            if error.kind.as_deref() == Some("EntitlementError") {
                Reading::Unavailable(NO_GO_PLAN.into())
            } else {
                Reading::Unavailable(NOT_FOR_THIS_KEY.into())
            }
        }
        404 => Reading::Unavailable(NOT_GO.into()),
        status => Reading::Failed(http::failure_text(
            Some(status),
            &String::from_utf8_lossy(&answer.body),
            None,
        )),
    }
}

/// Applies a reading to the kept status.
pub fn apply(status: &mut OpencodeUsage, reading: Reading, now: String) {
    match reading {
        Reading::Limits(limits) => {
            *status = OpencodeUsage {
                limits,
                unavailable: None,
                fetched_at: Some(now),
                error: None,
            };
        }
        Reading::Unavailable(reason) => {
            *status = OpencodeUsage {
                limits: Vec::new(),
                unavailable: Some(reason),
                fetched_at: Some(now),
                error: None,
            };
        }
        Reading::Failed(error) => status.error = Some(error),
    }
}

/// Managed state: the last OpenCode usage and its refresh.
#[derive(Default)]
pub struct UsageService {
    usage: Mutex<OpencodeUsage>,
    /// Held for a whole refresh, so concurrent refreshes wait and reuse the result.
    refresh: Mutex<Slot>,
}

#[derive(Default)]
struct Slot {
    last_attempt: Option<Instant>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl UsageService {
    /// The last known usage.
    pub fn usage(&self) -> OpencodeUsage {
        lock(&self.usage).clone()
    }

    /// Forgets what is known (another key or address), so nothing stale is shown.
    pub fn reset(&self) {
        *lock(&self.usage) = OpencodeUsage::default();
    }

    /// Asks OpenCode now (only while edits run on OpenCode) and emits `OpencodeUsageUpdated`.
    /// Blocking: call it off the async runtime.
    pub fn refresh<R: Runtime>(&self, app: &AppHandle<R>) -> OpencodeUsage {
        let asked = Instant::now();
        let mut slot = lock(&self.refresh);
        // Only a refresh that started after this one was asked for saw the same settings (the
        // provider, key or address may have changed in between), so only then is it reused.
        if slot.last_attempt.is_some_and(|t| t >= asked) {
            return self.usage();
        }
        slot.last_attempt = Some(Instant::now());
        let reading = read(app);
        drop(slot);
        let Some(reading) = reading else {
            return self.usage();
        };
        let status = {
            let mut status = lock(&self.usage);
            apply(&mut status, reading, now_iso());
            status.clone()
        };
        if let Err(err) = OpencodeUsageUpdated(status.clone()).emit(app) {
            eprintln!("vidai: could not send the OpenCode usage: {err}");
        }
        status
    }

    fn due(&self, visible: bool, jobs_running: bool) -> bool {
        let interval = if visible {
            crate::claude::service::USAGE_INTERVAL_VISIBLE
        } else if jobs_running {
            crate::claude::service::USAGE_INTERVAL_JOBS
        } else {
            return false;
        };
        let Ok(slot) = self.refresh.try_lock() else {
            return false;
        };
        slot.last_attempt.is_none_or(|t| t.elapsed() >= interval)
    }
}

/// Whether edits run on OpenCode Go now (the only option with a quota to show).
pub fn selected<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<Store>().settings().setup == Setup::OpencodeGo
}

/// One reading, or `None` when edits do not run on OpenCode (nothing is asked then).
fn read<R: Runtime>(app: &AppHandle<R>) -> Option<Reading> {
    if !selected(app) {
        return None;
    }
    let settings = app.state::<Store>().settings();
    let key = match super::saved_key(app.state::<Secrets>().inner(), ApiOption::OpencodeGo) {
        Ok(Some(key)) => key,
        Ok(None) => return Some(Reading::Unavailable(NO_KEY.into())),
        Err(err) => return Some(Reading::Unavailable(err.message)),
    };
    let Some(url) = usage_url(&super::base_url(&settings, ApiOption::OpencodeGo)) else {
        return Some(Reading::Unavailable(NOT_GO.into()));
    };
    Some(
        match tauri::async_runtime::block_on(http::get_with_key(&url, &key)) {
            Ok(answer) => reading_of(&answer),
            Err(message) => Reading::Failed(message),
        },
    )
}

/// Starts the schedule (once, from `lib.rs`): a first refresh, then the same cadence as the
/// Claude limits, only while edits run on OpenCode.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let spawned = thread::Builder::new()
        .name("vidai-opencode-usage".into())
        .spawn(move || {
            let service = handle.state::<UsageService>();
            service.refresh(&handle);
            loop {
                thread::sleep(TICK);
                if !selected(&handle) {
                    continue;
                }
                let visible = handle
                    .get_webview_window(crate::lifecycle::MAIN_WINDOW)
                    .is_some_and(|w| {
                        w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)
                    });
                let jobs_running = handle.state::<Store>().latest_jobs().iter().any(|j| {
                    matches!(
                        j.state,
                        JobState::Running | JobState::Pausing | JobState::Stopping
                    )
                });
                if service.due(visible, jobs_running) {
                    service.refresh(&handle);
                }
            }
        });
    if let Err(err) = spawned {
        eprintln!("vidai: could not start the OpenCode usage refresh: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_address_of_go_addresses_only() {
        assert_eq!(
            usage_url("https://opencode.ai/inference/go/anthropic").as_deref(),
            Some("https://opencode.ai/inference/go/v1/usage")
        );
        assert_eq!(
            usage_url("http://127.0.0.1:8484/inference/go/anthropic").as_deref(),
            Some("http://127.0.0.1:8484/inference/go/v1/usage")
        );
        assert_eq!(usage_url("https://opencode.ai/inference/anthropic"), None);
        assert_eq!(usage_url("https://gateway.example.com/anthropic"), None);
        assert_eq!(usage_url("not a url"), None);
    }

    #[test]
    fn reads_the_go_windows() {
        let body = br#"{"usage":{
            "rolling":{"status":"ok","percent":42,"resetsAt":"2026-10-24T17:00:00.000Z"},
            "weekly":{"status":"ok","percent":12.5,"resetsAt":"2026-10-27T00:00:00Z"},
            "monthly":{"status":"rate-limited","percent":97,"resetsAt":"2026-11-03T08:15:00+00:00"}
        }}"#;
        let limits = parse_go_usage(body).unwrap();
        assert_eq!(limits.len(), 3);
        assert_eq!(limits[0].key, "fiveHour");
        assert_eq!(limits[0].label, "5-hour limit");
        assert_eq!(limits[0].used_percent, 42.0);
        assert_eq!(
            limits[0].resets_at.as_deref(),
            Some("2026-10-24T17:00:00.000Z")
        );
        assert_eq!(limits[1].used_percent, 12.5);
        assert_eq!(limits[2].key, "monthly");
        assert_eq!(limits[2].used_percent, 100.0, "rate-limited is used up");
        assert_eq!(
            limits[2].resets_at.as_deref(),
            Some("2026-11-03T08:15:00.000Z")
        );
        // Missing windows are left out; nothing readable is no answer.
        let partial = parse_go_usage(br#"{"usage":{"weekly":{"percent":3}}}"#).unwrap();
        assert_eq!(partial.len(), 1);
        assert_eq!(partial[0].resets_at, None);
        assert!(parse_go_usage(br#"{"usage":{}}"#).is_none());
        assert!(parse_go_usage(b"nope").is_none());
    }

    fn answer(status: u16, body: &str) -> http::Answer {
        http::Answer {
            status,
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn answers_become_readings() {
        assert!(matches!(
            reading_of(&answer(200, r#"{"usage":{"rolling":{"percent":1}}}"#)),
            Reading::Limits(_)
        ));
        assert!(matches!(reading_of(&answer(200, "{}")), Reading::Failed(_)));
        assert_eq!(
            reading_of(&answer(
                401,
                r#"{"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}"#
            )),
            Reading::Unavailable(NOT_FOR_THIS_KEY.into())
        );
        assert_eq!(
            reading_of(&answer(
                403,
                r#"{"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}"#
            )),
            Reading::Unavailable(NO_GO_PLAN.into())
        );
        assert!(matches!(reading_of(&answer(503, "")), Reading::Failed(m) if m.contains("503")));
    }

    /// The request as `opencode::usage` makes it, against a stand-in that answers like the
    /// gateway's source does.
    #[test]
    fn the_usage_request_carries_the_key_and_reads_the_windows() {
        let (base, seen) = http::stand_in::serve(|req| {
            if req.headers.contains("authorization: bearer oc_sk_go") {
                (200, r#"{"usage":{"rolling":{"status":"ok","percent":42,"resetsAt":"2026-11-15T17:00:00.000Z"},"weekly":{"status":"ok","percent":8,"resetsAt":"2026-11-16T00:00:00.000Z"},"monthly":{"status":"ok","percent":3,"resetsAt":"2026-12-01T00:00:00.000Z"}}}"#.into())
            } else {
                (
                    401,
                    r#"{"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}"#
                        .into(),
                )
            }
        });
        let url = usage_url(&format!("{base}/inference/go/anthropic")).unwrap();
        let answer = tauri::async_runtime::block_on(http::get_with_key(&url, "oc_sk_go")).unwrap();
        let Reading::Limits(limits) = reading_of(&answer) else {
            panic!("no limits");
        };
        assert_eq!(limits.len(), 3);
        assert_eq!(seen.lock().unwrap()[0].target, "/inference/go/v1/usage");
        let answer =
            tauri::async_runtime::block_on(http::get_with_key(&url, "oc_sk_other")).unwrap();
        assert_eq!(
            reading_of(&answer),
            Reading::Unavailable(NOT_FOR_THIS_KEY.into())
        );
    }

    #[test]
    fn a_failed_refresh_keeps_the_last_limits() {
        let mut status = OpencodeUsage::default();
        let limits = parse_go_usage(br#"{"usage":{"rolling":{"percent":5}}}"#).unwrap();
        apply(&mut status, Reading::Limits(limits.clone()), "t1".into());
        apply(&mut status, Reading::Failed("down".into()), "t2".into());
        assert_eq!(status.limits, limits);
        assert_eq!(status.error.as_deref(), Some("down"));
        assert_eq!(status.fetched_at.as_deref(), Some("t1"));
        apply(
            &mut status,
            Reading::Unavailable(NOT_GO.into()),
            "t3".into(),
        );
        assert!(status.limits.is_empty());
        assert_eq!(status.unavailable.as_deref(), Some(NOT_GO));
    }
}

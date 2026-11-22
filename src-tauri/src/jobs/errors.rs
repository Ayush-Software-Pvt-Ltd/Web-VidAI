//! User-readable job errors (`JobView::error`): short, human, no jargon, no em dash.

use chrono::{DateTime, Local, TimeZone, Utc};

use crate::claude::protocol::TurnResult;
use crate::model::JobKind;
use crate::opencode::http::{Service, failure_text_for, unknown_failure};

/// "Claude finished without ..." for a job of `kind`.
pub fn missing_output(kind: JobKind) -> String {
    match kind {
        JobKind::Edit => "Claude finished without creating a review project.",
        JobKind::ReEdit => "Claude finished without saving a new review project version.",
        JobKind::Render => "Claude finished without creating a final render.",
    }
    .to_owned()
}

/// "Claude usage limit reached, resets at 4:30 PM" (local time; the date is added when the reset
/// is not today).
pub fn usage_limit(resets_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> String {
    usage_limit_in(resets_at, now, &Local)
}

fn usage_limit_in<Tz: TimeZone>(
    resets_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
    tz: &Tz,
) -> String
where
    Tz::Offset: std::fmt::Display,
{
    match resets_at.filter(|r| *r > now) {
        Some(reset) => {
            let local = reset.with_timezone(tz);
            let today = now.with_timezone(tz).date_naive() == local.date_naive();
            if today {
                format!(
                    "Claude usage limit reached, resets at {}",
                    local.format("%-I:%M %p")
                )
            } else {
                format!(
                    "Claude usage limit reached, resets on {} at {}",
                    local.format("%b %-d"),
                    local.format("%-I:%M %p")
                )
            }
        }
        None => "Claude usage limit reached. Try again when the limit resets.".to_owned(),
    }
}

/// Claude Code is logged out (or its login expired) while a job ran or was about to start.
pub fn logged_out() -> String {
    "Claude Code is logged out. Log in again (Settings, System), then press Continue Editing."
        .to_owned()
}

/// Claude Code ended unexpectedly.
pub fn crashed(code: Option<i32>, signal: Option<i32>, last_stderr: Option<&str>) -> String {
    let how = match (code, signal) {
        (Some(code), _) => format!("exit code {code}"),
        (None, Some(signal)) => format!("signal {signal}"),
        (None, None) => "unknown reason".to_owned(),
    };
    match last_stderr.map(str::trim).filter(|l| !l.is_empty()) {
        Some(line) => format!(
            "Claude Code stopped unexpectedly ({how}): {}",
            super::log::truncate_chars(line, 300)
        ),
        None => format!("Claude Code stopped unexpectedly ({how})."),
    }
}

/// Claude Code produced no output at all for a long time.
pub fn stalled(minutes: u64) -> String {
    format!("Claude Code stopped responding (no activity for {minutes} minutes).")
}

/// A job of `kind` that VidAI kept going stopped because its model is stuck
/// (`jobs::keepgoing::Stuck`). Provider-neutral: on OpenCode the model is not Claude.
pub fn stuck(kind: JobKind, why: crate::jobs::keepgoing::Stuck) -> String {
    use crate::jobs::keepgoing::{Stuck, work_noun};
    let work = work_noun(kind);
    match why {
        Stuck::IdleTurns(n) => format!(
            "The model stopped working on the {work}: it ended {n} turns in a row without doing anything. Press Continue Editing to try again."
        ),
        Stuck::NoProgress(n) => format!(
            "The model made no progress on the {work} after being asked {n} times to keep going. Press Continue Editing to try again."
        ),
        Stuck::Ceiling(n) => format!(
            "The {work} is still not finished after VidAI asked {n} times to keep going, the most it asks in one run. Press Continue Editing to go on."
        ),
    }
}

/// The Claude process could not be started.
pub fn spawn_failed(err: &std::io::Error) -> String {
    format!("Claude Code could not be started: {err}")
}

/// The Editing Folder is gone.
pub fn editing_folder_missing(path: &std::path::Path) -> String {
    format!(
        "The Editing Folder is missing: {}. Reconnect the drive or choose the folder again in Settings.",
        path.display()
    )
}

/// The video folder is gone.
pub fn video_folder_missing(path: &std::path::Path) -> String {
    format!("The video folder is missing: {}", path.display())
}

/// Text patterns of a usage limit in a result or error message.
pub(super) fn looks_like_usage_limit(text: &str) -> bool {
    let t = text.to_lowercase();
    t.contains("usage limit")
        || t.contains("hit your limit")
        || t.contains("limit reached")
        || t.contains("rate limit")
        || t.contains("limit will reset")
}

/// Text patterns of a lost login.
pub(super) fn looks_logged_out(text: &str) -> bool {
    let t = text.to_lowercase();
    t.contains("/login")
        || t.contains("not logged in")
        || t.contains("please log in")
        || t.contains("invalid api key")
        || t.contains("oauth token")
        || t.contains("authentication_error")
        || t.contains("authentication failed")
}

/// The reset time Claude Code appends to its classic limit message: `...|1794637200`.
pub(super) fn epoch_suffix(text: &str) -> Option<i64> {
    let (_, tail) = text.rsplit_once('|')?;
    tail.trim()
        .parse()
        .ok()
        .filter(|t: &i64| *t > 1_000_000_000)
}

/// The `error` of a job that gave up retrying after a model error: `message` plus how often it
/// retried (SPEC section 6, "Retrying after a model error").
pub fn retries_used_up(message: &str, retries: u32) -> String {
    let times = if retries == 1 {
        "1 time".to_owned()
    } else {
        format!("{retries} times")
    };
    format!(
        "{}. VidAI retried {times} without success.",
        message.trim_end().trim_end_matches('.')
    )
}

/// The message for an error result. `limit_reset` is the reset time of a rejected
/// `rate_limit_event` seen in this process (epoch seconds), if any.
pub fn for_error_result(
    result: &TurnResult,
    limit_reset: Option<Option<i64>>,
    now: DateTime<Utc>,
) -> String {
    let text = result.error_text();
    let api_429 = result.api_error_status == Some(429);
    if limit_reset.is_some() || looks_like_usage_limit(&text) || api_429 {
        let reset = limit_reset
            .flatten()
            .or_else(|| epoch_suffix(&text))
            .and_then(|s| Utc.timestamp_opt(s, 0).single());
        return usage_limit(reset, now);
    }
    if looks_logged_out(&text) || result.api_error_status == Some(401) {
        return logged_out();
    }
    format!(
        "Claude Code reported an error: {}",
        super::log::truncate_chars(&super::log::first_line(&text), 300)
    )
}

/// The message for an error result of a job on an API option, Claude Code as its program: what
/// the service answered, in words (`opencode::http::failure_text_for`, naming OpenCode for an
/// OpenCode address and "the service" for any other). A refused key is the key's problem, never a
/// lost Claude login, and a limit is the service's, never the Claude plan's.
pub fn for_opencode_result(result: &TurnResult, model: Option<&str>, service: Service) -> String {
    opencode_result(result, model, service, "Claude Code")
}

/// [`for_opencode_result`] for a job in the OpenCode 2 program (its errors are translated into the
/// same shape, `opencode::harness::events2::TurnError::text`); what is not one of OpenCode's known
/// answers is reported as OpenCode 2's error.
pub fn for_opencode2_program_result(
    result: &TurnResult,
    model: Option<&str>,
    service: Service,
) -> String {
    opencode_result(result, model, service, "OpenCode 2")
}

fn opencode_result(
    result: &TurnResult,
    model: Option<&str>,
    service: Service,
    program: &str,
) -> String {
    let text = result.error_text();
    let status = result
        .api_error_status
        .and_then(|s| u16::try_from(s).ok())
        .or_else(|| api_error_status_in(&text));
    let status = status.or_else(|| looks_logged_out(&text).then_some(401));
    let readable = failure_text_for(service, status, &text, model);
    if readable != unknown_failure(service) {
        return readable;
    }
    format!(
        "{program} reported an error: {}",
        super::log::truncate_chars(&super::log::first_line(&text), 300)
    )
}

/// The HTTP status in Claude Code's "API Error: 429 {...}" text.
pub(super) fn api_error_status_in(text: &str) -> Option<u16> {
    let rest = text.split("API Error: ").nth(1)?;
    rest.get(..3)?
        .parse()
        .ok()
        .filter(|s| (400..600).contains(s))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    #[test]
    fn opencode_results_say_what_opencode_answered() {
        let go = error(
            r#"API Error: 429 {"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"},"metadata":{"limitName":"weekly"}}"#,
        );
        assert!(
            for_opencode_result(&go, Some("glm-5.3"), Service::OpenCode)
                .starts_with("The weekly limit of your OpenCode Go plan")
        );
        let key = error("Invalid API key \u{b7} Please run /login");
        assert!(
            for_opencode_result(&key, None, Service::OpenCode)
                .starts_with("OpenCode did not accept the API key")
        );
        let mut forbidden = error("API Error: 403 Forbidden");
        forbidden.api_error_status = Some(403);
        assert!(
            for_opencode_result(&forbidden, Some("big-pickle"), Service::OpenCode)
                .contains("does not allow the model big-pickle")
        );
        let budget = error("API Error: Upstream request failed: Policy budget exceeded");
        assert!(
            for_opencode_result(&budget, None, Service::OpenCode)
                .starts_with("An OpenCode budget limit")
        );
        assert_eq!(
            for_opencode_result(&error("Something odd\nmore"), None, Service::OpenCode),
            "Claude Code reported an error: Something odd"
        );
        assert_eq!(
            for_opencode2_program_result(&error("Something odd\nmore"), None, Service::OpenCode),
            "OpenCode 2 reported an error: Something odd"
        );
    }

    #[test]
    fn results_of_another_service_name_it_generically() {
        let key = error("Invalid API key \u{b7} Please run /login");
        for message in [
            for_opencode_result(&key, None, Service::Generic),
            for_opencode2_program_result(&key, None, Service::Generic),
        ] {
            assert!(
                message.starts_with("The service did not accept the API key"),
                "{message}"
            );
            assert!(!message.contains("OpenCode"), "{message}");
        }
        let mut limited = error("API Error: 429 too many");
        limited.api_error_status = Some(429);
        assert_eq!(
            for_opencode2_program_result(&limited, None, Service::Generic),
            "The service is limiting requests right now. Try again in a minute."
        );
        let mut forbidden = error("API Error: 403 Forbidden");
        forbidden.api_error_status = Some(403);
        assert!(
            for_opencode_result(&forbidden, Some("m1"), Service::Generic)
                .starts_with("The service does not allow the model m1 for this key")
        );
        // What the service did not say anything about is the program's own report.
        assert_eq!(
            for_opencode2_program_result(&error("Something odd"), None, Service::Generic),
            "OpenCode 2 reported an error: Something odd"
        );
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 14, 10, 0, 0).unwrap()
    }

    #[test]
    fn usage_limit_wording() {
        let tz = FixedOffset::east_opt(0).unwrap();
        let today = Utc.with_ymd_and_hms(2026, 11, 14, 16, 30, 0).unwrap();
        assert_eq!(
            usage_limit_in(Some(today), now(), &tz),
            "Claude usage limit reached, resets at 4:30 PM"
        );
        let later = Utc.with_ymd_and_hms(2026, 11, 19, 9, 5, 0).unwrap();
        assert_eq!(
            usage_limit_in(Some(later), now(), &tz),
            "Claude usage limit reached, resets on Nov 19 at 9:05 AM"
        );
        assert_eq!(
            usage_limit_in(None, now(), &tz),
            "Claude usage limit reached. Try again when the limit resets."
        );
    }

    fn error(text: &str) -> TurnResult {
        TurnResult {
            subtype: "success".into(),
            is_error: true,
            num_turns: 1,
            text: Some(text.into()),
            ..TurnResult::default()
        }
    }

    #[test]
    fn classifies_error_results() {
        assert!(
            for_error_result(
                &error("You've hit your limit \u{b7} resets 4:30pm"),
                None,
                now()
            )
            .starts_with("Claude usage limit reached")
        );
        let classic = for_error_result(
            &error("Claude AI usage limit reached|1794655200"),
            None,
            now(),
        );
        assert!(
            classic.starts_with("Claude usage limit reached, resets"),
            "{classic}"
        );
        assert!(
            for_error_result(&error("Overloaded"), Some(Some(1794655200)), now())
                .starts_with("Claude usage limit reached, resets")
        );
        assert_eq!(
            for_error_result(
                &error("Invalid API key \u{b7} Please run /login"),
                None,
                now()
            ),
            logged_out()
        );
        assert_eq!(
            for_error_result(&error("API Error: 500 Internal\nmore"), None, now()),
            "Claude Code reported an error: API Error: 500 Internal"
        );
    }

    #[test]
    fn other_messages() {
        assert_eq!(
            crashed(Some(2), None, Some("  Error: boom ")),
            "Claude Code stopped unexpectedly (exit code 2): Error: boom"
        );
        assert_eq!(
            crashed(None, Some(9), None),
            "Claude Code stopped unexpectedly (signal 9)."
        );
        assert_eq!(
            missing_output(JobKind::Edit),
            "Claude finished without creating a review project."
        );
        use crate::jobs::keepgoing::Stuck;
        assert_eq!(
            stuck(JobKind::Edit, Stuck::IdleTurns(3)),
            "The model stopped working on the edit: it ended 3 turns in a row without doing anything. Press Continue Editing to try again."
        );
        assert_eq!(
            stuck(JobKind::ReEdit, Stuck::NoProgress(8)),
            "The model made no progress on the re-edit after being asked 8 times to keep going. Press Continue Editing to try again."
        );
        assert_eq!(
            stuck(JobKind::Render, Stuck::Ceiling(40)),
            "The final render is still not finished after VidAI asked 40 times to keep going, the most it asks in one run. Press Continue Editing to go on."
        );
    }
}

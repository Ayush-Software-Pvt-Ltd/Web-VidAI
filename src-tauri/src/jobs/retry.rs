//! Automatic retries after the model provider failed (SPEC section 6, "Retrying after a model
//! error"): which failures are the provider's, how long to wait before each retry, and the words
//! of the wait. Pure, so it is tested without a process; the driver does the waiting.

use std::time::Duration;

use chrono::{DateTime, Local, TimeZone, Utc};

use crate::claude::protocol::TurnResult;
use crate::jobs::errors::{
    api_error_status_in, epoch_suffix, looks_like_usage_limit, looks_logged_out,
};

/// How long to wait before retry 1, 2, 3, 4 and 5; every later retry waits [`LATER_GAP`].
pub const GAPS: [Duration; 5] = [
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(2 * 60),
    Duration::from_secs(5 * 60),
    Duration::from_secs(10 * 60),
];
/// The wait before every retry after the fifth.
pub const LATER_GAP: Duration = Duration::from_secs(15 * 60);

/// A failure of the model provider that may pass by itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    /// Short, for the log: "529 Overloaded", "Usage limit".
    pub what: String,
    /// When the provider said a usage limit resets.
    pub reset: Option<DateTime<Utc>>,
}

/// Text of answers that waiting does not fix: the plan, the balance, the key or the model.
const NOT_TRANSIENT: [&str; 12] = [
    "gousagelimit",
    "go usage limit",
    "freeusagelimit",
    "budget exceeded",
    "budget policy",
    "budgetlimit",
    "insufficient account funds",
    "credit balance",
    "credit limit",
    "invoice is overdue",
    "model_not_found",
    "model not found",
];

/// Text of network and server trouble that carries no status, with the name it gets in the log.
const TEXTS: [(&str, &str); 14] = [
    ("overloaded", "Overloaded"),
    ("rate limit", "Rate limit"),
    ("internal server error", "Server error"),
    ("bad gateway", "Bad gateway"),
    ("service unavailable", "Service unavailable"),
    ("temporarily unavailable", "Service unavailable"),
    ("gateway timeout", "Gateway timeout"),
    ("timed out", "Timeout"),
    ("etimedout", "Timeout"),
    ("econnreset", "Network error"),
    ("econnrefused", "Network error"),
    ("socket hang up", "Network error"),
    ("fetch failed", "Network error"),
    ("network error", "Network error"),
];

fn status_name(status: u16) -> &'static str {
    match status {
        400 => "Bad request",
        408 => "Request timeout",
        409 => "Conflict",
        425 => "Too early",
        429 => "Rate limited",
        500 => "Server error",
        502 => "Bad gateway",
        503 => "Service unavailable",
        504 => "Gateway timeout",
        529 => "Overloaded",
        _ => "Server error",
    }
}

/// Whether an error result is the provider's failure that may pass: HTTP 400, 408, 409, 425, 429
/// and every 5xx (529 overloaded included), a usage limit, an overloaded or rate-limited
/// provider, and network trouble. Never a lost login, a refused key, a missing model or plan
/// limit that only a person fixes. `limit_reset` is the reset time of a rejected
/// `rate_limit_event` seen in this process (epoch seconds), if any.
pub fn classify(result: &TurnResult, limit_reset: Option<Option<i64>>) -> Option<Failure> {
    let text = result.error_text();
    let lower = text.to_lowercase();
    let status = result
        .api_error_status
        .and_then(|s| u16::try_from(s).ok())
        .or_else(|| api_error_status_in(&text));
    if looks_logged_out(&text)
        || matches!(status, Some(401..=404))
        || NOT_TRANSIENT.iter().any(|p| lower.contains(p))
    {
        return None;
    }
    if limit_reset.is_some() || looks_like_usage_limit(&text) || status == Some(429) {
        let reset = limit_reset
            .flatten()
            .or_else(|| epoch_suffix(&text))
            .and_then(|s| Utc.timestamp_opt(s, 0).single());
        let what = match status {
            Some(status) => format!("{status} {}", status_name(status)),
            None => "Usage limit".to_owned(),
        };
        return Some(Failure { what, reset });
    }
    let what = match status {
        Some(s @ (400 | 408 | 409 | 425 | 500..=599)) => format!("{s} {}", status_name(s)),
        Some(_) => return None,
        None => TEXTS
            .iter()
            .find(|(pattern, _)| lower.contains(pattern))?
            .1
            .to_owned(),
    };
    Some(Failure { what, reset: None })
}

/// The scheduled wait before retry number `retry` (1 is the first).
pub fn gap(retry: u32) -> Duration {
    let index = usize::try_from(retry.saturating_sub(1)).unwrap_or(usize::MAX);
    GAPS.get(index).copied().unwrap_or(LATER_GAP)
}

/// The wait before a retry: the scheduled `gap`, or until the provider's `reset` when that is
/// later.
pub fn wait(gap: Duration, reset: Option<DateTime<Utc>>, now: DateTime<Utc>) -> Duration {
    let until_reset = reset
        .and_then(|r| (r - now).to_std().ok())
        .unwrap_or_default();
    gap.max(until_reset)
}

/// "30 seconds", "2 minutes", "1 hour 5 minutes" (whole minutes from a minute on, rounded up).
pub fn in_words(wait: Duration) -> String {
    let secs = wait.as_secs();
    if secs < 60 {
        return match secs {
            1 => "1 second".to_owned(),
            n => format!("{n} seconds"),
        };
    }
    let minutes = secs.div_ceil(60);
    let (hours, minutes) = (minutes / 60, minutes % 60);
    let plural = |n: u64, unit: &str| format!("{n} {unit}{}", if n == 1 { "" } else { "s" });
    match (hours, minutes) {
        (0, m) => plural(m, "minute"),
        (h, 0) => plural(h, "hour"),
        (h, m) => format!("{} {}", plural(h, "hour"), plural(m, "minute")),
    }
}

/// The local clock time of `at`, with the date when it is not today.
pub fn clock(at: DateTime<Utc>, now: DateTime<Utc>) -> String {
    clock_in(at, now, &Local)
}

fn clock_in<Tz: TimeZone>(at: DateTime<Utc>, now: DateTime<Utc>, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let local = at.with_timezone(tz);
    if now.with_timezone(tz).date_naive() == local.date_naive() {
        local.format("%-I:%M %p").to_string()
    } else {
        local.format("%b %-d, %-I:%M %p").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn error(text: &str, status: Option<i64>) -> TurnResult {
        TurnResult {
            subtype: "success".into(),
            is_error: true,
            num_turns: 1,
            text: Some(text.into()),
            api_error_status: status,
            ..TurnResult::default()
        }
    }

    fn what(text: &str, status: Option<i64>) -> Option<String> {
        classify(&error(text, status), None).map(|f| f.what)
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 14, 10, 0, 0).unwrap()
    }

    #[test]
    fn the_schedule_is_30s_1m_2m_5m_10m_then_15m() {
        let secs: Vec<u64> = (1..=8).map(|n| gap(n).as_secs()).collect();
        assert_eq!(secs, [30, 60, 120, 300, 600, 900, 900, 900]);
        assert_eq!(gap(0), GAPS[0]);
        assert_eq!(gap(u32::MAX), LATER_GAP);
    }

    #[test]
    fn a_later_reset_replaces_the_gap() {
        let gap = Duration::from_secs(60);
        assert_eq!(wait(gap, None, now()), gap);
        let soon = now() + chrono::Duration::seconds(20);
        assert_eq!(wait(gap, Some(soon), now()), gap);
        let later = now() + chrono::Duration::hours(2);
        assert_eq!(wait(gap, Some(later), now()), Duration::from_secs(7200));
        assert_eq!(
            wait(gap, Some(now() - chrono::Duration::hours(1)), now()),
            gap
        );
    }

    #[test]
    fn waits_in_words() {
        let words = |s| in_words(Duration::from_secs(s));
        assert_eq!(words(1), "1 second");
        assert_eq!(words(30), "30 seconds");
        assert_eq!(words(60), "1 minute");
        assert_eq!(words(120), "2 minutes");
        assert_eq!(words(61), "2 minutes");
        assert_eq!(words(900), "15 minutes");
        assert_eq!(words(3600), "1 hour");
        assert_eq!(words(3900), "1 hour 5 minutes");
        assert_eq!(words(7200), "2 hours");
    }

    #[test]
    fn clock_names_the_date_when_it_is_not_today() {
        let tz = FixedOffset::east_opt(0).unwrap();
        let today = Utc.with_ymd_and_hms(2026, 11, 14, 16, 30, 0).unwrap();
        assert_eq!(clock_in(today, now(), &tz), "4:30 PM");
        let later = Utc.with_ymd_and_hms(2026, 11, 19, 9, 5, 0).unwrap();
        assert_eq!(clock_in(later, now(), &tz), "Nov 19, 9:05 AM");
    }

    #[test]
    fn provider_failures_are_retried() {
        assert_eq!(
            what("API Error: 529 {\"type\":\"overloaded_error\"}", Some(529)).as_deref(),
            Some("529 Overloaded")
        );
        for status in [400, 408, 409, 425, 500, 502, 503, 504, 520, 529] {
            assert!(what("API Error", Some(status)).is_some(), "{status}");
        }
        // Without a status field the text says it.
        assert_eq!(
            what("API Error: 503 Service Unavailable", None).as_deref(),
            Some("503 Service unavailable")
        );
        assert_eq!(what("Overloaded", None).as_deref(), Some("Overloaded"));
        assert_eq!(
            what("API Error: Request timed out.", None).as_deref(),
            Some("Timeout")
        );
        assert_eq!(
            what("API Error: Unable to connect: ECONNRESET", None).as_deref(),
            Some("Network error")
        );
        assert_eq!(
            what("API Error: 429 rate_limit_error", Some(429)).as_deref(),
            Some("429 Rate limited")
        );
    }

    #[test]
    fn a_usage_limit_waits_for_its_reset() {
        let failure = classify(
            &error("Claude AI usage limit reached|1794655200", None),
            None,
        )
        .expect("retried");
        assert_eq!(failure.what, "Usage limit");
        assert_eq!(failure.reset, Utc.timestamp_opt(1794655200, 0).single());
        let failure = classify(&error("Overloaded", None), Some(Some(1794655200))).unwrap();
        assert_eq!(failure.reset, Utc.timestamp_opt(1794655200, 0).single());
        let failure = classify(&error("You've hit your limit", None), Some(None)).unwrap();
        assert_eq!(failure.reset, None);
    }

    #[test]
    fn what_waiting_does_not_fix_is_not_retried() {
        for (text, status) in [
            ("Invalid API key \u{b7} Please run /login", None),
            ("API Error: 401 authentication_error", Some(401)),
            ("API Error: 403 Forbidden", Some(403)),
            ("API Error: 404 model_not_found", Some(404)),
            ("API Error: 402 Insufficient account funds", Some(402)),
            ("Your credit balance is too low", Some(400)),
            (
                "API Error: 429 GoUsageLimitError Go usage limit exceeded",
                Some(429),
            ),
            (
                "API Error: Upstream request failed: Policy budget exceeded",
                None,
            ),
            ("Something odd happened", None),
            ("API Error: 422 invalid", Some(422)),
        ] {
            assert_eq!(what(text, status), None, "{text}");
        }
    }
}

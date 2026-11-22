//! The plan's usage limits (`UsageStatus`): periodic refresh through the local Claude Code
//! process (`get_usage` control request) and free updates from the `rate_limit_event` lines of
//! running jobs (SPEC section 6, "Models, effort and usage limits").
//!
//! This file holds the pure mapping from Claude Code's answers to `UsageLimit`s. The refresh
//! schedule and the helper process live in `claude::service`.
//!
//! A `get_usage` answer (Claude Code 2.1.319) has `rate_limits_available` and `rate_limits` with
//! the windows `five_hour` and `seven_day` (`{ utilization: percent, resets_at: ISO }` or null),
//! model-scoped weekly windows (`seven_day_opus`, `seven_day_sonnet`, `model_scoped[]`), and a
//! `limits` array that lists the same limits by `kind`: `session`, `weekly_all`, and
//! `weekly_scoped` with `scope.model.display_name`. All of them are read and merged by key, the
//! `limits` array first.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;
use tauri::AppHandle;

use crate::model::UsageLimit;

/// Key of the 5-hour (session) limit.
pub const FIVE_HOUR: &str = "fiveHour";
/// Key of the weekly limit over all models.
pub const WEEKLY: &str = "weekly";

/// Feeds the `rate_limit_info` object of a `rate_limit_event` line from a running job into the
/// usage status (`unifiedWindows.{five_hour,seven_day}.{utilization 0..1, resetsAt epoch s}`),
/// and emits `events::UsageUpdated` when it changed. Never blocks, never fails.
pub fn record_rate_limit_event(app: &AppHandle, rate_limit_info: &serde_json::Value) {
    super::service::record_rate_limit_limits(app, limits_from_rate_limit_info(rate_limit_info));
}

/// `(available, limits)` from a `get_usage` answer. Limits are ordered `fiveHour`, `weekly`,
/// then the model-scoped weekly ones in the order Claude Code lists them.
pub fn parse_usage(answer: &Value) -> (bool, Vec<UsageLimit>) {
    let available = answer
        .get("rate_limits_available")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(windows) = answer.get("rate_limits").filter(|v| v.is_object()) else {
        return (false, Vec::new());
    };
    if !available {
        return (false, Vec::new());
    }
    let mut limits = Vec::new();
    for entry in windows
        .get("limits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = match entry.get("kind").and_then(Value::as_str) {
            Some("session") => Some(LimitName::FiveHour),
            Some("weekly_all") => Some(LimitName::Weekly),
            Some("weekly_scoped") => entry
                .pointer("/scope/model/display_name")
                .and_then(Value::as_str)
                .map(LimitName::Scoped),
            _ => None,
        };
        if let Some(name) = name {
            push(
                &mut limits,
                name,
                entry.get("percent"),
                entry.get("resets_at"),
            );
        }
    }
    let window = |key: &str| windows.get(key).filter(|w| w.is_object());
    let windowed = [
        ("five_hour", LimitName::FiveHour),
        ("seven_day", LimitName::Weekly),
        ("seven_day_opus", LimitName::Scoped("Opus")),
        ("seven_day_sonnet", LimitName::Scoped("Sonnet")),
    ];
    for (key, name) in windowed {
        if let Some(w) = window(key) {
            push(&mut limits, name, w.get("utilization"), w.get("resets_at"));
        }
    }
    for entry in windows
        .get("model_scoped")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(model) = entry.get("display_name").and_then(Value::as_str) {
            push(
                &mut limits,
                LimitName::Scoped(model),
                entry.get("utilization"),
                entry.get("resets_at"),
            );
        }
    }
    sort(&mut limits);
    (!limits.is_empty(), limits)
}

/// The 5-hour and weekly limits of a `rate_limit_event`'s `rate_limit_info`, where utilization
/// is a fraction (0..1) and `resetsAt` is in epoch seconds. Empty when the shape is unknown.
pub fn limits_from_rate_limit_info(info: &Value) -> Vec<UsageLimit> {
    let mut limits = Vec::new();
    for (key, name) in [
        ("five_hour", LimitName::FiveHour),
        ("seven_day", LimitName::Weekly),
    ] {
        let Some(window) = info.pointer(&format!("/unifiedWindows/{key}")) else {
            continue;
        };
        let Some(fraction) = window.get("utilization").and_then(Value::as_f64) else {
            continue;
        };
        let resets_at = window
            .get("resetsAt")
            .and_then(Value::as_f64)
            .and_then(|s| DateTime::<Utc>::from_timestamp_millis((s * 1000.0) as i64))
            .map(iso);
        if let Some(limit) = limit(name, fraction * 100.0, resets_at) {
            limits.push(limit);
        }
    }
    limits
}

/// Replaces the limits in `current` that `updates` has a value for (by key), keeps the others,
/// and keeps the canonical order. Returns whether anything changed.
pub fn merge(current: &mut Vec<UsageLimit>, updates: Vec<UsageLimit>) -> bool {
    let before = current.clone();
    for update in updates {
        match current.iter_mut().find(|l| l.key == update.key) {
            Some(existing) => *existing = update,
            None => current.push(update),
        }
    }
    sort(current);
    *current != before
}

/// Which limit a value belongs to.
#[derive(Clone, Copy)]
enum LimitName<'a> {
    FiveHour,
    Weekly,
    /// A weekly limit for one model family, by its display name (for example "Fable").
    Scoped(&'a str),
}

fn push(
    limits: &mut Vec<UsageLimit>,
    name: LimitName,
    percent: Option<&Value>,
    resets: Option<&Value>,
) {
    let resets_at = resets.and_then(Value::as_str).and_then(normalize_iso);
    let Some(limit) = percent
        .and_then(Value::as_f64)
        .and_then(|p| limit(name, p, resets_at))
    else {
        return;
    };
    if !limits.iter().any(|l| l.key == limit.key) {
        limits.push(limit);
    }
}

fn limit(name: LimitName, percent: f64, resets_at: Option<String>) -> Option<UsageLimit> {
    if !percent.is_finite() {
        return None;
    }
    let (key, label) = match name {
        LimitName::FiveHour => (FIVE_HOUR.to_owned(), "5-hour limit".to_owned()),
        LimitName::Weekly => (WEEKLY.to_owned(), "Weekly limit".to_owned()),
        LimitName::Scoped(model) => {
            let model = model.trim();
            let suffix: String = model.chars().filter(char::is_ascii_alphanumeric).collect();
            if suffix.is_empty() {
                return None;
            }
            (
                format!("{WEEKLY}{}", capitalize(&suffix)),
                format!("Weekly limit ({model})"),
            )
        }
    };
    Some(UsageLimit {
        key,
        label,
        // Two decimals hide float noise such as 0.19 * 100 = 19.000000000000004.
        used_percent: (percent.clamp(0.0, 100.0) * 100.0).round() / 100.0,
        resets_at,
    })
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    chars
        .next()
        .map(|c| c.to_ascii_uppercase().to_string() + chars.as_str())
        .unwrap_or_default()
}

/// `fiveHour`, then `weekly`, then the rest in their current order.
fn sort(limits: &mut [UsageLimit]) {
    limits.sort_by_key(|l| match l.key.as_str() {
        FIVE_HOUR => 0,
        WEEKLY => 1,
        _ => 2,
    });
}

/// Any RFC 3339 time as ISO 8601 UTC with milliseconds (the format of every model timestamp).
fn normalize_iso(text: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(text.trim())
        .ok()
        .map(|t| iso(t.with_timezone(&Utc)))
}

fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(name: &str) -> Value {
        let path = format!(
            "{}/tests/fixtures/claude-control/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn lim(key: &str, label: &str, used: f64, resets: Option<&str>) -> UsageLimit {
        UsageLimit {
            key: key.into(),
            label: label.into(),
            used_percent: used,
            resets_at: resets.map(Into::into),
        }
    }

    #[test]
    fn maps_recorded_get_usage() {
        let (available, limits) = parse_usage(&fixture("get_usage.json"));
        assert!(available);
        assert_eq!(
            limits,
            vec![
                lim(
                    "fiveHour",
                    "5-hour limit",
                    20.0,
                    Some("2026-11-14T06:20:00.424Z")
                ),
                lim(
                    "weekly",
                    "Weekly limit",
                    33.0,
                    Some("2026-11-19T17:00:00.424Z")
                ),
                lim(
                    "weeklyFable",
                    "Weekly limit (Fable)",
                    11.0,
                    Some("2026-11-19T17:00:00.424Z")
                ),
            ]
        );
    }

    #[test]
    fn unavailable_plan_has_no_limits() {
        assert_eq!(
            parse_usage(&fixture("get_usage_unavailable.json")),
            (false, vec![])
        );
        assert_eq!(parse_usage(&json!({})), (false, vec![]));
        // Available but nothing readable counts as unavailable.
        assert_eq!(
            parse_usage(
                &json!({"rate_limits_available": true, "rate_limits": {"five_hour": null}})
            ),
            (false, vec![])
        );
    }

    #[test]
    fn falls_back_to_windows_without_limits_array() {
        let answer = json!({
            "rate_limits_available": true,
            "rate_limits": {
                "seven_day_opus": {"utilization": 71.5, "resets_at": "2026-11-19T22:30:00+05:30"},
                "seven_day": {"utilization": 140, "resets_at": "not a time"},
                "five_hour": {"utilization": -3, "resets_at": null},
                "model_scoped": [{"display_name": "Fable 5", "utilization": 2, "resets_at": null}]
            }
        });
        let (available, limits) = parse_usage(&answer);
        assert!(available);
        assert_eq!(
            limits,
            vec![
                lim("fiveHour", "5-hour limit", 0.0, None),
                lim("weekly", "Weekly limit", 100.0, None),
                lim(
                    "weeklyOpus",
                    "Weekly limit (Opus)",
                    71.5,
                    Some("2026-11-19T17:00:00.000Z")
                ),
                lim("weeklyFable5", "Weekly limit (Fable 5)", 2.0, None),
            ]
        );
    }

    #[test]
    fn ignores_unknown_kinds_and_scopes_without_model() {
        let answer = json!({
            "rate_limits_available": true,
            "rate_limits": {"limits": [
                {"kind": "monthly_spend", "percent": 50, "resets_at": null},
                {"kind": "weekly_scoped", "percent": 9, "scope": {"model": null, "surface": "x"}},
                {"kind": "weekly_scoped", "percent": 9, "scope": {"model": {"display_name": "  "}}},
                {"kind": "session", "percent": 12.25, "resets_at": "2026-11-14T11:20:00.070800+00:00"}
            ]}
        });
        assert_eq!(
            parse_usage(&answer).1,
            vec![lim(
                "fiveHour",
                "5-hour limit",
                12.25,
                Some("2026-11-14T11:20:00.070Z")
            )]
        );
    }

    #[test]
    fn maps_rate_limit_event() {
        let line = fixture("rate_limit_event.json");
        let limits = limits_from_rate_limit_info(&line["rate_limit_info"]);
        assert_eq!(
            limits,
            vec![
                lim(
                    "fiveHour",
                    "5-hour limit",
                    19.0,
                    Some("2026-11-14T06:20:00.000Z")
                ),
                lim(
                    "weekly",
                    "Weekly limit",
                    32.0,
                    Some("2026-11-19T17:00:00.000Z")
                ),
            ]
        );
        assert!(limits_from_rate_limit_info(&json!({"status": "allowed"})).is_empty());
        assert!(
            limits_from_rate_limit_info(&json!({"unifiedWindows": {"five_hour": {}}})).is_empty()
        );
    }

    #[test]
    fn merge_replaces_by_key_and_keeps_scoped_limits() {
        let mut current = vec![
            lim("fiveHour", "5-hour limit", 10.0, None),
            lim("weekly", "Weekly limit", 30.0, None),
            lim("weeklyFable", "Weekly limit (Fable)", 5.0, None),
        ];
        let update = vec![
            lim("weekly", "Weekly limit", 31.0, None),
            lim("fiveHour", "5-hour limit", 10.0, None),
        ];
        assert!(merge(&mut current, update.clone()));
        assert_eq!(current[1].used_percent, 31.0);
        assert_eq!(current[2].key, "weeklyFable");
        assert!(!merge(&mut current, update));
        // Into an empty status the canonical order is kept.
        let mut empty = Vec::new();
        assert!(merge(
            &mut empty,
            vec![
                lim("weekly", "Weekly limit", 1.0, None),
                lim("fiveHour", "5-hour limit", 2.0, None)
            ]
        ));
        assert_eq!(empty[0].key, "fiveHour");
    }
}

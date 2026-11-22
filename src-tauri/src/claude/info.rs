//! `ClaudeInfo`: the models, effort levels and defaults of the local Claude Code, read from the
//! `initialize` and `get_settings` control requests (SPEC section 6, "Models, effort and usage
//! limits").
//!
//! Refresh policy: at startup, on demand (`get_claude_info(refresh: true)`), and at most once a
//! day otherwise (see `claude::refresh`). The last result is cached in `state.json` through the
//! store, `events::ClaudeInfoUpdated` is emitted, and the saved model selection is normalized
//! again when the list changed.

use std::time::Duration;

use serde_json::Value;

use super::control::ControlClient;
use crate::error::AppResult;
use crate::model::{ClaudeInfo, ClaudeModel};

/// How long `initialize` may take (it answers in well under a second normally).
pub const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long `get_settings` may take.
pub const SETTINGS_TIMEOUT: Duration = Duration::from_secs(15);
/// How old the cached list may get before it is fetched again without being asked.
pub const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// The value Claude Code uses for its own "Default (recommended)" entry. VidAI leaves it out of
/// the list: the UI's own "Default" choice (`model: null`) already means "let Claude Code
/// decide", which also honours the model in the user's Claude Code settings.
const DEFAULT_ENTRY: &str = "default";

/// Asks a running helper for the model list and the defaults. `get_settings` failing is not
/// fatal: the defaults are then unknown.
pub fn fetch(client: &mut ControlClient, fetched_at: String) -> AppResult<ClaudeInfo> {
    let init = client.request("initialize", INITIALIZE_TIMEOUT)?;
    let settings = client.request("get_settings", SETTINGS_TIMEOUT).ok();
    Ok(parse(&init, settings.as_ref(), Some(fetched_at)))
}

/// Builds `ClaudeInfo` from the `initialize` answer and the optional `get_settings` answer.
pub fn parse(init: &Value, settings: Option<&Value>, fetched_at: Option<String>) -> ClaudeInfo {
    let entries: Vec<&Value> = init
        .get("models")
        .and_then(Value::as_array)
        .map(|models| models.iter().collect())
        .unwrap_or_default();
    let models: Vec<ClaudeModel> = entries
        .iter()
        .filter_map(|m| parse_model(m))
        .filter(|m| m.value != DEFAULT_ENTRY)
        .collect();
    ClaudeInfo {
        default_model: settings.and_then(|s| default_model(s, &entries)),
        default_effort: settings
            .and_then(|s| s.pointer("/applied/effort"))
            .and_then(non_empty_str),
        subscription_type: init
            .pointer("/account/subscriptionType")
            .and_then(non_empty_str),
        version: init.get("claude_code_version").and_then(non_empty_str),
        models,
        fetched_at,
    }
}

fn parse_model(m: &Value) -> Option<ClaudeModel> {
    let value = m.get("value").and_then(non_empty_str)?;
    let supports_effort = m.get("supportsEffort").and_then(Value::as_bool) != Some(false);
    let effort_levels = match m.get("supportedEffortLevels").and_then(Value::as_array) {
        Some(levels) if supports_effort => levels.iter().filter_map(non_empty_str).collect(),
        _ => Vec::new(),
    };
    Some(ClaudeModel {
        display_name: m
            .get("displayName")
            .and_then(non_empty_str)
            .unwrap_or_else(|| value.clone()),
        description: m
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        effort_levels,
        value,
    })
}

/// The list value of the model Claude Code would use by itself.
///
/// `applied.model` is the resolved model id (for example "claude-fable-5-1"), while the list holds
/// aliases (for example "fable" resolving to it). Preference: an entry whose value is the applied
/// id, then the alias from the user's settings (`effective.model`) when it resolves to the
/// applied id, then the first entry that resolves to it. Without `applied.model`, Claude Code's
/// own default entry tells which model it uses.
fn default_model(settings: &Value, entries: &[&Value]) -> Option<String> {
    let value_of = |m: &Value| m.get("value").and_then(non_empty_str);
    let resolved_of = |m: &Value| m.get("resolvedModel").and_then(non_empty_str);
    let is_listed = |v: &str| entries.iter().any(|m| value_of(m).as_deref() == Some(v));
    let applied = settings
        .pointer("/applied/model")
        .and_then(non_empty_str)
        .or_else(|| {
            entries
                .iter()
                .find(|m| value_of(m).as_deref() == Some(DEFAULT_ENTRY))
                .and_then(|m| resolved_of(m))
        })?;
    if applied != DEFAULT_ENTRY && is_listed(&applied) {
        return Some(applied);
    }
    let resolves_to_applied = |v: &str| {
        entries.iter().any(|m| {
            value_of(m).as_deref() == Some(v) && resolved_of(m).as_deref() == Some(&applied)
        })
    };
    if let Some(alias) = settings.pointer("/effective/model").and_then(non_empty_str)
        && alias != DEFAULT_ENTRY
        && resolves_to_applied(&alias)
    {
        return Some(alias);
    }
    entries
        .iter()
        .filter(|m| resolved_of(m).as_deref() == Some(&applied))
        .filter_map(|m| value_of(m))
        .find(|v| v != DEFAULT_ENTRY)
        .or(Some(applied))
}

fn non_empty_str(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
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

    #[test]
    fn parses_recorded_initialize_and_settings() {
        let info = parse(
            &fixture("initialize.json"),
            Some(&fixture("get_settings.json")),
            Some("2026-11-14T06:00:00.000Z".into()),
        );
        let values: Vec<&str> = info.models.iter().map(|m| m.value.as_str()).collect();
        assert_eq!(
            values,
            [
                "opus",
                "claude-fable-5-2",
                "sonnet",
                "haiku",
                "fable",
                "claude-haiku-4-5-20251001",
                "claude-opus-4-6"
            ]
        );
        let opus = &info.models[0];
        assert_eq!(opus.display_name, "Opus 5.5");
        assert_eq!(opus.description, "For complex work and everyday tasks");
        assert_eq!(
            opus.effort_levels,
            ["low", "medium", "high", "xhigh", "max"]
        );
        // A model without effort levels.
        assert!(info.models[5].effort_levels.is_empty());
        assert_eq!(
            info.models[6].effort_levels,
            ["low", "medium", "high", "max"]
        );
        // applied.model "claude-fable-5-1" is reached through the user's alias "fable".
        assert_eq!(info.default_model.as_deref(), Some("fable"));
        assert_eq!(info.default_effort.as_deref(), Some("high"));
        assert_eq!(info.subscription_type.as_deref(), Some("Claude Team"));
        assert_eq!(info.version.as_deref(), Some("2.1.319"));
        assert_eq!(info.fetched_at.as_deref(), Some("2026-11-14T06:00:00.000Z"));
    }

    #[test]
    fn without_settings_the_defaults_are_unknown() {
        let info = parse(&fixture("initialize.json"), None, None);
        assert_eq!(info.default_model, None);
        assert_eq!(info.default_effort, None);
        assert_eq!(info.models.len(), 7);
    }

    #[test]
    fn default_model_resolution() {
        let init = fixture("initialize.json");
        let entries: Vec<&Value> = init["models"].as_array().unwrap().iter().collect();
        let dm = |s: Value| default_model(&s, &entries);
        // An applied value that is itself in the list.
        assert_eq!(
            dm(json!({"applied":{"model":"sonnet"}})).as_deref(),
            Some("sonnet")
        );
        // A resolved id without a matching alias in the settings: first alias resolving to it.
        assert_eq!(
            dm(json!({"applied":{"model":"claude-opus-5-5"}})).as_deref(),
            Some("opus")
        );
        // No model applied: Claude Code's own default entry decides.
        assert_eq!(
            dm(json!({"applied":{"model":null}})).as_deref(),
            Some("opus")
        );
        // An id the list does not know is kept as is (display only).
        assert_eq!(
            dm(json!({"applied":{"model":"claude-new-9"}})).as_deref(),
            Some("claude-new-9")
        );
    }

    #[test]
    fn tolerates_missing_fields() {
        let info = parse(
            &json!({"models":[{"value":"x"},{"displayName":"no value"},{"value":"y","supportsEffort":false,"supportedEffortLevels":["low"]}]}),
            Some(&json!({})),
            None,
        );
        assert_eq!(info.models.len(), 2);
        assert_eq!(info.models[0].display_name, "x");
        assert_eq!(info.models[0].description, "");
        assert!(info.models[1].effort_levels.is_empty());
        assert_eq!(info.subscription_type, None);
        assert_eq!(info.version, None);
        assert_eq!(parse(&json!({}), None, None), ClaudeInfo::default());
    }
}

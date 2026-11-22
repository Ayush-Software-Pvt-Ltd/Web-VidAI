//! Everything about the locally installed Claude Code CLI (SPEC section 6, "Driving Claude Code"
//! and "Models, effort and usage limits").
//!
//! - [`env`]: capture the login-shell environment once at startup.
//! - [`locate`]: find the `claude` binary (`VIDAI_CLAUDE_BIN`, login-shell `PATH`, well-known places).
//! - [`auth`]: login state from `claude auth status`.
//! - [`protocol`]: the stream-json wire format (parse stdout lines, build stdin messages).
//! - [`session`]: one running Claude Code process for a job (spawn in its own process group, send,
//!   interrupt, close).
//! - [`control`]: a helper Claude Code process that only answers control requests (`initialize`,
//!   `get_settings`, `get_usage`), never a model call.
//! - [`info`]: `ClaudeInfo` from `initialize` and `get_settings`.
//! - [`usage`]: `UsageStatus` from `get_usage` and from the `rate_limit_event` lines of jobs.
//! - [`service`]: the cached `ClaudeInfo` and `UsageStatus`, the reused usage helper and the
//!   refresh schedule.
//!
//! [`setup`] is called once from `lib.rs` at startup. [`normalize_selection`] applies the model
//! and effort selection rules and is used by `set_model_selection`.

pub mod auth;
pub mod control;
pub mod env;
pub mod info;
pub mod locate;
pub mod protocol;
pub mod service;
pub mod session;
pub mod usage;

use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::model::{ClaudeInfo, ModelSelection};
use crate::store::Store;

/// Startup hook: starts the login-shell environment capture, registers [`service::ClaudeService`]
/// as managed state, and starts the first `ClaudeInfo` and `UsageStatus` fetches and the refresh
/// schedule on background threads. Returns at once.
pub fn setup(app: &AppHandle) -> AppResult<()> {
    env::warm_up();
    let data_dir = app.state::<Store>().data_dir().to_path_buf();
    app.manage(service::ClaudeService::new(&data_dir));
    service::start(app);
    Ok(())
}

/// Applies the selection rules of SPEC section 6 against the known model list:
/// a model that is not in the list falls back to `None` (Claude Code's default), and an effort
/// the chosen model does not support is reset to `None`. Without a fetched list (`info` is `None`
/// or has no models) the selection is kept as given, only blank strings become `None`.
pub fn normalize_selection(selection: ModelSelection, info: Option<&ClaudeInfo>) -> ModelSelection {
    let clean = |v: Option<String>| v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    let mut model = clean(selection.model);
    let mut effort = clean(selection.effort);
    let Some(info) = info.filter(|i| !i.models.is_empty()) else {
        return ModelSelection { model, effort };
    };
    let effective = model.as_deref().or(info.default_model.as_deref());
    let known = effective.and_then(|v| info.models.iter().find(|m| m.value == v));
    if model.is_some() && known.is_none() {
        model = None;
    }
    let levels = match (&model, known) {
        (Some(_), Some(m)) => Some(&m.effort_levels),
        // Default model: only check when Claude Code told us which model that is.
        (None, Some(m)) if info.default_model.is_some() => Some(&m.effort_levels),
        _ => None,
    };
    if let (Some(levels), Some(e)) = (levels, &effort)
        && !levels.contains(e)
    {
        effort = None;
    }
    ModelSelection { model, effort }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ClaudeModel;

    fn info() -> ClaudeInfo {
        let model = |value: &str, levels: &[&str]| ClaudeModel {
            value: value.into(),
            display_name: value.into(),
            description: String::new(),
            effort_levels: levels.iter().map(|s| s.to_string()).collect(),
        };
        ClaudeInfo {
            models: vec![model("opus", &["low", "high"]), model("haiku", &[])],
            default_model: Some("opus".into()),
            ..ClaudeInfo::default()
        }
    }

    fn sel(model: Option<&str>, effort: Option<&str>) -> ModelSelection {
        ModelSelection {
            model: model.map(Into::into),
            effort: effort.map(Into::into),
        }
    }

    #[test]
    fn keeps_valid_selection() {
        let i = info();
        assert_eq!(
            normalize_selection(sel(Some("opus"), Some("high")), Some(&i)),
            sel(Some("opus"), Some("high"))
        );
        assert_eq!(
            normalize_selection(sel(None, Some("low")), Some(&i)),
            sel(None, Some("low"))
        );
    }

    #[test]
    fn resets_unsupported_effort_and_unknown_model() {
        let i = info();
        assert_eq!(
            normalize_selection(sel(Some("haiku"), Some("high")), Some(&i)),
            sel(Some("haiku"), None)
        );
        assert_eq!(
            normalize_selection(sel(Some("gone"), Some("low")), Some(&i)),
            sel(None, Some("low"))
        );
        assert_eq!(
            normalize_selection(sel(None, Some("max")), Some(&i)),
            sel(None, None)
        );
    }

    #[test]
    fn without_list_only_blanks_are_cleared() {
        assert_eq!(
            normalize_selection(sel(Some(" "), Some("max")), None),
            sel(None, Some("max"))
        );
        assert_eq!(
            normalize_selection(sel(Some("x"), Some("y")), None),
            sel(Some("x"), Some("y"))
        );
    }
}

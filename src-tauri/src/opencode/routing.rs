//! Whether the user's own setup already points Claude Code at another service (SPEC section 7a).
//!
//! Claude Code reads `ANTHROPIC_BASE_URL` from its environment and from the `env` object of its
//! settings file (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`), which it
//! applies over the environment. VidAI never changes either: with the Claude subscription
//! selected it sets nothing, so such a setting decides where edits go, and "Claude subscription"
//! would not mean what it says. Settings shows that plainly instead.

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::Value;

use crate::model::{ClaudeRouting, RoutingSource};

const BASE_URL_VAR: &str = "ANTHROPIC_BASE_URL";

/// Claude Code's settings file for this environment.
pub fn settings_file(env: &HashMap<String, String>) -> Option<PathBuf> {
    if let Some(dir) = env
        .get("CLAUDE_CONFIG_DIR")
        .filter(|d| !d.trim().is_empty())
    {
        return Some(PathBuf::from(dir).join("settings.json"));
    }
    crate::claude::env::home(env)
        .map(|home| PathBuf::from(home).join(".claude").join("settings.json"))
}

/// The routing in `env` or in the text of Claude Code's settings file; the settings file wins,
/// as in Claude Code.
pub fn routing_from(
    env: &HashMap<String, String>,
    settings_json: Option<&str>,
) -> Option<ClaudeRouting> {
    let from_settings = settings_json
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|v| {
            v.pointer(&format!("/env/{BASE_URL_VAR}"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|url| !url.trim().is_empty());
    if let Some(url) = from_settings {
        return Some(ClaudeRouting {
            base_url: url.trim().to_owned(),
            source: RoutingSource::ClaudeSettings,
        });
    }
    env.get(BASE_URL_VAR)
        .map(|url| url.trim())
        .filter(|url| !url.is_empty())
        .map(|url| ClaudeRouting {
            base_url: url.to_owned(),
            source: RoutingSource::Environment,
        })
}

/// The routing of this computer now (reads the settings file; cheap, called by Settings).
pub fn detect() -> Option<ClaudeRouting> {
    let env = crate::claude::env::child_env();
    let text = settings_file(&env).and_then(|path| std::fs::read_to_string(path).ok());
    routing_from(&env, text.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn finds_a_base_url_in_the_environment_or_the_settings_file() {
        assert_eq!(routing_from(&env(&[]), None), None);
        assert_eq!(
            routing_from(&env(&[("ANTHROPIC_BASE_URL", "  ")]), Some("{}")),
            None
        );
        assert_eq!(
            routing_from(
                &env(&[("ANTHROPIC_BASE_URL", "https://proxy.example")]),
                None
            ),
            Some(ClaudeRouting {
                base_url: "https://proxy.example".into(),
                source: RoutingSource::Environment
            })
        );
        let settings = r#"{"model":"opus","env":{"ANTHROPIC_BASE_URL":"https://opencode.ai/inference/anthropic"}}"#;
        assert_eq!(
            routing_from(
                &env(&[("ANTHROPIC_BASE_URL", "https://proxy.example")]),
                Some(settings)
            ),
            Some(ClaudeRouting {
                base_url: "https://opencode.ai/inference/anthropic".into(),
                source: RoutingSource::ClaudeSettings
            })
        );
        assert_eq!(routing_from(&env(&[]), Some("not json")), None);
    }

    #[test]
    fn the_settings_file_follows_claude_config_dir() {
        // `HOME` on macOS, `USERPROFILE` on Windows (`claude::env::home`).
        let (home_var, home) = if cfg!(windows) {
            ("USERPROFILE", r"C:\Users\me")
        } else {
            ("HOME", "/Users/me")
        };
        assert_eq!(
            settings_file(&env(&[(home_var, home)])),
            Some(PathBuf::from(home).join(".claude").join("settings.json"))
        );
        assert_eq!(
            settings_file(&env(&[(home_var, home), ("CLAUDE_CONFIG_DIR", "/c")])),
            Some(PathBuf::from("/c").join("settings.json"))
        );
        assert_eq!(settings_file(&env(&[])), None);
    }
}

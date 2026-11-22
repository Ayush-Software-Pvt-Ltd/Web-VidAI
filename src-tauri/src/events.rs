//! Backend to UI events (SPEC section 5), all in one place.
//!
//! Each event is a typed struct; emit it with `tauri_specta::Event::emit`, for example
//! `JobUpdated(job).emit(&app)?`. The TypeScript side gets typed listeners in
//! `src/lib/bindings.ts`, and `src/lib/ipc.ts` exposes them as `api.on.*`.
//! The wire names are fixed by the `event_name` attributes and mirrored in [`names`].

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::{Event, Events, collect_events};

use crate::model::{ClaudeInfo, JobView, LogEntry, OpencodeUsage, Settings, UsageStatus};

/// Wire names of every event, for code that needs the raw string (logs, tests).
pub mod names {
    pub const LIBRARY_CHANGED: &str = "library-changed";
    pub const JOB_UPDATED: &str = "job-updated";
    pub const JOB_LOG: &str = "job-log";
    pub const USAGE_UPDATED: &str = "usage-updated";
    pub const CLAUDE_INFO_UPDATED: &str = "claude-info-updated";
    pub const QUIT_REQUESTED: &str = "quit-requested";
    pub const SETTINGS_CHANGED: &str = "settings-changed";
    pub const OPENCODE_USAGE_UPDATED: &str = "opencode-usage-updated";
}

/// Something on disk or in a job changed; the UI calls `get_library` again. No payload.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "library-changed")]
pub struct LibraryChanged;

/// A job changed state or its `lastActivity`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "job-updated")]
pub struct JobUpdated(pub JobView);

/// New log entries, batched (at most every 150 ms).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "job-log")]
pub struct JobLog {
    pub video_id: String,
    pub job_id: String,
    pub entries: Vec<LogEntry>,
}

/// The usage limits were refreshed.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "usage-updated")]
pub struct UsageUpdated(pub UsageStatus);

/// The model list was refreshed.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "claude-info-updated")]
pub struct ClaudeInfoUpdated(pub ClaudeInfo);

/// The user tried to quit while jobs run; the UI confirms and calls `confirm_quit`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "quit-requested")]
pub struct QuitRequested {
    pub running: u32,
}

/// The settings changed without a command from the UI (the View menu's text size items); the
/// payload is the new `Settings`. Commands return the new `Settings` themselves instead.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "settings-changed")]
pub struct SettingsChanged(pub Settings);

/// The OpenCode quota was refreshed (`opencode::usage`).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "opencode-usage-updated")]
pub struct OpencodeUsageUpdated(pub OpencodeUsage);

/// Every event, for the specta builder in `lib.rs`.
pub fn all() -> Events {
    collect_events![
        LibraryChanged,
        JobUpdated,
        JobLog,
        UsageUpdated,
        ClaudeInfoUpdated,
        QuitRequested,
        SettingsChanged,
        OpencodeUsageUpdated
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_event_structs() {
        assert_eq!(LibraryChanged::NAME, names::LIBRARY_CHANGED);
        assert_eq!(JobUpdated::NAME, names::JOB_UPDATED);
        assert_eq!(JobLog::NAME, names::JOB_LOG);
        assert_eq!(UsageUpdated::NAME, names::USAGE_UPDATED);
        assert_eq!(ClaudeInfoUpdated::NAME, names::CLAUDE_INFO_UPDATED);
        assert_eq!(QuitRequested::NAME, names::QUIT_REQUESTED);
        assert_eq!(SettingsChanged::NAME, names::SETTINGS_CHANGED);
        assert_eq!(OpencodeUsageUpdated::NAME, names::OPENCODE_USAGE_UPDATED);
    }

    #[test]
    fn payload_shapes() {
        assert_eq!(
            serde_json::to_value(LibraryChanged).unwrap(),
            serde_json::Value::Null
        );
        let log = JobLog {
            video_id: "c/v".into(),
            job_id: "j".into(),
            entries: vec![],
        };
        assert_eq!(
            serde_json::to_value(log).unwrap(),
            serde_json::json!({ "videoId": "c/v", "jobId": "j", "entries": [] })
        );
    }
}

//! `AppError`, the one error shape every command rejects with (SPEC section 4).
//!
//! Modules return [`AppResult`] and pick the constructor that matches the situation, so the UI can
//! branch on `code` (for example to show the "Claude Code is not installed" flow) and show
//! `message` to the user as is. Messages are short, human and never contain an em dash.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Machine-readable error category. Serialized in camelCase, for example `"claudeNotInstalled"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    ClaudeNotInstalled,
    ClaudeNotLoggedIn,
    /// Windows: Git for Windows (Git Bash), which Claude Code needs, is not installed.
    GitBashMissing,
    NoEditingFolder,
    NotFound,
    InvalidInput,
    /// For example a rename while a job is active, or a target folder that already exists.
    Conflict,
    Io,
    Internal,
    /// macOS: the saved API keys could not be read from the Keychain at startup (the password
    /// dialog was denied or the Keychain is locked); VidAI behaves as if no key is saved until
    /// the user presses Try Again (`retry_secrets`).
    SecretsUnavailable,
}

/// The error every command rejects with: `{ code, message }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
}

/// Result alias used across the crate.
pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn claude_not_installed() -> Self {
        Self::new(
            ErrorCode::ClaudeNotInstalled,
            if cfg!(windows) {
                "Claude Code is not installed on this PC."
            } else {
                "Claude Code is not installed on this Mac."
            },
        )
    }

    pub fn claude_not_logged_in() -> Self {
        Self::new(
            ErrorCode::ClaudeNotLoggedIn,
            "Claude Code is not logged in.",
        )
    }

    /// Windows: Git Bash was not found (SPEC section 11, Prerequisites).
    pub fn git_bash_missing() -> Self {
        Self::new(
            ErrorCode::GitBashMissing,
            "VidAI needs Git for Windows (Git Bash), which Claude Code uses to run the editing tools. \
             Install it from https://git-scm.com/downloads/win, then try again.",
        )
    }

    pub fn no_editing_folder() -> Self {
        Self::new(
            ErrorCode::NoEditingFolder,
            "Choose an Editing Folder in Settings first.",
        )
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Io, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    pub fn secrets_unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::SecretsUnavailable, message)
    }

    /// Placeholder for commands whose body has not been written yet.
    pub fn not_implemented(command: &str) -> Self {
        Self::internal(format!("{command} is not implemented yet."))
    }

    /// Wraps an I/O error with context, for example `AppError::io_at("Could not read", &path, err)`.
    pub fn io_at(action: &str, path: &std::path::Path, err: std::io::Error) -> Self {
        Self::io(format!("{action} {}: {err}", path.display()))
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self::io(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        Self::internal(err.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(err: tauri::Error) -> Self {
        Self::internal(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_code_and_message() {
        let json = serde_json::to_value(AppError::claude_not_logged_in()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "code": "claudeNotLoggedIn", "message": "Claude Code is not logged in." })
        );
        let json = serde_json::to_value(AppError::git_bash_missing()).unwrap();
        assert_eq!(json["code"], "gitBashMissing");
        assert!(
            json["message"]
                .as_str()
                .unwrap()
                .contains("https://git-scm.com/downloads/win")
        );
        let json = serde_json::to_value(AppError::invalid_input("x")).unwrap();
        assert_eq!(json["code"], "invalidInput");
    }

    #[test]
    fn io_errors_map_to_io_code() {
        let err: AppError = std::io::Error::other("disk full").into();
        assert_eq!(err.code, ErrorCode::Io);
        assert_eq!(err.to_string(), "disk full");
    }
}

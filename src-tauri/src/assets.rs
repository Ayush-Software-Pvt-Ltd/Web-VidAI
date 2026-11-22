//! Runtime access for the asset protocol, so the UI can show local images (thumbnails).
//!
//! `tauri.conf.json` enables the asset protocol with an empty static scope, because the Editing
//! Folder is chosen by the user at runtime. Access is granted here instead:
//!
//! - on startup (from `lib.rs`) for the Editing Folder stored in settings, and
//! - by `set_editing_folder` after a new folder is saved: call
//!   `assets::allow_editing_folder(&app, &path)`.
//!
//! The UI turns an absolute path into a URL with `api.assetUrl(path)` (`convertFileSrc` inside
//! Tauri). Paths outside the granted folders are refused by Tauri.

use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

/// Allows the asset protocol to serve every file inside `folder` (recursively).
pub fn allow_editing_folder(app: &AppHandle, folder: &Path) -> AppResult<()> {
    app.asset_protocol_scope()
        .allow_directory(folder, true)
        .map_err(|e| AppError::internal(format!("Could not allow {}: {e}", folder.display())))
}

//! Access to files bundled with the app (`src-tauri/resources`, see `bundle.resources` in
//! `tauri.conf.json`).

use std::path::PathBuf;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

fn resolve(app: &AppHandle, name: &str) -> AppResult<PathBuf> {
    let path = app
        .path()
        .resolve(format!("resources/{name}"), BaseDirectory::Resource)
        .map_err(|e| AppError::internal(format!("Could not locate the bundled {name}: {e}")))?;
    if path.exists() {
        Ok(path)
    } else {
        Err(AppError::not_found(format!(
            "The bundled {name} is missing at {}.",
            path.display()
        )))
    }
}

/// The default prompt for new channels (`resources/default_prompt.md`).
pub fn default_prompt(app: &AppHandle) -> AppResult<String> {
    let path = resolve(app, "default_prompt.md")?;
    std::fs::read_to_string(&path).map_err(|e| AppError::io_at("Could not read", &path, e))
}

/// Path of the bundled toolkit snapshot (`resources/toolkit.tar.gz`).
pub fn toolkit_archive(app: &AppHandle) -> AppResult<PathBuf> {
    resolve(app, "toolkit.tar.gz")
}

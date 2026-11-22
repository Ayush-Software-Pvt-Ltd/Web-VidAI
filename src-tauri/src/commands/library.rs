//! Library commands: the scanned Editing Folder and per-video choices.
//!
//! Scanning is blocking file system work, so it runs on Tauri's blocking pool.

use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::model::{Library, VideoInputs, VideoType, VideoView};
use crate::scanner;
use crate::store::Store;

/// Runs blocking work with the store on the blocking pool.
async fn blocking<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&AppHandle) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(move || f(&app))
        .await
        .map_err(|e| AppError::internal(format!("The library scan stopped unexpectedly: {e}")))?
}

#[tauri::command]
#[specta::specta]
pub async fn get_library(app: AppHandle) -> AppResult<Library> {
    blocking(app, scanner::library_for_ui).await
}

/// `video_type` is `null` for Auto (use the detected type).
#[tauri::command]
#[specta::specta]
pub async fn set_video_type_override(
    app: AppHandle,
    video_id: String,
    video_type: Option<VideoType>,
) -> AppResult<VideoView> {
    blocking(app, move |app| {
        let store = app.state::<Store>();
        // Resolve first, so an unknown or vanished video is refused instead of remembered.
        scanner::video_view(&store, &video_id)?;
        store.update_video(&video_id, |v| {
            v.type_override = video_type;
            Ok(())
        })?;
        let view = scanner::video_view(&store, &video_id)?;
        scanner::request_rescan(app);
        Ok(view)
    })
    .await
}

/// Product links and notes used last time for this video.
#[tauri::command]
#[specta::specta]
pub async fn get_video_inputs(store: State<'_, Store>, video_id: String) -> AppResult<VideoInputs> {
    Ok(store.video(&video_id).inputs)
}

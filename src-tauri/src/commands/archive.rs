//! Archive and edit log commands (the Archive and Edit Log pages).
//!
//! Archiving removes a video from the main list without deleting anything on disk:
//! the job history in `state.json` is kept, so unarchiving restores its status.
//! Archived videos whose folders no longer exist are dropped from the list
//! automatically (`get_archived` prunes them).

use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::model::{ArchivedVideo, EditLogEntry, VideoAction, VideoView, now_iso};
use crate::scanner;
use crate::store::Store;

/// The archive retains its reason: only edited videos and failed edits offer it.
fn refuse_unless_archivable(view: &VideoView) -> AppResult<()> {
    if !view.actions.contains(&VideoAction::Archive) {
        return Err(AppError::invalid_input(
            "Only edited videos and failed edits can be archived.",
        ));
    }
    Ok(())
}

fn log(store: &Store, video_id: &str, folder: &str, event: &str, message: String) {
    let entry = EditLogEntry {
        ts: now_iso(),
        video_id: video_id.to_owned(),
        folder: folder.to_owned(),
        event: event.to_owned(),
        message,
    };
    if let Err(err) = store.append_edit_log(entry) {
        eprintln!("vidai: could not append to the edit log: {err}");
    }
}

/// Moves a video out of the main list (kept on the Archive page).
#[tauri::command]
#[specta::specta]
pub async fn archive_video(app: AppHandle, video_id: String) -> AppResult<ArchivedVideo> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        if store.is_archived(&video_id) {
            return Err(AppError::conflict("This video is already archived."));
        }
        let view = scanner::video_view(&store, &video_id)?;
        refuse_unless_archivable(&view)?;
        let entry = ArchivedVideo {
            video_id: view.id.clone(),
            channel_id: view.channel_id.clone(),
            folder_name: view.folder_name.clone(),
            path: view.path.clone(),
            archived_at: now_iso(),
        };
        store.archive_video(entry.clone())?;
        log(
            &store,
            &view.id,
            &view.folder_name,
            "archived",
            "Archived".to_owned(),
        );
        scanner::request_rescan(&app);
        Ok(entry)
    })
    .await
    .map_err(|e| AppError::internal(format!("The archive command failed: {e}")))?
}

/// Moves a video back to the main list (its job history is kept).
#[tauri::command]
#[specta::specta]
pub async fn unarchive_video(app: AppHandle, video_id: String) -> AppResult<VideoView> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        let removed = store.unarchive_video(&video_id)?;
        let Some(archived) = removed else {
            return Err(AppError::not_found("This video is not archived."));
        };
        log(
            &store,
            &archived.video_id,
            &archived.folder_name,
            "unarchived",
            "Unarchived".to_owned(),
        );
        scanner::request_rescan(&app);
        scanner::video_view(&store, &video_id)
    })
    .await
    .map_err(|e| AppError::internal(format!("The unarchive command failed: {e}")))?
}

/// Every archived video, newest first (see [`archived_list`]).
#[tauri::command]
#[specta::specta]
pub async fn get_archived(app: AppHandle) -> AppResult<Vec<ArchivedVideo>> {
    tauri::async_runtime::spawn_blocking(move || Ok(archived_list(&app.state::<Store>())))
        .await
        .map_err(|e| AppError::internal(format!("Could not read the archive: {e}")))?
}

/// Every archived video, newest first, with the current path of its folder (a renamed channel
/// keeps its archive, since the id holds the channel id). Entries whose folders no longer exist are
/// removed, but only while the Editing Folder itself is there (an unplugged drive removes nothing).
pub fn archived_list(store: &Store) -> Vec<ArchivedVideo> {
    let all = store.with_state(|s| s.archived.values().cloned().collect::<Vec<_>>());
    let mut existing = Vec::new();
    let mut gone = false;
    for mut entry in all {
        match scanner::video_path(store, &entry.video_id) {
            Ok(path) => {
                entry.path = path.to_string_lossy().into_owned();
                existing.push(entry);
            }
            Err(_) => gone = true,
        }
    }
    let reachable = store
        .settings()
        .editing_folder
        .is_some_and(|f| std::path::Path::new(&f).is_dir());
    if gone && reachable {
        let keep: Vec<String> = existing.iter().map(|e| e.video_id.clone()).collect();
        // Best effort: the list is still returned when pruning fails.
        let _ = store.prune_archived(&keep);
    }
    existing.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
    existing
}

/// The edit log, oldest first (the UI shows the newest first).
#[tauri::command]
#[specta::specta]
pub async fn get_edit_log(store: State<'_, Store>) -> AppResult<Vec<EditLogEntry>> {
    Ok(store.edit_log())
}

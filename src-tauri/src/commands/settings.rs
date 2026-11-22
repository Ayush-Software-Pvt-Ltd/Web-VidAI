//! Settings, channels, model selection and toolkit commands.
//!
//! The rules live in the submodules [`channels`] (Editing Folder and channel commands) and
//! [`transfer`] (settings export and import), and in `toolkit.rs`; the commands here only wire
//! them to Tauri state and ask the scanner for a rescan after every change.

mod channels;
mod transfer;

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::jobs::JobManager;
use crate::model::{
    AppearanceSettings, ChannelUpdate, GeneralSettings, MAX_CONCURRENT_EDITS_RANGE,
    MAX_MODEL_RETRIES, MAX_START_DELAY_MINUTES, MAX_TEXT_SIZE, MIN_TEXT_SIZE, ModelSelection,
    Platform, ReviewSoftware, Settings, ToolkitKind, ToolkitStatus,
};
use crate::sleep::SleepPrevention;
use crate::store::Store;
use crate::{assets, claude, resources, scanner, toolkit};

/// Runs blocking file work off the async runtime's worker threads.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::internal(format!("A background task failed: {e}")))?
}

/// Calls `scanner::request_rescan` after the change, whether it succeeded or not (a failed
/// rename can still have changed something on disk).
fn rescan_after<T>(app: &AppHandle, result: AppResult<T>) -> AppResult<T> {
    scanner::request_rescan(app);
    result
}

/// The argument of `update_general_settings`, checked before anything is saved.
fn validate_general(settings: &GeneralSettings, platform: Platform) -> AppResult<()> {
    if !settings.review_software.is_available_on(platform) {
        return Err(AppError::invalid_input(format!(
            "{} is not available on this computer. Choose {}.",
            settings.review_software.display_name(),
            ReviewSoftware::default_on(platform).display_name()
        )));
    }
    if !MAX_CONCURRENT_EDITS_RANGE.contains(&settings.max_concurrent_edits) {
        return Err(AppError::invalid_input(format!(
            "Maximum simultaneous edits must be between {} and {}.",
            MAX_CONCURRENT_EDITS_RANGE.start(),
            MAX_CONCURRENT_EDITS_RANGE.end()
        )));
    }
    if settings.start_delay_minutes > MAX_START_DELAY_MINUTES {
        return Err(AppError::invalid_input(format!(
            "The start delay must be between 0 and {MAX_START_DELAY_MINUTES} minutes."
        )));
    }
    if settings.max_model_retries > MAX_MODEL_RETRIES {
        return Err(AppError::invalid_input(format!(
            "The retries after a model error must be between 0 and {MAX_MODEL_RETRIES}."
        )));
    }
    Ok(())
}

/// The argument of `update_appearance`, checked before anything is saved.
fn validate_appearance(appearance: &AppearanceSettings) -> AppResult<()> {
    if !(MIN_TEXT_SIZE..=MAX_TEXT_SIZE).contains(&appearance.text_size) {
        return Err(AppError::invalid_input(format!(
            "Text size must be between {MIN_TEXT_SIZE} and {MAX_TEXT_SIZE} px."
        )));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_settings(store: State<'_, Store>) -> AppResult<Settings> {
    Ok(store.settings())
}

/// Saves the Editing Folder, grants asset access (`assets::allow_editing_folder`) and seeds the
/// toolkit (SPEC section 7). Refused with `conflict` while an edit is active.
#[tauri::command]
#[specta::specta]
pub async fn set_editing_folder(
    app: AppHandle,
    store: State<'_, Store>,
    path: String,
) -> AppResult<Settings> {
    let (settings, folder) = channels::set_editing_folder(&store, &path)?;
    let seeded = async {
        assets::allow_editing_folder(&app, &folder)?;
        let handle = app.clone();
        blocking(move || toolkit::seed_from_bundle(&handle, &folder)).await
    }
    .await;
    let seeded = seeded.map_err(|e| {
        AppError::new(
            e.code,
            format!(
                "The Editing Folder was saved, but the toolkit could not be set up: {}",
                e.message
            ),
        )
    });
    rescan_after(&app, seeded.map(|_| settings))
}

#[tauri::command]
#[specta::specta]
pub async fn update_general_settings(
    store: State<'_, Store>,
    jobs: State<'_, JobManager>,
    settings: GeneralSettings,
) -> AppResult<Settings> {
    validate_general(&settings, Platform::current())?;
    let saved = store.update_settings(|s| {
        s.review_software = settings.review_software;
        s.max_concurrent_edits = settings.max_concurrent_edits;
        s.start_delay_minutes = settings.start_delay_minutes;
        s.max_model_retries = settings.max_model_retries;
        Ok(s.clone())
    })?;
    // A raised limit or a shorter start delay starts queued jobs now.
    jobs.settings_changed();
    Ok(saved)
}

/// Saves the theme and the text size (per-machine preferences, never in settings files) and
/// applies them to the window at once (`appearance::apply`).
#[tauri::command]
#[specta::specta]
pub async fn update_appearance(
    app: AppHandle,
    store: State<'_, Store>,
    appearance: AppearanceSettings,
) -> AppResult<Settings> {
    validate_appearance(&appearance)?;
    let settings = store.update_settings(|s| {
        s.theme = appearance.theme;
        s.text_size = appearance.text_size;
        Ok(s.clone())
    })?;
    crate::appearance::apply(&app, &settings);
    Ok(settings)
}

/// Saves the No Sleep checkbox of the main window's sidebar (a preference of this machine, never
/// in settings files) and applies it at once (`sleep::SleepPrevention`).
#[tauri::command]
#[specta::specta]
pub async fn set_no_sleep(
    store: State<'_, Store>,
    sleep: State<'_, Arc<SleepPrevention>>,
    on: bool,
) -> AppResult<Settings> {
    let settings = store.update_settings(|s| {
        s.no_sleep = on;
        Ok(s.clone())
    })?;
    sleep.set_no_sleep(on);
    Ok(settings)
}

/// Saves the model and effort for new edits, normalized against the cached `ClaudeInfo`
/// (`claude::normalize_selection`).
#[tauri::command]
#[specta::specta]
pub async fn set_model_selection(
    store: State<'_, Store>,
    selection: ModelSelection,
) -> AppResult<Settings> {
    let info = store.claude_info();
    let selection = claude::normalize_selection(selection, info.as_ref());
    store.update_settings(|s| {
        s.model = selection.model;
        s.effort = selection.effort;
        Ok(s.clone())
    })
}

#[tauri::command]
#[specta::specta]
pub async fn get_default_prompt(app: AppHandle) -> AppResult<String> {
    resources::default_prompt(&app)
}

/// Adds an existing folder as a channel; both prompts get the default prompt and both styles get
/// `<channel>/Style/STYLE.md` when it exists.
#[tauri::command]
#[specta::specta]
pub async fn add_channel(
    app: AppHandle,
    store: State<'_, Store>,
    folder_name: String,
) -> AppResult<Settings> {
    let prompt = resources::default_prompt(&app)?;
    rescan_after(&app, channels::add(&store, &prompt, &folder_name))
}

/// Creates the folder, then behaves like `add_channel`.
#[tauri::command]
#[specta::specta]
pub async fn create_channel(
    app: AppHandle,
    store: State<'_, Store>,
    folder_name: String,
) -> AppResult<Settings> {
    let prompt = resources::default_prompt(&app)?;
    rescan_after(&app, channels::create(&store, &prompt, &folder_name))
}

/// A new `folderName` renames the folder on disk (`conflict` when the target exists or a video of
/// the channel has an active job).
#[tauri::command]
#[specta::specta]
pub async fn update_channel(
    app: AppHandle,
    store: State<'_, Store>,
    id: String,
    update: ChannelUpdate,
) -> AppResult<Settings> {
    rescan_after(&app, channels::update(&store, &id, update))
}

/// Removes the channel from VidAI only; the folder stays on disk.
#[tauri::command]
#[specta::specta]
pub async fn remove_channel(
    app: AppHandle,
    store: State<'_, Store>,
    id: String,
) -> AppResult<Settings> {
    rescan_after(&app, channels::remove(&store, &id))
}

#[tauri::command]
#[specta::specta]
pub async fn reorder_channels(
    app: AppHandle,
    store: State<'_, Store>,
    ids: Vec<String>,
) -> AppResult<Settings> {
    rescan_after(&app, channels::reorder(&store, &ids))
}

/// Writes channels and general settings to one JSON file; never secrets or the Editing Folder.
#[tauri::command]
#[specta::specta]
pub async fn export_settings(store: State<'_, Store>, path: String) -> AppResult<()> {
    transfer::export(&store, &path)
}

/// Merges a settings file by channel folder name (see `transfer`).
#[tauri::command]
#[specta::specta]
pub async fn import_settings(
    app: AppHandle,
    store: State<'_, Store>,
    jobs: State<'_, JobManager>,
    path: String,
) -> AppResult<Settings> {
    let info = store.claude_info();
    let imported = transfer::import(&store, &path, info.as_ref());
    if imported.is_ok() {
        // The file may raise `maxConcurrentEdits`.
        jobs.settings_changed();
    }
    rescan_after(&app, imported)
}

#[tauri::command]
#[specta::specta]
pub async fn get_toolkit_status(store: State<'_, Store>) -> AppResult<ToolkitStatus> {
    Ok(toolkit::status(&store.settings()))
}

/// Creates `CLAUDE_VE_ALL_OWN` with a short `README.md`, or leaves an existing one as it is.
#[tauri::command]
#[specta::specta]
pub async fn create_own_toolkit(store: State<'_, Store>) -> AppResult<ToolkitStatus> {
    let settings = store.settings();
    let folder = channels::editing_folder(&settings)?;
    blocking(move || toolkit::create_own(&folder)).await?;
    Ok(toolkit::status(&settings))
}

/// Chooses the toolkit for new jobs; `own` only once it exists.
#[tauri::command]
#[specta::specta]
pub async fn set_active_toolkit(
    store: State<'_, Store>,
    kind: ToolkitKind,
) -> AppResult<ToolkitStatus> {
    toolkit::set_active(&store, kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::model::Theme;

    fn general(max_concurrent_edits: u32, start_delay_minutes: u32) -> GeneralSettings {
        GeneralSettings {
            review_software: ReviewSoftware::Fcp,
            max_concurrent_edits,
            start_delay_minutes,
            max_model_retries: 5,
        }
    }

    #[test]
    fn general_settings_ranges() {
        for ok in [
            general(1, 0),
            general(8, MAX_START_DELAY_MINUTES),
            general(3, 10),
        ] {
            assert!(validate_general(&ok, Platform::Macos).is_ok(), "{ok:?}");
        }
        let err = validate_general(&general(0, 10), Platform::Macos).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(
            err.message.contains("simultaneous edits"),
            "{}",
            err.message
        );
        let err = validate_general(&general(3, MAX_START_DELAY_MINUTES + 1), Platform::Macos)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert_eq!(
            err.message,
            "The start delay must be between 0 and 120 minutes."
        );
    }

    #[test]
    fn final_cut_pro_is_refused_on_windows() {
        let premiere = GeneralSettings {
            review_software: ReviewSoftware::Premiere,
            ..general(3, 10)
        };
        assert!(validate_general(&premiere, Platform::Windows).is_ok());
        assert!(validate_general(&premiere, Platform::Macos).is_ok());
        let err = validate_general(&general(3, 10), Platform::Windows).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert_eq!(
            err.message,
            "Final Cut Pro is not available on this computer. Choose Premiere Pro."
        );
    }

    #[test]
    fn appearance_text_size_range() {
        let appearance = |text_size| AppearanceSettings {
            theme: Theme::Dark,
            text_size,
        };
        for ok in [MIN_TEXT_SIZE, 15, MAX_TEXT_SIZE] {
            assert!(validate_appearance(&appearance(ok)).is_ok(), "{ok}");
        }
        for bad in [0, MIN_TEXT_SIZE - 1, MAX_TEXT_SIZE + 1] {
            let err = validate_appearance(&appearance(bad)).unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidInput);
            assert_eq!(err.message, "Text size must be between 11 and 20 px.");
        }
    }
}

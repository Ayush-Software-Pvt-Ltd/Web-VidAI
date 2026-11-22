//! Job commands. Each one that would start an edit first checks that its program is ready (Claude Code installed and
//! logged in, `claudeNotInstalled` / `claudeNotLoggedIn`, or the OpenCode setup). The work is done by
//! `jobs::JobManager`; these functions only validate, delegate and map errors.

use std::time::Duration;

use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::jobs::JobManager;
use crate::model::{JobView, LogEntry, RenderFinalRequest, VideoInputs};

/// How long `confirm_quit` waits for running jobs to pause before exiting anyway (the orphan
/// watchdog ends whatever is left).
const QUIT_PAUSE_TIMEOUT: Duration = Duration::from_secs(40);

fn video(video_id: &str) -> AppResult<&str> {
    let id = video_id.trim();
    if id.is_empty() || !id.contains('/') {
        return Err(AppError::invalid_input(format!(
            "Invalid video id: {video_id:?}"
        )));
    }
    Ok(id)
}

/// Runs blocking manager work (store writes) off the async runtime's worker threads.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

/// Whether new work can start on the current selection of "Edits run on" and "Run edits with":
/// the one decision of `readiness`, gathered for the running app. A session that resumes on its
/// own provider and program is checked again when it launches (`jobs::runner`).
async fn ensure_ready(app: &AppHandle) -> AppResult<()> {
    let app = app.clone();
    blocking(move || crate::readiness::check(&app)).await
}

#[tauri::command]
#[specta::specta]
pub async fn start_edit(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    video_id: String,
    inputs: VideoInputs,
) -> AppResult<JobView> {
    let id = video(&video_id)?.to_owned();
    ensure_ready(&app).await?;
    let jobs = jobs.inner().clone();
    blocking(move || jobs.start_edit(&id, inputs)).await
}

#[tauri::command]
#[specta::specta]
pub async fn pause_job(jobs: State<'_, JobManager>, video_id: String) -> AppResult<JobView> {
    let id = video(&video_id)?.to_owned();
    let jobs = jobs.inner().clone();
    blocking(move || jobs.pause_job(&id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn continue_job(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    video_id: String,
) -> AppResult<JobView> {
    let id = video(&video_id)?.to_owned();
    ensure_ready(&app).await?;
    let jobs = jobs.inner().clone();
    blocking(move || jobs.continue_job(&id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn stop_job(jobs: State<'_, JobManager>, video_id: String) -> AppResult<JobView> {
    let id = video(&video_id)?.to_owned();
    let jobs = jobs.inner().clone();
    blocking(move || jobs.stop_job(&id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn re_edit(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    video_id: String,
    changes: String,
) -> AppResult<JobView> {
    let id = video(&video_id)?.to_owned();
    if changes.trim().is_empty() {
        return Err(AppError::invalid_input("Describe what should change."));
    }
    ensure_ready(&app).await?;
    let jobs = jobs.inner().clone();
    blocking(move || jobs.re_edit(&id, &changes)).await
}

#[tauri::command]
#[specta::specta]
pub async fn render_final(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    video_id: String,
    request: RenderFinalRequest,
) -> AppResult<JobView> {
    let id = video(&video_id)?.to_owned();
    ensure_ready(&app).await?;
    let jobs = jobs.inner().clone();
    blocking(move || jobs.render_final(&id, request)).await
}

/// Starts a queued job that the start delay holds back without waiting for the rest of the delay
/// (see `JobManager::start_now`).
#[tauri::command]
#[specta::specta]
pub async fn start_job_now(jobs: State<'_, JobManager>, video_id: String) -> AppResult<JobView> {
    let id = video(&video_id)?.to_owned();
    let jobs = jobs.inner().clone();
    blocking(move || jobs.start_now(&id)).await
}

/// The latest job's log, at most the last `model::MAX_LOG_ENTRIES` entries.
#[tauri::command]
#[specta::specta]
pub async fn get_job_log(
    jobs: State<'_, JobManager>,
    video_id: String,
) -> AppResult<Vec<LogEntry>> {
    let id = video(&video_id)?.to_owned();
    let jobs = jobs.inner().clone();
    blocking(move || jobs.job_log(&id)).await
}

/// Pauses every running job, then exits the app.
#[tauri::command]
#[specta::specta]
pub async fn confirm_quit(app: AppHandle, jobs: State<'_, JobManager>) -> AppResult<()> {
    let jobs = jobs.inner().clone();
    blocking(move || {
        if !jobs.pause_all_for_quit(QUIT_PAUSE_TIMEOUT) {
            eprintln!("vidai: some jobs did not pause in time; exiting anyway");
        }
        jobs.shutdown();
        Ok(())
    })
    .await?;
    app.exit(0);
    Ok(())
}

//! Persistence of `settings.json`, `state.json` and `logs/<jobId>.jsonl` (SPEC section 4).
//!
//! [`Store`] is managed Tauri state (`State<'_, Store>`), shared by every command. It keeps both
//! documents in memory behind one mutex and writes them through on every change:
//!
//! - Reads return clones ([`Store::settings`], [`Store::video`], [`Store::claude_info`]) or borrow
//!   inside a closure ([`Store::with_state`]).
//! - Writes go through `update_*` closures that work on a copy. When the closure returns `Ok`
//!   and the copy differs, the copy is saved atomically and only then becomes the current value.
//!   When the closure returns `Err` or saving fails, nothing changes in memory or on disk.
//!   Callers therefore cannot forget to persist, and can validate inside the closure.
//! - The one exception is [`Store::update_video_deferred`], for frequent changes that may wait
//!   (the creep of a job's progress): it changes the state in memory only, and the next save of
//!   the state ([`Store::update_state`] with a change, or [`Store::flush_state`]) writes it.
//! - Files are written atomically (temp file in the same directory, fsync, rename, fsync dir).
//!   A store for throwaway data ([`Durability::Unsynced`], the tests) skips the fsyncs.
//! - A file that cannot be parsed is moved aside as `<name>.corrupt-<timestamp>` and replaced by
//!   defaults, never silently overwritten.
//! - Each document carries `schemaVersion`. Older versions are migrated in [`migrate`]; a newer
//!   version (written by a newer VidAI) is read leniently, unknown fields are ignored.
//!
//! Job logs are append-only JSON Lines files, one per job, guarded by a separate lock so that
//! logging never waits for a settings write.

use std::collections::{BTreeMap, VecDeque};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::model::{
    API_EFFORTS, ApiModels, ApiOption, ArchivedVideo, CHANNEL_SLOTS, ChannelProfile, ChannelSlot,
    ClaudeInfo, DEFAULT_START_DELAY_MINUTES, DEFAULT_TEXT_SIZE, EditLogEntry, JobView, LogEntry,
    MAX_CONCURRENT_EDITS_RANGE, MAX_MODEL_RETRIES, MAX_SLOT_NAME_CHARS, MAX_START_DELAY_MINUTES,
    MAX_TEXT_SIZE, MIN_TEXT_SIZE, Settings, VideoInputs, VideoType,
};

/// Current version of both `settings.json` and `state.json`.
///
/// History:
/// - 1: first release.
/// - 2: channels have a `videoType` (`auto`, `long` or `short`); see [`migrate_settings`].
/// - 3: settings have `theme`, `textSize` and `startDelayMinutes` (see [`migrate_settings`]);
///   stored jobs have `progress` and `startsAt`, which load as `null` when missing (serde reads a
///   missing `Option` field as `None`, see `JobView`), so `state.json` needs no migration step.
///   The state's `progressHistory` and each video's `progressMemory` were added later in the same
///   version; both are optional on load (`#[serde(default)]`), so no step is needed either.
/// - 4: settings have `provider` (`claude` or `opencode`) and `opencode` (`baseUrl`, `model`),
///   which older files get as the Claude subscription and the defaults (see
///   [`migrate_settings`]); stored jobs have `provider`, which loads as `null` (the Claude
///   subscription) when missing, and the state has `opencodeModels`, optional on load.
/// - 5: the settings' `opencode` has `harness` ("Run edits with": `claudeCode` or `opencode2`),
///   which older files get as `claudeCode`, the program that ran every edit before (see
///   [`migrate_settings`]).
/// - 6: the settings' `opencode` has `efforts` (reasoning effort per OpenCode model id), which
///   older files get as an empty map (see [`migrate_settings`]).
/// - 7: each channel's `long` and `short` have `prompts` and `styles` (lists of named slots)
///   instead of one `prompt` and one `style`, which older files get as slot 0; each video's
///   `inputs` have `promptSlot` and `styleSlot`, which older files get as 0 (see
///   [`migrate_settings`] and [`migrate_state`]).
/// - 8: the harness `opencode` (OpenCode 1.x, dropped) is stored as `opencode2` in the settings'
///   `opencode` and in each stored job (see [`migrate_settings`] and [`migrate_state`]).
/// - 9: the settings have `setup` and `apiOptions` instead of `provider` and `opencode`, each stored
///   job has `setup` instead of `provider`, and the state's `apiModels` replaces `opencodeModels`
///   (SPEC section 7a, Migration from 0.2.4; see [`migrate_settings`] and [`migrate_state`]).
pub const SCHEMA_VERSION: u32 = 9;
/// Environment variable that overrides the app data directory.
pub const DATA_DIR_ENV: &str = "VIDAI_DATA_DIR";

const SETTINGS_FILE: &str = "settings.json";
const STATE_FILE: &str = "state.json";
const LOGS_DIR: &str = "logs";
const SCHEMA_KEY: &str = "schemaVersion";

/// The app data directory: `VIDAI_DATA_DIR` when set and not empty, otherwise `default`
/// (the OS app data directory for `com.vidai.desktop`, from `app.path().app_data_dir()`).
pub fn resolve_data_dir(default: PathBuf) -> PathBuf {
    data_dir_from(std::env::var_os(DATA_DIR_ENV), default)
}

fn data_dir_from(value: Option<OsString>, default: PathBuf) -> PathBuf {
    match value {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => default,
    }
}

// ---------------------------------------------------------------------------------------------
// state.json
// ---------------------------------------------------------------------------------------------

/// Contents of `state.json` (without `schemaVersion`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppState {
    /// Keyed by `VideoView::id` (`<channelId>/<folderName>`).
    pub videos: BTreeMap<String, VideoState>,
    /// Last `ClaudeInfo` fetched from Claude Code, so the pickers are never empty after the first run.
    pub claude_info: Option<ClaudeInfo>,
    /// How long the stretches of finished jobs took, for pacing the progress of new ones
    /// (`jobs::progress`). Missing in files written before it existed, which load it empty.
    pub progress_history: ProgressHistory,
    /// The models last fetched for OpenCode Go, with their address, so the picker is filled at
    /// once and a job can tell a model that is gone. The other API options have no list.
    pub api_models: ApiModelsCache,
    /// Videos removed from the main list with Archive, keyed by `VideoView::id`.
    /// Missing in files written before archiving existed, which load it empty.
    pub archived: BTreeMap<String, ArchivedVideo>,
    /// What happened to each video (the Edit Log page). Missing files load it empty.
    /// Capped at [`EDIT_LOG_LEN`], oldest first dropped.
    pub edit_log: Vec<EditLogEntry>,
}

/// The model list of OpenCode Go (`state.json`, `apiModels`). `anthropicApi` and `openaiApi` take a
/// typed model id and keep no list; entries older files hold for them are ignored and dropped at
/// the next save.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApiModelsCache {
    pub opencode_go: Option<ApiModels>,
}

impl ApiModelsCache {
    pub fn get(&self, option: ApiOption) -> Option<&ApiModels> {
        match option {
            ApiOption::OpencodeGo => self.opencode_go.as_ref(),
            ApiOption::AnthropicApi | ApiOption::OpenaiApi => None,
        }
    }
}

/// How many edit log entries are kept in `state.json` (the text mirror keeps everything).
pub const EDIT_LOG_LEN: usize = 2000;
/// Name of the edit log mirror inside the Editing Folder (survives an uninstall).
pub const EDIT_LOG_FILE: &str = "VidAI-edit-log.txt";
/// How the lines of the mirror end: the line ending of the platform's text files, so Notepad and
/// every other Windows program show one entry per line.
const EDIT_LOG_EOL: &str = if cfg!(windows) { "\r\n" } else { "\n" };

/// One line of the mirror file, with its line ending.
fn edit_log_line(entry: &EditLogEntry) -> String {
    format!(
        "[{}] {} {} - {}{EDIT_LOG_EOL}",
        entry.ts, entry.video_id, entry.event, entry.message
    )
}

/// What VidAI remembers about one video.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoState {
    pub type_override: Option<VideoType>,
    /// Product links and notes used last time, to pre-fill the Start Editing sheet.
    pub inputs: VideoInputs,
    /// Only the latest job per video is kept.
    pub latest_job: Option<JobView>,
    pub type_detection: Option<TypeDetection>,
    /// What the progress engine knows about the latest job beyond `JobView::progress` (which
    /// milestones are done and when), so a continued job goes on from where it was, also after
    /// a restart. Ignored when its `job_id` is not the latest job's.
    pub progress_memory: Option<ProgressMemory>,
}

/// The progress engine's memory of one job (see `jobs::progress`). Times are active
/// milliseconds of the job (`JobView::active_ms` plus the time running since).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProgressMemory {
    pub job_id: String,
    /// Finished milestones by marker name.
    pub done: BTreeMap<String, ProgressMark>,
    /// The last percent shown; progress never goes below it.
    pub percent: u32,
}

/// When a milestone was finished, and whether only a later milestone implied it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProgressMark {
    pub at_ms: u64,
    pub implied: bool,
}

/// Recent finished jobs by `<kind>/<videoType>` (for example `edit/short`), oldest first, at
/// most [`PROGRESS_HISTORY_LEN`] each.
pub type ProgressHistory = BTreeMap<String, Vec<ProgressRun>>;

/// How many finished jobs are kept per kind and video type in [`AppState::progress_history`].
pub const PROGRESS_HISTORY_LEN: usize = 10;

/// One finished job: the active milliseconds at which each milestone was seen finished (implied
/// ones are left out) and the active milliseconds of the whole job.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProgressRun {
    pub milestones: BTreeMap<String, u64>,
    pub total_ms: u64,
}

impl VideoState {
    /// True when nothing is remembered, so the entry can be dropped.
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

/// Cached Long/Short detection of a video's main A-roll (SPEC section 8), valid while path, size
/// and mtime match and `detector` is the current `media::DETECTOR_VERSION`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeDetection {
    pub path: String,
    pub size: u64,
    /// Modification time in milliseconds since the Unix epoch.
    pub modified_ms: i64,
    /// The detected type: the metadata's, corrected by the picture check once that ran. `None`
    /// when nothing could be read.
    pub detected: Option<VideoType>,
    /// Version of the detector that wrote this entry. Entries written before the picture check
    /// existed have none and read as 0, so they are detected again once.
    #[serde(default)]
    pub detector: u32,
    /// Display size by the metadata (rotation flag applied) as `[width, height]`; `None` when
    /// nothing could be read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<[u32; 2]>,
    /// What the picture check found: the clockwise degrees (0, 90, 180 or 270) that make the
    /// picture upright, 0 also when it found no clear answer or the picture could not be decoded.
    /// `None` while it has not run, also when it was not available or failed: it is tried again
    /// later instead of caching a guess.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picture_rotation: Option<u32>,
}

impl TypeDetection {
    pub fn matches(&self, path: &str, size: u64, modified_ms: i64) -> bool {
        self.path == path && self.size == size && self.modified_ms == modified_ms
    }

    /// True when both entries describe the same version of the same file.
    pub fn same_file(&self, other: &Self) -> bool {
        self.matches(&other.path, other.size, other.modified_ms)
    }
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

struct Data {
    settings: Settings,
    state: AppState,
    /// `state` has changes that are not saved yet ([`Store::update_video_deferred`]).
    state_dirty: bool,
    /// The settings of a version 8 file chose `anthropicApi`, so the old key still has to be
    /// copied to that option's field of the keychain before `settings.json` is written at version
    /// 9 (SPEC section 7a, Migration from 0.2.4, "Order"). Until then settings changes stay in
    /// memory.
    key_migration_pending: bool,
}

/// Thread-safe handle to everything VidAI persists. Manage one instance with `app.manage(store)`.
pub struct Store {
    dir: PathBuf,
    durability: Durability,
    data: Mutex<Data>,
    logs: Mutex<()>,
}

/// Whether the store's documents are flushed to the disk when they are saved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Durability {
    /// Every save is flushed (fsync) before it counts, so it survives a crash or a power loss.
    /// The app's data.
    Synced,
    /// Saves stay atomic (temp file and rename) but are not flushed. For throwaway data (the
    /// tests): the system serializes flushes, so many test processes saving at once would
    /// otherwise wait on each other's flushes for no benefit.
    Unsynced,
}

impl Store {
    /// Opens (creating when needed) the store in `dir`. Missing files mean defaults; corrupt
    /// files are quarantined and replaced by defaults.
    pub fn open(dir: impl Into<PathBuf>) -> AppResult<Self> {
        Self::open_with(dir, Durability::Synced)
    }

    /// [`Store::open`] with a choice of [`Durability`].
    pub fn open_with(dir: impl Into<PathBuf>, durability: Durability) -> AppResult<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir)
            .map_err(|e| AppError::io_at("Could not create the data folder", &dir, e))?;
        let (mut settings, settings_from): (Settings, u32) =
            load_document(&dir.join(SETTINGS_FILE), migrate_settings, durability)?;
        sanitize_settings(&mut settings);
        let (mut state, _): (AppState, u32) =
            load_document(&dir.join(STATE_FILE), migrate_state, durability)?;
        let key_migration_pending =
            settings_from < 9 && settings.setup == crate::model::Setup::AnthropicApi;
        for video in state.videos.values_mut() {
            let inputs = &mut video.inputs;
            // A hand-edited file: a slot that does not exist is the default one.
            if inputs.prompt_slot as usize >= CHANNEL_SLOTS {
                inputs.prompt_slot = 0;
            }
            if inputs.style_slot as usize >= CHANNEL_SLOTS {
                inputs.style_slot = 0;
            }
        }
        Ok(Self {
            dir,
            durability,
            data: Mutex::new(Data {
                settings,
                state,
                state_dirty: false,
                key_migration_pending,
            }),
            logs: Mutex::new(()),
        })
    }

    /// The app data directory this store lives in.
    pub fn data_dir(&self) -> &Path {
        &self.dir
    }

    /// Writes a file of the data folder that is not one of the store's documents (for example
    /// the start delay clock), atomically and with the store's [`Durability`].
    pub fn write_data_file(&self, name: &str, bytes: &[u8]) -> AppResult<()> {
        write_file(&self.dir.join(name), bytes, self.durability)
    }

    fn lock(&self) -> MutexGuard<'_, Data> {
        // Updates work on copies, so the data is consistent even if a closure panicked.
        self.data.lock().unwrap_or_else(PoisonError::into_inner)
    }

    // ----- settings -----

    /// A copy of the current settings.
    pub fn settings(&self) -> Settings {
        self.lock().settings.clone()
    }

    /// Changes the settings and saves them. See the module docs for the transaction rules.
    ///
    /// ```
    /// # fn demo(store: &vidai_lib::store::Store) -> vidai_lib::error::AppResult<()> {
    /// let settings = store.update_settings(|s| {
    ///     s.max_concurrent_edits = 4;
    ///     Ok(s.clone())
    /// })?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn update_settings<R>(
        &self,
        f: impl FnOnce(&mut Settings) -> AppResult<R>,
    ) -> AppResult<R> {
        let mut data = self.lock();
        let mut next = data.settings.clone();
        let out = f(&mut next)?;
        if next != data.settings {
            if !data.key_migration_pending {
                save_document(&self.dir.join(SETTINGS_FILE), &next, self.durability)?;
            }
            data.settings = next;
        }
        Ok(out)
    }

    /// Whether the settings still wait for the key migration (see
    /// [`Store::finish_api_key_migration`]).
    pub fn api_key_migration_pending(&self) -> bool {
        self.lock().key_migration_pending
    }

    /// The last step of the migration of a version 8 install that chose `anthropicApi`: runs
    /// `copy_keys` (the keychain write, which must have read back when it returns `Ok`) and only
    /// after that succeeded writes `settings.json` at version 9. On an error nothing is written
    /// and the step can be tried again. Does nothing when no migration is pending.
    pub fn finish_api_key_migration(
        &self,
        copy_keys: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()> {
        if !self.api_key_migration_pending() {
            return Ok(());
        }
        // Not under the lock: the keychain can take a while.
        copy_keys()?;
        let mut data = self.lock();
        if data.key_migration_pending {
            save_document(
                &self.dir.join(SETTINGS_FILE),
                &data.settings,
                self.durability,
            )?;
            data.key_migration_pending = false;
        }
        Ok(())
    }

    // ----- state -----

    /// Reads the state without copying it.
    pub fn with_state<R>(&self, f: impl FnOnce(&AppState) -> R) -> R {
        f(&self.lock().state)
    }

    /// Changes the state and saves it. Same transaction rules as [`Store::update_settings`].
    /// Deferred changes ([`Store::update_video_deferred`]) are saved along.
    pub fn update_state<R>(&self, f: impl FnOnce(&mut AppState) -> AppResult<R>) -> AppResult<R> {
        let mut data = self.lock();
        let mut next = data.state.clone();
        let out = f(&mut next)?;
        if next != data.state || data.state_dirty {
            save_document(&self.dir.join(STATE_FILE), &next, self.durability)?;
            data.state = next;
            data.state_dirty = false;
        }
        Ok(out)
    }

    /// Writes deferred changes of the state now, if there are any.
    pub fn flush_state(&self) -> AppResult<()> {
        let mut data = self.lock();
        if data.state_dirty {
            save_document(&self.dir.join(STATE_FILE), &data.state, self.durability)?;
            data.state_dirty = false;
        }
        Ok(())
    }

    /// A copy of what is remembered about one video (defaults when nothing is).
    pub fn video(&self, video_id: &str) -> VideoState {
        self.with_state(|s| s.videos.get(video_id).cloned().unwrap_or_default())
    }

    /// Changes what is remembered about one video and saves it. Entries that end up empty are
    /// removed.
    pub fn update_video<R>(
        &self,
        video_id: &str,
        f: impl FnOnce(&mut VideoState) -> AppResult<R>,
    ) -> AppResult<R> {
        self.update_state(|state| {
            let mut video = state.videos.remove(video_id).unwrap_or_default();
            let out = f(&mut video)?;
            if !video.is_empty() {
                state.videos.insert(video_id.to_owned(), video);
            }
            Ok(out)
        })
    }

    /// Like [`Store::update_video`], but the change is kept in memory and saved with the next save
    /// of the state, so a crash can lose it. Only for frequent changes that are cheap to lose,
    /// such as the time-based creep of a job's progress.
    pub fn update_video_deferred<R>(
        &self,
        video_id: &str,
        f: impl FnOnce(&mut VideoState) -> AppResult<R>,
    ) -> AppResult<R> {
        let mut data = self.lock();
        let mut video = data.state.videos.get(video_id).cloned().unwrap_or_default();
        let out = f(&mut video)?;
        let before = data.state.videos.get(video_id);
        let changed = match before {
            Some(before) => *before != video,
            None => !video.is_empty(),
        };
        if changed {
            if video.is_empty() {
                data.state.videos.remove(video_id);
            } else {
                data.state.videos.insert(video_id.to_owned(), video);
            }
            data.state_dirty = true;
        }
        Ok(out)
    }

    /// The finished runs recorded for `key` (`<kind>/<videoType>`), oldest first.
    pub fn progress_runs(&self, key: &str) -> Vec<ProgressRun> {
        self.with_state(|s| s.progress_history.get(key).cloned().unwrap_or_default())
    }

    /// Records one finished run for `key`, keeping the last [`PROGRESS_HISTORY_LEN`].
    pub fn record_progress_run(&self, key: &str, run: ProgressRun) -> AppResult<()> {
        self.update_state(|s| {
            let runs = s.progress_history.entry(key.to_owned()).or_default();
            runs.push(run);
            let excess = runs.len().saturating_sub(PROGRESS_HISTORY_LEN);
            runs.drain(..excess);
            Ok(())
        })
    }

    /// The latest job of every video that has one.
    pub fn latest_jobs(&self) -> Vec<JobView> {
        self.with_state(|s| {
            s.videos
                .values()
                .filter_map(|v| v.latest_job.clone())
                .collect()
        })
    }

    /// The cached `ClaudeInfo`, if one was ever stored.
    pub fn claude_info(&self) -> Option<ClaudeInfo> {
        self.with_state(|s| s.claude_info.clone())
    }

    /// Replaces the cached `ClaudeInfo`.
    pub fn set_claude_info(&self, info: ClaudeInfo) -> AppResult<()> {
        self.update_state(|s| {
            s.claude_info = Some(info);
            Ok(())
        })
    }

    /// The models last fetched for `option`: only OpenCode Go has a list, the other options `None`.
    pub fn api_models(&self, option: ApiOption) -> Option<ApiModels> {
        self.with_state(|s| s.api_models.get(option).cloned())
    }

    /// Replaces the cached models of OpenCode Go.
    pub fn set_api_models(&self, models: ApiModels) -> AppResult<()> {
        debug_assert_eq!(models.option, ApiOption::OpencodeGo);
        self.update_state(|s| {
            s.api_models.opencode_go = Some(models);
            Ok(())
        })
    }

    // ----- archive and edit log -----

    /// Whether the video is archived (hidden from the main list).
    pub fn is_archived(&self, video_id: &str) -> bool {
        self.with_state(|s| s.archived.contains_key(video_id))
    }

    /// The ids of all archived videos.
    pub fn archived_ids(&self) -> Vec<String> {
        self.with_state(|s| s.archived.keys().cloned().collect())
    }

    /// Archives a video (hides it from the main list; the job history is kept).
    pub fn archive_video(&self, entry: ArchivedVideo) -> AppResult<()> {
        self.update_state(|s| {
            s.archived.insert(entry.video_id.clone(), entry);
            Ok(())
        })
    }

    /// Removes a video from the archive (it shows in the main list again).
    /// Returns the removed entry, if any.
    pub fn unarchive_video(&self, video_id: &str) -> AppResult<Option<ArchivedVideo>> {
        self.update_state(|s| Ok(s.archived.remove(video_id)))
    }

    /// Drops archived entries whose folders no longer exist (called by `get_archived`).
    pub fn prune_archived(&self, existing: &[String]) -> AppResult<()> {
        self.update_state(|s| {
            let keep: std::collections::BTreeSet<&String> = existing.iter().collect();
            s.archived.retain(|id, _| keep.contains(id));
            Ok(())
        })
    }

    /// Appends one entry to the edit log, keeping the last [`EDIT_LOG_LEN`].
    /// Also mirrors the line to `<Editing Folder>/VidAI-edit-log.txt` (best effort),
    /// so the log survives an uninstall.
    pub fn append_edit_log(&self, entry: EditLogEntry) -> AppResult<()> {
        let line = edit_log_line(&entry);
        let mirror = self
            .lock()
            .settings
            .editing_folder
            .clone()
            .map(PathBuf::from);
        self.update_state(|s| {
            s.edit_log.push(entry);
            let excess = s.edit_log.len().saturating_sub(EDIT_LOG_LEN);
            s.edit_log.drain(..excess);
            Ok(())
        })?;
        if let Some(root) = mirror.filter(|p| p.is_dir()) {
            let path = root.join(EDIT_LOG_FILE);
            // Best effort: a failed mirror must not fail the edit itself.
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
                let _ = file.write_all(line.as_bytes());
            }
        }
        Ok(())
    }

    /// The edit log, oldest first.
    pub fn edit_log(&self) -> Vec<EditLogEntry> {
        self.with_state(|s| s.edit_log.clone())
    }

    // ----- job logs -----

    /// Path of `logs/<jobId>.jsonl`. Rejects ids that are not plain file names.
    pub fn log_path(&self, job_id: &str) -> AppResult<PathBuf> {
        let valid = !job_id.is_empty()
            && job_id.len() <= 128
            && job_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !valid {
            return Err(AppError::invalid_input(format!(
                "Invalid job id: {job_id:?}"
            )));
        }
        Ok(self.dir.join(LOGS_DIR).join(format!("{job_id}.jsonl")))
    }

    /// Appends entries to the job's log, one JSON object per line.
    pub fn append_log(&self, job_id: &str, entries: &[LogEntry]) -> AppResult<()> {
        let path = self.log_path(job_id)?;
        if entries.is_empty() {
            return Ok(());
        }
        let mut buf = Vec::new();
        for entry in entries {
            serde_json::to_writer(&mut buf, entry)?;
            buf.push(b'\n');
        }
        let _guard = self.logs.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| AppError::io_at("Could not create", parent, e))?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .read(true)
            .open(&path)
            .map_err(|e| AppError::io_at("Could not open", &path, e))?;
        // A line cut short by a crash must not swallow the first new entry.
        if ends_without_newline(&mut file)
            .map_err(|e| AppError::io_at("Could not read", &path, e))?
        {
            buf.insert(0, b'\n');
        }
        file.write_all(&buf)
            .map_err(|e| AppError::io_at("Could not write", &path, e))
    }

    /// The last `limit` entries of the job's log, oldest first. A missing log is empty.
    /// Lines that cannot be parsed (for example a line cut short by a crash) are skipped.
    pub fn read_log(&self, job_id: &str, limit: usize) -> AppResult<Vec<LogEntry>> {
        let path = self.log_path(job_id)?;
        let bytes = {
            let _guard = self.logs.lock().unwrap_or_else(PoisonError::into_inner);
            match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
                Err(e) => return Err(AppError::io_at("Could not read", &path, e)),
            }
        };
        let mut out = VecDeque::with_capacity(limit.min(1024));
        if limit == 0 {
            return Ok(Vec::new());
        }
        for line in bytes.split(|b| *b == b'\n') {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            if let Ok(entry) = serde_json::from_slice::<LogEntry>(line) {
                if out.len() == limit {
                    out.pop_front();
                }
                out.push_back(entry);
            }
        }
        Ok(out.into())
    }

    /// Deletes the job's log (used when a newer job replaces it). A missing log is fine.
    pub fn remove_log(&self, job_id: &str) -> AppResult<()> {
        let path = self.log_path(job_id)?;
        let _guard = self.logs.lock().unwrap_or_else(PoisonError::into_inner);
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::io_at("Could not delete", &path, e)),
        }
    }
}

fn ends_without_newline(file: &mut File) -> std::io::Result<bool> {
    if file.metadata()?.len() == 0 {
        return Ok(false);
    }
    file.seek(SeekFrom::End(-1))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)?;
    Ok(last[0] != b'\n')
}

/// Clamps numbers found on disk into their allowed ranges, and replaces a review software that
/// does not exist on this platform (a settings.json copied from a Mac to a PC).
fn sanitize_settings(settings: &mut Settings) {
    settings.review_software = settings
        .review_software
        .for_platform(crate::model::Platform::current());
    settings.max_concurrent_edits = settings.max_concurrent_edits.clamp(
        *MAX_CONCURRENT_EDITS_RANGE.start(),
        *MAX_CONCURRENT_EDITS_RANGE.end(),
    );
    settings.text_size = settings.text_size.clamp(MIN_TEXT_SIZE, MAX_TEXT_SIZE);
    settings.start_delay_minutes = settings.start_delay_minutes.min(MAX_START_DELAY_MINUTES);
    settings.max_model_retries = settings.max_model_retries.min(MAX_MODEL_RETRIES);
    for channel in &mut settings.channels {
        sanitize_profile(&mut channel.long);
        sanitize_profile(&mut channel.short);
    }
    sanitize_setup(settings);
}

/// Makes a profile read from a file valid: exactly [`CHANNEL_SLOTS`] prompts and styles (missing
/// ones are empty and default-named, extra ones are dropped), slot 0 named "Default", other
/// names trimmed, cut to the longest allowed and default-named when empty.
pub fn sanitize_profile(profile: &mut ChannelProfile) {
    for (label, slots) in [
        ("Prompt", &mut profile.prompts),
        ("Style", &mut profile.styles),
    ] {
        slots.truncate(CHANNEL_SLOTS);
        for index in slots.len()..CHANNEL_SLOTS {
            slots.push(ChannelSlot::empty(label, index));
        }
        for (index, slot) in slots.iter_mut().enumerate() {
            let name: String = slot.name.trim().chars().take(MAX_SLOT_NAME_CHARS).collect();
            slot.name = if index == 0 || name.is_empty() {
                ChannelSlot::empty(label, index).name
            } else {
                name
            };
        }
    }
}

/// The API options of the settings as this version can use them: an address that is not valid
/// for its option loads as the default, a model is trimmed, only known efforts of named models
/// stay, and an API option as `setup` without a model loads as the Claude subscription.
fn sanitize_setup(settings: &mut Settings) {
    for option in ApiOption::ALL {
        let api = settings.api_options.get_mut(option);
        api.base_url = api.base_url.as_deref().and_then(|url| {
            crate::opencode::normalize_base_url(option, url)
                .ok()
                .flatten()
        });
        api.model = api
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(str::to_owned);
        // A hand-edited file: only known levels of named models stay.
        api.efforts.retain(|model, effort| {
            !model.trim().is_empty() && API_EFFORTS.contains(&effort.as_str())
        });
    }
    if let Some(option) = settings.setup.api_option()
        && settings.api_options.get(option).model.is_none()
    {
        settings.setup = crate::model::Setup::ClaudeSubscription;
    }
}

// ---------------------------------------------------------------------------------------------
// Documents on disk
// ---------------------------------------------------------------------------------------------

/// Upgrades a document written by an older VidAI to [`SCHEMA_VERSION`], in place. Each document
/// has its own function with one step per version bump that changed it, for example
/// `if from < 2 { ... }`.
type Migration = fn(&mut serde_json::Map<String, Value>, u32);

/// `settings.json`.
fn migrate_settings(document: &mut serde_json::Map<String, Value>, from: u32) {
    if from < 2 {
        // Version 2 added the channel's video type; existing channels keep detecting it.
        if let Some(Value::Array(channels)) = document.get_mut("channels") {
            for channel in channels.iter_mut().filter_map(Value::as_object_mut) {
                channel
                    .entry("videoType")
                    .or_insert_with(|| Value::from("auto"));
            }
        }
    }
    if from < 3 {
        // Version 3 added the appearance and the start delay; existing installs get the defaults.
        let defaults = [
            ("theme", Value::from("system")),
            ("textSize", Value::from(DEFAULT_TEXT_SIZE)),
            (
                "startDelayMinutes",
                Value::from(DEFAULT_START_DELAY_MINUTES),
            ),
        ];
        for (key, value) in defaults {
            document.entry(key).or_insert(value);
        }
    }
    if from < 4 {
        // Version 4 added OpenCode; existing installs keep running edits on the Claude
        // subscription, with the default address and no model.
        document
            .entry("provider")
            .or_insert_with(|| Value::from("claude"));
        document
            .entry("opencode")
            .or_insert_with(|| serde_json::json!({ "baseUrl": null, "model": null }));
    }
    if from < 5 {
        // Version 5 added "Run edits with"; existing installs keep editing with Claude Code. A
        // value this version does not know (a hand-edited file) loads the same way.
        if let Some(Value::Object(opencode)) = document.get_mut("opencode") {
            let known = matches!(
                opencode.get("harness").and_then(Value::as_str),
                Some("claudeCode" | "opencode" | "opencode2")
            );
            if !known {
                opencode.insert("harness".into(), Value::from("claudeCode"));
            }
        }
    }
    if from < 6 {
        // Version 6 added the reasoning effort per OpenCode model; no model has one yet.
        if let Some(Value::Object(opencode)) = document.get_mut("opencode") {
            opencode
                .entry("efforts")
                .or_insert_with(|| serde_json::json!({}));
        }
    }
    if from < 7 {
        // Version 7 replaced a profile's one `prompt` and one `style` by lists of slots; the old
        // texts become slot 0 (`sanitize_profile` fills in the rest).
        if let Some(Value::Array(channels)) = document.get_mut("channels") {
            for channel in channels.iter_mut().filter_map(Value::as_object_mut) {
                for key in ["long", "short"] {
                    let Some(Value::Object(profile)) = channel.get_mut(key) else {
                        continue;
                    };
                    for (old, new) in [("prompt", "prompts"), ("style", "styles")] {
                        let text = profile.remove(old).unwrap_or_else(|| Value::from(""));
                        profile.entry(new).or_insert_with(
                            || serde_json::json!([{ "name": "Default", "text": text }]),
                        );
                    }
                }
            }
        }
    }
    if from < 8 {
        // Version 8 dropped OpenCode 1.x; its stored harness name now means OpenCode 2.
        if let Some(Value::Object(opencode)) = document.get_mut("opencode")
            && opencode.get("harness").and_then(Value::as_str) == Some("opencode")
        {
            opencode.insert("harness".into(), Value::from("opencode2"));
        }
    }
    if from < 9 {
        migrate_provider_to_setup(document);
    }
    lenient_setup(document);
}

/// Version 9: `provider` and `opencode` become `setup` and `apiOptions` (SPEC section 7a,
/// Migration from 0.2.4). The old address, model and efforts always go to `opencodeGo`; when the
/// old install edited with Claude Code on OpenCode (`provider` `opencode`, harness not
/// `opencode2`) they also go to `anthropicApi`, with the old address stored explicitly (null was
/// the Go default, which is not the default of `anthropicApi`). OpenCode without a model was
/// never selectable and becomes the Claude subscription.
fn migrate_provider_to_setup(document: &mut serde_json::Map<String, Value>) {
    let provider = document.remove("provider");
    let old = match document.remove("opencode") {
        Some(Value::Object(old)) => old,
        _ => serde_json::Map::new(),
    };
    let text = |key: &str| {
        old.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
    };
    let (base_url, model) = (text("baseUrl"), text("model"));
    let efforts = match old.get("efforts") {
        Some(Value::Object(efforts)) => Value::Object(efforts.clone()),
        _ => serde_json::json!({}),
    };
    let on_opencode = provider.as_ref().and_then(Value::as_str) == Some("opencode");
    let setup = match (on_opencode && model.is_some(), text("harness").as_deref()) {
        (false, _) => "claudeSubscription",
        (true, Some("opencode2" | "opencode")) => "opencodeGo",
        (true, _) => "anthropicApi",
    };
    let option = |base_url: Option<String>| serde_json::json!({ "baseUrl": base_url, "model": model, "efforts": efforts });
    let anthropic = if setup == "anthropicApi" {
        option(Some(base_url.clone().unwrap_or_else(|| {
            crate::opencode::DEFAULT_BASE_URL.to_owned()
        })))
    } else {
        empty_api_option()
    };
    document.insert("setup".into(), Value::from(setup));
    document.insert(
        "apiOptions".into(),
        serde_json::json!({
            "opencodeGo": option(base_url),
            "anthropicApi": anthropic,
            "openaiApi": empty_api_option(),
        }),
    );
}

fn empty_api_option() -> Value {
    serde_json::json!({ "baseUrl": null, "model": null, "efforts": {} })
}

/// Makes `setup` and `apiOptions` of any version loadable: a `setup` this version does not know is
/// the Claude subscription, and a missing or wrongly typed part of an API option is empty (the
/// values themselves are checked by `sanitize_setup`).
fn lenient_setup(document: &mut serde_json::Map<String, Value>) {
    let known = [
        "claudeSubscription",
        "opencodeGo",
        "anthropicApi",
        "openaiApi",
    ];
    if let Some(setup) = document.get_mut("setup")
        && !setup.as_str().is_some_and(|s| known.contains(&s))
    {
        *setup = Value::from("claudeSubscription");
    }
    let Some(options) = document.get_mut("apiOptions") else {
        return;
    };
    if !options.is_object() {
        *options = serde_json::json!({});
    }
    let Some(options) = options.as_object_mut() else {
        return;
    };
    for name in ["opencodeGo", "anthropicApi", "openaiApi"] {
        let entry = options.entry(name).or_insert_with(empty_api_option);
        if !entry.is_object() {
            *entry = empty_api_option();
        }
        let Some(entry) = entry.as_object_mut() else {
            continue;
        };
        for key in ["baseUrl", "model"] {
            if !entry.get(key).is_some_and(|v| v.is_string() || v.is_null()) {
                entry.insert(key.into(), Value::Null);
            }
        }
        if !entry.get("efforts").is_some_and(|v| {
            v.as_object()
                .is_some_and(|m| m.values().all(Value::is_string))
        }) {
            entry.insert("efforts".into(), serde_json::json!({}));
        }
    }
}

/// `state.json` (fields added to stored jobs are `Option`s, which load as `None` when missing;
/// the steps are the video's selected prompt and style, and the harness name of OpenCode 1.x).
fn migrate_state(document: &mut serde_json::Map<String, Value>, from: u32) {
    if from < 9 {
        // Version 9: the model list of OpenCode is the one of `opencodeGo`.
        if let Some(Value::Object(mut list)) = document.remove("opencodeModels") {
            list.insert("option".into(), Value::from("opencodeGo"));
            let cache = document
                .entry("apiModels")
                .or_insert_with(|| serde_json::json!({}));
            if let Some(cache) = cache.as_object_mut() {
                cache
                    .entry("opencodeGo")
                    .or_insert_with(|| Value::Object(list));
            }
        } else {
            document.remove("opencodeModels");
        }
    }
    let Some(Value::Object(videos)) = document.get_mut("videos") else {
        return;
    };
    for video in videos.values_mut().filter_map(Value::as_object_mut) {
        if from < 7
            && let Some(Value::Object(inputs)) = video.get_mut("inputs")
        {
            inputs.entry("promptSlot").or_insert_with(|| Value::from(0));
            inputs.entry("styleSlot").or_insert_with(|| Value::from(0));
        }
        if let Some(Value::Object(job)) = video.get_mut("latestJob") {
            if from < 8 && job.get("harness").and_then(Value::as_str) == Some("opencode") {
                job.insert("harness".into(), Value::from("opencode2"));
            }
            if from < 9 {
                // The provider and the program of a job become its setup.
                let provider = job.remove("provider");
                let harness = job.get("harness").and_then(Value::as_str);
                let setup = match (provider.as_ref().and_then(Value::as_str), harness) {
                    (Some("opencode"), Some("opencode2")) => "opencodeGo",
                    (Some("opencode"), _) => "anthropicApi",
                    _ => "claudeSubscription",
                };
                job.entry("setup").or_insert_with(|| Value::from(setup));
            }
        }
    }
}

/// Loads a versioned JSON document. Missing means defaults; corrupt means quarantine + defaults.
/// Returns the document and the version of the file it came from ([`SCHEMA_VERSION`] when there was
/// no file or it was replaced).
fn load_document<T: DeserializeOwned + Serialize + Default>(
    path: &Path,
    migrate: Migration,
    durability: Durability,
) -> AppResult<(T, u32)> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok((T::default(), SCHEMA_VERSION)),
        Err(e) => return Err(AppError::io_at("Could not read", path, e)),
    };
    match parse_document(&bytes, migrate) {
        Ok(loaded) => Ok(loaded),
        Err(reason) => {
            let moved_to = quarantine(path)?;
            eprintln!(
                "vidai: {} is corrupt ({reason}); moved to {} and replaced by defaults",
                path.display(),
                moved_to.display()
            );
            let value = T::default();
            save_document(path, &value, durability)?;
            Ok((value, SCHEMA_VERSION))
        }
    }
}

fn parse_document<T: DeserializeOwned + Serialize + Default>(
    bytes: &[u8],
    migrate: Migration,
) -> Result<(T, u32), String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let Value::Object(mut map) = value else {
        return Err("not a JSON object".into());
    };
    let version = match map.remove(SCHEMA_KEY) {
        None => SCHEMA_VERSION,
        Some(v) => v
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .ok_or_else(|| format!("invalid {SCHEMA_KEY}: {v}"))?,
    };
    // Also a current file goes through it: the steps are guarded by the version, and the last
    // ones make hand-edited values loadable.
    migrate(&mut map, version);
    // Top-level fields missing from the file take their default values.
    let Value::Object(mut document) =
        serde_json::to_value(T::default()).map_err(|e| e.to_string())?
    else {
        return Err("defaults are not a JSON object".into());
    };
    document.extend(map);
    let value = serde_json::from_value(Value::Object(document)).map_err(|e| e.to_string())?;
    Ok((value, version))
}

/// Serializes `value` with `schemaVersion` first and writes it atomically.
fn save_document<T: Serialize>(path: &Path, value: &T, durability: Durability) -> AppResult<()> {
    let Value::Object(fields) = serde_json::to_value(value)? else {
        return Err(AppError::internal(
            "A stored document must be a JSON object.",
        ));
    };
    let mut document = serde_json::Map::new();
    document.insert(SCHEMA_KEY.into(), SCHEMA_VERSION.into());
    document.extend(fields);
    let mut bytes = serde_json::to_vec_pretty(&Value::Object(document))?;
    bytes.push(b'\n');
    write_file(path, &bytes, durability)
}

/// Moves a corrupt file aside as `<name>.corrupt-<timestamp>` and returns the new path.
fn quarantine(path: &Path) -> AppResult<PathBuf> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let mut target = path.with_file_name(format!("{name}.corrupt-{stamp}"));
    let mut n = 1;
    while target.exists() {
        target = path.with_file_name(format!("{name}.corrupt-{stamp}-{n}"));
        n += 1;
    }
    fs::rename(path, &target).map_err(|e| AppError::io_at("Could not move aside", path, e))?;
    Ok(target)
}

/// Writes a file atomically: temp file in the same directory, fsync, rename over the target,
/// then fsync the directory. Readers see either the old or the new content, never a mix.
/// Usable for any file VidAI writes (for example `export_settings`).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    write_file(path, bytes, Durability::Synced)
}

/// [`write_atomic`], with the fsyncs only when `durability` asks for them.
fn write_file(path: &Path, bytes: &[u8], durability: Durability) -> AppResult<()> {
    let synced = durability == Durability::Synced;
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(dir).map_err(|e| AppError::io_at("Could not create", dir, e))?;
    let name = path
        .file_name()
        .ok_or_else(|| AppError::invalid_input(format!("Not a file path: {}", path.display())))?
        .to_string_lossy();
    let tmp = dir.join(format!(".{name}.tmp-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        if synced {
            file.sync_all()?;
        }
        crate::platform::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::io_at("Could not write", path, e));
    }
    if synced {
        sync_dir(dir);
    }
    Ok(())
}

/// Makes the rename durable. Best effort: not every platform can open a directory.
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(dir) = File::open(dir) {
        let _ = dir.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        ChannelProfile, ChannelVideoType, ClaudeModel, Harness, JobKind, JobProgress, JobState,
        LogKind, ReviewSoftware, Theme, ToolkitKind,
    };
    use std::sync::Arc;
    use tempfile::TempDir;

    fn temp_store() -> (TempDir, Store) {
        let dir = TempDir::new().unwrap();
        let store = Store::open(dir.path()).unwrap();
        (dir, store)
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn job(id: &str, video_id: &str) -> JobView {
        JobView {
            id: id.into(),
            video_id: video_id.into(),
            kind: JobKind::Edit,
            state: JobState::Running,
            session_id: Some("s".into()),
            toolkit: ToolkitKind::Standard,
            model: None,
            effort: None,
            video_type: VideoType::Long,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            started_at: None,
            ended_at: None,
            active_ms: 0,
            running_since: None,
            last_activity: None,
            error: None,
            cost_usd: None,
            progress: None,
            starts_at: None,
            setup: crate::model::Setup::ClaudeSubscription,
            harness: None,
        }
    }

    fn entry(seq: u64) -> LogEntry {
        LogEntry {
            seq,
            ts: "2026-01-01T00:00:00.000Z".into(),
            kind: LogKind::Status,
            text: format!("line {seq}"),
            detail: None,
            nested: false,
        }
    }

    #[test]
    fn data_dir_env_override() {
        let default = PathBuf::from("/default");
        assert_eq!(data_dir_from(None, default.clone()), default);
        assert_eq!(data_dir_from(Some("".into()), default.clone()), default);
        assert_eq!(
            data_dir_from(Some("/tmp/x".into()), default),
            PathBuf::from("/tmp/x")
        );
    }

    #[test]
    fn fresh_store_has_defaults_and_writes_nothing() {
        let (dir, store) = temp_store();
        assert_eq!(store.settings(), Settings::default());
        assert_eq!(store.video("a/b"), VideoState::default());
        assert!(store.claude_info().is_none());
        assert!(files_in(dir.path()).is_empty());
    }

    #[test]
    fn settings_round_trip_with_schema_version() {
        let (dir, store) = temp_store();
        let saved = store
            .update_settings(|s| {
                s.editing_folder = Some("/Users/me/Editing".into());
                s.max_concurrent_edits = 5;
                s.review_software = ReviewSoftware::Premiere;
                s.channels.push(crate::model::Channel {
                    id: "c1".into(),
                    folder_name: "Channel One".into(),
                    video_type: ChannelVideoType::Short,
                    long: ChannelProfile::with_defaults("long".into(), String::new()),
                    short: ChannelProfile::default(),
                });
                Ok(s.clone())
            })
            .unwrap();
        let json = read_json(&dir.path().join(SETTINGS_FILE));
        assert_eq!(json["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(json["maxConcurrentEdits"], 5);
        assert_eq!(json["channels"][0]["folderName"], "Channel One");
        assert_eq!(json["channels"][0]["videoType"], "short");

        let reopened = Store::open(dir.path()).unwrap();
        assert_eq!(reopened.settings(), saved);
    }

    #[test]
    fn failed_update_changes_nothing() {
        let (dir, store) = temp_store();
        let err = store
            .update_settings(|s| -> AppResult<()> {
                s.max_concurrent_edits = 7;
                Err(AppError::invalid_input("nope"))
            })
            .unwrap_err();
        assert_eq!(err.message, "nope");
        assert_eq!(store.settings().max_concurrent_edits, 3);
        assert!(!dir.path().join(SETTINGS_FILE).exists());
    }

    #[test]
    fn unchanged_update_does_not_write() {
        let (dir, store) = temp_store();
        store
            .update_settings(|s| {
                s.max_concurrent_edits = 2;
                Ok(())
            })
            .unwrap();
        fs::remove_file(dir.path().join(SETTINGS_FILE)).unwrap();
        store
            .update_settings(|s| {
                s.max_concurrent_edits = 2;
                Ok(())
            })
            .unwrap();
        assert!(!dir.path().join(SETTINGS_FILE).exists());
    }

    #[test]
    fn corrupt_settings_are_quarantined_and_replaced() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(SETTINGS_FILE);
        fs::write(&path, b"{ this is not json").unwrap();
        let store = Store::open(dir.path()).unwrap();
        assert_eq!(store.settings(), Settings::default());

        let names = files_in(dir.path());
        let corrupt: Vec<_> = names
            .iter()
            .filter(|n| n.starts_with("settings.json.corrupt-"))
            .collect();
        assert_eq!(corrupt.len(), 1, "{names:?}");
        assert_eq!(
            fs::read(dir.path().join(corrupt[0])).unwrap(),
            b"{ this is not json"
        );
        assert_eq!(read_json(&path)["schemaVersion"], SCHEMA_VERSION);
    }

    #[test]
    fn wrongly_typed_state_is_quarantined() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join(STATE_FILE),
            br#"{"schemaVersion":1,"videos":[1,2,3]}"#,
        )
        .unwrap();
        fs::write(dir.path().join(SETTINGS_FILE), b"[]").unwrap();
        let store = Store::open(dir.path()).unwrap();
        assert!(store.with_state(|s| s.videos.is_empty()));
        let names = files_in(dir.path());
        assert!(names.iter().any(|n| n.starts_with("state.json.corrupt-")));
        assert!(
            names
                .iter()
                .any(|n| n.starts_with("settings.json.corrupt-"))
        );
    }

    #[test]
    fn lenient_load_fills_missing_fields_and_clamps() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"schemaVersion":1,"maxConcurrentEdits":99,"futureField":true}"#,
        )
        .unwrap();
        let store = Store::open(dir.path()).unwrap();
        let settings = store.settings();
        assert_eq!(settings.max_concurrent_edits, 8);
        assert_eq!(settings.active_toolkit, ToolkitKind::Standard);
        assert!(!files_in(dir.path()).iter().any(|n| n.contains("corrupt")));
    }

    #[test]
    fn out_of_range_numbers_are_clamped_on_load() {
        for (text_size, start_delay, want_text_size, want_start_delay) in [
            (99, 9999, MAX_TEXT_SIZE, MAX_START_DELAY_MINUTES),
            (0, 0, MIN_TEXT_SIZE, 0),
            (17, 45, 17, 45),
        ] {
            let dir = TempDir::new().unwrap();
            fs::write(
                dir.path().join(SETTINGS_FILE),
                format!(
                    r#"{{"schemaVersion":3,"textSize":{text_size},"startDelayMinutes":{start_delay}}}"#
                ),
            )
            .unwrap();
            let settings = Store::open(dir.path()).unwrap().settings();
            assert_eq!(settings.text_size, want_text_size, "{text_size}");
            assert_eq!(
                settings.start_delay_minutes, want_start_delay,
                "{start_delay}"
            );
        }
    }

    /// A `settings.json` written by VidAI before channels had a video type.
    const SETTINGS_V1: &str = r#"{
  "schemaVersion": 1,
  "editingFolder": "/Users/me/Editing",
  "reviewSoftware": "fcp",
  "maxConcurrentEdits": 3,
  "model": null,
  "effort": null,
  "activeToolkit": "standard",
  "channels": [
    {
      "id": "c1",
      "folderName": "Nikon Shorts",
      "long": { "prompt": "long", "style": "" },
      "short": { "prompt": "short", "style": "s" }
    }
  ]
}"#;

    #[test]
    fn version_1_settings_load_with_auto_channel_type() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(SETTINGS_FILE), SETTINGS_V1).unwrap();
        let store = Store::open(dir.path()).unwrap();
        let settings = store.settings();
        assert_eq!(settings.channels.len(), 1);
        let channel = &settings.channels[0];
        assert_eq!(channel.folder_name, "Nikon Shorts");
        assert_eq!(channel.video_type, ChannelVideoType::Auto);
        assert_eq!(channel.short.styles[0].text, "s");
        // The old prompt and style are slot 0; the other slots are empty and default-named.
        assert_eq!(channel.long.prompts[0].text, "long");
        assert_eq!(channel.long.prompts[0].name, "Default");
        assert_eq!(channel.long.prompts.len(), 5);
        assert_eq!(channel.long.prompts[1], ChannelSlot::empty("Prompt", 1));
        assert_eq!(channel.long.styles[4], ChannelSlot::empty("Style", 4));
        assert!(!files_in(dir.path()).iter().any(|n| n.contains("corrupt")));

        // The next save writes the current version with the field.
        store
            .update_settings(|s| {
                s.channels[0].video_type = ChannelVideoType::Short;
                Ok(())
            })
            .unwrap();
        let json = read_json(&dir.path().join(SETTINGS_FILE));
        assert_eq!(json["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(json["channels"][0]["videoType"], "short");
        let reopened = Store::open(dir.path()).unwrap();
        assert_eq!(
            reopened.settings().channels[0].video_type,
            ChannelVideoType::Short
        );
    }

    /// A `settings.json` written by VidAI before the appearance and the start delay existed.
    const SETTINGS_V2: &str = r#"{
  "schemaVersion": 2,
  "editingFolder": "/Users/me/Editing",
  "reviewSoftware": "premiere",
  "maxConcurrentEdits": 4,
  "model": "opus",
  "effort": "high",
  "activeToolkit": "standard",
  "channels": [
    {
      "id": "c1",
      "folderName": "Tech",
      "videoType": "short",
      "long": { "prompt": "long", "style": "" },
      "short": { "prompt": "short", "style": "s" }
    }
  ]
}"#;

    #[test]
    fn version_2_settings_load_with_appearance_and_start_delay_defaults() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(SETTINGS_FILE), SETTINGS_V2).unwrap();
        let store = Store::open(dir.path()).unwrap();
        let settings = store.settings();
        assert_eq!(settings.theme, Theme::System);
        assert_eq!(settings.text_size, DEFAULT_TEXT_SIZE);
        assert_eq!(settings.start_delay_minutes, DEFAULT_START_DELAY_MINUTES);
        // Everything that was there is kept.
        assert_eq!(settings.review_software, ReviewSoftware::Premiere);
        assert_eq!(settings.max_concurrent_edits, 4);
        assert_eq!(settings.model.as_deref(), Some("opus"));
        assert_eq!(settings.channels[0].video_type, ChannelVideoType::Short);
        assert!(!files_in(dir.path()).iter().any(|n| n.contains("corrupt")));

        // The next save writes the current version with the new fields.
        store
            .update_settings(|s| {
                s.theme = Theme::Dark;
                Ok(())
            })
            .unwrap();
        let json = read_json(&dir.path().join(SETTINGS_FILE));
        assert_eq!(json["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(json["theme"], "dark");
        assert_eq!(json["textSize"], DEFAULT_TEXT_SIZE);
        assert_eq!(json["startDelayMinutes"], DEFAULT_START_DELAY_MINUTES);
        let reopened = Store::open(dir.path()).unwrap();
        assert_eq!(reopened.settings(), store.settings());
    }

    #[test]
    fn migration_to_3_keeps_values_that_are_already_there() {
        let mut document = serde_json::from_str::<Value>(
            r#"{"theme":"light","textSize":18,"startDelayMinutes":0}"#,
        )
        .unwrap()
        .as_object()
        .unwrap()
        .clone();
        migrate_settings(&mut document, 2);
        assert_eq!(document["theme"], "light");
        assert_eq!(document["textSize"], 18);
        assert_eq!(document["startDelayMinutes"], 0);

        let mut empty = serde_json::Map::new();
        migrate_settings(&mut empty, 2);
        assert_eq!(
            Value::Object(empty),
            serde_json::json!({
                "theme": serde_json::to_value(Theme::default()).unwrap(),
                "textSize": DEFAULT_TEXT_SIZE,
                "startDelayMinutes": DEFAULT_START_DELAY_MINUTES,
                "setup": "claudeSubscription",
                "apiOptions": {
                    "opencodeGo": { "baseUrl": null, "model": null, "efforts": {} },
                    "anthropicApi": { "baseUrl": null, "model": null, "efforts": {} },
                    "openaiApi": { "baseUrl": null, "model": null, "efforts": {} },
                },
            })
        );
    }

    /// Writes a `settings.json` of `version` with `body` (the other fields) and opens it.
    fn open_settings(version: u32, body: &str) -> (TempDir, Store) {
        let dir = TempDir::new().unwrap();
        let comma = if body.is_empty() { "" } else { "," };
        fs::write(
            dir.path().join(SETTINGS_FILE),
            format!(r#"{{"schemaVersion":{version}{comma}{body}}}"#),
        )
        .unwrap();
        let store = Store::open(dir.path()).unwrap();
        (dir, store)
    }

    fn api(settings: &Settings, option: ApiOption) -> (Option<String>, Option<String>) {
        let o = settings.api_options.get(option);
        (o.base_url.clone(), o.model.clone())
    }

    #[test]
    fn version_8_claude_settings_become_the_claude_subscription() {
        let (_dir, store) = open_settings(
            8,
            r#""provider":"claude","opencode":{"baseUrl":null,"model":"glm-5.3","harness":"opencode2","efforts":{"glm-5.3":"high"}}"#,
        );
        let settings = store.settings();
        assert_eq!(settings.setup, crate::model::Setup::ClaudeSubscription);
        // What was chosen for OpenCode is kept for the Go option, and only there.
        assert_eq!(
            api(&settings, ApiOption::OpencodeGo),
            (None, Some("glm-5.3".into()))
        );
        assert_eq!(settings.api_options.opencode_go.efforts["glm-5.3"], "high");
        assert_eq!(api(&settings, ApiOption::AnthropicApi), (None, None));
        assert!(!store.api_key_migration_pending());
    }

    #[test]
    fn version_8_opencode_with_the_opencode_2_program_is_opencode_go() {
        let (_dir, store) = open_settings(
            8,
            r#""provider":"opencode","opencode":{"baseUrl":"https://example.com/gw","model":"kimi-k3","harness":"opencode2","efforts":{"kimi-k3":"max"}}"#,
        );
        let settings = store.settings();
        assert_eq!(settings.setup, crate::model::Setup::OpencodeGo);
        // The address of the Go option: an Anthropic style address, kept as it was.
        assert_eq!(
            api(&settings, ApiOption::OpencodeGo),
            (
                Some("https://example.com/gw".into()),
                Some("kimi-k3".into())
            )
        );
        assert_eq!(api(&settings, ApiOption::AnthropicApi), (None, None));
        assert!(!store.api_key_migration_pending());
    }

    #[test]
    fn version_8_opencode_with_claude_code_is_the_anthropic_api_and_waits_for_the_key_copy() {
        let (dir, store) = open_settings(
            8,
            r#""provider":"opencode","opencode":{"baseUrl":null,"model":"glm-5.3","harness":"claudeCode","efforts":{"glm-5.3":"low"}}"#,
        );
        let settings = store.settings();
        assert_eq!(settings.setup, crate::model::Setup::AnthropicApi);
        // The old default address is stored explicitly for the Anthropic option (null means
        // another default there), and the Go option keeps the same choices.
        assert_eq!(
            api(&settings, ApiOption::AnthropicApi),
            (
                Some(crate::opencode::DEFAULT_BASE_URL.to_owned()),
                Some("glm-5.3".into())
            )
        );
        assert_eq!(settings.api_options.anthropic_api.efforts["glm-5.3"], "low");
        assert_eq!(
            api(&settings, ApiOption::OpencodeGo),
            (None, Some("glm-5.3".into()))
        );
        assert!(store.api_key_migration_pending());

        // Until the key was copied nothing is written at version 9: a change of the settings
        // stays in memory, and the file is still the one of the old version.
        let path = dir.path().join(SETTINGS_FILE);
        let before = fs::read(&path).unwrap();
        store
            .update_settings(|s| {
                s.text_size = 17;
                Ok(())
            })
            .unwrap();
        assert_eq!(store.settings().text_size, 17);
        assert_eq!(fs::read(&path).unwrap(), before);

        // A copy that fails writes nothing and leaves the step pending.
        assert!(
            store
                .finish_api_key_migration(|| Err(AppError::secrets_unavailable("locked")))
                .is_err()
        );
        assert!(store.api_key_migration_pending());
        assert_eq!(fs::read(&path).unwrap(), before);

        // After the copy the file is written at version 9, with the change.
        store.finish_api_key_migration(|| Ok(())).unwrap();
        assert!(!store.api_key_migration_pending());
        let json = read_json(&path);
        assert_eq!(json["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(json["setup"], "anthropicApi");
        assert_eq!(json["textSize"], 17);
        assert!(json.get("provider").is_none() && json.get("opencode").is_none());
        // Later changes are written at once, and a second finish does nothing.
        store
            .finish_api_key_migration(|| panic!("not pending"))
            .unwrap();
        store
            .update_settings(|s| {
                s.text_size = 18;
                Ok(())
            })
            .unwrap();
        assert_eq!(read_json(&path)["textSize"], 18);
    }

    #[test]
    fn a_pending_migration_that_never_finishes_leaves_the_old_file_for_the_next_start() {
        let (dir, store) = open_settings(
            8,
            r#""provider":"opencode","opencode":{"baseUrl":null,"model":"glm-5.3","harness":"claudeCode"}"#,
        );
        assert!(store.api_key_migration_pending());
        drop(store);
        let again = Store::open(dir.path()).unwrap();
        assert!(again.api_key_migration_pending());
        assert_eq!(again.settings().setup, crate::model::Setup::AnthropicApi);
    }

    #[test]
    fn version_4_and_5_opencode_settings_migrate_through_the_older_steps() {
        // Version 4 had no program: Claude Code on OpenCode, so the Anthropic API.
        let (_dir, store) = open_settings(
            4,
            r#""provider":"opencode","opencode":{"baseUrl":null,"model":"glm-5.3"}"#,
        );
        let settings = store.settings();
        assert_eq!(settings.setup, crate::model::Setup::AnthropicApi);
        assert!(store.api_key_migration_pending());
        // Version 5 stored the program; "cursor" is not one this version knows (Claude Code).
        let (_dir, store) = open_settings(
            5,
            r#""provider":"opencode","opencode":{"baseUrl":null,"model":"glm-5.3","harness":"cursor"}"#,
        );
        assert_eq!(store.settings().setup, crate::model::Setup::AnthropicApi);
        let (_dir, store) = open_settings(
            5,
            r#""provider":"claude","opencode":{"baseUrl":null,"model":"glm-5.3","harness":"claudeCode"}"#,
        );
        assert_eq!(
            store.settings().setup,
            crate::model::Setup::ClaudeSubscription
        );
        assert!(store.settings().api_options.opencode_go.efforts.is_empty());
    }

    #[test]
    fn version_8_opencode_without_a_model_is_the_claude_subscription() {
        let (_dir, store) = open_settings(
            8,
            r#""provider":"opencode","opencode":{"baseUrl":null,"model":null,"harness":"claudeCode"}"#,
        );
        assert_eq!(
            store.settings().setup,
            crate::model::Setup::ClaudeSubscription
        );
        assert!(!store.api_key_migration_pending());
        let (_dir, store) = open_settings(8, r#""provider":"opencode","opencode":{"model":"  "}"#);
        assert_eq!(
            store.settings().setup,
            crate::model::Setup::ClaudeSubscription
        );
    }

    #[test]
    fn a_settings_file_without_no_sleep_loads_it_off_and_keeps_a_saved_choice() {
        // Files written before the setting existed, at the current and at an older version.
        for version in [3, SCHEMA_VERSION] {
            let (_dir, store) = open_settings(version, r#""textSize":16"#);
            assert!(!store.settings().no_sleep, "version {version}");
        }
        let (dir, store) = open_settings(SCHEMA_VERSION, r#""noSleep":true"#);
        assert!(store.settings().no_sleep);
        store
            .update_settings(|s| {
                s.no_sleep = false;
                Ok(())
            })
            .unwrap();
        assert_eq!(read_json(&dir.path().join(SETTINGS_FILE))["noSleep"], false);
    }

    #[test]
    fn version_3_settings_load_with_the_claude_subscription() {
        let (_dir, store) = open_settings(
            3,
            r#""model":"opus","theme":"dark","textSize":15,"startDelayMinutes":5"#,
        );
        let settings = store.settings();
        assert_eq!(settings.setup, crate::model::Setup::ClaudeSubscription);
        assert_eq!(settings.api_options, crate::model::ApiOptions::default());
        assert_eq!(settings.model.as_deref(), Some("opus"));
        assert!(!store.api_key_migration_pending());
    }

    #[test]
    fn a_setup_this_version_does_not_know_loads_as_the_claude_subscription() {
        let (_dir, store) = open_settings(9, r#""setup":"somethingNew""#);
        assert_eq!(
            store.settings().setup,
            crate::model::Setup::ClaudeSubscription
        );
        // Wrongly typed parts of the API options load empty; the rest of the file stays.
        let (_dir, store) = open_settings(
            9,
            r#""textSize":16,"setup":"claudeSubscription","apiOptions":{"opencodeGo":{"baseUrl":5,"model":["x"],"efforts":"high"},"openaiApi":"nope"}"#,
        );
        let settings = store.settings();
        assert_eq!(settings.text_size, 16);
        assert_eq!(settings.api_options, crate::model::ApiOptions::default());
    }

    #[test]
    fn api_options_are_sanitized_when_the_settings_load() {
        let (_dir, store) = open_settings(
            9,
            r#""setup":"openaiApi","apiOptions":{
                "opencodeGo":{"baseUrl":"https://opencode.ai/inference/go/anthropic/","model":" glm-5.3 ","efforts":{"glm-5.3":"high","kimi-k3":"turbo"," ":"low"}},
                "anthropicApi":{"baseUrl":"http://example.com","model":"claude-x","efforts":{}},
                "openaiApi":{"baseUrl":"https://api.openai.com/v1/chat/completions","model":"gpt-x","efforts":{"gpt-x":"xhigh"}}}"#,
        );
        let settings = store.settings();
        // The default address is stored as null, a model is trimmed, unusable efforts are dropped.
        let go = &settings.api_options.opencode_go;
        assert_eq!(go.base_url, None);
        assert_eq!(go.model.as_deref(), Some("glm-5.3"));
        assert_eq!(
            go.efforts.iter().collect::<Vec<_>>(),
            vec![(&"glm-5.3".to_owned(), &"high".to_owned())]
        );
        // A broken address loads as the default.
        assert_eq!(settings.api_options.anthropic_api.base_url, None);
        // The OpenAI form keeps its /v1 and loses the pasted path; its default is null.
        assert_eq!(
            settings.api_options.openai_api.base_url.as_deref(),
            Some("https://api.openai.com/v1")
                .filter(|u| *u != crate::opencode::OPENAI_DEFAULT_BASE_URL)
        );
        assert_eq!(settings.setup, crate::model::Setup::OpenaiApi);
    }

    #[test]
    fn an_api_option_without_a_model_loads_as_the_claude_subscription() {
        let (_dir, store) = open_settings(
            9,
            r#""setup":"anthropicApi","apiOptions":{"anthropicApi":{"baseUrl":null,"model":"  ","efforts":{}}}"#,
        );
        assert_eq!(
            store.settings().setup,
            crate::model::Setup::ClaudeSubscription
        );
    }

    #[test]
    fn efforts_of_api_models_survive_a_restart_and_drop_unknown_levels() {
        let (dir, store) = open_settings(9, "");
        store
            .update_settings(|s| {
                let efforts = &mut s.api_options.get_mut(ApiOption::OpencodeGo).efforts;
                for (model, effort) in [("glm-5.3", "high"), ("kimi-k3", "turbo"), (" ", "low")] {
                    efforts.insert(model.into(), effort.into());
                }
                Ok(())
            })
            .unwrap();
        // The next start of the app drops the entries that cannot be used.
        let reopened = Store::open(dir.path())
            .unwrap()
            .settings()
            .api_options
            .opencode_go
            .efforts;
        assert_eq!(
            reopened.into_iter().collect::<Vec<_>>(),
            vec![("glm-5.3".to_owned(), "high".to_owned())]
        );
    }

    #[test]
    fn the_edit_log_is_mirrored_into_the_editing_folder_with_the_line_endings_of_the_platform() {
        let (dir, store) = temp_store();
        let editing = dir.path().join("Editing");
        fs::create_dir_all(&editing).unwrap();
        store
            .update_settings(|s| {
                s.editing_folder = Some(editing.to_string_lossy().into_owned());
                Ok(())
            })
            .unwrap();
        for (n, event) in ["started", "completed"].into_iter().enumerate() {
            store
                .append_edit_log(EditLogEntry {
                    ts: format!("2026-11-15T10:0{n}:00.000Z"),
                    video_id: "chan/001 Clip".into(),
                    folder: "001 Clip".into(),
                    event: event.into(),
                    message: format!("Edit {event}"),
                })
                .unwrap();
        }
        let eol = if cfg!(windows) { "\r\n" } else { "\n" };
        assert_eq!(
            fs::read_to_string(editing.join(EDIT_LOG_FILE)).unwrap(),
            format!(
                "[2026-11-15T10:00:00.000Z] chan/001 Clip started - Edit started{eol}\
                 [2026-11-15T10:01:00.000Z] chan/001 Clip completed - Edit completed{eol}"
            )
        );
        assert_eq!(store.edit_log().len(), 2);
        // Without an Editing Folder the log is only kept in the state.
        let (_other, bare) = temp_store();
        bare.append_edit_log(EditLogEntry {
            ts: "2026-11-15T10:00:00.000Z".into(),
            video_id: "chan/x".into(),
            folder: "x".into(),
            event: "started".into(),
            message: "m".into(),
        })
        .unwrap();
        assert_eq!(bare.edit_log().len(), 1);
    }

    #[test]
    fn profiles_are_padded_cut_and_renamed_on_load() {
        let dir = TempDir::new().unwrap();
        let slot = |name: &str, text: &str| serde_json::json!({ "name": name, "text": text });
        let profile = serde_json::json!({
            "prompts": [slot("Mine", "p0"), slot("  Fast  ", "p1"), slot("   ", "p2"),
                slot(&"x".repeat(60), "p3"), slot("Five", "p4"), slot("Six", "p5")],
            "styles": [slot("Default", "s0")],
        });
        let document = serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "channels": [{
                "id": "c1", "folderName": "A", "videoType": "auto",
                "long": profile, "short": profile
            }]
        });
        fs::write(dir.path().join(SETTINGS_FILE), document.to_string()).unwrap();
        let long = Store::open(dir.path()).unwrap().settings().channels[0]
            .long
            .clone();
        let names: Vec<_> = long.prompts.iter().map(|s| s.name.clone()).collect();
        assert_eq!(
            names,
            [
                "Default",
                "Fast",
                "Prompt 3",
                &"x".repeat(MAX_SLOT_NAME_CHARS),
                "Five"
            ]
        );
        assert_eq!(long.prompts[4].text, "p4");
        assert_eq!(long.styles.len(), 5);
        assert_eq!(long.styles[0].text, "s0");
        assert_eq!(long.styles[1].name, "Style 2");
    }

    #[test]
    fn video_selections_load_as_zero_and_out_of_range_clamps() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(STATE_FILE), STATE_V2).unwrap();
        let store = Store::open(dir.path()).unwrap();
        let inputs = store.video("c1/Video").inputs;
        assert_eq!((inputs.prompt_slot, inputs.style_slot), (0, 0));

        let document = serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "videos": { "c1/V": { "inputs": {
                "productLinks": "", "notes": "", "promptSlot": 4, "styleSlot": 9
            } } }
        });
        fs::write(dir.path().join(STATE_FILE), document.to_string()).unwrap();
        let inputs = Store::open(dir.path()).unwrap().video("c1/V").inputs;
        assert_eq!((inputs.prompt_slot, inputs.style_slot), (4, 0));
    }

    fn model_list(option: ApiOption, base_url: &str) -> ApiModels {
        ApiModels {
            option,
            base_url: base_url.into(),
            models: vec![crate::model::ApiModel {
                id: "glm-5.3".into(),
                display_name: "GLM-5.3".into(),
            }],
            fetched_at: Some("2026-11-15T10:00:00.000Z".into()),
        }
    }

    #[test]
    fn jobs_without_a_setup_and_the_go_model_cache_load() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(STATE_FILE), STATE_V2).unwrap();
        let store = Store::open(dir.path()).unwrap();
        let job = store.video("c1/Video").latest_job.unwrap();
        assert_eq!(job.setup, crate::model::Setup::ClaudeSubscription);
        for option in ApiOption::ALL {
            assert_eq!(store.api_models(option), None);
        }
        // Only OpenCode Go has a list.
        let go = model_list(
            ApiOption::OpencodeGo,
            "https://opencode.ai/inference/go/anthropic",
        );
        store.set_api_models(go.clone()).unwrap();
        let reopened = Store::open(dir.path()).unwrap();
        assert_eq!(reopened.api_models(ApiOption::OpencodeGo), Some(go));
        assert_eq!(reopened.api_models(ApiOption::AnthropicApi), None);
        assert_eq!(reopened.api_models(ApiOption::OpenaiApi), None);
    }

    #[test]
    fn old_lists_of_the_other_options_are_ignored_and_the_old_go_cache_moves() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join(STATE_FILE),
            r#"{"schemaVersion":9,"apiModels":{
                "opencodeGo":{"option":"opencodeGo","baseUrl":"https://opencode.ai/inference/go/anthropic","models":[{"id":"glm-5.3","displayName":"GLM-5.3"}],"fetchedAt":"2026-11-15T10:00:00.000Z"},
                "anthropicApi":{"option":"anthropicApi","baseUrl":"https://api.anthropic.com","models":[{"id":"x","displayName":"X"}],"fetchedAt":"2026-11-15T10:00:00.000Z"},
                "openaiApi":{"option":"openaiApi","baseUrl":"https://api.openai.com/v1","models":[],"fetchedAt":null}}}"#,
        )
        .unwrap();
        let store = Store::open(dir.path()).unwrap();
        assert_eq!(store.api_models(ApiOption::AnthropicApi), None);
        assert_eq!(store.api_models(ApiOption::OpenaiApi), None);
        assert_eq!(
            store.api_models(ApiOption::OpencodeGo).unwrap().models[0].id,
            "glm-5.3"
        );
        // The version 8 cache of OpenCode 1.x becomes the one of OpenCode Go, and a pending
        // `anthropicApi` gets no list of its own.
        fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{"schemaVersion":8,"provider":"opencode","opencode":{"model":"glm-5.3","harness":"claudeCode"}}"#,
        )
        .unwrap();
        fs::write(
            dir.path().join(STATE_FILE),
            r#"{"schemaVersion":8,"opencodeModels":{"baseUrl":"https://opencode.ai/inference/go/anthropic","models":[{"id":"glm-5.3","displayName":"GLM-5.3"}],"fetchedAt":"2026-11-15T10:00:00.000Z"}}"#,
        )
        .unwrap();
        let store = Store::open(dir.path()).unwrap();
        let go = store.api_models(ApiOption::OpencodeGo).unwrap();
        assert_eq!(go.option, ApiOption::OpencodeGo);
        assert_eq!(go.models[0].id, "glm-5.3");
        assert_eq!(store.api_models(ApiOption::AnthropicApi), None);
    }

    /// A `state.json` written by VidAI before jobs had `progress` and `startsAt`.
    const STATE_V2: &str = r#"{
  "schemaVersion": 2,
  "videos": {
    "c1/Video": {
      "typeOverride": null,
      "inputs": { "productLinks": "", "notes": "n" },
      "latestJob": {
        "id": "j1",
        "videoId": "c1/Video",
        "kind": "edit",
        "state": "paused",
        "sessionId": "s1",
        "toolkit": "standard",
        "model": null,
        "effort": null,
        "videoType": "long",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "startedAt": "2026-01-01T00:00:01.000Z",
        "endedAt": null,
        "activeMs": 1000,
        "runningSince": null,
        "lastActivity": "Paused",
        "error": null,
        "costUsd": 0.5
      },
      "typeDetection": null
    }
  }
}"#;

    #[test]
    fn version_2_state_loads_jobs_without_progress_and_starts_at() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(STATE_FILE), STATE_V2).unwrap();
        let store = Store::open(dir.path()).unwrap();
        let job = store.video("c1/Video").latest_job.unwrap();
        assert_eq!(job.id, "j1");
        assert_eq!(job.state, JobState::Paused);
        assert_eq!(job.session_id.as_deref(), Some("s1"));
        assert_eq!(job.progress, None);
        assert_eq!(job.starts_at, None);
        assert_eq!(store.video("c1/Video").inputs.notes, "n");
        // Files written before the progress history and memory existed load them empty.
        assert_eq!(store.video("c1/Video").progress_memory, None);
        assert!(store.progress_runs("edit/long").is_empty());
        assert!(!files_in(dir.path()).iter().any(|n| n.contains("corrupt")));
    }

    #[test]
    fn a_stored_opencode_1_harness_loads_as_opencode2() {
        let dir = TempDir::new().unwrap();
        let state = STATE_V2.replace(
            "\"toolkit\"",
            "\"harness\": \"opencode\",\n        \"toolkit\"",
        );
        assert_ne!(state, STATE_V2);
        fs::write(dir.path().join(STATE_FILE), state).unwrap();
        let store = Store::open(dir.path()).unwrap();
        let job = store.video("c1/Video").latest_job.unwrap();
        assert_eq!(job.harness, Some(Harness::Opencode2));
        let mut document = serde_json::json!({ "opencode": { "harness": "opencode" } })
            .as_object()
            .unwrap()
            .clone();
        migrate_settings(&mut document, 7);
        // Version 8 renames the program; version 9 then reads it (no model: Claude subscription).
        assert_eq!(document["setup"], "claudeSubscription");
    }

    #[test]
    fn stored_jobs_get_the_setup_of_their_provider_and_program() {
        let dir = TempDir::new().unwrap();
        for (provider, harness, expected) in [
            (
                r#""provider": "opencode","#,
                r#""harness": "opencode2","#,
                "opencodeGo",
            ),
            (
                r#""provider": "opencode","#,
                r#""harness": "opencode","#,
                "opencodeGo",
            ),
            (
                r#""provider": "opencode","#,
                r#""harness": "claudeCode","#,
                "anthropicApi",
            ),
            (r#""provider": "opencode","#, "", "anthropicApi"),
            (
                r#""provider": "claude","#,
                r#""harness": "claudeCode","#,
                "claudeSubscription",
            ),
            ("", "", "claudeSubscription"),
        ] {
            let state = STATE_V2.replace(
                "\"toolkit\"",
                &format!("{provider}\n        {harness}\n        \"toolkit\""),
            );
            fs::write(dir.path().join(STATE_FILE), state).unwrap();
            let job = Store::open(dir.path())
                .unwrap()
                .video("c1/Video")
                .latest_job
                .unwrap();
            assert_eq!(
                serde_json::to_value(job.setup).unwrap(),
                expected,
                "{provider} {harness}"
            );
        }
    }

    #[test]
    fn type_detections_from_before_the_picture_check_load_as_detector_0() {
        let dir = TempDir::new().unwrap();
        let state = r#"{
  "schemaVersion": 2,
  "videos": {
    "c1/Video": {
      "typeDetection": { "path": "/a.MOV", "size": 10, "modifiedMs": 5, "detected": "long" }
    }
  }
}"#;
        fs::write(dir.path().join(STATE_FILE), state).unwrap();
        let store = Store::open(dir.path()).unwrap();
        let detection = store.video("c1/Video").type_detection.unwrap();
        assert!(detection.matches("/a.MOV", 10, 5));
        assert_eq!(detection.detected, Some(VideoType::Long));
        assert_eq!(
            (
                detection.detector,
                detection.display,
                detection.picture_rotation
            ),
            (0, None, None)
        );
        assert!(!files_in(dir.path()).iter().any(|n| n.contains("corrupt")));
    }

    #[test]
    fn deferred_changes_are_written_with_the_next_save_or_a_flush() {
        let (dir, store) = temp_store();
        let path = dir.path().join(STATE_FILE);
        let mut stored = job("j1", "c1/Video");
        store
            .update_video("c1/Video", |v| {
                v.latest_job = Some(stored.clone());
                Ok(())
            })
            .unwrap();
        let on_disk = || Store::open(dir.path()).unwrap().video("c1/Video");
        stored.progress = Some(JobProgress {
            percent: 12,
            stage: Some("Transcribing".into()),
        });
        store
            .update_video_deferred("c1/Video", |v| {
                v.latest_job = Some(stored.clone());
                Ok(())
            })
            .unwrap();
        // In memory at once, on disk not yet.
        assert_eq!(store.video("c1/Video").latest_job, Some(stored.clone()));
        assert_eq!(on_disk().latest_job.unwrap().progress, None);
        let written = fs::metadata(&path).unwrap().modified().unwrap();
        // The next save of anything writes it along, even when that save changes nothing else.
        store.update_video("c1/Video", |_| Ok(())).unwrap();
        assert_eq!(on_disk().latest_job, Some(stored.clone()));
        // A flush writes only when something is pending.
        store
            .update_video_deferred("c1/Video", |v| {
                v.progress_memory = Some(ProgressMemory {
                    job_id: "j1".into(),
                    percent: 12,
                    ..ProgressMemory::default()
                });
                Ok(())
            })
            .unwrap();
        store.flush_state().unwrap();
        assert_eq!(on_disk().progress_memory.unwrap().percent, 12);
        let flushed = fs::metadata(&path).unwrap().modified().unwrap();
        assert!(flushed >= written);
        fs::remove_file(&path).unwrap();
        store.flush_state().unwrap();
        assert!(!path.exists(), "nothing pending, nothing written");
        // A deferred change that leaves nothing to remember removes the entry.
        store
            .update_video_deferred("c1/Video", |v| {
                *v = VideoState::default();
                Ok(())
            })
            .unwrap();
        assert_eq!(store.video("c1/Video"), VideoState::default());
    }

    #[test]
    fn progress_history_keeps_the_last_runs_per_key() {
        let (dir, store) = temp_store();
        for i in 0..(PROGRESS_HISTORY_LEN as u64 + 3) {
            let run = ProgressRun {
                milestones: BTreeMap::from([("planned".to_owned(), i)]),
                total_ms: i,
            };
            store.record_progress_run("edit/short", run).unwrap();
        }
        store
            .record_progress_run("render/long", ProgressRun::default())
            .unwrap();
        let runs = store.progress_runs("edit/short");
        assert_eq!(runs.len(), PROGRESS_HISTORY_LEN);
        assert_eq!(runs.first().unwrap().total_ms, 3, "oldest dropped first");
        assert_eq!(runs.last().unwrap().total_ms, 12);
        assert_eq!(store.progress_runs("render/long").len(), 1);
        let reopened = Store::open(dir.path()).unwrap();
        assert_eq!(reopened.progress_runs("edit/short"), runs);
        let json = read_json(&dir.path().join(STATE_FILE));
        assert_eq!(
            json["progressHistory"]["edit/short"][0]["milestones"]["planned"],
            3
        );
    }

    #[test]
    fn job_progress_and_starts_at_round_trip() {
        let (dir, store) = temp_store();
        let mut stored = job("j1", "c1/Video");
        stored.state = JobState::Queued;
        stored.progress = Some(JobProgress {
            percent: 40,
            stage: Some("Transcribing".into()),
        });
        stored.starts_at = Some("2026-01-01T00:10:00.000Z".into());
        store
            .update_video("c1/Video", |v| {
                v.latest_job = Some(stored.clone());
                Ok(())
            })
            .unwrap();
        let json = read_json(&dir.path().join(STATE_FILE));
        let saved = &json["videos"]["c1/Video"]["latestJob"];
        assert_eq!(saved["progress"]["percent"], 40);
        assert_eq!(saved["progress"]["stage"], "Transcribing");
        assert_eq!(saved["startsAt"], "2026-01-01T00:10:00.000Z");
        let reopened = Store::open(dir.path()).unwrap();
        assert_eq!(reopened.video("c1/Video").latest_job, Some(stored));
    }

    #[test]
    fn migration_keeps_a_video_type_that_is_already_there() {
        let mut document = serde_json::from_str::<Value>(
            r#"{"channels":[{"videoType":"long"},{"folderName":"x"},"not a channel"]}"#,
        )
        .unwrap()
        .as_object()
        .unwrap()
        .clone();
        migrate_settings(&mut document, 1);
        assert_eq!(document["channels"][0]["videoType"], "long");
        assert_eq!(document["channels"][1]["videoType"], "auto");
        assert_eq!(document["channels"][2], "not a channel");
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_files() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("out.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(files_in(dir.path()), vec!["out.json".to_string()]);
    }

    #[test]
    fn atomic_write_failure_keeps_old_content() {
        let dir = TempDir::new().unwrap();
        // The target is a non-empty directory, so the final rename fails.
        let path = dir.path().join("target");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("keep"), b"x").unwrap();
        assert!(write_atomic(&path, b"new").is_err());
        assert!(path.join("keep").exists());
        assert_eq!(files_in(dir.path()), vec!["target".to_string()]);
    }

    #[test]
    fn video_state_update_and_cleanup() {
        let (dir, store) = temp_store();
        store
            .update_video("c1/Video", |v| {
                v.type_override = Some(VideoType::Short);
                v.inputs.notes = "notes".into();
                v.latest_job = Some(job("j1", "c1/Video"));
                v.type_detection = Some(TypeDetection {
                    path: "/a.mp4".into(),
                    size: 10,
                    modified_ms: 5,
                    detected: Some(VideoType::Short),
                    detector: 1,
                    display: Some([3840, 2160]),
                    picture_rotation: Some(270),
                });
                Ok(())
            })
            .unwrap();
        let reopened = Store::open(dir.path()).unwrap();
        let video = reopened.video("c1/Video");
        assert_eq!(video.type_override, Some(VideoType::Short));
        assert_eq!(video.inputs.notes, "notes");
        assert!(
            video
                .type_detection
                .as_ref()
                .unwrap()
                .matches("/a.mp4", 10, 5)
        );
        assert!(
            !video
                .type_detection
                .as_ref()
                .unwrap()
                .matches("/a.mp4", 11, 5)
        );
        let detection = video.type_detection.as_ref().unwrap();
        assert_eq!(
            (
                detection.detector,
                detection.display,
                detection.picture_rotation
            ),
            (1, Some([3840, 2160]), Some(270))
        );
        assert_eq!(reopened.latest_jobs().len(), 1);

        reopened
            .update_video("c1/Video", |v| {
                *v = VideoState::default();
                Ok(())
            })
            .unwrap();
        assert!(reopened.with_state(|s| s.videos.is_empty()));
    }

    #[test]
    fn claude_info_cache() {
        let (dir, store) = temp_store();
        let info = ClaudeInfo {
            models: vec![ClaudeModel {
                value: "opus".into(),
                display_name: "Opus".into(),
                description: "d".into(),
                effort_levels: vec!["low".into()],
            }],
            fetched_at: Some("2026-01-01T00:00:00.000Z".into()),
            ..ClaudeInfo::default()
        };
        store.set_claude_info(info.clone()).unwrap();
        assert_eq!(Store::open(dir.path()).unwrap().claude_info(), Some(info));
    }

    #[test]
    fn logs_append_read_limit_and_skip_bad_lines() {
        let (_dir, store) = temp_store();
        assert!(store.read_log("job-1", 10).unwrap().is_empty());
        store
            .append_log("job-1", &(1..=5).map(entry).collect::<Vec<_>>())
            .unwrap();
        // Simulate a crash mid-write.
        let path = store.log_path("job-1").unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{\"seq\":6,\"ts")
            .unwrap();
        store.append_log("job-1", &[entry(7)]).unwrap();

        let all = store.read_log("job-1", 100).unwrap();
        assert_eq!(
            all.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5, 7]
        );
        let last = store.read_log("job-1", 2).unwrap();
        assert_eq!(last.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![5, 7]);
        assert!(store.read_log("job-1", 0).unwrap().is_empty());

        store.remove_log("job-1").unwrap();
        store.remove_log("job-1").unwrap();
        assert!(store.read_log("job-1", 10).unwrap().is_empty());
    }

    #[test]
    fn logs_keep_newest_entries() {
        let (_dir, store) = temp_store();
        let entries: Vec<_> = (1..=50).map(entry).collect();
        store.append_log("j", &entries).unwrap();
        let last = store.read_log("j", 3).unwrap();
        assert_eq!(
            last.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![48, 49, 50]
        );
    }

    #[test]
    fn log_ids_must_be_plain_names() {
        let (_dir, store) = temp_store();
        for bad in ["", "../x", "a/b", "a.b", "a b"] {
            assert!(store.log_path(bad).is_err(), "{bad}");
        }
        assert!(store.append_log("../../etc", &[entry(1)]).is_err());
    }

    #[test]
    fn concurrent_updates_are_serialized() {
        let (dir, store) = temp_store();
        let store = Arc::new(store);
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let store = Arc::clone(&store);
                std::thread::spawn(move || {
                    for j in 0..10 {
                        store
                            .update_video(&format!("c/{i}"), |v| {
                                v.inputs.notes = format!("{j}");
                                Ok(())
                            })
                            .unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let reopened = Store::open(dir.path()).unwrap();
        for i in 0..8 {
            assert_eq!(reopened.video(&format!("c/{i}")).inputs.notes, "9");
        }
    }
}

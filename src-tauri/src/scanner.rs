//! Editing Folder scan, output detection and action rules (SPEC sections 2, 5 and 6).
//!
//! Responsibility:
//! - Scan the Editing Folder (cheap, three levels deep, never recursing into `CLAUDE_VE`) into a
//!   `Library`: channels from `Settings`, their video folders, A-roll counts, outputs (review
//!   projects, final renders, thumbnails, `meta.txt`, `info.txt`) and discovered folders.
//! - Apply the reserved-name rules and the b-roll folder rule of SPEC section 2.
//! - Keep the library fresh: rescan on a 3 second timer while the window is visible, on window
//!   focus and after every job event, and emit `events::LibraryChanged` only when the result
//!   differs. [`setup`] and [`on_window_event`] are the hooks `lib.rs` calls for this.
//! - [`compute_actions`]: the one pure function that decides which buttons a video row offers.
//!
//! Every scan is blocking file system work. It runs on the dedicated rescan thread, or on Tauri's
//! blocking pool when a command needs it (`commands::library`), never on an async worker or the
//! UI thread.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager, Window, WindowEvent};
use tauri_specta::Event;

use crate::error::{AppError, AppResult};
use crate::events::LibraryChanged;
use crate::media::{self, ArollFile};
use crate::model::{
    Channel, ChannelView, JobState, Library, OutputFile, ReviewSoftware, VideoAction, VideoOutput,
    VideoType, VideoView, resolve_video_type, video_id,
};
use crate::store::{Store, TypeDetection, VideoState};

/// Rescan period while the window is visible (SPEC section 5).
const RESCAN_INTERVAL: Duration = Duration::from_secs(3);
/// Name of the folder inside a video folder that holds the review project and renders.
const OUTPUT_DIR: &str = "output";
/// How much of an `.xml` file is read to recognize Premiere / FCP7 XML.
const XMEML_SNIFF_BYTES: usize = 4096;

/// Everything the job engine needs to know about one video.
///
/// Seam between `scanner` (which owns the folder rules) and `jobs` (which never reads folders
/// itself). Built fresh from disk and the store on every call.
#[derive(Debug, Clone)]
pub struct VideoContext {
    pub video_id: String,
    pub channel_id: String,
    /// Directory name of the channel inside the Editing Folder.
    pub channel_folder: String,
    /// Directory name of the video inside the channel folder.
    pub video_folder: String,
    pub editing_folder: PathBuf,
    /// Absolute path of the video folder.
    pub path: PathBuf,
    /// Effective type by `model::resolve_video_type`: the override, else the channel's setting
    /// when it is not `auto`, else the detected type, else `Long`.
    pub video_type: VideoType,
    /// B-roll folder name by the rule of SPEC section 2 (`Broll` when none matches).
    pub broll_folder: String,
    /// File name of the main A-roll (SPEC section 8), when there is one.
    pub main_aroll: Option<String>,
    /// 90, 180 or 270 when the main A-roll is stored sideways or upside down without a rotation
    /// flag (`VideoView::aroll_rotation`).
    pub aroll_rotation: Option<u32>,
    pub output: VideoOutput,
}

// ---------------------------------------------------------------------------------------------
// Folder rules (SPEC section 2)
// ---------------------------------------------------------------------------------------------

/// Reserved at the Editing Folder root (never a channel).
pub fn is_reserved_root_name(name: &str) -> bool {
    name.starts_with('.') || name.starts_with("CLAUDE_VE")
}

/// Channel asset folders that are never videos (compared ignoring case).
const CHANNEL_ASSET_FOLDERS: [&str; 7] = [
    "Style",
    "sample",
    "samples",
    "images",
    "pictures",
    "host images",
    "host pictures",
];

/// Reserved inside a channel folder (never a video).
pub fn is_reserved_channel_entry(name: &str) -> bool {
    name.starts_with('.')
        || name.starts_with("CLAUDE_VE")
        || CHANNEL_ASSET_FOLDERS
            .iter()
            .any(|n| name.eq_ignore_ascii_case(n))
}

/// True for `b-roll`, `B_Rolls`, `broll`, `B Roll` and so on: `^b[-_ ]?rolls?$`, ignoring case.
pub fn is_broll_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix('b') else {
        return false;
    };
    let rest = rest.strip_prefix(['-', '_', ' ']).unwrap_or(rest);
    matches!(rest, "roll" | "rolls")
}

/// The b-roll folder of a video: the first matching subfolder in natural name order, else
/// `Broll`.
pub fn broll_folder(subfolders: &[String]) -> String {
    let mut matching: Vec<&String> = subfolders.iter().filter(|n| is_broll_name(n)).collect();
    matching.sort_by(|a, b| natural_cmp(a, b));
    matching
        .first()
        .map_or_else(|| "Broll".to_owned(), |n| (*n).clone())
}

/// A single plain path component (no separators, not `.` or `..`, not empty).
fn is_plain_component(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

/// Natural order: digit runs compare by value (`2` before `10`), other text case-insensitively,
/// with the raw string as the final tie-break so the order is total.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a, b);
    loop {
        match (x.is_empty(), y.is_empty()) {
            (true, true) => return a.cmp(b),
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            _ => {}
        }
        let (cx, rx) = split_chunk(x);
        let (cy, ry) = split_chunk(y);
        let order = match (is_digit_chunk(cx), is_digit_chunk(cy)) {
            (true, true) => {
                let (tx, ty) = (cx.trim_start_matches('0'), cy.trim_start_matches('0'));
                tx.len().cmp(&ty.len()).then_with(|| tx.cmp(ty))
            }
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => cx.to_lowercase().cmp(&cy.to_lowercase()),
        };
        if order != Ordering::Equal {
            return order;
        }
        (x, y) = (rx, ry);
    }
}

fn is_digit_chunk(s: &str) -> bool {
    s.as_bytes().first().is_some_and(u8::is_ascii_digit)
}

/// Splits off the leading run of ASCII digits, or of everything else.
fn split_chunk(s: &str) -> (&str, &str) {
    let digits = is_digit_chunk(s);
    let end = s
        .char_indices()
        .find(|(_, c)| c.is_ascii_digit() != digits)
        .map_or(s.len(), |(i, _)| i);
    s.split_at(end)
}

// ---------------------------------------------------------------------------------------------
// Directory reading helpers
// ---------------------------------------------------------------------------------------------

/// One directory entry with symlinks resolved. Entries whose names are not valid UTF-8 are
/// skipped (macOS file names always are).
struct Entry {
    name: String,
    path: PathBuf,
    meta: fs::Metadata,
}

fn read_entries(dir: &Path) -> Vec<Entry> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    read.filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let path = entry.path();
            let file_type = entry.file_type().ok()?;
            // `DirEntry::metadata` does not follow symlinks; only pay for a second stat then.
            let meta = if file_type.is_symlink() {
                fs::metadata(&path).ok()?
            } else {
                entry.metadata().ok()?
            };
            Some(Entry { name, path, meta })
        })
        .collect()
}

/// Names of the subfolders of `dir` that pass `keep`, in natural order.
fn subfolder_names(dir: &Path, keep: impl Fn(&str) -> bool) -> Vec<String> {
    let mut names: Vec<String> = read_entries(dir)
        .into_iter()
        .filter(|e| e.meta.is_dir() && keep(&e.name))
        .map(|e| e.name)
        .collect();
    names.sort_by(|a, b| natural_cmp(a, b));
    names
}

/// What the top level of one video folder holds.
struct VideoDir {
    aroll: Vec<ArollFile>,
    subfolders: Vec<String>,
}

fn read_video_dir(dir: &Path) -> VideoDir {
    let mut aroll = Vec::new();
    let mut subfolders = Vec::new();
    for entry in read_entries(dir) {
        if entry.name.starts_with('.') {
            continue;
        }
        if entry.meta.is_dir() {
            subfolders.push(entry.name);
        } else if entry.meta.is_file() && media::is_aroll_name(&entry.name) {
            aroll.push(ArollFile::new(entry.path, &entry.meta));
        }
    }
    VideoDir { aroll, subfolders }
}

fn iso_time(time: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Birth time of a folder, else its modified time (not every file system keeps a birth time).
fn folder_created(path: &Path) -> SystemTime {
    let meta = fs::metadata(path).ok();
    meta.as_ref()
        .and_then(|m| m.created().or_else(|_| m.modified()).ok())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------------------------
// Output detection
// ---------------------------------------------------------------------------------------------

fn extension_lower(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
}

/// True when the first 4 KB of the file contain `<xmeml` (Premiere / FCP7 XML).
fn is_xmeml(path: &Path) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut head = Vec::with_capacity(XMEML_SNIFF_BYTES);
    if file
        .take(XMEML_SNIFF_BYTES as u64)
        .read_to_end(&mut head)
        .is_err()
    {
        return false;
    }
    head.windows(6).any(|w| w == b"<xmeml")
}

/// Classification of one entry of the output folder.
enum OutputKind {
    Review(ReviewSoftware),
    Final,
    Thumbnail,
    Meta,
}

fn classify_output(entry: &Entry) -> Option<OutputKind> {
    if entry.name.starts_with('.') {
        return None;
    }
    let ext = extension_lower(&entry.name);
    let ext = ext.as_deref();
    if entry.meta.is_dir() {
        return (ext == Some("fcpxmld")).then_some(OutputKind::Review(ReviewSoftware::Fcp));
    }
    if !entry.meta.is_file() {
        return None;
    }
    match ext {
        Some("fcpxml") => Some(OutputKind::Review(ReviewSoftware::Fcp)),
        Some("prproj") => Some(OutputKind::Review(ReviewSoftware::Premiere)),
        Some("xml") if is_xmeml(&entry.path) => Some(OutputKind::Review(ReviewSoftware::Premiere)),
        Some("mp4" | "mov" | "m4v") => Some(OutputKind::Final),
        Some("png" | "jpg" | "jpeg")
            if entry.name.to_ascii_lowercase().starts_with("thumbnail-") =>
        {
            Some(OutputKind::Thumbnail)
        }
        _ if entry.name.eq_ignore_ascii_case("meta.txt") => Some(OutputKind::Meta),
        _ => None,
    }
}

/// Modification time of an output entry. A `.fcpxmld` bundle counts as modified when its
/// `Info.fcpxml` is, because rewriting a file inside a folder does not touch the folder.
fn output_modified(entry: &Entry) -> SystemTime {
    let own = entry.meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    if entry.meta.is_dir() {
        let inner = fs::metadata(entry.path.join("Info.fcpxml"))
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        own.max(inner)
    } else {
        own
    }
}

/// Newest first; equal times in natural name order.
fn sort_newest_first(files: &mut [(SystemTime, OutputFile)]) {
    files.sort_by(|(ta, a), (tb, b)| tb.cmp(ta).then_with(|| natural_cmp(&a.name, &b.name)));
}

/// The current content of `<video_dir>/output` plus `<video_dir>/info.txt` (SPEC section 2).
/// Never fails: a missing or unreadable folder is an empty output.
pub fn scan_output(video_dir: &Path) -> VideoOutput {
    let dir = video_dir.join(OUTPUT_DIR);
    let info = video_dir.join("info.txt");
    let mut review = Vec::new();
    let mut finals = Vec::new();
    let mut thumbnails = Vec::new();
    let mut meta_file = None;
    for entry in read_entries(&dir) {
        let Some(kind) = classify_output(&entry) else {
            continue;
        };
        let file = |software| {
            let modified = output_modified(&entry);
            let file = OutputFile {
                path: path_string(&entry.path),
                name: entry.name.clone(),
                modified_at: iso_time(modified),
                software,
            };
            (modified, file)
        };
        match kind {
            OutputKind::Review(software) => review.push(file(Some(software))),
            OutputKind::Final => finals.push(file(None)),
            OutputKind::Thumbnail => thumbnails.push((entry.name, path_string(&entry.path))),
            OutputKind::Meta => meta_file = Some(path_string(&entry.path)),
        }
    }
    sort_newest_first(&mut review);
    sort_newest_first(&mut finals);
    thumbnails.sort_by(|(a, _), (b, _)| natural_cmp(a, b));
    VideoOutput {
        dir: path_string(&dir),
        review_files: review.into_iter().map(|(_, f)| f).collect(),
        final_files: finals.into_iter().map(|(_, f)| f).collect(),
        thumbnails: thumbnails.into_iter().map(|(_, p)| p).collect(),
        meta_file,
        info_file: info.is_file().then(|| path_string(&info)),
    }
}

// ---------------------------------------------------------------------------------------------
// Library scan
// ---------------------------------------------------------------------------------------------

/// Builds the view of one video folder. A new type detection (cache miss) is pushed to
/// `detections` so the caller can save all of them in one write.
fn build_video_view(
    channel: &Channel,
    folder_name: &str,
    path: &Path,
    state: &VideoState,
    slot_free: bool,
    detections: &mut Vec<(String, TypeDetection)>,
) -> VideoView {
    let id = video_id(&channel.id, folder_name);
    let dir = read_video_dir(path);
    let main = media::main_aroll(&dir.aroll);
    let detected = media::detect_with_cache(state.type_detection.as_ref(), main);
    if let Some(entry) = detected.picture_check_pending() {
        media::request_picture_check(&id, entry);
    }
    let detection = detected.detection;
    if let Some(entry) = detected.entry.filter(|_| detected.is_new) {
        detections.push((id.clone(), entry));
    }
    let output = scan_output(path);
    let edited = !output.review_files.is_empty();
    let job = state.latest_job.clone();
    let detected_type = detection.video_type;
    let (video_type, type_source) =
        resolve_video_type(state.type_override, channel.video_type, detected_type);
    VideoView {
        actions: compute_actions(
            job.as_ref().map(|j| j.state),
            edited,
            job.as_ref().is_some_and(|j| j.starts_at.is_some()),
            slot_free,
        ),
        channel_id: channel.id.clone(),
        folder_name: folder_name.to_owned(),
        path: path_string(path),
        created_at: iso_time(folder_created(path)),
        detected_type,
        type_override: state.type_override,
        channel_type: channel.video_type,
        video_type,
        type_source,
        aroll_count: u32::try_from(dir.aroll.len()).unwrap_or(u32::MAX),
        aroll_rotation: detection.rotation,
        edited,
        final_rendered: !output.final_files.is_empty(),
        output,
        job,
        id,
    }
}

/// The folder of `channel` inside `root`, when its name is a usable folder name.
fn channel_dir(root: &Path, channel: &Channel) -> Option<PathBuf> {
    (is_plain_component(&channel.folder_name) && !is_reserved_root_name(&channel.folder_name))
        .then(|| root.join(&channel.folder_name))
}

fn scan_channel(
    root: Option<&Path>,
    channel: &Channel,
    states: &BTreeMap<String, VideoState>,
    archived: &std::collections::BTreeSet<String>,
    slot_free: bool,
    detections: &mut Vec<(String, TypeDetection)>,
) -> ChannelView {
    let dir = root
        .and_then(|root| channel_dir(root, channel))
        .filter(|d| d.is_dir());
    let videos = dir.as_deref().map_or_else(Vec::new, |dir| {
        let mut names = subfolder_names(dir, |n| !is_reserved_channel_entry(n));
        // Newest first: natural sort, descending.
        names.reverse();
        names
            .iter()
            .filter(|name| !archived.contains(&video_id(&channel.id, name)))
            .map(|name| {
                let state = states
                    .get(&video_id(&channel.id, name))
                    .cloned()
                    .unwrap_or_default();
                build_video_view(
                    channel,
                    name,
                    &dir.join(name),
                    &state,
                    slot_free,
                    detections,
                )
            })
            .collect()
    });
    ChannelView {
        id: channel.id.clone(),
        folder_name: channel.folder_name.clone(),
        exists: dir.is_some(),
        videos,
    }
}

/// Scans the Editing Folder into a `Library` (blocking). Type detections that were not cached
/// yet are detected and saved to the store in one write.
pub fn scan_library(store: &Store) -> Library {
    let settings = store.settings();
    let (states, jobs, archived) = store.with_state(|s| {
        let jobs: Vec<JobState> = s
            .videos
            .values()
            .filter_map(|v| v.latest_job.as_ref().map(|j| j.state))
            .collect();
        let archived: std::collections::BTreeSet<String> = s.archived.keys().cloned().collect();
        (s.videos.clone(), jobs, archived)
    });
    let root = settings
        .editing_folder
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir());

    let mut detections = Vec::new();
    let free = slot_free(settings.max_concurrent_edits, jobs.iter().copied());
    let channels = settings
        .channels
        .iter()
        .map(|channel| {
            scan_channel(
                root.as_deref(),
                channel,
                &states,
                &archived,
                free,
                &mut detections,
            )
        })
        .collect();
    media::save_detections(store, detections);

    let discovered_folders = root.as_deref().map_or_else(Vec::new, |root| {
        subfolder_names(root, |name| {
            !is_reserved_root_name(name) && !settings.channels.iter().any(|c| c.folder_name == name)
        })
    });
    let count = |pred: fn(JobState) -> bool| {
        u32::try_from(jobs.iter().filter(|s| pred(**s)).count()).unwrap_or(u32::MAX)
    };
    Library {
        editing_folder: settings.editing_folder.clone(),
        editing_folder_exists: root.is_some(),
        channels,
        discovered_folders,
        running: count(JobState::holds_slot),
        queued: count(|s| s == JobState::Queued),
    }
}

/// A video id resolved against the settings and the disk.
struct Located {
    editing_folder: PathBuf,
    channel: Channel,
    folder: String,
    path: PathBuf,
}

fn locate_video(store: &Store, video_id: &str) -> AppResult<Located> {
    let settings = store.settings();
    let editing_folder = settings
        .editing_folder
        .map(PathBuf::from)
        .ok_or_else(AppError::no_editing_folder)?;
    let unknown = || AppError::not_found(format!("Unknown video: {video_id}"));
    let (channel_id, folder) = video_id.split_once('/').ok_or_else(unknown)?;
    let channel = settings
        .channels
        .into_iter()
        .find(|c| c.id == channel_id)
        .ok_or_else(|| AppError::not_found("This channel is no longer in VidAI."))?;
    if !is_plain_component(folder) || is_reserved_channel_entry(folder) {
        return Err(unknown());
    }
    let channel_path = channel_dir(&editing_folder, &channel).ok_or_else(unknown)?;
    let path = channel_path.join(folder);
    if !path.is_dir() {
        return Err(AppError::not_found(format!(
            "The video folder {} was not found.",
            path.display()
        )));
    }
    Ok(Located {
        editing_folder,
        channel,
        folder: folder.to_owned(),
        path,
    })
}

/// The current folder of a video id; `notFound` when it is gone (errors like [`resolve_video`]).
pub fn video_path(store: &Store, video_id: &str) -> AppResult<PathBuf> {
    locate_video(store, video_id).map(|l| l.path)
}

/// Resolves a video id (`<channelId>/<folderName>`) against the settings and the disk.
///
/// Errors: `noEditingFolder`, `notFound` (unknown channel, or the video folder is gone).
pub fn resolve_video(store: &Store, video_id: &str) -> AppResult<VideoContext> {
    let located = locate_video(store, video_id)?;
    let dir = read_video_dir(&located.path);
    let main = media::main_aroll(&dir.aroll);
    // Blocking: a pending picture check runs now, so a job starts with the final type.
    let detection = media::detect_video_type(store, video_id, main);
    let type_override = store.video(video_id).type_override;
    let (video_type, _) = resolve_video_type(
        type_override,
        located.channel.video_type,
        detection.video_type,
    );
    Ok(VideoContext {
        video_id: video_id.to_owned(),
        channel_id: located.channel.id,
        channel_folder: located.channel.folder_name,
        video_folder: located.folder,
        editing_folder: located.editing_folder,
        video_type,
        broll_folder: broll_folder(&dir.subfolders),
        main_aroll: main
            .and_then(|m| m.path.file_name())
            .map(|n| n.to_string_lossy().into_owned()),
        aroll_rotation: detection.rotation,
        output: scan_output(&located.path),
        path: located.path,
    })
}

/// The current view of one video (blocking). Errors like [`resolve_video`].
pub fn video_view(store: &Store, video_id: &str) -> AppResult<VideoView> {
    let located = locate_video(store, video_id)?;
    let state = store.video(video_id);
    let max = store.settings().max_concurrent_edits;
    let free = store.with_state(|s| {
        slot_free(
            max,
            s.videos
                .values()
                .filter_map(|v| v.latest_job.as_ref().map(|j| j.state)),
        )
    });
    let mut detections = Vec::new();
    let view = build_video_view(
        &located.channel,
        &located.folder,
        &located.path,
        &state,
        free,
        &mut detections,
    );
    media::save_detections(store, detections);
    Ok(view)
}

// ---------------------------------------------------------------------------------------------
// Freshness: the rescan thread
// ---------------------------------------------------------------------------------------------

/// Shared state of the rescan loop. Managed as Tauri state by [`setup`].
#[derive(Default)]
pub struct Rescanner {
    /// A rescan was requested and has not started yet (requests coalesce).
    pending: Mutex<bool>,
    wake: Condvar,
    /// The library the UI last got, through an event or `get_library`.
    last: Mutex<Option<Library>>,
}

impl Rescanner {
    fn request(&self) {
        *self.pending.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.wake.notify_one();
    }

    /// Waits until a rescan is requested or `timeout` passes. Returns whether one was requested.
    fn wait(&self, timeout: Duration) -> bool {
        let pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        let (mut pending, _) = self
            .wake
            .wait_timeout_while(pending, timeout, |p| !*p)
            .unwrap_or_else(PoisonError::into_inner);
        std::mem::take(&mut *pending)
    }

    /// Records `library` as the latest one and returns whether it differs from the previous one,
    /// that is whether `library-changed` must be emitted.
    pub fn publish(&self, library: &Library) -> bool {
        let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
        if last.as_ref() == Some(library) {
            return false;
        }
        *last = Some(library.clone());
        true
    }
}

/// True when any window is visible and not minimized (also false when the app is hidden).
fn window_visible(app: &AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(true))
}

fn rescan_loop(app: &AppHandle) {
    let rescanner = app.state::<Rescanner>();
    loop {
        let requested = rescanner.wait(RESCAN_INTERVAL);
        if !requested && !window_visible(app) {
            continue;
        }
        let Some(store) = app.try_state::<Store>() else {
            continue;
        };
        let library = scan_library(&store);
        if rescanner.publish(&library)
            && let Err(err) = LibraryChanged.emit(app)
        {
            eprintln!("vidai: could not emit library-changed: {err}");
        }
    }
}

/// Scans for the UI (`get_library`, blocking) and records the result, so the rescan loop does not
/// announce a change the UI already has.
pub fn library_for_ui(app: &AppHandle) -> AppResult<Library> {
    let store = app
        .try_state::<Store>()
        .ok_or_else(|| AppError::internal("The store is not ready yet."))?;
    let library = scan_library(&store);
    if let Some(rescanner) = app.try_state::<Rescanner>() {
        rescanner.publish(&library);
    }
    Ok(library)
}

/// Asks for a rescan as soon as possible (coalesced). Emits `events::LibraryChanged` when the
/// library differs from the last one sent. Called by `jobs` after every job state change and by
/// the settings commands after channel or Editing Folder changes. Never blocks.
pub fn request_rescan(app: &AppHandle) {
    if let Some(rescanner) = app.try_state::<Rescanner>() {
        rescanner.request();
    }
}

/// Startup hook: starts the rescan thread and the background picture checks of the type
/// detection (each finished check is saved and triggers a rescan).
pub fn setup(app: &AppHandle) -> AppResult<()> {
    app.manage(Rescanner::default());
    let checks_app = app.clone();
    media::pictures::start(Box::new(move |video_id, entry| {
        if let Some(store) = checks_app.try_state::<Store>() {
            media::save_picture_result(&store, video_id, entry);
        }
        request_rescan(&checks_app);
    }));
    let handle = app.clone();
    std::thread::Builder::new()
        .name("vidai-rescan".into())
        .spawn(move || rescan_loop(&handle))
        .map_err(|e| AppError::internal(format!("Could not start the library rescan: {e}")))?;
    Ok(())
}

/// Window event hook: rescans when a window gains focus.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::Focused(true) = event {
        request_rescan(window.app_handle());
    }
}

/// Whether one of the `maxConcurrentEdits` slots is free, given the states of all latest jobs.
fn slot_free(max_concurrent_edits: u32, states: impl IntoIterator<Item = JobState>) -> bool {
    let holding = states.into_iter().filter(|s| s.holds_slot()).count();
    crate::jobs::queue::free_slots(max_concurrent_edits, holding) > 0
}

/// Which actions a video offers (SPEC section 6, "Which actions a video offers").
///
/// `job_state` is the state of the latest job, if any; `edited` is whether a review
/// project exists in its `output` folder; `held_by_delay` is whether that job waits for the start
/// delay (`JobView.startsAt` is set); `slot_free` is whether a `maxConcurrentEdits` slot is free.
///
/// `archive` is offered for edited videos and for failed edits with no active job: it removes
/// the video from the main list (the Archive page keeps it).
pub fn compute_actions(
    job_state: Option<JobState>,
    edited: bool,
    held_by_delay: bool,
    slot_free: bool,
) -> Vec<VideoAction> {
    use VideoAction::*;
    let mut actions = match job_state {
        Some(JobState::Queued) if held_by_delay && slot_free => vec![StartNow, Stop],
        Some(JobState::Queued) => vec![Stop],
        Some(JobState::Running) => vec![Pause, Stop],
        Some(JobState::Pausing | JobState::Stopping) => vec![],
        Some(JobState::Paused) => vec![Continue, Stop],
        Some(JobState::Failed) if edited => vec![Continue, ReEdit, RenderFinal],
        Some(JobState::Failed) => vec![Continue, Start],
        Some(JobState::Stopped | JobState::Completed) | None if edited => vec![ReEdit, RenderFinal],
        Some(JobState::Stopped | JobState::Completed) | None => vec![Start],
    };
    let active = job_state.is_some_and(|s| s.is_active());
    if !active && (edited || job_state == Some(JobState::Failed)) {
        actions.push(Archive);
    }
    actions
}

#[cfg(test)]
mod tests {
    use super::*;
    use JobState::*;
    use VideoAction::*;

    #[test]
    fn action_rules_match_spec_table() {
        let cases: &[(Option<JobState>, bool, &[VideoAction])] = &[
            (Some(Queued), false, &[Stop]),
            (Some(Queued), true, &[Stop]),
            (Some(Running), false, &[Pause, Stop]),
            (Some(Running), true, &[Pause, Stop]),
            (Some(Pausing), false, &[]),
            (Some(Stopping), true, &[]),
            (Some(Paused), false, &[Continue, Stop]),
            (Some(Paused), true, &[Continue, Stop]),
            (Some(Failed), false, &[Continue, Start, Archive]),
            (
                Some(Failed),
                true,
                &[Continue, ReEdit, RenderFinal, Archive],
            ),
            (None, false, &[Start]),
            (Some(Stopped), false, &[Start]),
            (Some(Completed), false, &[Start]),
            (None, true, &[ReEdit, RenderFinal, Archive]),
            (Some(Stopped), true, &[ReEdit, RenderFinal, Archive]),
            (Some(Completed), true, &[ReEdit, RenderFinal, Archive]),
        ];
        for (state, edited, expected) in cases {
            // The start delay facts change nothing outside of a queued job held by the delay
            // with a free slot.
            for (held, free) in [(false, false), (false, true), (true, false), (true, true)] {
                if *state == Some(Queued) && held && free {
                    continue;
                }
                assert_eq!(
                    compute_actions(*state, *edited, held, free),
                    expected.to_vec(),
                    "state {state:?}, edited {edited}, held {held}, free {free}"
                );
            }
        }
    }

    #[test]
    fn start_now_only_for_a_queued_job_held_by_the_delay_with_a_free_slot() {
        for edited in [false, true] {
            assert_eq!(
                compute_actions(Some(Queued), edited, true, true),
                [StartNow, Stop]
            );
            assert_eq!(compute_actions(Some(Queued), edited, true, false), [Stop]);
            assert_eq!(compute_actions(Some(Queued), edited, false, true), [Stop]);
        }
        assert!(slot_free(2, [Running, Queued, Paused]));
        assert!(!slot_free(2, [Running, Stopping, Queued]));
        assert!(!slot_free(1, [Pausing]));
        assert!(slot_free(1, [Completed, Failed, Stopped]));
    }

    // ----- helpers -----

    use crate::model::{
        ChannelProfile, ChannelVideoType, JobKind, JobView, ToolkitKind, TypeSource,
    };

    struct Fixture {
        /// Holds the temp folders alive.
        _tmp: tempfile::TempDir,
        root: PathBuf,
        store: Store,
    }

    impl Fixture {
        /// An Editing Folder with the given channels configured (ids `ch-<folder>`).
        fn new(channels: &[&str]) -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path().join("Editing Folder");
            fs::create_dir(&root).unwrap();
            let store = Store::open(tmp.path().join("data")).unwrap();
            let folder = path_string(&root);
            let channels: Vec<Channel> = channels
                .iter()
                .map(|name| Channel {
                    id: format!("ch-{name}"),
                    folder_name: (*name).to_owned(),
                    video_type: ChannelVideoType::Auto,
                    long: ChannelProfile::default(),
                    short: ChannelProfile::default(),
                })
                .collect();
            store
                .update_settings(|s| {
                    s.editing_folder = Some(folder);
                    s.channels = channels;
                    Ok(())
                })
                .unwrap();
            Self {
                _tmp: tmp,
                root,
                store,
            }
        }

        fn dir(&self, rel: &str) -> PathBuf {
            let path = self.root.join(rel);
            fs::create_dir_all(&path).unwrap();
            path
        }

        fn file(&self, rel: &str, contents: &[u8]) -> PathBuf {
            let path = self.root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, contents).unwrap();
            path
        }

        fn fixture(&self, name: &str, rel: &str) -> PathBuf {
            let path = self.root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let src = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/media")
                .join(name);
            fs::copy(src, &path).unwrap();
            path
        }

        fn scan(&self) -> Library {
            scan_library(&self.store)
        }
    }

    fn set_mtime(path: &Path, secs_after_epoch: u64) {
        let time = SystemTime::UNIX_EPOCH + Duration::from_secs(secs_after_epoch);
        // A read-only handle is enough for the owner, and also works for directories.
        #[cfg(not(windows))]
        fs::File::open(path).unwrap().set_modified(time).unwrap();
        // Windows: the handle needs the right to write attributes, and folders need backup
        // semantics to be opened at all.
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_WRITE_ATTRIBUTES: u32 = 0x100;
            const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
            fs::OpenOptions::new()
                .access_mode(FILE_WRITE_ATTRIBUTES)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(path)
                .unwrap()
                .set_modified(time)
                .unwrap();
        }
    }

    fn job(video_id: &str, state: JobState) -> JobView {
        JobView {
            id: format!("job-{}", video_id.replace('/', "-")),
            video_id: video_id.to_owned(),
            kind: JobKind::Edit,
            state,
            session_id: None,
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

    fn names(videos: &[VideoView]) -> Vec<&str> {
        videos.iter().map(|v| v.folder_name.as_str()).collect()
    }

    // ----- folder rules -----

    #[test]
    fn reserved_names() {
        for name in [
            ".git",
            ".DS_Store",
            "CLAUDE_VE_ALL",
            "CLAUDE_VE_ALL_OWN",
            "CLAUDE_VE",
        ] {
            assert!(is_reserved_root_name(name), "{name}");
        }
        for name in ["Kudrat Care", "Style", "claude_ve_all"] {
            assert!(!is_reserved_root_name(name), "{name}");
        }
        for name in [
            ".hidden",
            "Style",
            "style",
            "STYLE",
            "CLAUDE_VE",
            "CLAUDE_VE_x",
            "sample",
            "Samples",
            "images",
            "Pictures",
            "host images",
            "Host Pictures",
        ] {
            assert!(is_reserved_channel_entry(name), "{name}");
        }
        for name in [
            "Styles",
            "001 My Style",
            "019 Hair Growth Mask",
            "002 Images",
            "hostimages",
        ] {
            assert!(!is_reserved_channel_entry(name), "{name}");
        }
    }

    #[test]
    fn broll_rule() {
        for name in ["Broll", "b-roll", "B_Rolls", "B Roll", "BROLLS", "brolls"] {
            assert!(is_broll_name(name), "{name}");
        }
        for name in [
            "b--roll", "Brolled", "my broll", "roll", "b.roll", "B-Roll 2",
        ] {
            assert!(!is_broll_name(name), "{name}");
        }
        let subs = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(broll_folder(&subs(&["output", "CLAUDE_VE"])), "Broll");
        assert_eq!(
            broll_folder(&subs(&["output", "B_Rolls", "b-roll"])),
            "b-roll"
        );
        assert_eq!(broll_folder(&subs(&["B Roll"])), "B Roll");
    }

    #[test]
    fn natural_order() {
        let mut v = vec![
            "010 Ten",
            "2 Two",
            "019 Hair Growth Mask - Curd Hair Mask",
            "001 One",
            "020 बालों के लिए दही",
            "abc",
            "ABD",
            "02 Two",
        ];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            v,
            [
                "001 One",
                "02 Two",
                "2 Two",
                "010 Ten",
                "019 Hair Growth Mask - Curd Hair Mask",
                "020 बालों के लिए दही",
                "abc",
                "ABD",
            ]
        );
        assert_eq!(natural_cmp("file9", "file10"), Ordering::Less);
        assert_eq!(natural_cmp("a", "a"), Ordering::Equal);
        assert_ne!(natural_cmp("A", "a"), Ordering::Equal);
    }

    // ----- library scan -----

    #[test]
    fn scans_channels_videos_and_discovered_folders() {
        let fx = Fixture::new(&["Kudrat Care", "Gone Channel"]);
        fx.dir("Kudrat Care/Style");
        fx.dir("Kudrat Care/.cache");
        fx.dir("Kudrat Care/CLAUDE_VE_tmp");
        fx.file("Kudrat Care/notes.txt", b"not a video");
        fx.dir("Kudrat Care/2 Second");
        fx.dir("Kudrat Care/10 Tenth");
        fx.dir("Kudrat Care/019 Hair Growth Mask - Curd Hair Mask");
        fx.dir("Kudrat Care/021 बालों के लिए दही");
        fx.dir("My Motor Talk");
        fx.dir("House of Tech Hindi");
        fx.dir("CLAUDE_VE_ALL");
        fx.dir(".git");
        fx.file("CLAUDE.md", b"notes");

        let lib = fx.scan();
        assert!(lib.editing_folder_exists);
        assert_eq!(lib.editing_folder.as_deref(), Some(&*path_string(&fx.root)));
        assert_eq!(
            lib.discovered_folders,
            ["House of Tech Hindi", "My Motor Talk"]
        );
        assert_eq!(lib.channels.len(), 2);

        let kudrat = &lib.channels[0];
        assert!(kudrat.exists);
        assert_eq!(kudrat.id, "ch-Kudrat Care");
        assert_eq!(
            names(&kudrat.videos),
            [
                "021 बालों के लिए दही",
                "019 Hair Growth Mask - Curd Hair Mask",
                "10 Tenth",
                "2 Second",
            ]
        );
        let video = &kudrat.videos[1];
        assert_eq!(
            video.id,
            "ch-Kudrat Care/019 Hair Growth Mask - Curd Hair Mask"
        );
        assert_eq!(video.channel_id, "ch-Kudrat Care");
        assert_eq!(
            video.path,
            path_string(
                &fx.root
                    .join("Kudrat Care")
                    .join("019 Hair Growth Mask - Curd Hair Mask")
            )
        );

        let gone = &lib.channels[1];
        assert!(!gone.exists);
        assert!(gone.videos.is_empty());
        assert_eq!((lib.running, lib.queued), (0, 0));
    }

    #[test]
    fn missing_or_unset_editing_folder() {
        let fx = Fixture::new(&["A"]);
        fs::remove_dir(&fx.root).unwrap();
        let lib = fx.scan();
        assert!(!lib.editing_folder_exists);
        assert!(lib.editing_folder.is_some());
        assert_eq!(lib.channels.len(), 1);
        assert!(!lib.channels[0].exists);
        assert!(lib.discovered_folders.is_empty());

        fx.store
            .update_settings(|s| {
                s.editing_folder = None;
                Ok(())
            })
            .unwrap();
        let lib = fx.scan();
        assert_eq!(lib.editing_folder, None);
        assert!(!lib.editing_folder_exists);
    }

    #[test]
    fn aroll_count_and_detected_type() {
        let fx = Fixture::new(&["C"]);
        // The largest A-roll decides: a big sideways MOV beats a small landscape MP4.
        fx.fixture("landscape.mp4", "C/001 Rotated/small.mp4");
        let big = fx.fixture("rotated-90.mov", "C/001 Rotated/DSC_0001.MOV");
        let mut padded = fs::read(&big).unwrap();
        padded.extend_from_slice(&[0; 4096]);
        fs::write(&big, padded).unwrap();
        fx.file("C/001 Rotated/._DSC_0001.MOV", &[0; 10_000]);
        fx.file("C/001 Rotated/voice.wav", b"x");
        fx.dir("C/001 Rotated/folder.mp4");
        fx.fixture("landscape.mp4", "C/001 Rotated/Broll/broll.mp4");
        fx.fixture("landscape.mp4", "C/001 Rotated/CLAUDE_VE/render.mp4");

        fx.fixture("landscape-with-audio.mov", "C/002 Long/a.mov");
        fx.fixture("portrait.mkv", "C/003 Mkv/a.mkv");
        fx.dir("C/004 Empty");
        fx.file("C/005 Junk/a.mp4", b"not a movie at all");

        let lib = fx.scan();
        let video = |name: &str| {
            lib.channels[0]
                .videos
                .iter()
                .find(|v| v.folder_name == name)
                .unwrap()
                .clone()
        };
        let rotated = video("001 Rotated");
        assert_eq!(rotated.aroll_count, 2);
        assert_eq!(rotated.detected_type, Some(VideoType::Short));
        assert_eq!(rotated.video_type, VideoType::Short);
        assert_eq!(rotated.type_override, None);
        assert_eq!(rotated.channel_type, ChannelVideoType::Auto);
        assert_eq!(rotated.type_source, TypeSource::Detected);

        let long = video("002 Long");
        assert_eq!(
            (long.aroll_count, long.detected_type),
            (1, Some(VideoType::Long))
        );

        // Matroska needs ffprobe; without it the type is unknown and assumed Long.
        let mkv = video("003 Mkv");
        assert_eq!(mkv.aroll_count, 1);
        assert!(matches!(mkv.detected_type, None | Some(VideoType::Short)));

        let empty = video("004 Empty");
        assert_eq!((empty.aroll_count, empty.detected_type), (0, None));
        assert!(chrono::DateTime::parse_from_rfc3339(&empty.created_at).is_ok());
        assert_eq!(empty.video_type, VideoType::Long);
        assert_eq!(empty.type_source, TypeSource::Assumed);

        let junk = video("005 Junk");
        assert_eq!(
            (junk.detected_type, junk.video_type),
            (None, VideoType::Long)
        );

        // Detections are cached in the store.
        let cached = fx
            .store
            .video(&rotated.id)
            .type_detection
            .expect("cached detection");
        assert_eq!(cached.detected, Some(VideoType::Short));
        assert!(cached.path.ends_with("DSC_0001.MOV"));
    }

    #[test]
    fn type_override_wins() {
        let fx = Fixture::new(&["C"]);
        fx.fixture("portrait-faststart.mp4", "C/001 V/a.mp4");
        let id = "ch-C/001 V";
        fx.store
            .update_video(id, |v| {
                v.type_override = Some(VideoType::Long);
                Ok(())
            })
            .unwrap();
        let view = video_view(&fx.store, id).unwrap();
        assert_eq!(view.detected_type, Some(VideoType::Short));
        assert_eq!(view.type_override, Some(VideoType::Long));
        assert_eq!(view.video_type, VideoType::Long);
        assert_eq!(view.type_source, TypeSource::Override);
        assert_eq!(
            resolve_video(&fx.store, id).unwrap().video_type,
            VideoType::Long
        );
    }

    #[test]
    fn picture_check_results_reach_the_view_and_the_job_context() {
        let fx = Fixture::new(&["C"]);
        fx.fixture("landscape.mp4", "C/001 Sideways/DSC_2078.MOV");
        fx.fixture("portrait-faststart.mp4", "C/001 Sideways/small.mp4");
        let id = "ch-C/001 Sideways";

        // The metadata says landscape; the scan reports that until the picture check ran.
        let view = video_view(&fx.store, id).unwrap();
        assert_eq!(view.detected_type, Some(VideoType::Long));
        assert_eq!(view.aroll_rotation, None);
        let metadata = fx.store.video(id).type_detection.unwrap();
        assert!(media::picture_check_pending(&metadata));

        // A background check found the picture sideways (the fixture has no face, so the
        // result is saved the way the worker saves it).
        media::save_picture_result(
            &fx.store,
            id,
            media::with_picture(&metadata, crate::orientation::Rotation::Cw270),
        );
        let lib = fx.scan();
        let view = &lib.channels[0].videos[0];
        assert_eq!(view.detected_type, Some(VideoType::Short));
        assert_eq!(view.video_type, VideoType::Short);
        assert_eq!(view.type_source, TypeSource::Detected);
        assert_eq!(view.aroll_rotation, Some(270));
        let ctx = resolve_video(&fx.store, id).unwrap();
        assert_eq!(ctx.video_type, VideoType::Short);
        assert_eq!(ctx.main_aroll.as_deref(), Some("DSC_2078.MOV"));
        assert_eq!(ctx.aroll_rotation, Some(270));

        // An entry written by the previous detector (no picture check) is detected again.
        fx.store
            .update_video(id, |v| {
                let entry = v.type_detection.as_mut().unwrap();
                entry.detector = 0;
                entry.picture_rotation = None;
                entry.detected = Some(VideoType::Short);
                Ok(())
            })
            .unwrap();
        let view = video_view(&fx.store, id).unwrap();
        assert_eq!(view.detected_type, Some(VideoType::Long));
        let entry = fx.store.video(id).type_detection.unwrap();
        assert_eq!(entry.detector, media::DETECTOR_VERSION);
        assert!(entry.path.ends_with("DSC_2078.MOV"));

        // A job start runs the pending check right away. With the helper (macOS) it sees no
        // face in the fixture, so the metadata stands and the check is cached as done.
        let ctx = resolve_video(&fx.store, id).unwrap();
        assert_eq!(ctx.video_type, VideoType::Long);
        assert_eq!(ctx.aroll_rotation, None);
        let entry = fx.store.video(id).type_detection.unwrap();
        assert_eq!(
            entry.picture_rotation,
            crate::orientation::available().then_some(0)
        );
    }

    fn set_channel_type(fx: &Fixture, video_type: ChannelVideoType) {
        fx.store
            .update_settings(|s| {
                s.channels[0].video_type = video_type;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn channel_type_beats_detection_but_not_the_override() {
        let fx = Fixture::new(&["Nikon"]);
        // A sideways recording without rotation metadata reads as landscape.
        fx.fixture("landscape.mp4", "Nikon/001 Sideways/DSC_0001.MOV");
        fx.dir("Nikon/002 No Aroll");
        let sideways = "ch-Nikon/001 Sideways";
        let empty = "ch-Nikon/002 No Aroll";
        let view_of = |id: &str| video_view(&fx.store, id).unwrap();
        let type_of = |id: &str| resolve_video(&fx.store, id).unwrap().video_type;

        let auto = view_of(sideways);
        assert_eq!(
            (auto.video_type, auto.type_source),
            (VideoType::Long, TypeSource::Detected)
        );

        set_channel_type(&fx, ChannelVideoType::Short);
        for id in [sideways, empty] {
            let view = view_of(id);
            assert_eq!(view.channel_type, ChannelVideoType::Short, "{id}");
            assert_eq!(
                (view.video_type, view.type_source),
                (VideoType::Short, TypeSource::Channel),
                "{id}"
            );
            assert_eq!(type_of(id), VideoType::Short, "{id}");
        }
        // The detected type is still reported as it is.
        assert_eq!(view_of(sideways).detected_type, Some(VideoType::Long));
        assert_eq!(view_of(empty).detected_type, None);
        // The library scan agrees with the single-video view.
        let lib = fx.scan();
        let scanned = lib.channels[0]
            .videos
            .iter()
            .find(|v| v.id == sideways)
            .unwrap();
        assert_eq!(scanned, &view_of(sideways));

        // The video's own override still wins.
        fx.store
            .update_video(sideways, |v| {
                v.type_override = Some(VideoType::Long);
                Ok(())
            })
            .unwrap();
        let view = view_of(sideways);
        assert_eq!(
            (view.video_type, view.type_source),
            (VideoType::Long, TypeSource::Override)
        );
        assert_eq!(type_of(sideways), VideoType::Long);

        // Always Long, and back to Auto.
        set_channel_type(&fx, ChannelVideoType::Long);
        let view = view_of(empty);
        assert_eq!(
            (view.video_type, view.type_source),
            (VideoType::Long, TypeSource::Channel)
        );
        set_channel_type(&fx, ChannelVideoType::Auto);
        let view = view_of(empty);
        assert_eq!(
            (view.video_type, view.type_source),
            (VideoType::Long, TypeSource::Assumed)
        );
    }

    #[test]
    fn jobs_actions_and_counts() {
        let fx = Fixture::new(&["C"]);
        fx.dir("C/001 A");
        fx.dir("C/002 B");
        fx.file("C/003 C/output/project.fcpxml", b"<fcpxml/>");
        fx.dir("C/004 D");
        let set = |id: &str, state| {
            fx.store
                .update_video(id, |v| {
                    v.latest_job = Some(job(id, state));
                    Ok(())
                })
                .unwrap();
        };
        set("ch-C/001 A", JobState::Running);
        set("ch-C/002 B", JobState::Queued);
        set("ch-C/003 C", JobState::Failed);
        // A job of a video that is not on disk still counts for the toolbar.
        set("ch-Other/x", JobState::Stopping);

        let lib = fx.scan();
        assert_eq!((lib.running, lib.queued), (2, 1));
        let videos = &lib.channels[0].videos;
        assert_eq!(names(videos), ["004 D", "003 C", "002 B", "001 A"]);
        assert_eq!(videos[0].job, None);
        assert_eq!(videos[0].actions, [Start]);
        assert!(videos[1].edited);
        assert_eq!(videos[1].job.as_ref().unwrap().state, JobState::Failed);
        assert_eq!(videos[1].actions, [Continue, ReEdit, RenderFinal, Archive]);
        assert_eq!(videos[2].actions, [Stop]);
        assert_eq!(videos[3].actions, [Pause, Stop]);
    }

    #[test]
    fn start_now_follows_the_delay_and_the_free_slots() {
        let fx = Fixture::new(&["C"]);
        fx.dir("C/001 A");
        fx.dir("C/002 B");
        fx.store
            .update_settings(|s| {
                s.max_concurrent_edits = 2;
                Ok(())
            })
            .unwrap();
        let set = |id: &str, j: JobView| {
            fx.store
                .update_video(id, |v| {
                    v.latest_job = Some(j);
                    Ok(())
                })
                .unwrap();
        };
        set("ch-C/001 A", job("ch-C/001 A", JobState::Running));
        let mut held = job("ch-C/002 B", JobState::Queued);
        held.starts_at = Some("2026-01-01T00:10:00.000Z".into());
        set("ch-C/002 B", held);
        let lib = fx.scan();
        assert_eq!(lib.channels[0].videos[0].actions, [StartNow, Stop]);
        assert_eq!(
            video_view(&fx.store, "ch-C/002 B").unwrap().actions,
            [StartNow, Stop]
        );
        // Every slot in use: the delay still holds it, but it cannot start now.
        set("ch-Other/x", job("ch-Other/x", JobState::Pausing));
        assert_eq!(fx.scan().channels[0].videos[0].actions, [Stop]);
        assert_eq!(video_view(&fx.store, "ch-C/002 B").unwrap().actions, [Stop]);
    }

    // ----- output detection -----

    #[test]
    fn output_detection() {
        let fx = Fixture::new(&["C"]);
        let video = fx.dir("C/001 V");
        let out = |name: &str, body: &[u8], mtime: u64| {
            let path = fx.file(&format!("C/001 V/output/{name}"), body);
            set_mtime(&path, mtime);
            path
        };
        out("v1.fcpxml", b"<fcpxml/>", 1_000);
        out("v3.FCPXML", b"<fcpxml/>", 3_000);
        out("premiere.prproj", b"gz", 2_000);
        out(
            "timeline.xml",
            b"<?xml version=\"1.0\"?>\n<!DOCTYPE xmeml>\n<xmeml version=\"5\">",
            4_000,
        );
        out("other.xml", b"<?xml version=\"1.0\"?><plist/>", 5_000);
        out("._v9.fcpxml", b"apple double", 9_000);
        // An .fcpxmld bundle counts as modified when its Info.fcpxml is.
        out("v2.fcpxmld/Info.fcpxml", b"<fcpxml/>", 6_000);
        set_mtime(&video.join("output/v2.fcpxmld"), 500);
        out("final.mp4", b"x", 10);
        out("final 4K.MOV", b"x", 20);
        out("notes.mp3", b"x", 30);
        out("thumbnail-10.png", b"x", 1);
        out("thumbnail-2.jpg", b"x", 1);
        out("Thumbnail-1.JPEG", b"x", 1);
        out("thumb.png", b"x", 1);
        out("thumbnail-3.gif", b"x", 1);
        out("meta.txt", b"title", 1);
        fx.dir("C/001 V/output/thumbnail-dir.png");
        fx.file("C/001 V/info.txt", b"log");

        let output = scan_output(&video);
        let review: Vec<(&str, Option<ReviewSoftware>)> = output
            .review_files
            .iter()
            .map(|f| (f.name.as_str(), f.software))
            .collect();
        assert_eq!(
            review,
            [
                ("v2.fcpxmld", Some(ReviewSoftware::Fcp)),
                ("timeline.xml", Some(ReviewSoftware::Premiere)),
                ("v3.FCPXML", Some(ReviewSoftware::Fcp)),
                ("premiere.prproj", Some(ReviewSoftware::Premiere)),
                ("v1.fcpxml", Some(ReviewSoftware::Fcp)),
            ]
        );
        assert_eq!(
            output.review_files[0].modified_at,
            "1970-01-01T01:40:00.000Z"
        );
        assert_eq!(
            output.review_files[4].path,
            path_string(&video.join("output").join("v1.fcpxml"))
        );
        let finals: Vec<(&str, Option<ReviewSoftware>)> = output
            .final_files
            .iter()
            .map(|f| (f.name.as_str(), f.software))
            .collect();
        assert_eq!(finals, [("final 4K.MOV", None), ("final.mp4", None)]);
        let thumbs: Vec<String> = output
            .thumbnails
            .iter()
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(
            thumbs,
            ["Thumbnail-1.JPEG", "thumbnail-2.jpg", "thumbnail-10.png"]
        );
        assert_eq!(
            output.meta_file,
            Some(path_string(&video.join("output").join("meta.txt")))
        );
        assert_eq!(output.info_file, Some(path_string(&video.join("info.txt"))));
        assert_eq!(output.dir, path_string(&video.join("output")));

        let view = video_view(&fx.store, "ch-C/001 V").unwrap();
        assert!(view.edited && view.final_rendered);
        assert_eq!(view.actions, [ReEdit, RenderFinal, Archive]);
    }

    #[test]
    fn missing_output_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let output = scan_output(tmp.path());
        assert_eq!(
            output,
            VideoOutput {
                dir: path_string(&tmp.path().join("output")),
                ..VideoOutput::default()
            }
        );
        // Only `.xml` files with `<xmeml` in the first 4 KB count.
        let mut late = vec![b' '; 5000];
        late.extend_from_slice(b"<xmeml>");
        fs::create_dir(tmp.path().join("output")).unwrap();
        fs::write(tmp.path().join("output/late.xml"), late).unwrap();
        assert!(scan_output(tmp.path()).review_files.is_empty());
    }

    // ----- resolve_video -----

    #[test]
    fn resolve_video_success() {
        let fx = Fixture::new(&["Kudrat Care"]);
        fx.fixture("rotated-270.mp4", "Kudrat Care/019 Mask/a.mp4");
        fx.dir("Kudrat Care/019 Mask/B-Rolls");
        fx.file("Kudrat Care/019 Mask/output/v1.fcpxml", b"<fcpxml/>");
        let ctx = resolve_video(&fx.store, "ch-Kudrat Care/019 Mask").unwrap();
        assert_eq!(ctx.video_id, "ch-Kudrat Care/019 Mask");
        assert_eq!(ctx.channel_id, "ch-Kudrat Care");
        assert_eq!(ctx.channel_folder, "Kudrat Care");
        assert_eq!(ctx.video_folder, "019 Mask");
        assert_eq!(ctx.editing_folder, fx.root);
        assert_eq!(ctx.path, fx.root.join("Kudrat Care/019 Mask"));
        assert_eq!(ctx.video_type, VideoType::Short);
        assert_eq!(ctx.broll_folder, "B-Rolls");
        assert_eq!(ctx.output.review_files.len(), 1);

        fs::remove_dir(fx.root.join("Kudrat Care/019 Mask/B-Rolls")).unwrap();
        let ctx = resolve_video(&fx.store, "ch-Kudrat Care/019 Mask").unwrap();
        assert_eq!(ctx.broll_folder, "Broll");
    }

    #[test]
    fn resolve_video_errors() {
        use crate::error::ErrorCode;
        let fx = Fixture::new(&["C"]);
        fx.dir("C/001 V");
        fx.dir("C/Style");
        fx.dir("C/.hidden");
        fx.dir("Other/001 V");
        let code = |id: &str| resolve_video(&fx.store, id).unwrap_err().code;
        assert_eq!(code("ch-Unknown/001 V"), ErrorCode::NotFound);
        assert_eq!(code("ch-C/002 Missing"), ErrorCode::NotFound);
        assert_eq!(code("ch-C/Style"), ErrorCode::NotFound);
        assert_eq!(code("ch-C/.hidden"), ErrorCode::NotFound);
        assert_eq!(code("ch-C/.."), ErrorCode::NotFound);
        assert_eq!(code("ch-C/../Other/001 V"), ErrorCode::NotFound);
        assert_eq!(code("ch-C"), ErrorCode::NotFound);
        assert_eq!(code("ch-C/"), ErrorCode::NotFound);
        assert!(resolve_video(&fx.store, "ch-C/001 V").is_ok());

        fx.store
            .update_settings(|s| {
                s.editing_folder = None;
                Ok(())
            })
            .unwrap();
        assert_eq!(code("ch-C/001 V"), ErrorCode::NoEditingFolder);
    }

    // ----- change detection -----

    #[test]
    fn publish_reports_only_real_changes() {
        let fx = Fixture::new(&["C"]);
        fx.dir("C/001 V");
        let rescanner = Rescanner::default();
        let first = fx.scan();
        assert!(rescanner.publish(&first), "the first library is news");
        assert!(!rescanner.publish(&fx.scan()), "nothing changed on disk");

        fx.file("C/001 V/output/v1.fcpxml", b"<fcpxml/>");
        assert!(rescanner.publish(&fx.scan()), "a review project appeared");
        assert!(!rescanner.publish(&fx.scan()));

        fx.dir("New Folder");
        assert!(rescanner.publish(&fx.scan()), "a folder was discovered");

        fx.store
            .update_video("ch-C/001 V", |v| {
                v.latest_job = Some(job("ch-C/001 V", JobState::Running));
                Ok(())
            })
            .unwrap();
        assert!(rescanner.publish(&fx.scan()), "a job changed");
        assert!(!rescanner.publish(&fx.scan()));
    }

    #[test]
    fn rescan_requests_coalesce() {
        let rescanner = Rescanner::default();
        assert!(!rescanner.wait(Duration::from_millis(1)));
        rescanner.request();
        rescanner.request();
        assert!(rescanner.wait(Duration::from_secs(5)));
        assert!(!rescanner.wait(Duration::from_millis(1)));
    }
}

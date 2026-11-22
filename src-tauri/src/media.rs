//! Long / Short detection from the A-roll (SPEC section 8).
//!
//! Responsibility:
//! - Pick the main A-roll: the largest A-roll file directly in the video folder.
//! - Read its display size: coded size with the rotation applied. MP4 / MOV family files are
//!   parsed directly in Rust (track header size and matrix), with no external tool. Other
//!   containers fall back to `ffprobe` from the login-shell `PATH` (see `claude::env`) when present.
//! - Taller than wide is `Short`, otherwise `Long`; unreadable is `None`.
//! - Then the picture check (`orientation`): faces in a few frames tell whether the picture is
//!   stored sideways or upside down without a rotation flag. A quarter turn swaps the display
//!   width and height. It runs in the background ([`pictures`]) during scans, and right away when
//!   a job starts ([`detect_video_type`]).
//! - Results are cached by path, size, modification time and [`DETECTOR_VERSION`] in
//!   `store::VideoState::type_detection` (see `store::TypeDetection`).
//!
//! Unit tests use small fixture files under `src-tauri/tests/fixtures/media/`.

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Deserialize;

use crate::model::VideoType;
use crate::orientation::Rotation;
use crate::store::{Store, TypeDetection};

/// A-roll file extensions (SPEC section 2), compared case-insensitively.
pub const AROLL_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "mkv", "mts", "m2ts", "avi", "webm"];

/// Extensions parsed directly as ISO base media (MP4 / QuickTime family).
const ISO_BMFF_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v"];

/// The `moov` box holds only metadata (a few KB to a few MB even for hours of footage). Anything
/// larger is treated as corrupt rather than read into memory.
const MAX_MOOV_BYTES: u64 = 256 * 1024 * 1024;

/// How long one `ffprobe` call may take before it is killed.
const FFPROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// True when `name` has one of the [`AROLL_EXTENSIONS`].
pub fn is_aroll_name(name: &str) -> bool {
    has_extension(Path::new(name), AROLL_EXTENSIONS)
}

fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| extensions.iter().any(|e| e.eq_ignore_ascii_case(ext)))
}

/// One A-roll file in a video folder, with the facts its detection is cached by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArollFile {
    pub path: PathBuf,
    pub size: u64,
    /// Modification time in milliseconds since the Unix epoch (0 when unknown).
    pub modified_ms: i64,
}

impl ArollFile {
    /// Builds the entry from a file's metadata.
    pub fn new(path: PathBuf, meta: &fs::Metadata) -> Self {
        Self {
            path,
            size: meta.len(),
            modified_ms: modified_ms(meta),
        }
    }
}

/// Modification time of `meta` in milliseconds since the Unix epoch (0 when unknown).
pub fn modified_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The main A-roll: the largest file (ties broken by name so the choice is stable).
pub fn main_aroll(files: &[ArollFile]) -> Option<&ArollFile> {
    files
        .iter()
        .max_by(|a, b| a.size.cmp(&b.size).then_with(|| b.path.cmp(&a.path)))
}

/// Width and height as the video is displayed (rotation applied).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DisplaySize {
    pub width: u32,
    pub height: u32,
}

impl DisplaySize {
    /// Taller than wide is `Short`, otherwise `Long`; `None` for a degenerate size.
    pub fn video_type(self) -> Option<VideoType> {
        if self.width == 0 || self.height == 0 {
            None
        } else if self.height > self.width {
            Some(VideoType::Short)
        } else {
            Some(VideoType::Long)
        }
    }
}

/// Why no display size could be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeError {
    /// The file was examined and holds no readable video track. Final for this file version.
    Unreadable(String),
    /// The fallback tool (`ffprobe`) is not installed. Worth retrying later.
    ToolMissing,
}

/// Reads the display size of a video file: MP4 / MOV family in Rust, anything else (or an MP4
/// family file the parser cannot read) through `ffprobe`. Blocking.
pub fn probe_display_size(path: &Path) -> Result<DisplaySize, ProbeError> {
    if has_extension(path, ISO_BMFF_EXTENSIONS) {
        match read_iso_bmff_size(path) {
            Ok(size) => return Ok(size),
            Err(err) => match ffprobe_display_size(path) {
                Ok(size) => return Ok(size),
                // Report the parser's reason: it is more useful than "ffprobe is missing".
                Err(ProbeError::ToolMissing) => return Err(ProbeError::Unreadable(err)),
                Err(other) => return Err(other),
            },
        }
    }
    ffprobe_display_size(path)
}

// ---------------------------------------------------------------------------------------------
// Detection with the cache and the picture check
// ---------------------------------------------------------------------------------------------

/// Version of the detector, stored in every cache entry. Entries written by an older version
/// are detected again once. Version 1 added the picture check.
pub const DETECTOR_VERSION: u32 = 1;

/// The detection of one video's main A-roll.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Detection {
    /// `None` when there is no readable A-roll.
    pub video_type: Option<VideoType>,
    /// 90, 180 or 270: the clockwise turn that makes the main A-roll upright, when the picture
    /// check found it stored sideways or upside down without a rotation flag
    /// (`VideoView::aroll_rotation`).
    pub rotation: Option<u32>,
}

impl Detection {
    /// The detection a cache entry stands for.
    pub fn of(entry: &TypeDetection) -> Self {
        Self {
            video_type: entry.detected,
            rotation: entry.picture_rotation.filter(|r| *r != 0),
        }
    }
}

/// What [`detect_with_cache`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    pub detection: Detection,
    /// The cache entry the detection stands for (`None` without an A-roll or when the fallback
    /// tool is missing).
    pub entry: Option<TypeDetection>,
    /// `entry` is new or changed and must be saved (see [`save_detections`]).
    pub is_new: bool,
}

impl Detected {
    fn none() -> Self {
        Self {
            detection: Detection::default(),
            entry: None,
            is_new: false,
        }
    }

    fn new_entry(entry: TypeDetection) -> Self {
        Self {
            detection: Detection::of(&entry),
            entry: Some(entry),
            is_new: true,
        }
    }

    /// The entry, when the picture check still has to run for it.
    pub fn picture_check_pending(&self) -> Option<&TypeDetection> {
        self.entry.as_ref().filter(|e| picture_check_pending(e))
    }
}

/// True when the picture check has not run for `entry` yet and has something to correct: the
/// metadata gave a display size.
pub fn picture_check_pending(entry: &TypeDetection) -> bool {
    entry.display.is_some() && entry.picture_rotation.is_none()
}

/// A cache entry for `main` from its metadata display size and, when it ran, the picture check.
/// A quarter turn swaps the displayed width and height, which turns a "landscape" file whose
/// picture is vertical into a Short.
pub fn detection_entry(
    main: &ArollFile,
    display: Option<DisplaySize>,
    rotation: Option<Rotation>,
) -> TypeDetection {
    let upright = match (display, rotation) {
        (Some(d), Some(r)) if r.swaps_sides() => Some(DisplaySize {
            width: d.height,
            height: d.width,
        }),
        _ => display,
    };
    TypeDetection {
        path: main.path.to_string_lossy().into_owned(),
        size: main.size,
        modified_ms: main.modified_ms,
        detected: upright.and_then(DisplaySize::video_type),
        detector: DETECTOR_VERSION,
        display: display.map(|d| [d.width, d.height]),
        picture_rotation: rotation.map(Rotation::degrees),
    }
}

/// `entry` with the picture check's result.
pub fn with_picture(entry: &TypeDetection, rotation: Rotation) -> TypeDetection {
    let file = ArollFile {
        path: PathBuf::from(&entry.path),
        size: entry.size,
        modified_ms: entry.modified_ms,
    };
    let display = entry
        .display
        .map(|[width, height]| DisplaySize { width, height });
    detection_entry(&file, display, Some(rotation))
}

/// Detects the type of one video's main A-roll from the metadata, using the cache.
///
/// The picture check is not run here (it takes a fraction of a second per file): an entry it has
/// not run for is reported by [`Detected::picture_check_pending`], and the caller hands it to
/// [`request_picture_check`] (background) or [`detect_video_type`] (blocking). Until then the
/// metadata result stands. A missing `ffprobe` is not cached, so installing it later fixes the
/// detection without touching the file.
pub fn detect_with_cache(cached: Option<&TypeDetection>, main: Option<&ArollFile>) -> Detected {
    let Some(main) = main else {
        return Detected::none();
    };
    let path = main.path.to_string_lossy();
    if let Some(entry) = cached
        .filter(|c| c.matches(&path, main.size, main.modified_ms) && c.detector == DETECTOR_VERSION)
    {
        return Detected {
            detection: Detection::of(entry),
            entry: Some(entry.clone()),
            is_new: false,
        };
    }
    let display = match probe_display_size(&main.path) {
        Ok(size) => Some(size).filter(|s| s.video_type().is_some()),
        Err(ProbeError::Unreadable(_)) => None,
        Err(ProbeError::ToolMissing) => return Detected::none(),
    };
    Detected::new_entry(detection_entry(main, display, None))
}

/// Saves new cache entries (video id, detection) in one write. Failures are logged, never fatal:
/// the cache only saves work.
///
/// An entry the picture check already completed is never replaced by an entry for the same file
/// without that result (a scan that started before the background check finished).
pub fn save_detections(store: &Store, detections: Vec<(String, TypeDetection)>) {
    if detections.is_empty() {
        return;
    }
    let result = store.update_state(|state| {
        for (video_id, detection) in detections {
            let slot = &mut state.videos.entry(video_id).or_default().type_detection;
            let keeps_picture = slot.as_ref().is_some_and(|old| {
                old.same_file(&detection)
                    && old.detector == detection.detector
                    && old.picture_rotation.is_some()
                    && detection.picture_rotation.is_none()
            });
            if !keeps_picture {
                *slot = Some(detection);
            }
        }
        Ok(())
    });
    if let Err(err) = result {
        eprintln!("vidai: could not save the type detection cache: {err}");
    }
}

/// Saves the picture check's result for `video_id`, unless the cache meanwhile holds an entry for
/// another file (the A-roll changed while the check ran).
pub fn save_picture_result(store: &Store, video_id: &str, entry: TypeDetection) {
    let result = store.update_state(|state| {
        let slot = &mut state
            .videos
            .entry(video_id.to_owned())
            .or_default()
            .type_detection;
        if slot.as_ref().is_none_or(|old| old.same_file(&entry)) {
            *slot = Some(entry);
        }
        Ok(())
    });
    if let Err(err) = result {
        eprintln!("vidai: could not save the picture check result: {err}");
    }
}

/// Detects one video's type through the store's cache, running a pending picture check right
/// away (blocking, bounded by the helper's time limit), and saves the result. Used when a job
/// starts, so it starts with the final type.
pub fn detect_video_type(store: &Store, video_id: &str, main: Option<&ArollFile>) -> Detection {
    let cached = store.video(video_id).type_detection;
    let detected = detect_with_cache(cached.as_ref(), main);
    let Some(mut entry) = detected.entry else {
        return detected.detection;
    };
    let mut changed = detected.is_new;
    if picture_check_pending(&entry)
        && !pictures::failed_this_session(video_id, &entry)
        && let Some(rotation) = pictures::check(video_id, &entry)
    {
        entry = with_picture(&entry, rotation);
        changed = true;
    }
    if changed {
        save_detections(store, vec![(video_id.to_owned(), entry.clone())]);
    }
    Detection::of(&entry)
}

/// Asks for the picture check of `entry` in the background (see [`pictures`]). Never blocks.
pub fn request_picture_check(video_id: &str, entry: &TypeDetection) {
    pictures::request(video_id, entry);
}

/// The picture checks of the library: a small pool of background workers, so a scan of many
/// new videos never waits for them.
///
/// - [`start`](pictures::start) runs once at startup (from `scanner::setup`) when the picture
///   check is available on this platform; until then, and without it, requests are ignored and
///   the metadata result stands.
/// - Requests are deduplicated per video and file version; at most [`WORKERS`](pictures::WORKERS)
///   checks run at a time.
/// - Each result is handed to the `done` callback, which saves it and asks for a rescan.
/// - A check that failed for a reason that may pass (time limit, crash) is not cached and not
///   retried during this session: the metadata result stands until the next start of VidAI.
pub mod pictures {
    use std::collections::{HashSet, VecDeque};
    use std::path::Path;
    use std::sync::{Arc, Condvar, Mutex, OnceLock, PoisonError};

    use crate::orientation::{self, PictureCheckError, Rotation};
    use crate::store::TypeDetection;

    /// Checks that may run at the same time. Each one keeps a video decoder and Vision busy for
    /// about a third of a second; two keep a scan of many new videos quick without making the
    /// Mac sluggish.
    pub const WORKERS: usize = 2;

    /// Runs the check for one file.
    pub type CheckFn = dyn Fn(&Path) -> Result<Rotation, PictureCheckError> + Send + Sync;
    /// Receives a finished check: the video id and its entry with the picture result.
    pub type DoneFn = dyn Fn(&str, TypeDetection) + Send + Sync;

    /// Video id, path, size, modification time.
    type Key = (String, String, u64, i64);

    fn key(video_id: &str, entry: &TypeDetection) -> Key {
        (
            video_id.to_owned(),
            entry.path.clone(),
            entry.size,
            entry.modified_ms,
        )
    }

    #[derive(Default)]
    struct State {
        queue: VecDeque<(String, TypeDetection)>,
        /// Queued or running.
        active: HashSet<Key>,
        /// Failed this session, not retried.
        failed: HashSet<Key>,
    }

    /// A queue of picture checks with its worker threads.
    pub struct Checks {
        state: Mutex<State>,
        wake: Condvar,
        check: Box<CheckFn>,
        done: Box<DoneFn>,
    }

    impl Checks {
        /// Starts `workers` threads that run `check` and report to `done`.
        pub fn start(workers: usize, check: Box<CheckFn>, done: Box<DoneFn>) -> Arc<Self> {
            let checks = Arc::new(Self {
                state: Mutex::default(),
                wake: Condvar::new(),
                check,
                done,
            });
            for n in 0..workers {
                let worker = Arc::clone(&checks);
                let spawned = std::thread::Builder::new()
                    .name(format!("vidai-picture-{n}"))
                    .spawn(move || worker.work());
                if let Err(err) = spawned {
                    eprintln!("vidai: could not start a picture check worker: {err}");
                }
            }
            checks
        }

        fn lock(&self) -> std::sync::MutexGuard<'_, State> {
            self.state.lock().unwrap_or_else(PoisonError::into_inner)
        }

        /// Queues the check of `entry` unless it is queued, running or failed this session.
        pub fn request(&self, video_id: &str, entry: &TypeDetection) {
            let key = key(video_id, entry);
            let mut state = self.lock();
            if state.failed.contains(&key) || !state.active.insert(key) {
                return;
            }
            state.queue.push_back((video_id.to_owned(), entry.clone()));
            drop(state);
            self.wake.notify_one();
        }

        /// True when the check of `entry` failed this session.
        pub fn failed(&self, video_id: &str, entry: &TypeDetection) -> bool {
            self.lock().failed.contains(&key(video_id, entry))
        }

        /// Records the outcome of a check: the rotation to cache, or `None` to leave the entry
        /// unchecked (remembering a failure for this session).
        fn settle(
            &self,
            video_id: &str,
            entry: &TypeDetection,
            outcome: Result<Rotation, PictureCheckError>,
        ) -> Option<Rotation> {
            let rotation = verdict(&entry.path, outcome);
            if rotation.is_none() {
                self.lock().failed.insert(key(video_id, entry));
            }
            rotation
        }

        fn work(&self) {
            loop {
                let (video_id, entry) = {
                    let mut state = self.lock();
                    loop {
                        if let Some(next) = state.queue.pop_front() {
                            break next;
                        }
                        state = self
                            .wake
                            .wait(state)
                            .unwrap_or_else(PoisonError::into_inner);
                    }
                };
                let outcome = (self.check)(Path::new(&entry.path));
                if let Some(rotation) = self.settle(&video_id, &entry, outcome) {
                    (self.done)(&video_id, super::with_picture(&entry, rotation));
                }
                self.lock().active.remove(&key(&video_id, &entry));
            }
        }
    }

    /// What to cache for a check's outcome: the rotation, or `None` to cache nothing and keep
    /// the metadata result.
    ///
    /// - A clear answer is cached, including "upright" when there were not enough faces: the
    ///   check ran and the metadata stands for this file version.
    /// - A picture the platform cannot decode is cached as upright, for the same reason.
    /// - Not available, or a failure that may pass, caches nothing, so a later run (a fixed
    ///   installation, the next start) checks again instead of keeping a guess forever.
    pub fn verdict(path: &str, outcome: Result<Rotation, PictureCheckError>) -> Option<Rotation> {
        match outcome {
            Ok(rotation) => Some(rotation),
            Err(PictureCheckError::Unreadable(why)) => {
                eprintln!("vidai: picture check of {path}: {why}; using the file's metadata");
                Some(Rotation::Upright)
            }
            Err(PictureCheckError::NotAvailable) => None,
            Err(err @ PictureCheckError::Failed(_)) => {
                eprintln!("vidai: picture check of {path}: {err}; using the file's metadata");
                None
            }
        }
    }

    static GLOBAL: OnceLock<Arc<Checks>> = OnceLock::new();

    /// Starts the background picture checks of the app, when the platform has them. `done` saves
    /// a result and asks for a rescan.
    pub fn start(done: Box<DoneFn>) {
        if !orientation::available() {
            return;
        }
        let checks = Checks::start(WORKERS, Box::new(orientation::check_picture), done);
        if GLOBAL.set(checks).is_err() {
            eprintln!("vidai: the picture checks were already started");
        }
    }

    /// Queues a background check (ignored before [`start`] or without a picture check).
    pub fn request(video_id: &str, entry: &TypeDetection) {
        if let Some(checks) = GLOBAL.get() {
            checks.request(video_id, entry);
        }
    }

    /// True when the background check of this entry failed this session.
    pub fn failed_this_session(video_id: &str, entry: &TypeDetection) -> bool {
        GLOBAL.get().is_some_and(|c| c.failed(video_id, entry))
    }

    /// Runs the check of `entry` now (blocking). `None` when nothing should be cached.
    pub fn check(video_id: &str, entry: &TypeDetection) -> Option<Rotation> {
        let outcome = orientation::check_picture(Path::new(&entry.path));
        match GLOBAL.get() {
            Some(checks) => checks.settle(video_id, entry, outcome),
            None => verdict(&entry.path, outcome),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// ISO base media (MP4 / MOV)
// ---------------------------------------------------------------------------------------------

/// Box header: type, where its payload starts, and its payload length (`None` = to end of file).
struct BoxHeader {
    kind: [u8; 4],
    header_len: u64,
    payload_len: Option<u64>,
}

/// Reads one box header at the current position. `remaining` is how many bytes are left in the
/// enclosing range. Returns `Ok(None)` at a clean end.
fn read_box_header(reader: &mut impl Read, remaining: u64) -> Result<Option<BoxHeader>, String> {
    if remaining == 0 {
        return Ok(None);
    }
    if remaining < 8 {
        return Err("truncated box header".into());
    }
    let mut head = [0u8; 8];
    reader
        .read_exact(&mut head)
        .map_err(|e| format!("could not read a box header: {e}"))?;
    let size32 = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
    let kind = [head[4], head[5], head[6], head[7]];
    let (header_len, total) = match size32 {
        0 => (8, None),
        1 => {
            if remaining < 16 {
                return Err("truncated 64-bit box header".into());
            }
            let mut large = [0u8; 8];
            reader
                .read_exact(&mut large)
                .map_err(|e| format!("could not read a box header: {e}"))?;
            (16, Some(u64::from_be_bytes(large)))
        }
        n => (8, Some(u64::from(n))),
    };
    let payload_len = match total {
        None => None,
        Some(total) if total < header_len || total > remaining => {
            return Err(format!(
                "box {} has an invalid size {total}",
                String::from_utf8_lossy(&kind)
            ));
        }
        Some(total) => Some(total - header_len),
    };
    Ok(Some(BoxHeader {
        kind,
        header_len,
        payload_len,
    }))
}

/// Finds the top-level `moov` box by walking box headers and seeking over everything else, so
/// even a multi-GB file with `moov` at the end costs a handful of small reads.
fn read_moov(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|e| format!("could not open the file: {e}"))?;
    let file_len = file
        .metadata()
        .map_err(|e| format!("could not read the file size: {e}"))?
        .len();
    // Recognize the container by its first box type before trusting any box size.
    let mut head = [0u8; 8];
    if file.read_exact(&mut head).is_err() || !is_plausible_first_box(&head[4..8]) {
        return Err("not an MP4 or QuickTime file".into());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("could not seek: {e}"))?;
    let mut pos = 0u64;
    while let Some(header) = read_box_header(&mut file, file_len - pos)? {
        let payload_len = header
            .payload_len
            .unwrap_or(file_len - pos - header.header_len);
        if &header.kind == b"moov" {
            if payload_len > MAX_MOOV_BYTES {
                return Err("the moov box is implausibly large".into());
            }
            let mut moov = vec![0u8; usize::try_from(payload_len).map_err(|e| e.to_string())?];
            file.read_exact(&mut moov)
                .map_err(|e| format!("could not read the moov box: {e}"))?;
            return Ok(moov);
        }
        pos += header.header_len + payload_len;
        file.seek(SeekFrom::Start(pos))
            .map_err(|e| format!("could not seek: {e}"))?;
    }
    Err("no moov box (the file may still be copying or recording)".into())
}

fn is_plausible_first_box(kind: &[u8]) -> bool {
    matches!(
        kind,
        b"ftyp" | b"moov" | b"mdat" | b"wide" | b"free" | b"skip" | b"pnot" | b"uuid" | b"styp"
    )
}

/// Iterates the child boxes of an in-memory payload as (type, payload).
fn child_boxes(data: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    let mut rest = data;
    std::iter::from_fn(move || {
        let mut reader = io::Cursor::new(rest);
        let header = read_box_header(&mut reader, rest.len() as u64).ok()??;
        let start = usize::try_from(header.header_len).ok()?;
        let len = match header.payload_len {
            Some(len) => usize::try_from(len).ok()?,
            None => rest.len() - start,
        };
        let payload = &rest[start..start + len];
        rest = &rest[start + len..];
        Some((header.kind, payload))
    })
}

fn find_child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    child_boxes(data).find(|(k, _)| k == kind).map(|(_, p)| p)
}

fn be_u32(data: &[u8], at: usize) -> Option<u32> {
    let bytes = data.get(at..at + 4)?;
    Some(u32::from_be_bytes(bytes.try_into().ok()?))
}

fn be_i32(data: &[u8], at: usize) -> Option<i32> {
    be_u32(data, at).map(|v| v as i32)
}

fn be_u16(data: &[u8], at: usize) -> Option<u16> {
    let bytes = data.get(at..at + 2)?;
    Some(u16::from_be_bytes(bytes.try_into().ok()?))
}

/// What one video track says about its size.
#[derive(Debug, Clone, Copy)]
struct TrackSize {
    enabled: bool,
    display: DisplaySize,
}

/// Parses one `trak` payload. Returns `None` for non-video tracks.
fn parse_video_track(trak: &[u8]) -> Option<TrackSize> {
    let mdia = find_child(trak, b"mdia")?;
    let hdlr = find_child(mdia, b"hdlr")?;
    // version+flags (4), pre_defined / component type (4), handler type (4).
    if hdlr.get(8..12)? != b"vide" {
        return None;
    }
    let tkhd = find_child(trak, b"tkhd")?;
    let version = *tkhd.first()?;
    let flags = be_u32(tkhd, 0)? & 0x00ff_ffff;
    // After version+flags: times, track id, reserved, duration (20 or 32 bytes), then reserved (8),
    // layer, alternate group, volume, reserved (8): the matrix follows.
    let matrix_at = 4 + if version == 1 { 32 } else { 20 } + 16;
    let m = |i: usize| be_i32(tkhd, matrix_at + i * 4).map(f64::from);
    let (a, b, c, d) = (m(0)?, m(1)?, m(3)?, m(4)?);
    let fixed = |at: usize| be_u32(tkhd, at).map(|v| f64::from(v) / 65536.0);
    let mut width = fixed(matrix_at + 36)?;
    let mut height = fixed(matrix_at + 40)?;
    if width < 1.0 || height < 1.0 {
        // Some writers leave the track header size empty; the sample description has the coded
        // size (visual sample entry: 6 reserved, 2 data ref index, 16 predefined, then w, h).
        let (w, h) = sample_entry_size(mdia)?;
        width = f64::from(w);
        height = f64::from(h);
    }
    // A point (x, y) maps to (a*x + c*y, b*x + d*y); the matrix entries are 16.16 fixed point,
    // so the 65536 scale cancels out in the ratio but not in the size: divide it back out.
    let display_w = (a * width).abs() + (c * height).abs();
    let display_h = (b * width).abs() + (d * height).abs();
    let display = DisplaySize {
        width: (display_w / 65536.0).round() as u32,
        height: (display_h / 65536.0).round() as u32,
    };
    Some(TrackSize {
        enabled: flags & 1 == 1,
        display,
    })
}

fn sample_entry_size(mdia: &[u8]) -> Option<(u16, u16)> {
    let minf = find_child(mdia, b"minf")?;
    let stbl = find_child(minf, b"stbl")?;
    let stsd = find_child(stbl, b"stsd")?;
    // version+flags (4), entry count (4), then the first entry box.
    let (_, entry) = child_boxes(stsd.get(8..)?).next()?;
    Some((be_u16(entry, 24)?, be_u16(entry, 26)?))
}

/// The sample entry code of the first video track of an MP4 / MOV family file (`avc1`, `hvc1`,
/// ...), `None` for other files. The Windows picture check uses it to tell a missing decoder from
/// a broken file.
#[cfg(any(windows, test))]
pub fn video_codec(path: &Path) -> Option<String> {
    if !has_extension(path, ISO_BMFF_EXTENSIONS) {
        return None;
    }
    let moov = read_moov(path).ok()?;
    child_boxes(&moov)
        .filter(|(kind, _)| kind == b"trak")
        .find_map(|(_, trak)| {
            let mdia = find_child(trak, b"mdia")?;
            if find_child(mdia, b"hdlr")?.get(8..12)? != b"vide" {
                return None;
            }
            let stbl = find_child(find_child(mdia, b"minf")?, b"stbl")?;
            let stsd = find_child(stbl, b"stsd")?;
            let (kind, _) = child_boxes(stsd.get(8..)?).next()?;
            Some(String::from_utf8_lossy(&kind).into_owned())
        })
}

/// Display size of the main video track of an MP4 / MOV file: the largest enabled video track,
/// else the largest video track.
fn read_iso_bmff_size(path: &Path) -> Result<DisplaySize, String> {
    let moov = read_moov(path)?;
    if find_child(&moov, b"cmov").is_some() {
        return Err("compressed movie header".into());
    }
    let tracks: Vec<TrackSize> = child_boxes(&moov)
        .filter(|(kind, _)| kind == b"trak")
        .filter_map(|(_, trak)| parse_video_track(trak))
        .filter(|t| t.display.video_type().is_some())
        .collect();
    let area = |t: &&TrackSize| u64::from(t.display.width) * u64::from(t.display.height);
    tracks
        .iter()
        .filter(|t| t.enabled)
        .max_by_key(area)
        .or_else(|| tracks.iter().max_by_key(area))
        .map(|t| t.display)
        .ok_or_else(|| "no video track".into())
}

// ---------------------------------------------------------------------------------------------
// ffprobe fallback
// ---------------------------------------------------------------------------------------------

/// Finds `ffprobe` on the `PATH` of the login-shell environment (`claude::env::child_env`); on
/// Windows `ffprobe.exe`, searched with `PATHEXT` (`claude::locate::which`).
fn find_ffprobe(env: &std::collections::HashMap<String, String>) -> Option<PathBuf> {
    crate::claude::locate::which("ffprobe", env)
}

fn ffprobe_display_size(path: &Path) -> Result<DisplaySize, ProbeError> {
    let env = crate::claude::env::child_env();
    let ffprobe = find_ffprobe(&env).ok_or(ProbeError::ToolMissing)?;
    let mut cmd = Command::new(ffprobe);
    crate::platform::process::hide_console(&mut cmd);
    let mut child = cmd
        .args([
            "-v",
            "error",
            "-select_streams",
            "V:0",
            "-show_entries",
            "stream=width,height:stream_tags=rotate:stream_side_data=rotation",
            "-of",
            "json",
        ])
        .arg(path)
        .env_clear()
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| ProbeError::Unreadable(format!("could not run ffprobe: {e}")))?;
    // The output is a few hundred bytes, far below the pipe buffer, so waiting before reading
    // cannot deadlock.
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > FFPROBE_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ProbeError::Unreadable("ffprobe timed out".into()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(ProbeError::Unreadable(format!("ffprobe failed: {e}"))),
        }
    }
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        stdout
            .read_to_string(&mut out)
            .map_err(|e| ProbeError::Unreadable(format!("could not read ffprobe output: {e}")))?;
    }
    parse_ffprobe_json(&out)
        .ok_or_else(|| ProbeError::Unreadable("ffprobe found no video stream".into()))
}

#[derive(Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
}

#[derive(Deserialize)]
struct FfprobeStream {
    width: Option<u32>,
    height: Option<u32>,
    #[serde(default)]
    tags: Option<FfprobeTags>,
    #[serde(default)]
    side_data_list: Vec<FfprobeSideData>,
}

#[derive(Deserialize)]
struct FfprobeTags {
    rotate: Option<String>,
}

#[derive(Deserialize)]
struct FfprobeSideData {
    rotation: Option<f64>,
}

/// Display size from `ffprobe -of json` output (first video stream, rotation applied).
fn parse_ffprobe_json(json: &str) -> Option<DisplaySize> {
    let output: FfprobeOutput = serde_json::from_str(json).ok()?;
    let stream = output.streams.into_iter().next()?;
    let (width, height) = (stream.width?, stream.height?);
    let rotation = stream
        .side_data_list
        .iter()
        .find_map(|s| s.rotation)
        .or_else(|| {
            stream
                .tags
                .and_then(|t| t.rotate?.trim().parse::<f64>().ok())
        })
        .unwrap_or(0.0);
    let quarter_turns = (rotation / 90.0).round() as i64;
    let size = if quarter_turns.rem_euclid(2) == 1 {
        DisplaySize {
            width: height,
            height: width,
        }
    } else {
        DisplaySize { width, height }
    };
    Some(size)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/media")
            .join(name)
    }

    fn size(w: u32, h: u32) -> DisplaySize {
        DisplaySize {
            width: w,
            height: h,
        }
    }

    #[test]
    fn reads_fixture_display_sizes_without_external_tools() {
        let cases = [
            ("landscape.mp4", size(64, 36), VideoType::Long),
            ("landscape-with-audio.mov", size(64, 36), VideoType::Long),
            ("portrait-faststart.mp4", size(36, 64), VideoType::Short),
            ("rotated-90.mov", size(36, 64), VideoType::Short),
            ("rotated-270.mp4", size(36, 64), VideoType::Short),
            ("rotated-180.mov", size(64, 36), VideoType::Long),
        ];
        for (name, expected, kind) in cases {
            let got = read_iso_bmff_size(&fixture(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(got, expected, "{name}");
            assert_eq!(got.video_type(), Some(kind), "{name}");
        }
    }

    #[test]
    fn reads_the_video_codec() {
        assert_eq!(
            video_codec(&fixture("landscape.mp4")).as_deref(),
            Some("avc1")
        );
        assert_eq!(
            video_codec(&fixture("landscape-with-audio.mov")).as_deref(),
            Some("avc1")
        );
        // A synthetic 3-frame HEVC test pattern.
        assert_eq!(video_codec(&fixture("hevc.mp4")).as_deref(), Some("hvc1"));
        assert_eq!(video_codec(&fixture("portrait.mkv")), None);
        assert_eq!(video_codec(&fixture("missing.mp4")), None);
    }

    #[test]
    fn non_iso_files_are_rejected_by_the_parser() {
        let err = read_iso_bmff_size(&fixture("portrait.mkv")).unwrap_err();
        assert!(err.contains("not an MP4"), "{err}");
    }

    fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out
    }

    /// A minimal `trak` with a version 0 `tkhd` and a `vide` handler.
    fn video_trak(matrix: [i32; 9], width: u32, height: u32, enabled: bool) -> Vec<u8> {
        let mut tkhd = vec![0, 0, 0, u8::from(enabled)];
        tkhd.extend_from_slice(&[0; 20]);
        tkhd.extend_from_slice(&[0; 16]);
        for v in matrix {
            tkhd.extend_from_slice(&v.to_be_bytes());
        }
        tkhd.extend_from_slice(&(width << 16).to_be_bytes());
        tkhd.extend_from_slice(&(height << 16).to_be_bytes());
        let mut hdlr = vec![0; 8];
        hdlr.extend_from_slice(b"vide");
        hdlr.extend_from_slice(&[0; 12]);
        let mdia = mp4_box(b"mdia", &mp4_box(b"hdlr", &hdlr));
        mp4_box(b"trak", &[mp4_box(b"tkhd", &tkhd), mdia].concat())
    }

    const IDENTITY: [i32; 9] = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x4000_0000];
    const ROT90: [i32; 9] = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x4000_0000];

    #[test]
    fn handles_64_bit_and_open_ended_boxes_with_moov_last() {
        let dir = tempfile::tempdir().unwrap();
        let moov = mp4_box(b"moov", &video_trak(ROT90, 3840, 2160, true));

        // ftyp, then an mdat with a 64-bit size, then moov.
        let mut file = mp4_box(b"ftyp", b"qt  \0\0\0\0");
        let mdat_payload = vec![0u8; 1000];
        file.extend_from_slice(&1u32.to_be_bytes());
        file.extend_from_slice(b"mdat");
        file.extend_from_slice(&(16 + mdat_payload.len() as u64).to_be_bytes());
        file.extend_from_slice(&mdat_payload);
        file.extend_from_slice(&moov);
        let path = dir.path().join("large.mov");
        fs::write(&path, &file).unwrap();
        assert_eq!(read_iso_bmff_size(&path).unwrap(), size(2160, 3840));

        // moov as the last box with size 0 ("extends to the end of the file").
        let mut file = mp4_box(b"ftyp", b"isom\0\0\0\0");
        let mut open = moov.clone();
        open[..4].copy_from_slice(&0u32.to_be_bytes());
        file.extend_from_slice(&open);
        let path = dir.path().join("open.mp4");
        fs::write(&path, &file).unwrap();
        assert_eq!(read_iso_bmff_size(&path).unwrap(), size(2160, 3840));
    }

    #[test]
    fn missing_moov_and_garbage_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copying.mp4");
        let mut file = mp4_box(b"ftyp", b"isom\0\0\0\0");
        // An mdat whose declared size runs past the end of the file (still being copied).
        file.extend_from_slice(&100_000u32.to_be_bytes());
        file.extend_from_slice(b"mdat");
        fs::write(&path, &file).unwrap();
        assert!(read_iso_bmff_size(&path).is_err());

        let path = dir.path().join("empty.mp4");
        fs::write(&path, b"").unwrap();
        assert!(read_iso_bmff_size(&path).is_err());
    }

    #[test]
    fn prefers_the_largest_enabled_video_track() {
        let dir = tempfile::tempdir().unwrap();
        let tracks = [
            video_trak(IDENTITY, 4000, 3000, false),
            video_trak(ROT90, 1920, 1080, true),
            video_trak(IDENTITY, 320, 240, true),
        ]
        .concat();
        let file = [mp4_box(b"ftyp", b"isom\0\0\0\0"), mp4_box(b"moov", &tracks)].concat();
        let path = dir.path().join("multi.mp4");
        fs::write(&path, &file).unwrap();
        assert_eq!(read_iso_bmff_size(&path).unwrap(), size(1080, 1920));
    }

    #[test]
    fn parses_ffprobe_output() {
        let plain = r#"{"programs":[],"streams":[{"width":3840,"height":2160}]}"#;
        assert_eq!(parse_ffprobe_json(plain), Some(size(3840, 2160)));
        let side = r#"{"streams":[{"width":1920,"height":1080,"side_data_list":[{"side_data_type":"Display Matrix","rotation":-90}]}]}"#;
        assert_eq!(parse_ffprobe_json(side), Some(size(1080, 1920)));
        let tag = r#"{"streams":[{"width":1920,"height":1080,"tags":{"rotate":"270"}}]}"#;
        assert_eq!(parse_ffprobe_json(tag), Some(size(1080, 1920)));
        let half =
            r#"{"streams":[{"width":1920,"height":1080,"side_data_list":[{"rotation":180}]}]}"#;
        assert_eq!(parse_ffprobe_json(half), Some(size(1920, 1080)));
        assert_eq!(parse_ffprobe_json(r#"{"streams":[]}"#), None);
        assert_eq!(parse_ffprobe_json("not json"), None);
    }

    #[test]
    fn main_aroll_is_the_largest_file() {
        let file = |name: &str, size: u64| ArollFile {
            path: PathBuf::from(name),
            size,
            modified_ms: 0,
        };
        let files = [file("a.mp4", 10), file("b.mov", 30), file("c.mp4", 20)];
        assert_eq!(main_aroll(&files).unwrap().path, PathBuf::from("b.mov"));
        let tie = [file("b.mp4", 10), file("a.mp4", 10)];
        assert_eq!(main_aroll(&tie).unwrap().path, PathBuf::from("a.mp4"));
        assert!(main_aroll(&[]).is_none());
    }

    #[test]
    fn aroll_extensions_are_case_insensitive() {
        for name in ["a.MP4", "b.mov", "c.M2TS", "d.webm", "e.MKV"] {
            assert!(is_aroll_name(name), "{name}");
        }
        for name in ["a.mp3", "b.txt", "mp4", "c.fcpxml"] {
            assert!(!is_aroll_name(name), "{name}");
        }
    }

    #[test]
    fn detection_cache_hits_misses_and_invalidation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mov");
        fs::copy(fixture("rotated-90.mov"), &path).unwrap();
        let meta = fs::metadata(&path).unwrap();
        let main = ArollFile::new(path.clone(), &meta);

        // Miss: detects from the metadata and returns an entry to save, picture check pending.
        let detected = detect_with_cache(None, Some(&main));
        assert_eq!(detected.detection.video_type, Some(VideoType::Short));
        assert_eq!(detected.detection.rotation, None);
        assert!(detected.is_new);
        let entry = detected.entry.clone().expect("a new entry");
        assert!(entry.matches(&path.to_string_lossy(), main.size, main.modified_ms));
        assert_eq!(entry.detector, DETECTOR_VERSION);
        assert_eq!(entry.display, Some([36, 64]));
        assert_eq!(detected.picture_check_pending(), Some(&entry));

        // Hit: the cached answer is used even if it disagrees with the file (proves no re-read).
        let stale = TypeDetection {
            detected: Some(VideoType::Long),
            ..entry.clone()
        };
        let hit = detect_with_cache(Some(&stale), Some(&main));
        assert_eq!(hit.detection.video_type, Some(VideoType::Long));
        assert!(!hit.is_new);

        // An entry of an older detector is detected again (once: the new entry is current).
        let old = TypeDetection {
            detector: 0,
            ..stale.clone()
        };
        let again = detect_with_cache(Some(&old), Some(&main));
        assert!(again.is_new);
        assert_eq!(again.detection.video_type, Some(VideoType::Short));

        // Changed size or mtime: detected again.
        let changed = ArollFile {
            modified_ms: main.modified_ms + 1,
            ..main.clone()
        };
        let detected = detect_with_cache(Some(&stale), Some(&changed));
        assert_eq!(detected.detection.video_type, Some(VideoType::Short));
        assert!(detected.is_new);

        // No A-roll: nothing to detect, nothing to cache.
        assert_eq!(detect_with_cache(Some(&stale), None), Detected::none());

        // Unreadable files are cached as unknown, with no picture check to run.
        let junk = dir.path().join("junk.mp4");
        fs::write(&junk, b"definitely not a movie").unwrap();
        let junk = ArollFile::new(junk.clone(), &fs::metadata(&junk).unwrap());
        let detected = detect_with_cache(None, Some(&junk));
        assert_eq!(detected.detection.video_type, None);
        assert_eq!(detected.picture_check_pending(), None);
        // Cached unless the fallback tool was missing.
        if find_ffprobe(&crate::claude::env::child_env()).is_some() {
            assert_eq!(detected.entry.unwrap().detected, None);
        }
    }

    fn aroll(name: &str) -> ArollFile {
        ArollFile {
            path: PathBuf::from(name),
            size: 100,
            modified_ms: 7,
        }
    }

    #[test]
    fn picture_rotation_corrects_the_metadata() {
        let nikon = aroll("/c/v/DSC_2078.MOV");
        let landscape = Some(size(3840, 2160));
        let metadata = detection_entry(&nikon, landscape, None);
        assert_eq!(metadata.detected, Some(VideoType::Long));
        assert!(picture_check_pending(&metadata));

        // Sideways without a flag: a quarter turn swaps the sides, so it is a Short.
        let sideways = with_picture(&metadata, Rotation::Cw270);
        assert_eq!(sideways.detected, Some(VideoType::Short));
        assert_eq!(sideways.display, Some([3840, 2160]));
        assert_eq!(sideways.picture_rotation, Some(270));
        assert!(!picture_check_pending(&sideways));
        assert_eq!(
            Detection::of(&sideways),
            Detection {
                video_type: Some(VideoType::Short),
                rotation: Some(270)
            }
        );
        let other_way = with_picture(&metadata, Rotation::Cw90);
        assert_eq!(Detection::of(&other_way).rotation, Some(90));
        assert_eq!(other_way.detected, Some(VideoType::Short));

        // Upside down keeps the type but is reported.
        let upside_down = with_picture(&metadata, Rotation::Cw180);
        assert_eq!(
            Detection::of(&upside_down),
            Detection {
                video_type: Some(VideoType::Long),
                rotation: Some(180)
            }
        );

        // Upright (or no clear answer): the metadata stands and no rotation is reported.
        let upright = with_picture(&metadata, Rotation::Upright);
        assert_eq!(
            Detection::of(&upright),
            Detection {
                video_type: Some(VideoType::Long),
                rotation: None
            }
        );

        // A vertical file turned sideways becomes Long; a square stays Long.
        let vertical = detection_entry(&nikon, Some(size(1080, 1920)), Some(Rotation::Cw90));
        assert_eq!(vertical.detected, Some(VideoType::Long));
        let square = detection_entry(&nikon, Some(size(1080, 1080)), Some(Rotation::Cw90));
        assert_eq!(square.detected, Some(VideoType::Long));

        // Unreadable metadata: nothing to correct, no picture check.
        let unreadable = detection_entry(&nikon, None, None);
        assert_eq!(unreadable.detected, None);
        assert!(!picture_check_pending(&unreadable));
    }

    #[test]
    fn what_is_cached_for_each_picture_check_outcome() {
        use crate::orientation::PictureCheckError;
        let path = "/c/v/a.MOV";
        assert_eq!(
            pictures::verdict(path, Ok(Rotation::Cw270)),
            Some(Rotation::Cw270)
        );
        // Ran and saw no face: cached as upright, so it is not checked again.
        assert_eq!(
            pictures::verdict(path, Ok(Rotation::Upright)),
            Some(Rotation::Upright)
        );
        // The platform cannot decode the picture: final for this file version.
        assert_eq!(
            pictures::verdict(path, Err(PictureCheckError::Unreadable("codec".into()))),
            Some(Rotation::Upright)
        );
        // No helper, or a failure that may pass: nothing cached, the metadata stands for now.
        assert_eq!(
            pictures::verdict(path, Err(PictureCheckError::NotAvailable)),
            None
        );
        assert_eq!(
            pictures::verdict(path, Err(PictureCheckError::Failed("timeout".into()))),
            None
        );
    }

    #[test]
    fn saving_keeps_a_finished_picture_check_and_ignores_stale_results() {
        let data = tempfile::tempdir().unwrap();
        let store = Store::open(data.path()).unwrap();
        let file = aroll("/c/v/a.MOV");
        let metadata = detection_entry(&file, Some(size(3840, 2160)), None);
        let checked = with_picture(&metadata, Rotation::Cw270);
        let cached = || store.video("c/v").type_detection;

        // The background check finished before the scan that started earlier saved its entry.
        save_picture_result(&store, "c/v", checked.clone());
        save_detections(&store, vec![("c/v".into(), metadata.clone())]);
        assert_eq!(cached(), Some(checked.clone()));

        // A new version of the file replaces it, and a late result for the old version is
        // dropped.
        let newer = detection_entry(
            &ArollFile {
                size: 200,
                ..file.clone()
            },
            Some(size(3840, 2160)),
            None,
        );
        save_detections(&store, vec![("c/v".into(), newer.clone())]);
        assert_eq!(cached(), Some(newer.clone()));
        save_picture_result(&store, "c/v", checked);
        assert_eq!(cached(), Some(newer));
    }

    #[test]
    fn background_checks_run_once_per_file_version_and_report() {
        use crate::orientation::PictureCheckError;
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        use std::sync::{Arc, Barrier, mpsc};

        let running = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Barrier::new(3));
        let (tx, rx) = mpsc::channel::<(String, TypeDetection)>();
        let tx = std::sync::Mutex::new(tx);
        let check = {
            let (running, most, calls, gate) = (
                Arc::clone(&running),
                Arc::clone(&most),
                Arc::clone(&calls),
                Arc::clone(&gate),
            );
            move |path: &Path| {
                calls.fetch_add(1, AtomicOrdering::SeqCst);
                let now = running.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                most.fetch_max(now, AtomicOrdering::SeqCst);
                let name = path.to_string_lossy().into_owned();
                if name.contains("gate") {
                    gate.wait();
                }
                running.fetch_sub(1, AtomicOrdering::SeqCst);
                if name.contains("fail") {
                    Err(PictureCheckError::Failed("crashed".into()))
                } else {
                    Ok(Rotation::Cw270)
                }
            }
        };
        let checks = pictures::Checks::start(
            2,
            Box::new(check),
            Box::new(move |id: &str, entry: TypeDetection| {
                let _ = tx
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .send((id.to_owned(), entry));
            }),
        );
        let entry = |name: &str| detection_entry(&aroll(name), Some(size(3840, 2160)), None);

        // Two checks hold both workers until the test lets them go; a third waits its turn and
        // duplicates are ignored.
        checks.request("c/a", &entry("/gate-a.MOV"));
        checks.request("c/b", &entry("/gate-b.MOV"));
        checks.request("c/a", &entry("/gate-a.MOV"));
        checks.request("c/c", &entry("/c.MOV"));
        gate.wait();
        let mut done: Vec<(String, TypeDetection)> = (0..3)
            .map(|_| rx.recv_timeout(Duration::from_secs(60)).expect("a result"))
            .collect();
        done.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            done.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            ["c/a", "c/b", "c/c"]
        );
        assert!(
            done.iter()
                .all(|(_, e)| e.detected == Some(VideoType::Short)
                    && e.picture_rotation == Some(270))
        );
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 3);
        assert!(most.load(AtomicOrdering::SeqCst) <= 2);

        // A failure reports nothing and is not retried this session.
        let failing = entry("/fail.MOV");
        checks.request("c/f", &failing);
        let deadline = Instant::now() + Duration::from_secs(60);
        while !checks.failed("c/f", &failing) {
            assert!(Instant::now() < deadline, "the failing check never ran");
            std::thread::sleep(Duration::from_millis(5));
        }
        checks.request("c/f", &failing);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 4);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn store_cache_round_trip_with_the_picture_check() {
        let data = tempfile::tempdir().unwrap();
        let store = Store::open(data.path()).unwrap();
        let path = data.path().join("clip.mp4");
        fs::copy(fixture("portrait-faststart.mp4"), &path).unwrap();
        let main = ArollFile::new(path.clone(), &fs::metadata(&path).unwrap());
        let detection = detect_video_type(&store, "c/v", Some(&main));
        assert_eq!(detection.video_type, Some(VideoType::Short));
        assert_eq!(detection.rotation, None);
        let cached = store.video("c/v").type_detection.unwrap();
        assert_eq!(cached.detected, Some(VideoType::Short));
        assert_eq!(cached.size, main.size);
        // With the helper (macOS), the picture check ran right away and saw no face: cached as
        // upright. Without it, nothing is cached for the picture and it stays pending.
        let expected = crate::orientation::available().then_some(0);
        assert_eq!(cached.picture_rotation, expected);
    }

    /// Prints the detection of every video folder's main A-roll in a real Editing Folder, read
    /// only, for tuning and checking the picture check on real footage (which never enters the
    /// repository):
    /// `VIDAI_VERIFY_EDITING_FOLDER=<folder> cargo test --lib verify_real_footage -- --ignored --nocapture`
    #[test]
    #[ignore = "needs real footage in VIDAI_VERIFY_EDITING_FOLDER"]
    fn verify_real_footage() {
        use crate::scanner::{is_reserved_channel_entry, is_reserved_root_name};
        let root = PathBuf::from(
            std::env::var_os("VIDAI_VERIFY_EDITING_FOLDER").expect("VIDAI_VERIFY_EDITING_FOLDER"),
        );
        let dirs = |dir: &Path, keep: &dyn Fn(&str) -> bool| -> Vec<PathBuf> {
            let mut out: Vec<PathBuf> = fs::read_dir(dir)
                .map(|entries| entries.flatten().map(|e| e.path()).collect())
                .unwrap_or_default();
            out.retain(|p| p.is_dir() && keep(&p.file_name().unwrap().to_string_lossy()));
            out.sort();
            out
        };
        println!("video | main A-roll | metadata | picture | type | rotation | seconds");
        for channel in dirs(&root, &|n| !is_reserved_root_name(n)) {
            for video in dirs(&channel, &|n| !is_reserved_channel_entry(n)) {
                let files: Vec<ArollFile> = fs::read_dir(&video)
                    .unwrap()
                    .flatten()
                    .filter(|e| {
                        e.path().is_file() && is_aroll_name(&e.file_name().to_string_lossy())
                    })
                    .map(|e| ArollFile::new(e.path(), &e.metadata().unwrap()))
                    .collect();
                let Some(main) = main_aroll(&files) else {
                    continue;
                };
                let started = Instant::now();
                let metadata = detect_with_cache(None, Some(main));
                let picture = crate::orientation::check_picture(&main.path);
                let entry = match (&metadata.entry, &picture) {
                    (Some(entry), Ok(rotation)) => with_picture(entry, *rotation),
                    (Some(entry), Err(_)) => entry.clone(),
                    (None, _) => continue,
                };
                let detection = Detection::of(&entry);
                println!(
                    "{} | {} | {:?} | {:?} | {:?} | {:?} | {:.2}",
                    video.strip_prefix(&root).unwrap().display(),
                    main.path.file_name().unwrap().to_string_lossy(),
                    metadata.detection.video_type,
                    picture,
                    detection.video_type,
                    detection.rotation,
                    started.elapsed().as_secs_f64()
                );
            }
        }
    }
}

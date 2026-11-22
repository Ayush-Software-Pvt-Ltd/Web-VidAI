//! The file picker's routes (SPEC section 12, Server): `POST /api/fs/list`, `POST /api/fs/places`
//! and `POST /api/fs/create-folder`. A browser cannot give a page real paths, so the page shows
//! its own dialog and asks the server for folders.
//!
//! The logic is in plain functions that take paths ([`list`], [`places`], [`create_folder`]); the
//! handlers only read the request, run one of them off the async runtime and answer. Every error
//! is the core's `AppError` as JSON with status 400. These routes change nothing but the one
//! folder that `create_folder` makes.
//!
//! Paths in answers are always text: an entry whose name is not valid UTF-8 is left out, because
//! the page could not send its path back.

use std::cmp::Ordering;
use std::fs::Metadata;
use std::path::{Component, Path, PathBuf};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use vidai_lib::error::{AppError, AppResult};

/// Windows: the hidden and the system attribute (`FILE_ATTRIBUTE_HIDDEN`, `FILE_ATTRIBUTE_SYSTEM`).
#[cfg(windows)]
const HIDDEN_OR_SYSTEM: u32 = 0x2 | 0x4;

/// What the page sends to `/api/fs/list`. A missing `path` is `null`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListRequest {
    #[serde(default)]
    path: Option<String>,
}

/// What the page sends to `/api/fs/create-folder`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRequest {
    parent: String,
    name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Folder,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
}

/// The answer of `/api/fs/list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// The folder that was listed.
    pub path: String,
    /// Its parent, `null` at the top of a volume or drive.
    pub parent: Option<String>,
    /// The last part of the asked path when a parent was listed instead, else `null`.
    pub name: Option<String>,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaceKind {
    Home,
    Desktop,
    Documents,
    Downloads,
    Movies,
    Volume,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub name: String,
    pub path: String,
    pub kind: PlaceKind,
}

/// The answer of `/api/fs/create-folder`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub path: String,
}

/// The well-known folders of the user, as the platform names them (some may not exist).
#[derive(Debug, Clone, Default)]
pub struct Known {
    pub home: Option<PathBuf>,
    pub desktop: Option<PathBuf>,
    pub documents: Option<PathBuf>,
    pub downloads: Option<PathBuf>,
    pub movies: Option<PathBuf>,
}

impl Known {
    /// From Tauri's path API (the home folder, Desktop, Documents, Downloads and Movies on a Mac
    /// or Videos on Windows).
    pub fn of(app: &AppHandle) -> Self {
        let paths = app.path();
        Self {
            home: paths.home_dir().ok(),
            desktop: paths.desktop_dir().ok(),
            documents: paths.document_dir().ok(),
            downloads: paths.download_dir().ok(),
            movies: paths.video_dir().ok(),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The plain functions
// ---------------------------------------------------------------------------------------------

/// The path as text, or an error when it is not valid UTF-8.
fn text(path: &Path) -> Option<String> {
    path.to_str().map(str::to_owned)
}

/// `.` parts and `..` parts resolved by the text of the path (as a shell's `cd` does, symlinks
/// are not followed for `..`), and no trailing separator except at a root.
pub fn clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                // `..` at a root stays at the root.
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => out.push(component),
            },
            other => out.push(other),
        }
    }
    out
}

/// Whether the entry is hidden: a leading dot, and on Windows the hidden or system attribute.
fn hidden(name: &str, own: &Metadata) -> bool {
    name.starts_with('.') || windows_hidden(own)
}

#[cfg(windows)]
fn windows_hidden(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & HIDDEN_OR_SYSTEM != 0
}

#[cfg(not(windows))]
fn windows_hidden(_: &Metadata) -> bool {
    false
}

/// The visible entries of `folder`: folders first, then files, each by name without regard to
/// case. A symlink counts as what it points to, and what cannot be read is left out.
fn entries_of(folder: &Path) -> AppResult<Vec<Entry>> {
    let reader =
        std::fs::read_dir(folder).map_err(|err| AppError::io_at("Could not read", folder, err))?;
    let mut entries = Vec::new();
    for item in reader.flatten() {
        let Ok(name) = item.file_name().into_string() else {
            continue;
        };
        let path = item.path();
        let Some(path) = text(&path) else {
            continue;
        };
        // The entry itself for the hidden bit (a link has its own), what it points to for the
        // kind. A link that leads nowhere, or an entry that cannot be examined, is skipped.
        let Ok(own) = item.metadata() else {
            continue;
        };
        if hidden(&name, &own) {
            continue;
        }
        let Ok(target) = std::fs::metadata(item.path()) else {
            continue;
        };
        let kind = if target.is_dir() {
            EntryKind::Folder
        } else {
            EntryKind::File
        };
        entries.push(Entry { name, path, kind });
    }
    entries.sort_by(compare);
    Ok(entries)
}

fn compare(a: &Entry, b: &Entry) -> Ordering {
    let rank = |e: &Entry| u8::from(e.kind == EntryKind::File);
    rank(a)
        .cmp(&rank(b))
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        .then_with(|| a.name.cmp(&b.name))
}

/// Lists one folder for the picker. `path` `None` or one that is not absolute lists `home`; a
/// folder is listed itself; anything else (a file, a path that does not exist) lists its nearest
/// existing parent folder, and `name` carries the last part of what was asked.
pub fn list(path: Option<&str>, home: Option<&Path>) -> AppResult<Listing> {
    let asked = path.map(Path::new).filter(|p| p.is_absolute()).map(clean);
    let (folder, name) = match &asked {
        Some(asked) if asked.is_dir() => (asked.clone(), None),
        Some(asked) => {
            let name = asked.file_name().map(|n| n.to_string_lossy().into_owned());
            let nearest = asked
                .ancestors()
                .skip(1)
                .find(|p| p.is_dir())
                .map(Path::to_path_buf);
            match nearest {
                Some(nearest) => (nearest, name),
                None => (home_folder(home)?, name),
            }
        }
        None => (home_folder(home)?, None),
    };
    let entries = entries_of(&folder)?;
    let path =
        text(&folder).ok_or_else(|| AppError::invalid_input("The folder name is not text."))?;
    let parent = folder.parent().and_then(text);
    Ok(Listing {
        path,
        parent,
        name,
        entries,
    })
}

fn home_folder(home: Option<&Path>) -> AppResult<PathBuf> {
    home.map(clean)
        .filter(|h| h.is_dir())
        .ok_or_else(|| AppError::not_found("The home folder of this computer was not found."))
}

/// The shortcuts that exist: the well-known folders, then the volumes (macOS) or drives
/// (Windows).
pub fn places(known: &Known, volumes: Vec<Place>) -> Vec<Place> {
    let mut out = Vec::new();
    let wanted = [
        ("Home", &known.home, PlaceKind::Home),
        ("Desktop", &known.desktop, PlaceKind::Desktop),
        ("Documents", &known.documents, PlaceKind::Documents),
        ("Downloads", &known.downloads, PlaceKind::Downloads),
        (
            if cfg!(windows) { "Videos" } else { "Movies" },
            &known.movies,
            PlaceKind::Movies,
        ),
    ];
    for (name, path, kind) in wanted {
        let Some(path) = path.as_deref().filter(|p| p.is_dir()) else {
            continue;
        };
        if let Some(path) = text(path) {
            out.push(Place {
                name: name.into(),
                path,
                kind,
            });
        }
    }
    out.extend(volumes);
    out
}

/// The volumes of this computer: the entries of `/Volumes` on macOS, the drives on Windows.
pub fn volumes() -> Vec<Place> {
    if cfg!(target_os = "macos") {
        mac_volumes(Path::new("/Volumes"))
    } else if cfg!(windows) {
        windows_drives(|root| root.exists())
    } else {
        Vec::new()
    }
}

/// The folders of `dir` (`/Volumes`), sorted by name, without the startup disk, which is there
/// as a link to `/`.
pub fn mac_volumes(dir: &Path) -> Vec<Place> {
    let Ok(reader) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<Place> = reader
        .flatten()
        .filter_map(|item| {
            let name = item.file_name().into_string().ok()?;
            let path = item.path();
            if name.starts_with('.') || !path.is_dir() {
                return None;
            }
            if std::fs::canonicalize(&path).is_ok_and(|real| real == Path::new("/")) {
                return None;
            }
            Some(Place {
                name,
                path: text(&path)?,
                kind: PlaceKind::Volume,
            })
        })
        .collect();
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

/// The drives `A:\` to `Z:\` for which `exists` says yes.
pub fn windows_drives(exists: impl Fn(&Path) -> bool) -> Vec<Place> {
    ('A'..='Z')
        .filter_map(|letter| {
            let root = format!("{letter}:\\");
            exists(Path::new(&root)).then(|| Place {
                name: format!("{letter}:"),
                path: root,
                kind: PlaceKind::Volume,
            })
        })
        .collect()
}

/// Why `name` cannot be the name of a new folder, if it cannot. `windows` applies the rules of
/// Windows too (the reserved characters, device names, a trailing dot or space).
pub fn bad_folder_name(name: &str, windows: bool) -> Option<&'static str> {
    if name.trim().is_empty() {
        return Some("Type a name for the folder.");
    }
    if name == "." || name == ".." {
        return Some("That is not a name for a folder.");
    }
    if name.contains(['/', '\\']) && (windows || name.contains('/')) {
        return Some("A folder name cannot contain a slash.");
    }
    if name.chars().any(char::is_control) {
        return Some("A folder name cannot contain control characters.");
    }
    // Exactly one normal part (this also rejects a drive prefix such as `C:`).
    let mut parts = Path::new(name).components();
    let single = matches!(parts.next(), Some(Component::Normal(part)) if part == name);
    if !single || parts.next().is_some() {
        return Some("A folder name must be one name, not a path.");
    }
    if windows {
        if name.contains(['<', '>', ':', '"', '|', '?', '*']) {
            return Some("A folder name cannot contain any of < > : \" | ? *");
        }
        if name.ends_with('.') || name.ends_with(' ') {
            return Some("A folder name cannot end with a dot or a space.");
        }
        let stem = name.split('.').next().unwrap_or(name).trim_end();
        const DEVICES: [&str; 22] = [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ];
        if DEVICES.iter().any(|d| d.eq_ignore_ascii_case(stem)) {
            return Some("Windows does not allow that name for a folder.");
        }
    }
    None
}

/// Makes the folder `name` inside `parent` and returns its path. An existing name (of a folder,
/// a file or a link) is an error: nothing is ever overwritten.
pub fn create_folder(parent: &str, name: &str, windows: bool) -> AppResult<Created> {
    if let Some(problem) = bad_folder_name(name, windows) {
        return Err(AppError::invalid_input(problem));
    }
    let parent = Path::new(parent);
    if !parent.is_absolute() {
        return Err(AppError::invalid_input("The folder must be a full path."));
    }
    let parent = clean(parent);
    if !parent.exists() {
        return Err(AppError::not_found(format!(
            "{} does not exist.",
            parent.display()
        )));
    }
    if !parent.is_dir() {
        return Err(AppError::invalid_input(format!(
            "{} is not a folder.",
            parent.display()
        )));
    }
    let path = parent.join(name);
    match std::fs::create_dir(&path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(AppError::conflict(format!(
                "\"{name}\" already exists in {}.",
                parent.display()
            )));
        }
        Err(err) => return Err(AppError::io_at("Could not create", &path, err)),
    }
    let path =
        text(&path).ok_or_else(|| AppError::invalid_input("The folder name is not text."))?;
    Ok(Created { path })
}

// ---------------------------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------------------------

/// `POST /api/fs/list`.
pub async fn list_handler(State(app): State<AppHandle>, body: Bytes) -> Response {
    let result = match parse::<ListRequest>(&body) {
        Ok(request) => {
            let home = app.path().home_dir().ok();
            blocking(move || list(request.path.as_deref(), home.as_deref())).await
        }
        Err(err) => Err(err),
    };
    answer(result)
}

/// `POST /api/fs/places` (the body is not read).
pub async fn places_handler(State(app): State<AppHandle>) -> Response {
    let known = Known::of(&app);
    answer(blocking(move || Ok(places(&known, volumes()))).await)
}

/// `POST /api/fs/create-folder`.
pub async fn create_folder_handler(body: Bytes) -> Response {
    let result = match parse::<CreateRequest>(&body) {
        Ok(request) => {
            blocking(move || create_folder(&request.parent, &request.name, cfg!(windows))).await
        }
        Err(err) => Err(err),
    };
    answer(result)
}

fn parse<T: for<'de> Deserialize<'de>>(body: &[u8]) -> AppResult<T> {
    // An empty body is `{}`, so a missing `path` is `null`.
    let body = if body.iter().all(u8::is_ascii_whitespace) {
        b"{}".as_slice()
    } else {
        body
    };
    serde_json::from_slice(body)
        .map_err(|err| AppError::invalid_input(format!("The request is not valid: {err}")))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|err| Err(AppError::internal(format!("The folder work failed: {err}"))))
}

/// 200 with the JSON of `value`, or 400 with the JSON of the error.
fn answer<T: Serialize>(result: AppResult<T>) -> Response {
    let (status, body) = match result {
        Ok(value) => (StatusCode::OK, serde_json::to_string(&value)),
        Err(err) => (StatusCode::BAD_REQUEST, serde_json::to_string(&err)),
    };
    let mut response = (status, body.unwrap_or_default()).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use vidai_lib::error::ErrorCode;

    fn names(listing: &Listing) -> Vec<&str> {
        listing.entries.iter().map(|e| e.name.as_str()).collect()
    }

    fn s(path: &Path) -> &str {
        path.to_str().unwrap()
    }

    #[test]
    fn lists_folders_first_then_files_each_by_name_without_case() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for name in ["beta", "Alpha", "gamma"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        for name in ["b.txt", "A.txt", "c.txt", "Z.txt"] {
            fs::write(root.join(name), b"x").unwrap();
        }
        let listing = list(Some(s(root)), None).unwrap();
        assert_eq!(
            names(&listing),
            ["Alpha", "beta", "gamma", "A.txt", "b.txt", "c.txt", "Z.txt"]
        );
        assert_eq!(listing.path, s(root));
        assert_eq!(listing.name, None);
        assert_eq!(
            listing.parent.as_deref(),
            root.parent().and_then(Path::to_str)
        );
        assert_eq!(listing.entries[0].kind, EntryKind::Folder);
        assert_eq!(listing.entries[3].kind, EntryKind::File);
        assert_eq!(listing.entries[0].path, s(&root.join("Alpha")));
    }

    #[test]
    fn hidden_entries_are_left_out() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".DS_Store"), b"x").unwrap();
        fs::write(dir.path().join("visible.txt"), b"x").unwrap();
        let listing = list(Some(s(dir.path())), None).unwrap();
        assert_eq!(names(&listing), ["visible.txt"]);
    }

    #[test]
    fn a_file_lists_its_folder_and_names_the_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("clip.mp4"), b"x").unwrap();
        let asked = dir.path().join("clip.mp4");
        let listing = list(Some(s(&asked)), None).unwrap();
        assert_eq!(listing.path, s(dir.path()));
        assert_eq!(listing.name.as_deref(), Some("clip.mp4"));
        assert_eq!(names(&listing), ["clip.mp4"]);
    }

    #[test]
    fn a_missing_path_lists_the_nearest_existing_parent() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("a")).unwrap();
        let asked = dir.path().join("a").join("b").join("c");
        let listing = list(Some(s(&asked)), None).unwrap();
        assert_eq!(listing.path, s(&dir.path().join("a")));
        assert_eq!(listing.name.as_deref(), Some("c"));
        assert!(listing.entries.is_empty());
    }

    #[test]
    fn null_or_a_path_that_is_not_absolute_lists_home() {
        let home = tempfile::tempdir().unwrap();
        fs::write(home.path().join("h.txt"), b"x").unwrap();
        for path in [None, Some(""), Some("relative/dir"), Some("~"), Some("..")] {
            let listing = list(path, Some(home.path())).unwrap();
            assert_eq!(listing.path, s(home.path()), "{path:?}");
            assert_eq!(listing.name, None, "{path:?}");
            assert_eq!(names(&listing), ["h.txt"]);
        }
        // No home folder at all is an error, not a panic.
        assert_eq!(list(None, None).unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn dot_dot_is_resolved_and_the_root_has_no_parent() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("a").join("b")).unwrap();
        let asked = dir.path().join("a").join("b").join("..").join(".");
        let listing = list(Some(s(&asked)), None).unwrap();
        assert_eq!(listing.path, s(&dir.path().join("a")));
        let listing = list(Some(if cfg!(windows) { "C:\\" } else { "/" }), None).unwrap();
        assert_eq!(listing.parent, None);
        assert_eq!(clean(Path::new("/..")), PathBuf::from("/"));
        assert_eq!(clean(Path::new("/a/../..")), PathBuf::from("/"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_count_as_what_they_point_to_and_broken_ones_are_skipped() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("real-dir")).unwrap();
        fs::write(root.join("real.txt"), b"x").unwrap();
        symlink(root.join("real-dir"), root.join("link-dir")).unwrap();
        symlink(root.join("real.txt"), root.join("link-file")).unwrap();
        symlink(root.join("nothing"), root.join("broken")).unwrap();
        symlink(root.join("real-dir"), root.join(".hidden-link")).unwrap();
        let listing = list(Some(s(root)), None).unwrap();
        assert_eq!(
            listing
                .entries
                .iter()
                .map(|e| (e.name.as_str(), e.kind))
                .collect::<Vec<_>>(),
            [
                ("link-dir", EntryKind::Folder),
                ("real-dir", EntryKind::Folder),
                ("link-file", EntryKind::File),
                ("real.txt", EntryKind::File),
            ]
        );
        // A link to a folder can be listed.
        let linked = list(Some(s(&root.join("link-dir"))), None).unwrap();
        assert_eq!(linked.name, None);
        assert_eq!(linked.path, s(&root.join("link-dir")));
    }

    #[cfg(unix)]
    #[test]
    fn names_that_are_not_utf8_are_skipped() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        // macOS file systems refuse such a name, so there is nothing to test there.
        if fs::write(dir.path().join(OsStr::from_bytes(b"bad-\xff.txt")), b"x").is_err() {
            return;
        }
        fs::write(dir.path().join("good.txt"), b"x").unwrap();
        let listing = list(Some(s(dir.path())), None).unwrap();
        assert_eq!(names(&listing), ["good.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_folder_is_an_io_error() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let result = list(Some(s(&locked)), None);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        // Root (a CI container) can read it anyway.
        if let Err(err) = result {
            assert_eq!(err.code, ErrorCode::Io);
            assert!(err.message.contains("locked"), "{}", err.message);
        }
    }

    #[test]
    fn places_keep_what_exists_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let desktop = home.join("Desktop");
        let movies = home.join("Movies");
        fs::create_dir_all(&desktop).unwrap();
        fs::create_dir_all(&movies).unwrap();
        let known = Known {
            home: Some(home.clone()),
            desktop: Some(desktop.clone()),
            documents: Some(home.join("Documents")), // does not exist
            downloads: None,
            movies: Some(movies.clone()),
        };
        let volume = Place {
            name: "USB".into(),
            path: "/Volumes/USB".into(),
            kind: PlaceKind::Volume,
        };
        let out = places(&known, vec![volume.clone()]);
        let kinds: Vec<_> = out.iter().map(|p| p.kind).collect();
        assert_eq!(
            kinds,
            [
                PlaceKind::Home,
                PlaceKind::Desktop,
                PlaceKind::Movies,
                PlaceKind::Volume
            ]
        );
        assert_eq!(out[0].name, "Home");
        assert_eq!(out[0].path, s(&home));
        assert_eq!(out[3], volume);
    }

    #[cfg(unix)]
    #[test]
    fn mac_volumes_leave_out_the_startup_disk_link_and_hidden_entries() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("usb")).unwrap();
        fs::create_dir(dir.path().join("Backup")).unwrap();
        fs::create_dir(dir.path().join(".hidden")).unwrap();
        fs::write(dir.path().join("a-file"), b"x").unwrap();
        symlink("/", dir.path().join("Macintosh HD")).unwrap();
        let out = mac_volumes(dir.path());
        assert_eq!(
            out.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            ["Backup", "usb"]
        );
        assert!(out.iter().all(|p| p.kind == PlaceKind::Volume));
        assert!(mac_volumes(&dir.path().join("missing")).is_empty());
    }

    #[test]
    fn windows_drives_are_the_existing_roots() {
        let drives = windows_drives(|root| matches!(root.to_str(), Some("C:\\" | "E:\\")));
        assert_eq!(
            drives,
            [
                Place {
                    name: "C:".into(),
                    path: "C:\\".into(),
                    kind: PlaceKind::Volume
                },
                Place {
                    name: "E:".into(),
                    path: "E:\\".into(),
                    kind: PlaceKind::Volume
                },
            ]
        );
        assert!(windows_drives(|_| false).is_empty());
    }

    #[test]
    fn folder_names_must_be_one_normal_part() {
        for good in ["New Folder", "a.b", ".dotted", "video 001", "ü"] {
            assert_eq!(bad_folder_name(good, false), None, "{good}");
            assert_eq!(bad_folder_name(good, true), None, "{good}");
        }
        for bad in [
            "", " ", "   ", ".", "..", "a/b", "/a", "a/", "../x", "a\0b", "a\nb",
        ] {
            assert!(bad_folder_name(bad, false).is_some(), "{bad:?}");
            assert!(bad_folder_name(bad, true).is_some(), "{bad:?}");
        }
        // A backslash is a separator on Windows only.
        assert_eq!(bad_folder_name("a\\b", false), None);
        assert!(bad_folder_name("a\\b", true).is_some());
        for bad in [
            "a:b", "C:", "a<b", "a>b", "a\"b", "a|b", "a?b", "a*b", "name.", "name ", "CON", "con",
            "Nul.txt", "COM1", "lpt9 ",
        ] {
            assert!(bad_folder_name(bad, true).is_some(), "{bad:?}");
        }
        assert_eq!(bad_folder_name("a:b", false), None);
        assert_eq!(bad_folder_name("CONSOLE", true), None);
    }

    #[test]
    fn create_folder_makes_one_folder_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let parent = s(dir.path());
        let created = create_folder(parent, "New Folder", cfg!(windows)).unwrap();
        assert_eq!(created.path, s(&dir.path().join("New Folder")));
        assert!(dir.path().join("New Folder").is_dir());

        let again = create_folder(parent, "New Folder", cfg!(windows)).unwrap_err();
        assert_eq!(again.code, ErrorCode::Conflict);
        assert!(
            again.message.contains("already exists"),
            "{}",
            again.message
        );

        // A file or a link of that name is not replaced either.
        fs::write(dir.path().join("a.txt"), b"keep").unwrap();
        let err = create_folder(parent, "a.txt", cfg!(windows)).unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"keep");

        // Not a path, not above, and nothing created for a bad name.
        for bad in ["", "..", "x/y", "../x"] {
            let err = create_folder(parent, bad, cfg!(windows)).unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidInput, "{bad:?}");
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn create_folder_needs_an_existing_absolute_folder() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f"), b"x").unwrap();
        let missing = dir.path().join("missing");
        assert_eq!(
            create_folder(s(&missing), "x", false).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert!(!missing.exists());
        assert_eq!(
            create_folder(s(&dir.path().join("f")), "x", false)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            create_folder("relative", "x", false).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    #[cfg(unix)]
    #[test]
    fn create_folder_does_not_follow_a_dangling_link_of_that_name() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("elsewhere");
        symlink(&target, dir.path().join("trap")).unwrap();
        let err = create_folder(s(dir.path()), "trap", false).unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert!(!target.exists());
    }

    #[test]
    fn the_json_shapes_are_camel_case() {
        let listing = Listing {
            path: "/a".into(),
            parent: None,
            name: Some("x".into()),
            entries: vec![Entry {
                name: "f".into(),
                path: "/a/f".into(),
                kind: EntryKind::Folder,
            }],
        };
        assert_eq!(
            serde_json::to_value(&listing).unwrap(),
            serde_json::json!({
                "path": "/a", "parent": null, "name": "x",
                "entries": [{ "name": "f", "path": "/a/f", "kind": "folder" }]
            })
        );
        let place = Place {
            name: "Home".into(),
            path: "/h".into(),
            kind: PlaceKind::Movies,
        };
        assert_eq!(
            serde_json::to_value(&place).unwrap(),
            serde_json::json!({ "name": "Home", "path": "/h", "kind": "movies" })
        );
    }

    #[test]
    fn requests_parse_leniently_and_errors_are_app_errors() {
        let ok: ListRequest = parse(br#"{"path": null}"#).unwrap();
        assert_eq!(ok.path, None);
        let ok: ListRequest = parse(b"").unwrap();
        assert_eq!(ok.path, None);
        let ok: ListRequest = parse(br#"{"path": "/a"}"#).unwrap();
        assert_eq!(ok.path.as_deref(), Some("/a"));
        let err = parse::<CreateRequest>(br#"{"parent": "/a"}"#).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        let err = parse::<ListRequest>(b"[1]").unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[cfg(windows)]
    #[test]
    fn windows_hidden_and_system_attributes_hide_entries() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("shown.txt"), b"x").unwrap();
        for (name, attribute) in [("hid.txt", 0x2), ("sys.txt", 0x4)] {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .attributes(attribute)
                .open(dir.path().join(name))
                .unwrap();
        }
        let listing = list(Some(s(dir.path())), None).unwrap();
        assert_eq!(names(&listing), ["shown.txt"]);
    }
}

//! Editing Folder and channel rules (SPEC sections 2 and 5, "Channel command behaviour").
//!
//! Plain functions over the [`Store`] and the disk, so they are unit-tested without Tauri; the
//! commands in `settings.rs` wrap them and ask the scanner for a rescan afterwards.
//!
//! A video's state is keyed by `<channelId>/<folderName>` and channel ids are stable across
//! renames, so renaming a channel folder needs no state migration.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::model::{
    CHANNEL_SLOTS, Channel, ChannelProfile, ChannelSlot, ChannelUpdate, ChannelVideoType,
    MAX_SLOT_NAME_CHARS, Settings,
};
use crate::store::Store;

/// Longest folder name accepted, in bytes (the macOS and Windows limit for one path component).
const MAX_NAME_BYTES: usize = 255;

/// Checks a channel folder name typed by the user and returns it trimmed.
///
/// Rules: not empty, no `/`, `\` or `:`, no control characters, not `.` or `..`, and not reserved
/// at the Editing Folder root (starting with `.` or with `CLAUDE_VE`, in any letter case because
/// macOS file names are case-insensitive).
pub fn validate_folder_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::invalid_input("Enter a folder name."));
    }
    if name.contains(['/', '\\', ':']) || name.chars().any(char::is_control) {
        return Err(AppError::invalid_input(
            "A folder name cannot contain /, \\, : or line breaks.",
        ));
    }
    if name.starts_with('.') {
        return Err(AppError::invalid_input(
            "A channel folder name cannot start with a dot.",
        ));
    }
    if name.to_uppercase().starts_with("CLAUDE_VE") {
        return Err(AppError::invalid_input(
            "Names starting with CLAUDE_VE are reserved for the toolkit.",
        ));
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(AppError::invalid_input("This folder name is too long."));
    }
    // Windows cannot store some names at all (SPEC section 11).
    #[cfg(windows)]
    if crate::platform::windows_name_problem(name).is_some() {
        return Err(AppError::invalid_input(
            "Windows does not allow this folder name. Avoid < > \" | ? * and names such as CON or NUL.",
        ));
    }
    Ok(name.to_owned())
}

/// Checks a profile sent by the UI: exactly [`CHANNEL_SLOTS`] prompts and styles, names not empty
/// and not longer than [`MAX_SLOT_NAME_CHARS`] (trimmed). Slot 0 is always named "Default".
fn validate_profile(mut profile: ChannelProfile) -> AppResult<ChannelProfile> {
    for (label, slots) in [
        ("prompt", &mut profile.prompts),
        ("style", &mut profile.styles),
    ] {
        if slots.len() != CHANNEL_SLOTS {
            return Err(AppError::invalid_input(format!(
                "Each video type has exactly {CHANNEL_SLOTS} {label}s."
            )));
        }
        for (index, slot) in slots.iter_mut().enumerate() {
            if index == 0 {
                slot.name = ChannelSlot::empty(label, 0).name;
                continue;
            }
            let name = slot.name.trim();
            if name.is_empty() || name.chars().count() > MAX_SLOT_NAME_CHARS {
                return Err(AppError::invalid_input(format!(
                    "Name {label} {} with 1 to {MAX_SLOT_NAME_CHARS} characters.",
                    index + 1
                )));
            }
            slot.name = name.to_owned();
        }
    }
    Ok(profile)
}

/// Folder names are compared without letter case, like the macOS file system does.
fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// The Editing Folder of these settings; `noEditingFolder` when none is set, `notFound` when it
/// is gone.
pub fn editing_folder(settings: &Settings) -> AppResult<PathBuf> {
    let folder = settings
        .editing_folder
        .as_deref()
        .ok_or_else(AppError::no_editing_folder)?;
    let folder = PathBuf::from(folder);
    if !folder.is_dir() {
        return Err(AppError::not_found(format!(
            "The Editing Folder {} is not available. Connect its drive or choose it again in Settings.",
            folder.display()
        )));
    }
    Ok(folder)
}

/// Whether any video of the channel has an active job (SPEC section 6).
pub fn has_active_job(store: &Store, channel_id: &str) -> bool {
    let prefix = format!("{channel_id}/");
    store
        .latest_jobs()
        .iter()
        .any(|job| job.state.is_active() && job.video_id.starts_with(&prefix))
}

fn any_active_job(store: &Store) -> bool {
    store.latest_jobs().iter().any(|job| job.state.is_active())
}

/// The text of `<channel>/Style/STYLE.md`, or empty when there is none. The file is only read.
pub fn read_style(channel_dir: &Path) -> String {
    let path = channel_dir.join("Style").join("STYLE.md");
    if !path.is_file() {
        return String::new();
    }
    fs::read(&path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

fn new_channel(folder_name: String, prompt: &str, style: String) -> Channel {
    let profile = ChannelProfile::with_defaults(prompt.to_owned(), style);
    Channel {
        id: uuid::Uuid::new_v4().to_string(),
        folder_name,
        video_type: ChannelVideoType::Auto,
        long: profile.clone(),
        short: profile,
    }
}

fn ensure_not_added(
    settings: &Settings,
    folder_name: &str,
    except_id: Option<&str>,
) -> AppResult<()> {
    let taken = settings
        .channels
        .iter()
        .any(|c| Some(c.id.as_str()) != except_id && same_name(&c.folder_name, folder_name));
    if taken {
        return Err(AppError::conflict(format!(
            "A channel for the folder {folder_name} already exists."
        )));
    }
    Ok(())
}

fn find<'a>(settings: &'a mut Settings, id: &str) -> AppResult<&'a mut Channel> {
    settings
        .channels
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::not_found("This channel no longer exists."))
}

/// Saves a new Editing Folder after checking it. Returns the settings and the folder path.
/// Changing the folder while an edit is active is refused with `conflict`, because running
/// Claude Code processes work inside the current folder.
pub fn set_editing_folder(store: &Store, path: &str) -> AppResult<(Settings, PathBuf)> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid_input("Choose a folder."));
    }
    // Drops a trailing slash and `.` components so the same folder is always stored the same way.
    let folder: PathBuf = Path::new(trimmed)
        .components()
        .filter(|c| !matches!(c, Component::CurDir))
        .collect();
    if !folder.is_absolute() {
        return Err(AppError::invalid_input(
            "Choose a folder with its full path.",
        ));
    }
    if !folder.is_dir() {
        return Err(AppError::not_found(format!(
            "{} is not an existing folder.",
            folder.display()
        )));
    }
    let value = folder.to_string_lossy().into_owned();
    if store.settings().editing_folder.as_deref() != Some(value.as_str()) && any_active_job(store) {
        return Err(AppError::conflict(
            "Pause or stop the running edits before changing the Editing Folder.",
        ));
    }
    let settings = store.update_settings(|s| {
        s.editing_folder = Some(value);
        Ok(s.clone())
    })?;
    Ok((settings, folder))
}

/// Adds an existing folder of the Editing Folder as a channel.
pub fn add(store: &Store, default_prompt: &str, folder_name: &str) -> AppResult<Settings> {
    let folder_name = validate_folder_name(folder_name)?;
    let settings = store.settings();
    let editing = editing_folder(&settings)?;
    ensure_not_added(&settings, &folder_name, None)?;
    let dir = editing.join(&folder_name);
    if !dir.is_dir() {
        return Err(AppError::not_found(format!(
            "There is no folder named {folder_name} in the Editing Folder."
        )));
    }
    let channel = new_channel(folder_name, default_prompt, read_style(&dir));
    store.update_settings(|s| {
        ensure_not_added(s, &channel.folder_name, None)?;
        s.channels.push(channel);
        Ok(s.clone())
    })
}

/// Creates a new channel folder in the Editing Folder and adds it as a channel.
pub fn create(store: &Store, default_prompt: &str, folder_name: &str) -> AppResult<Settings> {
    let folder_name = validate_folder_name(folder_name)?;
    let settings = store.settings();
    let editing = editing_folder(&settings)?;
    ensure_not_added(&settings, &folder_name, None)?;
    let dir = editing.join(&folder_name);
    if fs::symlink_metadata(&dir).is_ok() {
        return Err(AppError::conflict(format!(
            "A folder named {folder_name} already exists. Add it from the folders found in the Editing Folder instead."
        )));
    }
    fs::create_dir(&dir).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => {
            AppError::conflict(format!("A folder named {folder_name} already exists."))
        }
        _ => AppError::io_at("Could not create", &dir, e),
    })?;
    let channel = new_channel(folder_name, default_prompt, read_style(&dir));
    let saved = store.update_settings(|s| {
        ensure_not_added(s, &channel.folder_name, None)?;
        s.channels.push(channel);
        Ok(s.clone())
    });
    if saved.is_err() {
        // Undo: the folder was created by this call a moment ago and is still empty.
        let _ = fs::remove_dir(&dir);
    }
    saved
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

/// Windows: the same volume and file index (for example `tech` and `Tech`, which Windows also
/// treats as one name).
#[cfg(windows)]
fn same_file(a: &Path, b: &Path) -> bool {
    ::same_file::is_same_file(a, b).unwrap_or(false)
}

#[cfg(not(any(unix, windows)))]
fn same_file(_a: &Path, _b: &Path) -> bool {
    false
}

/// Changes a channel's video type, prompts and styles and, with a new `folderName`, renames its
/// folder. The video type may change while edits run: a job keeps the type it started with.
pub fn update(store: &Store, id: &str, update: ChannelUpdate) -> AppResult<Settings> {
    let mut current = store.settings();
    let old_name = find(&mut current, id)?.folder_name.clone();
    let long = update.long.map(validate_profile).transpose()?;
    let short = update.short.map(validate_profile).transpose()?;
    let new_name = update
        .folder_name
        .as_deref()
        .map(validate_folder_name)
        .transpose()?
        .filter(|name| *name != old_name);

    let mut renamed: Option<(PathBuf, PathBuf)> = None;
    if let Some(new_name) = &new_name {
        let editing = editing_folder(&current)?;
        ensure_not_added(&current, new_name, Some(id))?;
        if has_active_job(store, id) {
            return Err(AppError::conflict(
                "Pause or stop the edits in this channel before renaming it.",
            ));
        }
        let from = editing.join(&old_name);
        let to = editing.join(new_name);
        if !from.is_dir() {
            return Err(AppError::not_found(format!(
                "The folder {old_name} is no longer in the Editing Folder."
            )));
        }
        // A change of letter case only is the same folder on macOS and Windows, so it may be
        // renamed.
        if fs::symlink_metadata(&to).is_ok() && !same_file(&from, &to) {
            return Err(AppError::conflict(format!(
                "A folder named {new_name} already exists in the Editing Folder."
            )));
        }
        fs::rename(&from, &to).map_err(|e| AppError::io_at("Could not rename", &from, e))?;
        renamed = Some((from, to));
    }

    let saved = store.update_settings(|s| {
        let channel = find(s, id)?;
        if let Some(name) = new_name {
            channel.folder_name = name;
        }
        if let Some(video_type) = update.video_type {
            channel.video_type = video_type;
        }
        if let Some(long) = long {
            channel.long = long;
        }
        if let Some(short) = short {
            channel.short = short;
        }
        Ok(s.clone())
    });
    if saved.is_err()
        && let Some((from, to)) = renamed
    {
        // Undo the rename so the disk and the settings keep agreeing.
        let _ = fs::rename(&to, &from);
    }
    saved
}

/// Removes a channel from VidAI only; its folder stays on disk.
pub fn remove(store: &Store, id: &str) -> AppResult<Settings> {
    find(&mut store.settings(), id)?;
    if has_active_job(store, id) {
        return Err(AppError::conflict(
            "Stop the edits in this channel before removing it.",
        ));
    }
    store.update_settings(|s| {
        find(s, id)?;
        s.channels.retain(|c| c.id != id);
        Ok(s.clone())
    })
}

/// Puts the channels in the order of `ids`, which must list every channel exactly once.
pub fn reorder(store: &Store, ids: &[String]) -> AppResult<Settings> {
    store.update_settings(|s| {
        let mut remaining = std::mem::take(&mut s.channels);
        let mut ordered = Vec::with_capacity(remaining.len());
        for id in ids {
            let pos = remaining.iter().position(|c| &c.id == id).ok_or_else(|| {
                AppError::invalid_input("The channel list changed. Reload and try again.")
            })?;
            ordered.push(remaining.swap_remove(pos));
        }
        if !remaining.is_empty() {
            return Err(AppError::invalid_input(
                "The channel list changed. Reload and try again.",
            ));
        }
        s.channels = ordered;
        Ok(s.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::model::{JobKind, JobState, JobView, ToolkitKind, VideoType, video_id};
    use tempfile::TempDir;

    const PROMPT: &str = "Default prompt";

    struct Env {
        _root: TempDir,
        store: Store,
        editing: PathBuf,
    }

    fn env() -> Env {
        let root = TempDir::new().unwrap();
        let editing = root.path().join("Editing");
        fs::create_dir(&editing).unwrap();
        let store = Store::open(root.path().join("data")).unwrap();
        set_editing_folder(&store, &editing.to_string_lossy()).unwrap();
        Env {
            _root: root,
            store,
            editing,
        }
    }

    fn job(video: &str, state: JobState) -> JobView {
        JobView {
            id: "job1".into(),
            video_id: video.into(),
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

    fn put_job(store: &Store, channel_id: &str, state: JobState) {
        let id = video_id(channel_id, "Video 1");
        store
            .update_video(&id, |v| {
                v.latest_job = Some(job(&id, state));
                Ok(())
            })
            .unwrap();
    }

    fn code<T: std::fmt::Debug>(result: AppResult<T>) -> ErrorCode {
        result.unwrap_err().code
    }

    #[test]
    fn folder_name_validation() {
        assert_eq!(validate_folder_name("  My Channel ").unwrap(), "My Channel");
        assert_eq!(validate_folder_name("हिंदी चैनल").unwrap(), "हिंदी चैनल");
        for bad in [
            "",
            "   ",
            ".",
            "..",
            ".hidden",
            "a/b",
            "a:b",
            "a\\b",
            "line\nbreak",
            "CLAUDE_VE_ALL",
            "CLAUDE_VE",
            "claude_ve_all_own",
        ] {
            assert_eq!(
                code(validate_folder_name(bad)),
                ErrorCode::InvalidInput,
                "{bad:?}"
            );
        }
        assert!(validate_folder_name(&"x".repeat(256)).is_err());
        assert!(
            validate_folder_name("Style").is_ok(),
            "Style is only reserved inside a channel"
        );
        #[cfg(windows)]
        for bad in [
            "CON",
            "nul.txt",
            "a?b",
            "a|b",
            "a*",
            "\"quoted\"",
            "trailing.",
        ] {
            assert_eq!(
                code(validate_folder_name(bad)),
                ErrorCode::InvalidInput,
                "{bad:?}"
            );
        }
    }

    #[test]
    fn editing_folder_must_exist_and_is_normalized() {
        let e = env();
        assert_eq!(
            code(set_editing_folder(&e.store, "relative/path")),
            ErrorCode::InvalidInput
        );
        assert_eq!(
            code(set_editing_folder(
                &e.store,
                &e.editing.join("missing").to_string_lossy()
            )),
            ErrorCode::NotFound
        );
        let file = e.editing.join("file.txt");
        fs::write(&file, "x").unwrap();
        assert_eq!(
            code(set_editing_folder(&e.store, &file.to_string_lossy())),
            ErrorCode::NotFound
        );

        let (settings, folder) =
            set_editing_folder(&e.store, &format!(" {}/ ", e.editing.display())).unwrap();
        assert_eq!(folder, e.editing);
        assert_eq!(
            settings.editing_folder.as_deref(),
            Some(e.editing.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn editing_folder_cannot_change_during_an_active_edit() {
        let e = env();
        let other = e.editing.parent().unwrap().join("Other");
        fs::create_dir(&other).unwrap();
        put_job(&e.store, "c1", JobState::Paused);
        assert_eq!(
            code(set_editing_folder(&e.store, &other.to_string_lossy())),
            ErrorCode::Conflict
        );
        // Choosing the same folder again is harmless.
        set_editing_folder(&e.store, &e.editing.to_string_lossy()).unwrap();
        put_job(&e.store, "c1", JobState::Completed);
        set_editing_folder(&e.store, &other.to_string_lossy()).unwrap();
    }

    #[test]
    fn channel_commands_need_an_editing_folder() {
        let root = TempDir::new().unwrap();
        let store = Store::open(root.path()).unwrap();
        assert_eq!(code(add(&store, PROMPT, "A")), ErrorCode::NoEditingFolder);
        assert_eq!(
            code(create(&store, PROMPT, "A")),
            ErrorCode::NoEditingFolder
        );
    }

    #[test]
    fn add_fills_prompts_and_imports_style_once() {
        let e = env();
        let style_dir = e.editing.join("Tech/Style");
        fs::create_dir_all(&style_dir).unwrap();
        fs::write(style_dir.join("STYLE.md"), "Bold captions\n").unwrap();

        let settings = add(&e.store, PROMPT, " Tech ").unwrap();
        let channel = &settings.channels[0];
        assert_eq!(channel.folder_name, "Tech");
        assert_eq!(channel.long.prompts[0].text, PROMPT);
        assert_eq!(channel.short.prompts[0].text, PROMPT);
        assert_eq!(channel.long.styles[0].text, "Bold captions\n");
        assert_eq!(channel.short.styles[0].text, "Bold captions\n");
        assert_eq!(
            uuid::Uuid::parse_str(&channel.id)
                .unwrap()
                .get_version_num(),
            4
        );
        // STYLE.md is only read.
        assert_eq!(
            fs::read_to_string(style_dir.join("STYLE.md")).unwrap(),
            "Bold captions\n"
        );

        fs::create_dir(e.editing.join("Plain")).unwrap();
        let settings = add(&e.store, PROMPT, "Plain").unwrap();
        assert_eq!(settings.channels[1].long.styles[0].text, "");
    }

    #[test]
    fn add_rejects_missing_and_duplicate_folders() {
        let e = env();
        assert_eq!(code(add(&e.store, PROMPT, "Nope")), ErrorCode::NotFound);
        fs::write(e.editing.join("file"), "x").unwrap();
        assert_eq!(code(add(&e.store, PROMPT, "file")), ErrorCode::NotFound);
        fs::create_dir(e.editing.join("Tech")).unwrap();
        add(&e.store, PROMPT, "Tech").unwrap();
        assert_eq!(code(add(&e.store, PROMPT, "Tech")), ErrorCode::Conflict);
        assert_eq!(code(add(&e.store, PROMPT, "tech")), ErrorCode::Conflict);
        assert_eq!(
            code(add(&e.store, PROMPT, "CLAUDE_VE_ALL")),
            ErrorCode::InvalidInput
        );
        assert_eq!(e.store.settings().channels.len(), 1);
    }

    #[test]
    fn create_makes_the_folder_and_refuses_existing_ones() {
        let e = env();
        let settings = create(&e.store, PROMPT, "New One").unwrap();
        assert!(e.editing.join("New One").is_dir());
        assert_eq!(settings.channels[0].short.prompts[0].text, PROMPT);
        assert_eq!(settings.channels[0].long.styles[0].text, "");

        fs::create_dir(e.editing.join("Existing")).unwrap();
        assert_eq!(
            code(create(&e.store, PROMPT, "Existing")),
            ErrorCode::Conflict
        );
        assert_eq!(
            code(create(&e.store, PROMPT, "New One")),
            ErrorCode::Conflict
        );
        assert_eq!(
            code(create(&e.store, PROMPT, "a/b")),
            ErrorCode::InvalidInput
        );
        assert_eq!(e.store.settings().channels.len(), 1);
    }

    #[test]
    fn update_changes_profiles_without_touching_disk() {
        let e = env();
        let id = create(&e.store, PROMPT, "Tech").unwrap().channels[0]
            .id
            .clone();
        let long = ChannelProfile::with_defaults("Long prompt".into(), "Long style".into());
        let settings = update(
            &e.store,
            &id,
            ChannelUpdate {
                folder_name: Some("Tech".into()),
                long: Some(long.clone()),
                ..ChannelUpdate::default()
            },
        )
        .unwrap();
        assert_eq!(settings.channels[0].long, long);
        assert_eq!(settings.channels[0].short.prompts[0].text, PROMPT);
        assert_eq!(settings.channels[0].video_type, ChannelVideoType::Auto);
        assert!(e.editing.join("Tech").is_dir());
        assert_eq!(
            code(update(&e.store, "unknown", ChannelUpdate::default())),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn update_checks_slot_names_and_count_and_fixes_slot_zero() {
        let e = env();
        let id = create(&e.store, PROMPT, "Tech").unwrap().channels[0]
            .id
            .clone();
        let update_long = |long: ChannelProfile| {
            update(
                &e.store,
                &id,
                ChannelUpdate {
                    long: Some(long),
                    ..ChannelUpdate::default()
                },
            )
        };
        let mut long = ChannelProfile::default();
        long.prompts[0].name = "Renamed".into();
        long.prompts[2].name = "  Fast cut ".into();
        let saved = update_long(long.clone()).unwrap().channels[0].long.clone();
        assert_eq!(saved.prompts[0].name, "Default");
        assert_eq!(saved.prompts[2].name, "Fast cut");

        long.styles[1].name = "  ".into();
        assert_eq!(code(update_long(long.clone())), ErrorCode::InvalidInput);
        long.styles[1].name = "x".repeat(41);
        assert_eq!(code(update_long(long.clone())), ErrorCode::InvalidInput);
        long.styles[1].name = "x".repeat(40);
        long.prompts.pop();
        assert_eq!(code(update_long(long)), ErrorCode::InvalidInput);
        // Nothing invalid was saved.
        assert_eq!(e.store.settings().channels[0].long, saved);
    }

    #[test]
    fn update_sets_the_video_type_even_during_an_active_edit() {
        let e = env();
        let id = create(&e.store, PROMPT, "Nikon").unwrap().channels[0]
            .id
            .clone();
        assert_eq!(
            e.store.settings().channels[0].video_type,
            ChannelVideoType::Auto
        );
        // A running job keeps the type it started with, so this is not a conflict.
        put_job(&e.store, &id, JobState::Running);
        let video_type = |t| ChannelUpdate {
            video_type: Some(t),
            ..ChannelUpdate::default()
        };
        let settings = update(&e.store, &id, video_type(ChannelVideoType::Short)).unwrap();
        assert_eq!(settings.channels[0].video_type, ChannelVideoType::Short);
        assert_eq!(settings.channels[0].long.prompts[0].text, PROMPT);

        // Leaving it out keeps it.
        let settings = update(
            &e.store,
            &id,
            ChannelUpdate {
                short: Some(ChannelProfile::default()),
                ..ChannelUpdate::default()
            },
        )
        .unwrap();
        assert_eq!(settings.channels[0].video_type, ChannelVideoType::Short);

        let reopened = Store::open(e.store.data_dir()).unwrap();
        assert_eq!(
            reopened.settings().channels[0].video_type,
            ChannelVideoType::Short
        );
        let settings = update(&e.store, &id, video_type(ChannelVideoType::Auto)).unwrap();
        assert_eq!(settings.channels[0].video_type, ChannelVideoType::Auto);
    }

    #[test]
    fn rename_moves_the_folder_and_keeps_the_id() {
        let e = env();
        let id = create(&e.store, PROMPT, "Tech").unwrap().channels[0]
            .id
            .clone();
        fs::create_dir(e.editing.join("Tech/Video 1")).unwrap();
        put_job(&e.store, &id, JobState::Completed);

        let rename = |name: &str| ChannelUpdate {
            folder_name: Some(name.into()),
            ..ChannelUpdate::default()
        };
        let settings = update(&e.store, &id, rename(" Tech Reviews ")).unwrap();
        assert_eq!(settings.channels[0].id, id);
        assert_eq!(settings.channels[0].folder_name, "Tech Reviews");
        assert!(!e.editing.join("Tech").exists());
        assert!(e.editing.join("Tech Reviews/Video 1").is_dir());
        // Video state is keyed by channel id, so it is still found.
        assert!(
            e.store
                .video(&video_id(&id, "Video 1"))
                .latest_job
                .is_some()
        );

        // An archived video stays archived, and its entry points at the renamed folder.
        let vid = video_id(&id, "Video 1");
        e.store
            .archive_video(crate::model::ArchivedVideo {
                video_id: vid.clone(),
                channel_id: id.clone(),
                folder_name: "Video 1".into(),
                path: e
                    .editing
                    .join("Tech Reviews/Video 1")
                    .to_string_lossy()
                    .into(),
                archived_at: "2026-11-20T00:00:00Z".into(),
            })
            .unwrap();

        // Only the letter case changes.
        let settings = update(&e.store, &id, rename("tech reviews")).unwrap();
        assert_eq!(settings.channels[0].folder_name, "tech reviews");
        assert!(e.editing.join("tech reviews/Video 1").is_dir());
        let renamed = update(&e.store, &id, rename("Gadgets")).unwrap();
        assert_eq!(renamed.channels[0].folder_name, "Gadgets");
        let list = crate::commands::archive::archived_list(&e.store);
        assert_eq!(list.len(), 1, "the archived video must survive the rename");
        assert_eq!(
            list[0].path,
            e.editing.join("Gadgets/Video 1").to_string_lossy()
        );
        assert!(e.store.is_archived(&vid));
    }

    #[test]
    fn rename_conflicts() {
        let e = env();
        let id = create(&e.store, PROMPT, "Tech").unwrap().channels[0]
            .id
            .clone();
        create(&e.store, PROMPT, "Food").unwrap();
        fs::create_dir(e.editing.join("Taken")).unwrap();
        let rename = |name: &str| ChannelUpdate {
            folder_name: Some(name.into()),
            ..ChannelUpdate::default()
        };

        assert_eq!(
            code(update(&e.store, &id, rename("Taken"))),
            ErrorCode::Conflict
        );
        assert_eq!(
            code(update(&e.store, &id, rename("food"))),
            ErrorCode::Conflict
        );
        assert_eq!(
            code(update(&e.store, &id, rename(".x"))),
            ErrorCode::InvalidInput
        );

        for state in [
            JobState::Queued,
            JobState::Running,
            JobState::Pausing,
            JobState::Paused,
            JobState::Stopping,
        ] {
            put_job(&e.store, &id, state);
            assert_eq!(
                code(update(&e.store, &id, rename("Free"))),
                ErrorCode::Conflict,
                "{state:?}"
            );
        }
        assert!(e.editing.join("Tech").is_dir() && !e.editing.join("Free").exists());
        assert_eq!(e.store.settings().channels[0].folder_name, "Tech");

        // A job in another channel does not block, nor does a finished one.
        put_job(&e.store, "other-channel", JobState::Running);
        put_job(&e.store, &id, JobState::Failed);
        update(&e.store, &id, rename("Free")).unwrap();
        assert!(e.editing.join("Free").is_dir());

        // A channel whose folder disappeared cannot be renamed.
        fs::remove_dir(e.editing.join("Free")).unwrap();
        assert_eq!(
            code(update(&e.store, &id, rename("Again"))),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn remove_keeps_the_folder_and_respects_active_jobs() {
        let e = env();
        let id = create(&e.store, PROMPT, "Tech").unwrap().channels[0]
            .id
            .clone();
        put_job(&e.store, &id, JobState::Running);
        assert_eq!(code(remove(&e.store, &id)), ErrorCode::Conflict);
        put_job(&e.store, &id, JobState::Stopped);
        let settings = remove(&e.store, &id).unwrap();
        assert!(settings.channels.is_empty());
        assert!(e.editing.join("Tech").is_dir());
        assert_eq!(code(remove(&e.store, &id)), ErrorCode::NotFound);
    }

    #[test]
    fn reorder_requires_every_channel_once() {
        let e = env();
        for name in ["A", "B", "C"] {
            create(&e.store, PROMPT, name).unwrap();
        }
        let ids: Vec<String> = e
            .store
            .settings()
            .channels
            .iter()
            .map(|c| c.id.clone())
            .collect();
        let reversed: Vec<String> = ids.iter().rev().cloned().collect();
        let settings = reorder(&e.store, &reversed).unwrap();
        let names: Vec<_> = settings
            .channels
            .iter()
            .map(|c| c.folder_name.as_str())
            .collect();
        assert_eq!(names, ["C", "B", "A"]);

        for bad in [
            vec![ids[0].clone(), ids[1].clone()],
            vec![ids[0].clone(), ids[0].clone(), ids[1].clone()],
            vec![ids[0].clone(), ids[1].clone(), ids[2].clone(), "x".into()],
            vec![ids[0].clone(), ids[1].clone(), "x".into()],
        ] {
            assert_eq!(code(reorder(&e.store, &bad)), ErrorCode::InvalidInput);
        }
        let names: Vec<_> = e
            .store
            .settings()
            .channels
            .iter()
            .map(|c| c.folder_name.clone())
            .collect();
        assert_eq!(names, ["C", "B", "A"]);
    }
}

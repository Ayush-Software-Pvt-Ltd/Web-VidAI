//! `export_settings` / `import_settings` (SPEC section 5, "Settings files").
//!
//! The file is JSON with a format marker and a version:
//!
//! ```json
//! {
//!   "format": "vidai-settings",
//!   "version": 2,
//!   "exportedAt": "2026-11-14T10:00:00.000Z",
//!   "general": {
//!     "reviewSoftware": "fcp", "maxConcurrentEdits": 3, "startDelayMinutes": 10, "maxModelRetries": 5,
//!     "model": null, "effort": null
//!   },
//!   "channels": [
//!     { "folderName": "Tech", "videoType": "auto", "long": { "prompts": [{ "name": "Default", "text": "" }, ...], "styles": [...] }, "short": { ... } }
//!   ]
//! }
//! ```
//!
//! What travels: the general settings above and every channel's folder name, video type, prompts
//! and styles (five named slots of each for Long and for Short; version 1 files have one `prompt`
//! and one `style` per video type, which import as slot 0). A channel without `videoType` (files from before it existed) imports as `auto`.
//! What never travels: secrets (they are not in `Settings` at all), the Editing Folder path (it
//! belongs to one machine), the active toolkit (it depends on what exists on that disk), the
//! theme and text size (preferences of whoever sits at that Mac) and channel ids (each machine
//! keeps its own).
//!
//! Import merges by folder name (compared without letter case): a channel with the same folder
//! name gets the imported video type, prompts and styles, other imported channels are added at the end with a
//! new id. Channels missing from the file are kept. General settings present in the file replace
//! the current ones; the model and effort are then checked against the known model list, and
//! numbers out of range are clamped. A file without `startDelayMinutes` (made before it existed)
//! keeps the current start delay. The whole file is validated before anything changes.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::channels::validate_folder_name;
use crate::claude;
use crate::error::{AppError, AppResult};
use crate::model::{
    Channel, ChannelProfile, ChannelSlot, ChannelVideoType, ClaudeInfo, MAX_CONCURRENT_EDITS_RANGE,
    MAX_MODEL_RETRIES, MAX_START_DELAY_MINUTES, ModelSelection, Platform, ReviewSoftware, Settings,
};
use crate::store::{Store, sanitize_profile, write_atomic};

/// Value of the `format` field.
pub const FORMAT: &str = "vidai-settings";
/// Current version of the file. Older versions are read; newer ones are refused.
pub const VERSION: u32 = 2;
/// Settings files larger than this are refused.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportFile<'a> {
    format: &'static str,
    version: u32,
    exported_at: String,
    general: ExportGeneral<'a>,
    channels: Vec<ExportChannel<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportGeneral<'a> {
    review_software: ReviewSoftware,
    max_concurrent_edits: u32,
    start_delay_minutes: u32,
    max_model_retries: u32,
    model: Option<&'a str>,
    effort: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportChannel<'a> {
    folder_name: &'a str,
    video_type: ChannelVideoType,
    long: &'a ChannelProfile,
    short: &'a ChannelProfile,
}

/// A channel as read from a file: a missing video type is `auto`, prompts and styles that are
/// missing are empty.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportChannel {
    folder_name: String,
    #[serde(default)]
    video_type: ChannelVideoType,
    #[serde(default)]
    long: ImportProfile,
    #[serde(default)]
    short: ImportProfile,
}

/// A profile as read from a file: version 1 files have one `prompt` and one `style` (slot 0),
/// later ones have lists of named slots, which are padded or cut to the right number.
#[derive(Default, Deserialize)]
#[serde(default)]
struct ImportProfile {
    prompt: String,
    style: String,
    prompts: Vec<ImportSlot>,
    styles: Vec<ImportSlot>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ImportSlot {
    name: String,
    text: String,
}

impl From<ImportProfile> for ChannelProfile {
    fn from(p: ImportProfile) -> Self {
        let slots = |old: String, new: Vec<ImportSlot>| {
            let mut slots: Vec<ChannelSlot> = new
                .into_iter()
                .map(|s| ChannelSlot {
                    name: s.name,
                    text: s.text,
                })
                .collect();
            if slots.is_empty() {
                slots.push(ChannelSlot {
                    name: String::new(),
                    text: old,
                });
            }
            slots
        };
        let mut profile = Self {
            prompts: slots(p.prompt, p.prompts),
            styles: slots(p.style, p.styles),
        };
        sanitize_profile(&mut profile);
        profile
    }
}

/// The exported JSON for these settings.
pub fn export_json(settings: &Settings) -> AppResult<Vec<u8>> {
    let file = ExportFile {
        format: FORMAT,
        version: VERSION,
        exported_at: crate::model::now_iso(),
        general: ExportGeneral {
            review_software: settings.review_software,
            max_concurrent_edits: settings.max_concurrent_edits,
            start_delay_minutes: settings.start_delay_minutes,
            max_model_retries: settings.max_model_retries,
            model: settings.model.as_deref(),
            effort: settings.effort.as_deref(),
        },
        channels: settings
            .channels
            .iter()
            .map(|c| ExportChannel {
                folder_name: &c.folder_name,
                video_type: c.video_type,
                long: &c.long,
                short: &c.short,
            })
            .collect(),
    };
    let mut bytes = serde_json::to_vec_pretty(&file)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn check_path(path: &str) -> AppResult<&Path> {
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::invalid_input("Choose a file."));
    }
    Ok(Path::new(path))
}

/// Writes the settings file to `path` (atomically).
pub fn export(store: &Store, path: &str) -> AppResult<()> {
    let path = check_path(path)?;
    write_atomic(path, &export_json(&store.settings())?)
}

fn not_a_settings_file() -> AppError {
    AppError::invalid_input("This file is not a VidAI settings file.")
}

/// Everything an import would change, validated.
struct Parsed {
    review_software: Option<ReviewSoftware>,
    max_concurrent_edits: Option<u32>,
    start_delay_minutes: Option<u32>,
    max_model_retries: Option<u32>,
    /// `Some` when the file has a `model` or an `effort` field.
    selection: Option<ModelSelection>,
    channels: Vec<ImportChannel>,
}

fn parse(bytes: &[u8]) -> AppResult<Parsed> {
    let Ok(Value::Object(mut root)) = serde_json::from_slice::<Value>(bytes) else {
        return Err(not_a_settings_file());
    };
    if root.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(not_a_settings_file());
    }
    let version = root.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version == 0 {
        return Err(not_a_settings_file());
    }
    if version > u64::from(VERSION) {
        return Err(AppError::invalid_input(
            "This settings file was made by a newer version of VidAI. Update VidAI and try again.",
        ));
    }

    let general = match root.remove("general") {
        None | Some(Value::Null) => serde_json::Map::new(),
        Some(Value::Object(map)) => map,
        Some(_) => return Err(not_a_settings_file()),
    };
    let field_error = |name: &str| {
        AppError::invalid_input(format!("The {name} in this settings file is not valid."))
    };
    let review_software = match general.get("reviewSoftware") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            serde_json::from_value::<ReviewSoftware>(v.clone())
                .map_err(|_| field_error("review software"))?,
        ),
    };
    let max_concurrent_edits = match general.get("maxConcurrentEdits") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let n = v
                .as_u64()
                .ok_or_else(|| field_error("maximum simultaneous edits"))?;
            let (lo, hi) = (
                *MAX_CONCURRENT_EDITS_RANGE.start(),
                *MAX_CONCURRENT_EDITS_RANGE.end(),
            );
            Some(u32::try_from(n).unwrap_or(hi).clamp(lo, hi))
        }
    };
    let start_delay_minutes = match general.get("startDelayMinutes") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let n = v.as_u64().ok_or_else(|| field_error("start delay"))?;
            Some(
                u32::try_from(n)
                    .unwrap_or(MAX_START_DELAY_MINUTES)
                    .min(MAX_START_DELAY_MINUTES),
            )
        }
    };
    let max_model_retries = match general.get("maxModelRetries") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let n = v
                .as_u64()
                .ok_or_else(|| field_error("retries after a model error"))?;
            Some(
                u32::try_from(n)
                    .unwrap_or(MAX_MODEL_RETRIES)
                    .min(MAX_MODEL_RETRIES),
            )
        }
    };
    let text = |name: &str, label: &str| -> AppResult<Option<Option<String>>> {
        match general.get(name) {
            None => Ok(None),
            Some(Value::Null) => Ok(Some(None)),
            Some(Value::String(s)) => Ok(Some(Some(s.clone()))),
            Some(_) => Err(field_error(label)),
        }
    };
    let model = text("model", "model")?;
    let effort = text("effort", "effort")?;
    let selection = (model.is_some() || effort.is_some()).then(|| ModelSelection {
        model: model.flatten(),
        effort: effort.flatten(),
    });

    let channels: Vec<ImportChannel> = match root.remove("channels") {
        None | Some(Value::Null) => Vec::new(),
        Some(v) => serde_json::from_value(v).map_err(|_| {
            AppError::invalid_input("The channels in this settings file are not valid.")
        })?,
    };
    let mut channels = channels;
    for i in 0..channels.len() {
        let name = validate_folder_name(&channels[i].folder_name).map_err(|e| {
            AppError::invalid_input(format!(
                "Channel {} in this settings file has an invalid folder name: {}",
                i + 1,
                e.message
            ))
        })?;
        let key = name.to_lowercase();
        if channels[..i]
            .iter()
            .any(|c| c.folder_name.to_lowercase() == key)
        {
            return Err(AppError::invalid_input(format!(
                "The channel {name} appears twice in this settings file."
            )));
        }
        channels[i].folder_name = name;
    }
    Ok(Parsed {
        review_software,
        max_concurrent_edits,
        start_delay_minutes,
        max_model_retries,
        selection,
        channels,
    })
}

/// Merges the settings file at `path` into the current settings (see the module docs).
pub fn import(store: &Store, path: &str, info: Option<&ClaudeInfo>) -> AppResult<Settings> {
    let path = check_path(path)?;
    let meta = fs::metadata(path).map_err(|e| AppError::io_at("Could not read", path, e))?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Err(not_a_settings_file());
    }
    let bytes = fs::read(path).map_err(|e| AppError::io_at("Could not read", path, e))?;
    let parsed = parse(&bytes)?;
    store.update_settings(|s| {
        // A file made on a Mac may say Final Cut Pro, which a PC does not have: keep the current one.
        if let Some(review_software) = parsed
            .review_software
            .filter(|r| r.is_available_on(Platform::current()))
        {
            s.review_software = review_software;
        }
        if let Some(max) = parsed.max_concurrent_edits {
            s.max_concurrent_edits = max;
        }
        if let Some(minutes) = parsed.start_delay_minutes {
            s.start_delay_minutes = minutes;
        }
        if let Some(retries) = parsed.max_model_retries {
            s.max_model_retries = retries;
        }
        if let Some(selection) = parsed.selection {
            let selection = claude::normalize_selection(selection, info);
            s.model = selection.model;
            s.effort = selection.effort;
        }
        for imported in parsed.channels {
            let key = imported.folder_name.to_lowercase();
            match s
                .channels
                .iter_mut()
                .find(|c| c.folder_name.to_lowercase() == key)
            {
                Some(existing) => {
                    existing.video_type = imported.video_type;
                    existing.long = imported.long.into();
                    existing.short = imported.short.into();
                }
                None => s.channels.push(Channel {
                    id: uuid::Uuid::new_v4().to_string(),
                    folder_name: imported.folder_name,
                    video_type: imported.video_type,
                    long: imported.long.into(),
                    short: imported.short.into(),
                }),
            }
        }
        Ok(s.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::model::{ClaudeModel, Theme, ToolkitKind};
    use tempfile::TempDir;

    fn profile(prompt: &str, style: &str) -> ChannelProfile {
        ChannelProfile::with_defaults(prompt.into(), style.into())
    }

    fn channel(id: &str, name: &str, prompt: &str) -> Channel {
        Channel {
            id: id.into(),
            folder_name: name.into(),
            video_type: ChannelVideoType::Auto,
            long: profile(&format!("{prompt} long"), "long style"),
            short: profile(&format!("{prompt} short"), "short style"),
        }
    }

    fn store_with(dir: &Path, f: impl FnOnce(&mut Settings)) -> Store {
        let store = Store::open(dir).unwrap();
        store
            .update_settings(|s| {
                f(s);
                Ok(())
            })
            .unwrap();
        store
    }

    #[test]
    fn export_has_version_and_no_machine_or_secret_fields() {
        let root = TempDir::new().unwrap();
        let store = store_with(&root.path().join("a"), |s| {
            s.editing_folder = Some("/Users/me/Editing".into());
            s.active_toolkit = ToolkitKind::Own;
            s.theme = Theme::Dark;
            s.text_size = 19;
            s.model = Some("opus".into());
            s.setup = crate::model::Setup::AnthropicApi;
            let api = s.api_options.get_mut(crate::model::ApiOption::AnthropicApi);
            api.base_url = Some("http://127.0.0.1:9/inference/go/anthropic".into());
            api.model = Some("glm-5.3".into());
            s.channels = vec![channel("id-1", "Tech", "tech")];
        });
        let out = root.path().join("out/vidai-settings.json");
        export(&store, &out.to_string_lossy()).unwrap();
        let json: Value = serde_json::from_slice(&fs::read(&out).unwrap()).unwrap();
        assert_eq!(json["format"], FORMAT);
        assert_eq!(json["version"], VERSION);
        assert_eq!(json["general"]["model"], "opus");
        assert_eq!(json["general"]["maxConcurrentEdits"], 3);
        assert_eq!(json["general"]["startDelayMinutes"], 10);
        assert_eq!(json["channels"][0]["folderName"], "Tech");
        assert_eq!(json["channels"][0]["videoType"], "auto");
        assert_eq!(
            json["channels"][0]["short"]["styles"][0]["text"],
            "short style"
        );
        let text = fs::read_to_string(&out).unwrap();
        for absent in [
            "/Users/me/Editing",
            "editingFolder",
            "activeToolkit",
            "theme",
            "textSize",
            "id-1",
            "key",
            "setup",
            "apiOptions",
            "anthropic",
            "openai",
            "opencode",
            "127.0.0.1",
            "glm-5.3",
        ] {
            assert!(
                !text.to_lowercase().contains(&absent.to_lowercase()),
                "{absent} in {text}"
            );
        }
    }

    #[test]
    fn round_trip_into_an_empty_install() {
        let root = TempDir::new().unwrap();
        let source = store_with(&root.path().join("a"), |s| {
            s.editing_folder = Some("/Users/a/Editing".into());
            s.review_software = ReviewSoftware::Premiere;
            s.max_concurrent_edits = 5;
            s.start_delay_minutes = 0;
            s.theme = Theme::Light;
            s.text_size = 12;
            s.model = Some("opus".into());
            s.effort = Some("high".into());
            s.channels = vec![channel("a1", "Tech", "tech"), channel("a2", "Food", "food")];
            s.channels[1].video_type = ChannelVideoType::Short;
        });
        let file = root.path().join("settings.json");
        export(&source, &file.to_string_lossy()).unwrap();

        let target = store_with(&root.path().join("b"), |s| {
            s.editing_folder = Some("/Users/b/Editing".into());
            s.theme = Theme::Dark;
            s.text_size = 18;
        });
        let settings = import(&target, &file.to_string_lossy(), None).unwrap();
        assert_eq!(settings.editing_folder.as_deref(), Some("/Users/b/Editing"));
        assert_eq!(settings.review_software, ReviewSoftware::Premiere);
        assert_eq!(settings.max_concurrent_edits, 5);
        assert_eq!(settings.start_delay_minutes, 0);
        // The appearance belongs to this machine.
        assert_eq!((settings.theme, settings.text_size), (Theme::Dark, 18));
        assert_eq!(settings.model.as_deref(), Some("opus"));
        assert_eq!(settings.effort.as_deref(), Some("high"));
        assert_eq!(settings.channels.len(), 2);
        for (got, want) in settings.channels.iter().zip(&source.settings().channels) {
            assert_eq!(got.folder_name, want.folder_name);
            assert_eq!(got.video_type, want.video_type);
            assert_eq!(got.long, want.long);
            assert_eq!(got.short, want.short);
            assert_ne!(got.id, want.id, "ids are local to each machine");
        }
    }

    #[test]
    fn import_merges_by_folder_name() {
        let root = TempDir::new().unwrap();
        let store = store_with(&root.path().join("a"), |s| {
            s.channels = vec![
                channel("keep", "Local Only", "local"),
                channel("t", "tech", "old"),
            ];
        });
        let file = root.path().join("in.json");
        fs::write(
            &file,
            r#"{"format":"vidai-settings","version":1,"futureField":1,
                "channels":[
                  {"folderName":"Tech","long":{"prompt":"new long","style":"s1"},"short":{"prompt":"new short","style":"s2"}},
                  {"folderName":" Travel ","long":{"prompt":"travel"}}
                ]}"#,
        )
        .unwrap();
        let before = store.settings();
        let settings = import(&store, &file.to_string_lossy(), None).unwrap();
        assert_eq!(settings.channels.len(), 3);
        assert_eq!(settings.channels[0], before.channels[0]);
        let tech = &settings.channels[1];
        assert_eq!((tech.id.as_str(), tech.folder_name.as_str()), ("t", "tech"));
        assert_eq!(tech.long, profile("new long", "s1"));
        assert_eq!(tech.short, profile("new short", "s2"));
        let travel = &settings.channels[2];
        assert_eq!(travel.folder_name, "Travel");
        assert_eq!(travel.long, profile("travel", ""));
        assert_eq!(travel.short, profile("", ""));
        // No general section: general settings stay.
        assert_eq!(settings.max_concurrent_edits, before.max_concurrent_edits);
        assert_eq!(settings.start_delay_minutes, before.start_delay_minutes);
        assert_eq!(settings.model, before.model);
    }

    #[test]
    fn import_reads_named_slots_and_fixes_their_number_and_names() {
        let root = TempDir::new().unwrap();
        let store = store_with(&root.path().join("a"), |_| {});
        let file = root.path().join("in.json");
        fs::write(
            &file,
            r#"{"format":"vidai-settings","version":2,"channels":[
                {"folderName":"Tech","long":{
                  "prompts":[{"name":"Mine","text":"p0"},{"name":" Fast ","text":"p1"},{"name":"","text":"p2"}],
                  "styles":[{"name":"Default","text":"s0"}]}}
            ]}"#,
        )
        .unwrap();
        let settings = import(&store, &file.to_string_lossy(), None).unwrap();
        let long = &settings.channels[0].long;
        let prompts: Vec<_> = long.prompts.iter().map(|s| (&*s.name, &*s.text)).collect();
        assert_eq!(
            prompts,
            [
                ("Default", "p0"),
                ("Fast", "p1"),
                ("Prompt 3", "p2"),
                ("Prompt 4", ""),
                ("Prompt 5", "")
            ]
        );
        assert_eq!(long.styles.len(), 5);
        assert_eq!(long.styles[0].text, "s0");
        assert_eq!(long.styles[4].name, "Style 5");
        assert_eq!(settings.channels[0].short, ChannelProfile::default());
        // What is exported imports back unchanged.
        let again = parse(&export_json(&settings).unwrap()).unwrap();
        assert_eq!(
            ChannelProfile::from(again.channels.into_iter().next().unwrap().long),
            *long
        );
    }

    #[test]
    fn import_reads_the_video_type_and_treats_a_missing_one_as_auto() {
        let root = TempDir::new().unwrap();
        let store = store_with(&root.path().join("a"), |s| {
            let mut nikon = channel("n", "Nikon", "nikon");
            nikon.video_type = ChannelVideoType::Short;
            let mut old = channel("o", "Old", "old");
            old.video_type = ChannelVideoType::Long;
            s.channels = vec![nikon, old];
        });
        let file = root.path().join("in.json");
        // "Old" comes from a file made before channels had a video type.
        fs::write(
            &file,
            r#"{"format":"vidai-settings","version":1,"channels":[
                {"folderName":"nikon","videoType":"long"},
                {"folderName":"Old","long":{"prompt":"p"}},
                {"folderName":"New Shorts","videoType":"short"},
                {"folderName":"New Auto"}
            ]}"#,
        )
        .unwrap();
        let settings = import(&store, &file.to_string_lossy(), None).unwrap();
        let types: Vec<_> = settings
            .channels
            .iter()
            .map(|c| (c.folder_name.as_str(), c.video_type))
            .collect();
        assert_eq!(
            types,
            [
                ("Nikon", ChannelVideoType::Long),
                ("Old", ChannelVideoType::Auto),
                ("New Shorts", ChannelVideoType::Short),
                ("New Auto", ChannelVideoType::Auto),
            ]
        );

        // An unknown value is refused and nothing changes.
        let before = store.settings();
        fs::write(
            &file,
            r#"{"format":"vidai-settings","version":1,"channels":[{"folderName":"Nikon","videoType":"square"}]}"#,
        )
        .unwrap();
        let err = import(&store, &file.to_string_lossy(), None).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert_eq!(store.settings(), before);
    }

    #[test]
    fn import_normalizes_model_and_clamps_numbers() {
        let root = TempDir::new().unwrap();
        let store = store_with(&root.path().join("a"), |s| s.model = Some("sonnet".into()));
        let file = root.path().join("in.json");
        fs::write(
            &file,
            r#"{"format":"vidai-settings","version":1,
                "general":{"maxConcurrentEdits":99,"startDelayMinutes":9999,"model":"retired-model","effort":"max"}}"#,
        )
        .unwrap();
        let info = ClaudeInfo {
            models: vec![ClaudeModel {
                value: "opus".into(),
                display_name: "Opus".into(),
                description: String::new(),
                effort_levels: vec!["high".into()],
            }],
            ..ClaudeInfo::default()
        };
        let settings = import(&store, &file.to_string_lossy(), Some(&info)).unwrap();
        assert_eq!(settings.max_concurrent_edits, 8);
        assert_eq!(settings.start_delay_minutes, MAX_START_DELAY_MINUTES);
        assert_eq!(settings.model, None);
    }

    #[test]
    fn invalid_files_change_nothing() {
        let root = TempDir::new().unwrap();
        let store = store_with(&root.path().join("a"), |s| {
            s.channels = vec![channel("t", "Tech", "old")];
        });
        let before = store.settings();
        let cases: &[(&str, &str)] = &[
            ("not json", "not a VidAI settings file"),
            ("[]", "not a VidAI settings file"),
            (r#"{"version":1}"#, "not a VidAI settings file"),
            (
                r#"{"format":"other","version":1}"#,
                "not a VidAI settings file",
            ),
            (
                r#"{"format":"vidai-settings"}"#,
                "not a VidAI settings file",
            ),
            (
                r#"{"format":"vidai-settings","version":3}"#,
                "newer version",
            ),
            (
                r#"{"format":"vidai-settings","version":1,"general":{"reviewSoftware":"avid"}}"#,
                "review software",
            ),
            (
                r#"{"format":"vidai-settings","version":1,"general":{"startDelayMinutes":-5}}"#,
                "start delay",
            ),
            (
                r#"{"format":"vidai-settings","version":1,"channels":[{"folderName":"Tech"},{"folderName":"../x"}]}"#,
                "invalid folder name",
            ),
            (
                r#"{"format":"vidai-settings","version":1,"channels":[{"folderName":"A"},{"folderName":"a"}]}"#,
                "appears twice",
            ),
            (
                r#"{"format":"vidai-settings","version":1,"channels":{"x":1}}"#,
                "channels in this settings file",
            ),
        ];
        let file = root.path().join("in.json");
        for (content, message) in cases {
            fs::write(&file, content).unwrap();
            let err = import(&store, &file.to_string_lossy(), None).unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidInput, "{content}");
            assert!(err.message.contains(message), "{content}: {}", err.message);
            assert_eq!(store.settings(), before);
        }
        let err = import(
            &store,
            &root.path().join("missing.json").to_string_lossy(),
            None,
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        assert_eq!(
            import(&store, " ", None).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    #[test]
    fn final_cut_pro_from_a_mac_file_is_kept_out_on_windows() {
        let root = TempDir::new().unwrap();
        let store = store_with(&root.path().join("s"), |s| {
            s.review_software = ReviewSoftware::Premiere;
        });
        let file = root.path().join("in.json");
        fs::write(
            &file,
            r#"{"format":"vidai-settings","version":1,"general":{"reviewSoftware":"fcp","maxConcurrentEdits":2}}"#,
        )
        .unwrap();
        let settings = import(&store, &file.to_string_lossy(), None).unwrap();
        // The rest of the file still applies.
        assert_eq!(settings.max_concurrent_edits, 2);
        let expected = match Platform::current() {
            Platform::Windows => ReviewSoftware::Premiere,
            Platform::Macos => ReviewSoftware::Fcp,
        };
        assert_eq!(settings.review_software, expected);
    }
}

//! Every type that crosses the IPC boundary (SPEC section 4).
//!
//! IPC types never use container-level `#[serde(default)]`, because that would make their fields
//! optional in TypeScript; lenient loading of stored documents is done in `store.rs` instead.
//!
//! All types serialize as camelCase JSON and derive `specta::Type`, so the TypeScript bindings in
//! `src/lib/bindings.ts` are generated from this file (see `bindings.rs`). Change a type here,
//! run `npm run gen:types`, and the UI's types follow.
//!
//! Numbers that are not `u32` (`activeMs`, `seq` as `u64`, `usedPercent` as `f64`) are exported
//! as a plain TypeScript `number` through `#[specta(type = Number)]`: `u64` is exact up to 2^53,
//! and without the override specta would widen `f64` to `number | null` (for NaN).

use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

/// The most entries `get_job_log` returns (the newest ones).
pub const MAX_LOG_ENTRIES: usize = 5_000;
/// `LogEntry::detail` is truncated to this many characters.
pub const MAX_LOG_DETAIL_CHARS: usize = 4_000;
/// Allowed range of `Settings::max_concurrent_edits`.
pub const MAX_CONCURRENT_EDITS_RANGE: std::ops::RangeInclusive<u32> = 1..=8;
/// Default of `Settings::max_concurrent_edits`.
pub const DEFAULT_MAX_CONCURRENT_EDITS: u32 = 3;
/// Body text size in px the UI is designed at (`Settings::text_size` scales from it).
pub const BASE_TEXT_SIZE: u32 = 13;
/// Smallest allowed `Settings::text_size`.
pub const MIN_TEXT_SIZE: u32 = 11;
/// Largest allowed `Settings::text_size`.
pub const MAX_TEXT_SIZE: u32 = 20;
/// Default of `Settings::text_size`.
pub const DEFAULT_TEXT_SIZE: u32 = 15;
/// Largest allowed `Settings::start_delay_minutes` (the smallest is 0, no delay).
pub const MAX_START_DELAY_MINUTES: u32 = 120;
/// Default of `Settings::start_delay_minutes`.
pub const DEFAULT_START_DELAY_MINUTES: u32 = 10;
/// Largest allowed `Settings::max_model_retries` (the smallest is 0, no retries).
pub const MAX_MODEL_RETRIES: u32 = 50;
/// Default of `Settings::max_model_retries`.
pub const DEFAULT_MAX_MODEL_RETRIES: u32 = 5;
const _: () = {
    assert!(DEFAULT_MAX_MODEL_RETRIES <= MAX_MODEL_RETRIES);
    assert!(MIN_TEXT_SIZE <= BASE_TEXT_SIZE && BASE_TEXT_SIZE <= MAX_TEXT_SIZE);
    assert!(MIN_TEXT_SIZE <= DEFAULT_TEXT_SIZE && DEFAULT_TEXT_SIZE <= MAX_TEXT_SIZE);
    assert!(DEFAULT_START_DELAY_MINUTES <= MAX_START_DELAY_MINUTES);
};
/// Folder name of the standard toolkit inside the Editing Folder.
pub const STANDARD_TOOLKIT_FOLDER: &str = "CLAUDE_VE_ALL";
/// Folder name of the optional "own" toolkit inside the Editing Folder.
pub const OWN_TOOLKIT_FOLDER: &str = "CLAUDE_VE_ALL_OWN";

/// The current time as ISO 8601 UTC with milliseconds, the format of every timestamp in the model.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum VideoType {
    Long,
    Short,
}

/// A channel's video type setting: `auto` uses the type detected from the A-roll, `long` and
/// `short` fix the type of every video of the channel (for cameras that record sideways without
/// rotation metadata). A video's own override still wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChannelVideoType {
    #[default]
    Auto,
    Long,
    Short,
}

impl ChannelVideoType {
    /// The type this setting fixes, `None` for `auto`.
    pub fn fixed(self) -> Option<VideoType> {
        match self {
            Self::Auto => None,
            Self::Long => Some(VideoType::Long),
            Self::Short => Some(VideoType::Short),
        }
    }
}

/// Where a video's effective type comes from (SPEC section 8), in order of precedence:
/// `override` (chosen on the video row), `channel` (the channel's setting is not `auto`),
/// `detected` (from the A-roll), `assumed` (nothing could be read, so Long).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TypeSource {
    Override,
    Channel,
    Detected,
    Assumed,
}

/// A video's effective type and where it comes from: the video's override, else the channel's
/// setting when it is not `auto`, else the detected type, else Long.
pub fn resolve_video_type(
    type_override: Option<VideoType>,
    channel: ChannelVideoType,
    detected: Option<VideoType>,
) -> (VideoType, TypeSource) {
    if let Some(t) = type_override {
        (t, TypeSource::Override)
    } else if let Some(t) = channel.fixed() {
        (t, TypeSource::Channel)
    } else if let Some(t) = detected {
        (t, TypeSource::Detected)
    } else {
        (VideoType::Long, TypeSource::Assumed)
    }
}

/// The operating system VidAI is running on (SPEC section 11). The UI takes its keyboard
/// shortcuts, wording, fonts and window layout from it (`src/lib/platform.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Platform {
    Macos,
    Windows,
}

impl Platform {
    /// The platform of this build. Only macOS and Windows are built; anything else reports
    /// itself as macOS and is refused by `platform::platform_supported` anyway.
    pub const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Macos
        }
    }

    /// The name used in JSON and in the page (`"macos"`, `"windows"`).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Macos => "macos",
            Self::Windows => "windows",
        }
    }
}

/// `fcp` is Final Cut Pro, `premiere` is Premiere Pro.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReviewSoftware {
    Fcp,
    Premiere,
}

impl ReviewSoftware {
    /// Final Cut Pro on macOS, Premiere Pro on Windows.
    pub fn platform_default() -> Self {
        Self::default_on(Platform::current())
    }

    /// The default review software on `platform`.
    pub const fn default_on(platform: Platform) -> Self {
        match platform {
            Platform::Macos => Self::Fcp,
            Platform::Windows => Self::Premiere,
        }
    }

    /// Whether `self` exists on `platform`: Final Cut Pro is a Mac app, so Windows offers
    /// Premiere Pro only.
    pub const fn is_available_on(self, platform: Platform) -> bool {
        !matches!((self, platform), (Self::Fcp, Platform::Windows))
    }

    /// `self` when it exists on `platform`, otherwise the platform's default (a settings file
    /// copied from a Mac to a PC says Final Cut Pro).
    pub const fn for_platform(self, platform: Platform) -> Self {
        if self.is_available_on(platform) {
            self
        } else {
            Self::default_on(platform)
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Fcp => "Final Cut Pro",
            Self::Premiere => "Premiere Pro",
        }
    }
}

/// `standard` is `CLAUDE_VE_ALL`, `own` is `CLAUDE_VE_ALL_OWN`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ToolkitKind {
    #[default]
    Standard,
    Own,
}

impl ToolkitKind {
    pub fn folder_name(self) -> &'static str {
        match self {
            Self::Standard => STANDARD_TOOLKIT_FOLDER,
            Self::Own => OWN_TOOLKIT_FOLDER,
        }
    }
}

/// The color theme of the UI: `system` follows the macOS appearance, `light` and `dark` fix it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// What a video row may offer (SPEC section 6, computed by `scanner::compute_actions`).
///
/// `startNow` starts a queued job that the start delay holds back (`start_job_now`), skipping the
/// rest of the delay. It is not offered yet: the rule that offers it comes with the start delay in
/// the jobs engine.
///
/// `archive` removes an edited or failed video from the main list (the Archive page keeps it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum VideoAction {
    Start,
    Pause,
    Continue,
    Stop,
    ReEdit,
    RenderFinal,
    StartNow,
    Archive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    Edit,
    ReEdit,
    Render,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Running,
    Pausing,
    Paused,
    Stopping,
    Stopped,
    Failed,
    Completed,
}

impl JobState {
    /// `queued`, `running`, `pausing`, `paused` or `stopping` (SPEC section 6).
    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Running | Self::Pausing | Self::Paused | Self::Stopping
        )
    }

    /// States that hold one of the `maxConcurrentEdits` slots.
    pub fn holds_slot(self) -> bool {
        matches!(self, Self::Running | Self::Pausing | Self::Stopping)
    }

    /// Whether a job in this state is still being edited, so the No Sleep setting keeps the
    /// computer awake for it (SPEC section 11, Sleep prevention). Every state is named, so a new
    /// one must be decided here.
    ///
    /// - `queued`: waiting for a slot or for the start delay, it will start by itself.
    /// - `running`: also while it waits to retry after a model error or for background commands.
    /// - `pausing`, `stopping`: the process is still ending.
    /// - `paused`: the user stopped the work, nothing happens until Continue Editing.
    /// - `stopped`, `failed`, `completed`: ended.
    pub fn is_editing(self) -> bool {
        match self {
            Self::Queued | Self::Running | Self::Pausing | Self::Stopping => true,
            Self::Paused | Self::Stopped | Self::Failed | Self::Completed => false,
        }
    }
}

/// Whether any of the jobs is still being edited ([`JobState::is_editing`]).
pub fn jobs_active(states: impl IntoIterator<Item = JobState>) -> bool {
    states.into_iter().any(JobState::is_editing)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogKind {
    Status,
    Assistant,
    Tool,
    ToolResult,
    User,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ToolName {
    Ffmpeg,
    Ffprobe,
    Python3,
    Node,
}

// ---------------------------------------------------------------------------------------------
// Settings and channels
// ---------------------------------------------------------------------------------------------

/// Persisted in `settings.json` (plus `schemaVersion`, see `store.rs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub editing_folder: Option<String>,
    pub review_software: ReviewSoftware,
    /// 1..=8, default 3.
    pub max_concurrent_edits: u32,
    /// Passed as `--model`; `null` is Claude Code's default.
    pub model: Option<String>,
    /// Passed as `--effort`; `null` is Claude Code's default.
    pub effort: Option<String>,
    pub active_toolkit: ToolkitKind,
    /// Display order.
    pub channels: Vec<Channel>,
    /// Color theme of the UI, default `system`.
    pub theme: Theme,
    /// Size of body text in px, `MIN_TEXT_SIZE..=MAX_TEXT_SIZE`, default `DEFAULT_TEXT_SIZE`.
    /// The UI is designed at `BASE_TEXT_SIZE` and scales from it.
    pub text_size: u32,
    /// Least number of minutes between the starts of two jobs while another job is running,
    /// `0..=MAX_START_DELAY_MINUTES`, default `DEFAULT_START_DELAY_MINUTES`; 0 means no delay.
    pub start_delay_minutes: u32,
    /// How often a job retries by itself after the model provider failed, without progress in
    /// between, `0..=MAX_MODEL_RETRIES`, default `DEFAULT_MAX_MODEL_RETRIES`; 0 means never.
    pub max_model_retries: u32,
    /// How edits run (SPEC section 7a): one of the four options. An API option only with a saved
    /// key and a chosen model.
    pub setup: Setup,
    /// The address, model and reasoning efforts of each API option (preferences of this machine,
    /// never exported).
    pub api_options: ApiOptions,
    /// Keeps the computer from sleeping for as long as VidAI is open, whether or not jobs run
    /// (SPEC section 11, Sleep prevention), default false. A preference of this machine, never
    /// exported.
    pub no_sleep: bool,
}

/// How edits run (SPEC section 7a, "The four options"): the program and the service the model
/// comes from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Setup {
    /// Claude Code on the user's own Claude login.
    #[default]
    ClaudeSubscription,
    /// The OpenCode 2 program with an OpenCode Go key.
    OpencodeGo,
    /// Claude Code pointed at an Anthropic compatible API with its own key.
    AnthropicApi,
    /// The OpenCode 2 program with an OpenAI compatible API and its own key.
    OpenaiApi,
}

impl Setup {
    /// Every option, in the order Settings shows them.
    pub const ALL: [Setup; 4] = [
        Self::ClaudeSubscription,
        Self::OpencodeGo,
        Self::AnthropicApi,
        Self::OpenaiApi,
    ];

    /// The program that does a new edit on this setup (`harness::for_new_job`).
    pub fn harness(self) -> Harness {
        match self {
            Self::ClaudeSubscription | Self::AnthropicApi => Harness::ClaudeCode,
            Self::OpencodeGo | Self::OpenaiApi => Harness::Opencode2,
        }
    }

    /// The API option behind this setup; `None` for the Claude subscription.
    pub fn api_option(self) -> Option<ApiOption> {
        match self {
            Self::ClaudeSubscription => None,
            Self::OpencodeGo => Some(ApiOption::OpencodeGo),
            Self::AnthropicApi => Some(ApiOption::AnthropicApi),
            Self::OpenaiApi => Some(ApiOption::OpenaiApi),
        }
    }

    /// The label Settings and the logs use.
    pub fn label(self) -> &'static str {
        match self {
            Self::ClaudeSubscription => "Claude Code with Claude Subscription",
            Self::OpencodeGo => "OpenCode 2 with OpenCode Go Subscription",
            Self::AnthropicApi => "Claude Code with Anthropic Compatible API",
            Self::OpenaiApi => "OpenCode 2 with OpenAI Compatible API",
        }
    }

    /// The service the model comes from, as the log says it ("on Anthropic Compatible API").
    pub fn service_name(self) -> &'static str {
        match self {
            Self::ClaudeSubscription => "Claude Subscription",
            Self::OpencodeGo => "OpenCode Go",
            Self::AnthropicApi => "Anthropic Compatible API",
            Self::OpenaiApi => "OpenAI Compatible API",
        }
    }
}

/// The setups that have an API key, an address, a model and efforts of their own.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "camelCase")]
pub enum ApiOption {
    OpencodeGo,
    AnthropicApi,
    OpenaiApi,
}

impl ApiOption {
    pub const ALL: [ApiOption; 3] = [Self::OpencodeGo, Self::AnthropicApi, Self::OpenaiApi];

    /// The setup that selects this option.
    pub fn setup(self) -> Setup {
        match self {
            Self::OpencodeGo => Setup::OpencodeGo,
            Self::AnthropicApi => Setup::AnthropicApi,
            Self::OpenaiApi => Setup::OpenaiApi,
        }
    }

    /// Whether edits on this option need a saved API key. Only OpenCode Go does; the other two
    /// are often a server on this computer that needs none (SPEC section 7a, "The key is
    /// optional").
    pub fn key_required(self) -> bool {
        self == Self::OpencodeGo
    }
}

/// The address, model and efforts of each API option.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApiOptions {
    pub opencode_go: ApiOptionSettings,
    pub anthropic_api: ApiOptionSettings,
    pub openai_api: ApiOptionSettings,
}

impl ApiOptions {
    pub fn get(&self, option: ApiOption) -> &ApiOptionSettings {
        match option {
            ApiOption::OpencodeGo => &self.opencode_go,
            ApiOption::AnthropicApi => &self.anthropic_api,
            ApiOption::OpenaiApi => &self.openai_api,
        }
    }

    pub fn get_mut(&mut self, option: ApiOption) -> &mut ApiOptionSettings {
        match option {
            ApiOption::OpencodeGo => &mut self.opencode_go,
            ApiOption::AnthropicApi => &mut self.anthropic_api,
            ApiOption::OpenaiApi => &mut self.openai_api,
        }
    }
}

/// One API option's part of `Settings`. The key is not here: it lives in the keychain only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApiOptionSettings {
    /// The normalized address (`opencode::normalize_base_url`); `null` is the default address of
    /// the option (`opencode::default_base_url`).
    pub base_url: Option<String>,
    /// The model id every edit on this option uses; `null` until one is chosen.
    pub model: Option<String>,
    /// Reasoning effort per model id (SPEC section 7a, "The reasoning effort"): one of
    /// [`API_EFFORTS`]. A model without an entry runs on its own default.
    pub efforts: std::collections::BTreeMap<String, String>,
}

/// The reasoning efforts a model can be given, lowest first. Each program passes one on only when
/// the model offers a level of that name.
pub const API_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// The agent program of a setup (SPEC section 7a, "The program of a setup"): Claude Code (also
/// when it is pointed at an API), or the OpenCode 2 program (`opencode2`) itself.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Harness {
    #[default]
    ClaudeCode,
    Opencode2,
}

impl Harness {
    /// The OpenCode 2 program, as opposed to Claude Code.
    pub fn is_opencode_program(self) -> bool {
        matches!(self, Self::Opencode2)
    }
}

/// The OpenCode 2 program on this computer (`opencode::harness::locate2`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeCli {
    pub found: bool,
    pub path: Option<String>,
    /// As `opencode2 --version` prints it, for example "2.2.6"; null when it did not answer.
    pub version: Option<String>,
    /// VidAI can drive this version (`opencode::harness::locate2::supported`).
    pub supported: bool,
    /// The command that installs OpenCode 2 on this platform (what the install terminal window
    /// runs), so the UI keeps no copy of it.
    pub install_command: String,
}

impl Default for OpencodeCli {
    fn default() -> Self {
        Self {
            found: false,
            path: None,
            version: None,
            supported: false,
            install_command: crate::opencode::harness::locate2::INSTALL_COMMAND.to_owned(),
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            editing_folder: None,
            review_software: ReviewSoftware::platform_default(),
            max_concurrent_edits: DEFAULT_MAX_CONCURRENT_EDITS,
            model: None,
            effort: None,
            active_toolkit: ToolkitKind::Standard,
            channels: Vec::new(),
            theme: Theme::System,
            text_size: DEFAULT_TEXT_SIZE,
            start_delay_minutes: DEFAULT_START_DELAY_MINUTES,
            max_model_retries: DEFAULT_MAX_MODEL_RETRIES,
            setup: Setup::ClaudeSubscription,
            api_options: ApiOptions::default(),
            no_sleep: false,
        }
    }
}

/// Exported to TypeScript as `ChannelConfig` because `Channel` is taken by the Tauri runtime;
/// `src/lib/types.ts` re-exports it as `Channel`. The JSON shape is unaffected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename = "ChannelConfig", rename_all = "camelCase")]
pub struct Channel {
    /// UUID, stable across renames.
    pub id: String,
    /// Directory name inside the Editing Folder.
    pub folder_name: String,
    /// Fixes the type of the channel's videos, or `auto` (settings files without it load as
    /// `auto`, see `store.rs`).
    pub video_type: ChannelVideoType,
    pub long: ChannelProfile,
    pub short: ChannelProfile,
}

/// How many prompts and how many styles each of Long and Short has, always exactly.
pub const CHANNEL_SLOTS: usize = 5;
/// Longest name of a slot, in characters.
pub const MAX_SLOT_NAME_CHARS: usize = 40;
/// The name of slot 0, which cannot be changed.
pub const DEFAULT_SLOT_NAME: &str = "Default";

/// The prompts and styles of one video type of a channel: [`CHANNEL_SLOTS`] of each, slot 0 is
/// named "Default". `store.rs` loads files with any other shape leniently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelProfile {
    pub prompts: Vec<ChannelSlot>,
    pub styles: Vec<ChannelSlot>,
}

/// One named prompt or style.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSlot {
    pub name: String,
    pub text: String,
}

impl ChannelSlot {
    /// The empty slot `index` of a list called `label` ("Prompt" or "Style").
    pub fn empty(label: &str, index: usize) -> Self {
        let name = if index == 0 {
            DEFAULT_SLOT_NAME.to_owned()
        } else {
            format!("{label} {}", index + 1)
        };
        Self {
            name,
            text: String::new(),
        }
    }
}

impl ChannelProfile {
    /// Every slot empty and default-named, except that slot 0 holds these texts.
    pub fn with_defaults(prompt: String, style: String) -> Self {
        let mut profile = Self::default();
        profile.prompts[0].text = prompt;
        profile.styles[0].text = style;
        profile
    }
}

impl ChannelProfile {
    /// The text of prompt `slot`, empty when there is no such slot.
    pub fn prompt_text(&self, slot: u32) -> &str {
        self.prompts
            .get(slot as usize)
            .map_or("", |s| s.text.as_str())
    }

    /// The text of style `slot`, empty when there is no such slot.
    pub fn style_text(&self, slot: u32) -> &str {
        self.styles
            .get(slot as usize)
            .map_or("", |s| s.text.as_str())
    }
}

impl Default for ChannelProfile {
    fn default() -> Self {
        let slots = |label| {
            (0..CHANNEL_SLOTS)
                .map(|i| ChannelSlot::empty(label, i))
                .collect()
        };
        Self {
            prompts: slots("Prompt"),
            styles: slots("Style"),
        }
    }
}

/// Argument of `update_general_settings`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    pub review_software: ReviewSoftware,
    pub max_concurrent_edits: u32,
    /// `0..=MAX_START_DELAY_MINUTES`.
    pub start_delay_minutes: u32,
    /// `0..=MAX_MODEL_RETRIES`.
    pub max_model_retries: u32,
}

/// Argument of `update_appearance`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    pub theme: Theme,
    /// `MIN_TEXT_SIZE..=MAX_TEXT_SIZE`.
    pub text_size: u32,
}

/// Argument of `set_model_selection`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// Argument of `update_channel`. Fields left out are not changed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelUpdate {
    /// A new folder name renames the folder on disk.
    #[specta(optional)]
    pub folder_name: Option<String>,
    #[specta(optional)]
    pub video_type: Option<ChannelVideoType>,
    #[specta(optional)]
    pub long: Option<ChannelProfile>,
    #[specta(optional)]
    pub short: Option<ChannelProfile>,
}

// ---------------------------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub editing_folder: Option<String>,
    pub editing_folder_exists: bool,
    /// The channels in Settings, same order.
    pub channels: Vec<ChannelView>,
    /// Non-reserved folders not yet added as channels.
    pub discovered_folders: Vec<String>,
    pub running: u32,
    pub queued: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelView {
    pub id: String,
    pub folder_name: String,
    pub exists: bool,
    pub videos: Vec<VideoView>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VideoView {
    /// `${channelId}/${folderName}`.
    pub id: String,
    pub channel_id: String,
    pub folder_name: String,
    /// Absolute.
    pub path: String,
    /// ISO 8601: creation time of the video folder, its modified time when the file system keeps
    /// no creation time (the list's Age sort).
    pub created_at: String,
    /// `null` when there is no readable A-roll.
    pub detected_type: Option<VideoType>,
    pub type_override: Option<VideoType>,
    /// The channel's video type setting.
    pub channel_type: ChannelVideoType,
    /// The effective type: `typeOverride`, else `channelType` when it is not `auto`, else
    /// `detectedType`, else Long (see [`resolve_video_type`]).
    pub video_type: VideoType,
    /// Where `videoType` comes from.
    pub type_source: TypeSource,
    pub aroll_count: u32,
    /// Clockwise degrees (90, 180 or 270) that make the main A-roll upright when its picture is
    /// stored sideways and the file carries no rotation flag; `null` otherwise.
    pub aroll_rotation: Option<u32>,
    pub output: VideoOutput,
    /// `output.reviewFiles` is not empty.
    pub edited: bool,
    /// `output.finalFiles` is not empty.
    pub final_rendered: bool,
    /// Latest job of this video.
    pub job: Option<JobView>,
    /// What the row may offer right now (computed by `scanner::compute_actions`).
    pub actions: Vec<VideoAction>,
}

/// Builds a `VideoView::id`.
pub fn video_id(channel_id: &str, folder_name: &str) -> String {
    format!("{channel_id}/{folder_name}")
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VideoOutput {
    pub dir: String,
    /// Newest first.
    pub review_files: Vec<OutputFile>,
    /// Newest first.
    pub final_files: Vec<OutputFile>,
    /// Absolute paths, sorted by name.
    pub thumbnails: Vec<String>,
    pub meta_file: Option<String>,
    /// `<video>/info.txt`.
    pub info_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OutputFile {
    pub path: String,
    pub name: String,
    pub modified_at: String,
    pub software: Option<ReviewSoftware>,
}

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

/// Stored in `state.json` as a video's latest job. Fields added later must be `Option`s: serde reads
/// a missing `Option` field as `None`, so jobs saved by an older VidAI still load (for example
/// `progress` and `startsAt`, added in schema version 3). `#[serde(default)]` is not used for
/// this because it would make the fields optional in TypeScript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: String,
    pub video_id: String,
    pub kind: JobKind,
    pub state: JobState,
    pub session_id: Option<String>,
    /// Toolkit this job started with.
    pub toolkit: ToolkitKind,
    /// Model this job started with (`null` is Claude Code's default).
    pub model: Option<String>,
    /// Effort this job started with (`null` is Claude Code's default).
    pub effort: Option<String>,
    pub video_type: VideoType,
    /// ISO 8601 UTC.
    pub created_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    /// Time spent running; pauses and queue time excluded.
    #[specta(type = Number)]
    pub active_ms: u64,
    /// Set while running, so the UI can tick a clock.
    pub running_since: Option<String>,
    /// One short line, for example "Running ffmpeg".
    pub last_activity: Option<String>,
    /// User-readable, set for `failed`.
    pub error: Option<String>,
    pub cost_usd: Option<f64>,
    /// How far the edit is; `null` until the engine reports any.
    pub progress: Option<JobProgress>,
    /// ISO 8601 UTC. When a `queued` job held back by the start delay will start; `null` in every
    /// other case.
    pub starts_at: Option<String>,
    /// How this job's session runs (SPEC section 7a); `model` is the model of that setup.
    pub setup: Setup,
    /// The program this job's session runs in, derived from the setup when it started. `null` is
    /// Claude Code (jobs saved before schema version 5).
    pub harness: Option<Harness>,
}

impl JobView {
    /// The program this job's session runs in.
    pub fn harness(&self) -> Harness {
        self.harness.unwrap_or_default()
    }
}

/// How far a job is, as reported by the jobs engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    /// 0..=100.
    pub percent: u32,
    /// One short user-facing label for the current step, for example "Transcribing".
    pub stage: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// Increasing per job.
    #[specta(type = Number)]
    pub seq: u64,
    pub ts: String,
    pub kind: LogKind,
    /// One short readable line or the assistant's text.
    pub text: String,
    /// Full command / input / output, truncated to `MAX_LOG_DETAIL_CHARS`.
    pub detail: Option<String>,
    /// Produced by a sub-agent.
    pub nested: bool,
}

/// Remembered per video.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VideoInputs {
    pub product_links: String,
    pub notes: String,
    /// Index of the selected prompt of the video's type, `0..CHANNEL_SLOTS` (`store.rs` clamps
    /// stored values).
    pub prompt_slot: u32,
    /// Index of the selected style, same range.
    pub style_slot: u32,
}

impl VideoInputs {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Argument of `render_final`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderFinalRequest {
    pub timeline_export_path: Option<String>,
    pub notes: String,
}

/// One video removed from the main list with Archive (the Archive page).
/// The job history in `state.json` is kept, so unarchiving restores its status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedVideo {
    /// `<channelId>/<folderName>` when archived.
    pub video_id: String,
    pub channel_id: String,
    pub folder_name: String,
    /// Absolute path of the video folder when archived.
    pub path: String,
    /// ISO 8601 UTC when it was archived.
    pub archived_at: String,
}

/// What happened to a video, for the Edit Log page (SPEC section 5).
/// Entries are kept in `state.json` and mirrored to `<Editing Folder>/VidAI-edit-log.txt`,
/// so the text file survives an uninstall.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditLogEntry {
    /// ISO 8601 UTC.
    pub ts: String,
    /// `<channelId>/<folderName>`.
    pub video_id: String,
    /// Video folder name, for humans.
    pub folder: String,
    /// `started`, `completed`, `failed`, `stopped`, `paused`, `continued`, `archived`,
    /// `unarchived`.
    pub event: String,
    /// One short human line, for example "Edit started (OpenCode glm-5.3)".
    pub message: String,
}

// ---------------------------------------------------------------------------------------------
// System, Claude, usage, toolkit
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatus {
    /// The version of VidAI itself (`version` in tauri.conf.json), for example "0.1.0".
    pub app_version: String,
    /// The operating system VidAI runs on.
    pub platform: Platform,
    /// `false` on a system VidAI does not run on (see `platform::platform_supported`).
    pub platform_supported: bool,
    pub claude: ClaudeStatus,
    /// Git for Windows (Git Bash), which Claude Code needs on Windows (SPEC section 11,
    /// Prerequisites); `None` where nothing like it is needed (macOS).
    pub git_bash: Option<GitBashStatus>,
    /// The OpenCode 2 program (`opencode2`, `opencode::harness::locate2`), on every platform.
    pub opencode2: OpencodeCli,
    pub tools: Vec<ToolStatus>,
    /// One line about this computer for Settings, for example "Windows 11 24H2, Intel Core
    /// i7-12700, 32 GB, NVIDIA GeForce RTX 3060" (`platform::machine`); `null` when nothing is
    /// known.
    pub machine: Option<String>,
}

/// Whether Git Bash, the `bash.exe` of Git for Windows, was found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitBashStatus {
    pub found: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub logged_in: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub name: ToolName,
    pub found: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModel {
    /// What is passed to `--model`, for example "opus".
    pub value: String,
    /// For example "Opus 5.5".
    pub display_name: String,
    pub description: String,
    /// For example `["low","medium","high","xhigh","max"]`; empty means no effort choice.
    pub effort_levels: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeInfo {
    /// As reported by Claude Code, same order.
    pub models: Vec<ClaudeModel>,
    /// What Claude Code would use by itself (display only).
    pub default_model: Option<String>,
    pub default_effort: Option<String>,
    /// For example "Claude Team".
    pub subscription_type: Option<String>,
    pub version: Option<String>,
    /// `null` means never fetched yet (the cached list may be empty).
    pub fetched_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimit {
    /// "fiveHour", "weekly", or a model-scoped weekly key.
    pub key: String,
    /// "5-hour limit", "Weekly limit", "Weekly limit (Opus)".
    pub label: String,
    /// 0..100.
    #[specta(type = Number)]
    pub used_percent: f64,
    /// ISO 8601 UTC.
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatus {
    /// `false` when the plan reports no rate limits (or never fetched).
    pub available: bool,
    /// `fiveHour` first, then `weekly`, then model-scoped ones.
    pub limits: Vec<UsageLimit>,
    pub fetched_at: Option<String>,
    /// Last refresh error, user-readable.
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolkitStatus {
    pub active: ToolkitKind,
    pub standard: ToolkitFolder,
    pub own: ToolkitFolder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolkitFolder {
    /// `CLAUDE_VE_ALL` for the standard toolkit, `CLAUDE_VE_ALL_OWN` for the own one.
    pub folder_name: String,
    pub exists: bool,
    pub path: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// API options (SPEC section 7a). The keys never cross the boundary back to the UI; they are only
// a command argument (`set_api_key`).
// ---------------------------------------------------------------------------------------------

/// What the UI may know about the saved key of one API option.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatus {
    pub configured: bool,
    /// Last 4 characters only, for example "...9f2c".
    pub key_hint: Option<String>,
}

/// The saved state of the key of each API option.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatuses {
    pub opencode_go: ApiKeyStatus,
    pub anthropic_api: ApiKeyStatus,
    pub openai_api: ApiKeyStatus,
}

impl ApiKeyStatuses {
    pub fn get(&self, option: ApiOption) -> &ApiKeyStatus {
        match option {
            ApiOption::OpencodeGo => &self.opencode_go,
            ApiOption::AnthropicApi => &self.anthropic_api,
            ApiOption::OpenaiApi => &self.openai_api,
        }
    }

    pub fn get_mut(&mut self, option: ApiOption) -> &mut ApiKeyStatus {
        match option {
            ApiOption::OpencodeGo => &mut self.opencode_go,
            ApiOption::AnthropicApi => &mut self.anthropic_api,
            ApiOption::OpenaiApi => &mut self.openai_api,
        }
    }
}

/// One model an API option offers at its address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApiModel {
    /// What is passed to `--model`, for example "glm-5.3".
    pub id: String,
    /// For example "GLM-5.3".
    pub display_name: String,
}

/// The models of one option at one address, as last fetched (also cached in `state.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApiModels {
    pub option: ApiOption,
    /// The address the list belongs to (the default address when the option has none of its own).
    pub base_url: String,
    /// In the order the service lists them.
    pub models: Vec<ApiModel>,
    /// ISO 8601 UTC; null for an empty stand-in that was never fetched.
    pub fetched_at: Option<String>,
}

/// The result of the Settings "Test" action: one tiny request to the service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApiTest {
    pub ok: bool,
    /// "OpenCode Go answered with GLM-5.3." or the reason it failed.
    pub message: String,
}

/// The OpenCode quota shown in the top bar instead of the Claude limits while edits run on
/// OpenCode (SPEC section 6, "OpenCode quota").
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeUsage {
    /// `fiveHour`, `weekly`, `monthly` as OpenCode reports them; empty while unknown.
    pub limits: Vec<UsageLimit>,
    /// Why no limits can be shown, user-readable; `null` while they are shown or before the
    /// first answer.
    pub unavailable: Option<String>,
    pub fetched_at: Option<String>,
    /// Last refresh error, user-readable (the last limits are kept).
    pub error: Option<String>,
}

/// Where Claude Code is pointed at another service than the Claude subscription by the user's
/// own setup, which VidAI leaves alone but mentions (SPEC section 7a).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRouting {
    /// The `ANTHROPIC_BASE_URL` found.
    pub base_url: String,
    pub source: RoutingSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RoutingSource {
    /// The login-shell environment.
    Environment,
    /// The `env` of `~/.claude/settings.json`.
    ClaudeSettings,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_software_per_platform() {
        use ReviewSoftware::{Fcp, Premiere};
        assert_eq!(Platform::Macos.as_str(), "macos");
        assert_eq!(serde_json::to_value(Platform::Windows).unwrap(), "windows");
        assert_eq!(ReviewSoftware::default_on(Platform::Macos), Fcp);
        assert_eq!(ReviewSoftware::default_on(Platform::Windows), Premiere);
        assert!(Fcp.is_available_on(Platform::Macos));
        assert!(Premiere.is_available_on(Platform::Macos));
        assert!(!Fcp.is_available_on(Platform::Windows));
        assert!(Premiere.is_available_on(Platform::Windows));
        assert_eq!(Fcp.for_platform(Platform::Windows), Premiere);
        assert_eq!(Fcp.for_platform(Platform::Macos), Fcp);
        assert_eq!(Premiere.for_platform(Platform::Macos), Premiere);
        assert_eq!(
            ReviewSoftware::platform_default(),
            ReviewSoftware::default_on(Platform::current())
        );
    }

    #[test]
    fn settings_default_and_camel_case() {
        let json = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(json["maxConcurrentEdits"], 3);
        assert_eq!(json["activeToolkit"], "standard");
        assert_eq!(json["editingFolder"], serde_json::Value::Null);
        #[cfg(not(windows))]
        assert_eq!(json["reviewSoftware"], "fcp");
        #[cfg(windows)]
        assert_eq!(json["reviewSoftware"], "premiere");
        assert_eq!(json["theme"], "system");
        assert_eq!(json["textSize"], DEFAULT_TEXT_SIZE);
        assert_eq!(json["startDelayMinutes"], DEFAULT_START_DELAY_MINUTES);
    }

    #[test]
    fn enums_serialize_camel_case() {
        assert_eq!(
            serde_json::to_value(VideoAction::RenderFinal).unwrap(),
            "renderFinal"
        );
        assert_eq!(
            serde_json::to_value(LogKind::ToolResult).unwrap(),
            "toolResult"
        );
        assert_eq!(serde_json::to_value(ToolName::Python3).unwrap(), "python3");
        assert_eq!(
            serde_json::to_value(VideoAction::StartNow).unwrap(),
            "startNow"
        );
        assert_eq!(serde_json::to_value(Theme::Dark).unwrap(), "dark");
    }

    #[test]
    fn job_state_activity() {
        use JobState::*;
        let active: Vec<_> = [
            Queued, Running, Pausing, Paused, Stopping, Stopped, Failed, Completed,
        ]
        .into_iter()
        .filter(|s| s.is_active())
        .collect();
        assert_eq!(active, vec![Queued, Running, Pausing, Paused, Stopping]);
        assert!(Running.holds_slot() && !Paused.holds_slot() && !Queued.holds_slot());
    }

    #[test]
    fn channel_update_fields_are_optional() {
        let update: ChannelUpdate = serde_json::from_str(r#"{"folderName":"New"}"#).unwrap();
        assert_eq!(update.folder_name.as_deref(), Some("New"));
        assert!(update.long.is_none() && update.short.is_none() && update.video_type.is_none());
    }

    #[test]
    fn video_type_resolution_order() {
        use ChannelVideoType as C;
        use TypeSource as S;
        use VideoType::{Long, Short};
        let cases = [
            // override, channel, detected => type, source
            (Some(Long), C::Short, Some(Short), Long, S::Override),
            (Some(Short), C::Auto, None, Short, S::Override),
            (None, C::Short, Some(Long), Short, S::Channel),
            (None, C::Long, Some(Short), Long, S::Channel),
            (None, C::Short, None, Short, S::Channel),
            (None, C::Auto, Some(Short), Short, S::Detected),
            (None, C::Auto, Some(Long), Long, S::Detected),
            (None, C::Auto, None, Long, S::Assumed),
        ];
        for (type_override, channel, detected, want_type, want_source) in cases {
            assert_eq!(
                resolve_video_type(type_override, channel, detected),
                (want_type, want_source),
                "{type_override:?} {channel:?} {detected:?}"
            );
        }
    }

    #[test]
    fn channel_video_type_json() {
        assert_eq!(ChannelVideoType::default(), ChannelVideoType::Auto);
        assert_eq!(
            serde_json::to_value(ChannelVideoType::Short).unwrap(),
            "short"
        );
        assert_eq!(
            serde_json::to_value(TypeSource::Override).unwrap(),
            "override"
        );
        let update: ChannelUpdate = serde_json::from_str(r#"{"videoType":"long"}"#).unwrap();
        assert_eq!(update.video_type, Some(ChannelVideoType::Long));
    }

    #[test]
    fn now_iso_is_utc_millis() {
        let now = now_iso();
        assert!(now.ends_with('Z'), "{now}");
        assert_eq!(now.len(), "2026-01-01T00:00:00.000Z".len());
    }
}

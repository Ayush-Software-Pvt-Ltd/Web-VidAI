# VidAI - Product and Engineering Spec

VidAI is a desktop app that starts, tracks, pauses, continues, stops and re-edits AI video edits.
It does not edit video itself and has no timeline UI.
Every edit is done by a locally installed coding agent (Claude Code or the OpenCode 2 program), running inside the user's Editing Folder.
The result of an edit is a Final Cut Pro or Premiere Pro project file that the user opens in that software.

This document is the contract between all parts of the codebase.
If code and this document disagree, fix one of them in the same change.

## 1. Decisions already made by the product owner

- Users: a small team of video editors, each on their own Mac.
- Platforms: macOS 12 or newer on Apple Silicon and on Intel, and Windows 10 (1809 or later) and 11 on x64, from the same codebase (section 11).
  The team download is one universal app that runs natively on both kinds of Mac; single-architecture builds exist for whoever wants them (section 10, Build and release).
  The app is ad-hoc signed, without an Apple Developer ID, so the first open of a downloaded copy needs one confirmation in System Settings (README, Installing a release).
- Stack: Tauri 2, Rust core, React + TypeScript UI.
- Agents: the app never bundles Claude Code or the OpenCode 2 program.
  It only runs the `claude` or `opencode2` binary installed on the machine: Claude Code on the user's own Claude login, or either program on an API service the user chose, with the API key the user saved when the service needs one (section 7a).
  Apart from the model lists (OpenCode Go's, and the others only when the user presses Fetch Models), Test and the OpenCode Go usage that Settings asks the chosen service for with the user's key (with no key at all on options 3 and 4 when none is saved), the app sends no request to any model service itself.
  If the program of the chosen option is missing (or Claude Code is logged out on the Claude subscription), the app tells the user how to fix it.
- Permissions: Claude Code is started with `--permission-mode bypassPermissions`.
- Prompts: every channel has five complete prompts for Long (16:9) and five for Short (9:16).
  The first of each is named "Default" and cannot be renamed; the others are named by the user ("Prompt 2" to "Prompt 5" until renamed).
  There is no shared base prompt.
  The user picks which prompt an edit uses when starting it, and the video remembers the choice.
- Styles: every channel has five styles for Long and five for Short, named like the prompts ("Default", then "Style 2" to "Style 5" until renamed), stored inside VidAI; VidAI never writes them to the channel folder. Only when the selected style is empty does the edit message ask the agent to save the style it designed in `<channel>/Style/STYLE.md`.
- Long vs Short is detected automatically from the A-roll and never asked.
  The user can still correct a wrong detection from the video row.
  A channel whose camera records sideways without any rotation information can be set to Always Long or Always Short, so its videos stay fully automatic; the default is Auto-detect (see section 8).
- A video counts as edited when a review project file exists in its `output` folder.
- After review the user can either export by hand in Final Cut Pro / Premiere Pro, or press Render Final 4K to have Claude render.
- Toolkit: VidAI creates the shared toolkit folder inside the Editing Folder when it is missing, see section 7.
- The model and the reasoning effort for new edits are chosen at the top of the main window, from a list fetched live from the local Claude Code (on the Claude subscription; on the other options the model is the one chosen in Settings, Harness + API Keys).
- The 5-hour and weekly usage limits of the Claude plan are shown at the bottom left of the main window and refreshed regularly, see section 6.
- How edits run is one choice of four options, made in Settings, Harness + API Keys and in the onboarding: Claude Code with Claude Subscription, OpenCode 2 with OpenCode Go Subscription, Claude Code with Anthropic Compatible API, and OpenCode 2 with OpenAI Compatible API.
  The three that use a service each have their own API key, address and model and need no Claude login; the key is required only for OpenCode Go, and optional for the two compatible APIs, which are often a model server on the user's own computer; the program of the option (Claude Code, or the OpenCode 2 program `opencode2`, installed separately) does the editing.
  All four exist on macOS and on Windows.
  See section 7a.
- A job stays on the option its session started on, also for Continue, Re-Edit and Render Final (section 6, Setup of a job).

## 2. Folder conventions on disk

```
<Editing Folder>/
  CLAUDE.md, MEMORY.md             notes Claude reads (seeded when missing)
  CLAUDE_VE_ALL/                   standard toolkit (seeded from the bundled snapshot when missing)
  CLAUDE_VE_ALL_OWN/               optional "own" toolkit, created empty on request
  <Channel>/                       one folder per channel
    Style/                         channel assets, never a video folder
    <Video Folder>/                one folder per video
      *.mp4, *.mov ...             A-roll files, directly in the video folder
      Broll/                       optional b-roll
      CLAUDE_VE/                   Claude's working files for this video
      info.txt                     Claude's log
      output/                      review project, thumbnails, meta.txt, final render
      backup-output-N/             copy of output/ made by VidAI before a Re-Edit (N = 1, 2, ...)
```

Rules:

- Reserved at the Editing Folder root (never a channel): names starting with `.` and names starting with `CLAUDE_VE`.
- Reserved inside a channel folder (never a video): names starting with `.`, names starting with `CLAUDE_VE`, and the asset folders `Style`, `sample`, `samples`, `images`, `pictures`, `host images`, `host pictures` (all case-insensitive).
- A-roll files are regular files directly in the video folder with one of these extensions (case-insensitive): `mp4 mov m4v mkv mts m2ts avi webm`.
- Review project files in `<video>/output/`: `*.fcpxml` (file), `*.fcpxmld` (directory bundle), `*.prproj`, and `*.xml` whose first 4 KB contain `<xmeml` (Premiere / FCP7 XML).
- Final render files in `<video>/output/`: `*.mp4`, `*.mov`, `*.m4v`.
- Thumbnails in `<video>/output/`: `thumbnail-*.png` (also jpg, jpeg).
- The b-roll folder of a video is the first subfolder whose name matches `^b[-_ ]?rolls?$` case-insensitively, else the literal `Broll`.
- Before a Re-Edit VidAI copies `<video>/output/` to `<video>/backup-output-N/`, where N is the smallest whole number from 1 whose folder does not exist yet (section 6, Re-Edit backup).
  The copy is recursive, `.fcpxmld` bundles included, and `output/` itself is left as it is.
  A `backup-output-N` folder is never a review project, a render or a thumbnail source: the scanner only looks directly in `output/`, and A-roll detection only reads regular files directly in the video folder, so a backup is never taken for A-roll or output.
- VidAI never deletes or overwrites anything inside the Editing Folder.
  The only things it creates there are: the toolkit folders and seed files (section 7), a new channel folder on "New channel", a renamed channel folder on rename, and the `backup-output-N` folders of a Re-Edit (written under the hidden name `.backup-output-N.partial` and renamed when complete, a failed copy removes its partial folder again).
  While seeding it also uses a hidden temporary folder `.vidai-seed-<id>`, which it removes again (also after a crash, on the next seeding).

## 3. Architecture

```
src/                         React UI
  app/                       shell: screen routing, window frame, shortcuts, primitives gallery
  lib/                       typed IPC layer, mock backend, app store, shared helpers, platform.ts (what differs between macOS and Windows)
  components/ui/             shared UI primitives and design tokens
  features/library/          main window: channels, video list, row actions
  features/activity/         activity panel for one video
  features/jobs/             Start / Re-Edit / Render Final / Stop dialogs
  features/settings/         settings screens
  features/onboarding/       first run and "Claude Code not ready" flows
src-tauri/
  resources/default_prompt.md   default prompt for new channels
  resources/toolkit.tar.gz      bundled toolkit snapshot (built by scripts/snapshot-toolkit.sh)
  helpers/orient/main.swift     vidai-orient, the macOS picture check helper (built by build.rs, bundled as a sidecar)
  src/lib.rs                 Tauri setup and wiring only (plugins, managed state, startup hooks)
  src/lifecycle.rs           app menu, window close and reopen (section 9)
  src/instance.rs            one running VidAI per data directory (section 9, Window, menu and quitting)
  src/appearance.rs          theme and text size applied to the window (section 9, Appearance)
  src/e2e.rs                 end-to-end test hook, debug builds only (section 10)
  src/model.rs               all types that cross the IPC boundary
  src/error.rs               AppError
  src/events.rs              backend to UI events and their names
  src/bindings.rs            registration of every command and event, TypeScript generation
  src/assets.rs              runtime asset-protocol access to the Editing Folder (thumbnails)
  src/resources.rs           access to the bundled resources
  src/store.rs               settings.json and state.json persistence
  src/scanner.rs             Editing Folder scan, output detection, action rules
  src/media.rs               Long/Short detection from A-roll, its cache and the background picture checks
  src/orientation.rs         picture check decision: which turn makes the picture upright (section 8)
  src/toolkit.rs             toolkit seeding and selection
  src/secrets.rs             secret storage in the OS keychain (the API keys of the three API options, one field each); on macOS through `/usr/bin/security` (`secrets/security_cli.rs`), read once per run
  src/opencode/              the API options (section 7a): their addresses and how they are normalized, the keys, the job variables, the model lists (fetched on demand), Test, the error words, the quota, the routing note
  src/readiness.rs           what new edits need on this computer: the one decision, the same function as src/lib/readiness.ts (section 6, Readiness of a launch)
  src/opencode/harness/      the OpenCode 2 program as the agent of a job, one server per run: locating it, its command line and run configuration, its event stream translated (`locate2`, `launch2`, `events2`, `server2`; `child` holds what starting a server needs)
  src/harness.rs             which program does an edit (`for_new_job`, from the setup) and what the job engine needs from a running agent (`AgentProcess`)
  src/claude/                locating claude, auth status, login-shell env, stream-json protocol, one session process
  src/jobs/                  job manager, queue, prompt composition, logs, keeping a job going, retrying after a model error (`retry.rs`), the Re-Edit backup (`backup.rs`)
  src/platform/              OS-specific code (process groups and process trees, terminal, sleep prevention, picture check helper, AppKit calls such as the traffic-light placement)
  src/commands/              thin #[tauri::command] functions only
```

Principles:

- The Rust core is the single source of truth.
  The UI never derives business rules (which buttons a video shows comes from Rust as `actions`).
- `commands/` functions are thin: validate, call a module, map errors.
- All OS-specific code sits in `platform/` behind small functions, so the Windows port touches only that folder.
- Types cross the boundary as camelCase JSON.
  TypeScript types and command bindings are generated from Rust by tauri-specta into `src/lib/bindings.ts` (`npm run gen:types`); `cargo test` fails while that file is stale.
  The UI imports types from `src/lib/types.ts`, which re-exports the generated ones under the names of section 4.
  `Channel` is exported from Rust as `ChannelConfig` (the name `Channel` is taken by the Tauri runtime) and re-exported as `Channel`.
  IPC types never use container-level `#[serde(default)]`, so no field becomes optional in TypeScript; lenient loading of stored files happens in `store.rs`.
- Every command is registered once, in `src-tauri/src/bindings.rs`.
  Feature modules plug into startup through hooks that `lib.rs` already calls (`toolkit::on_startup`, `claude::setup`, `jobs::setup`, `scanner::setup`, `scanner::on_window_event`, `jobs::on_run_event`, `appearance::setup`, and `lifecycle::menu`, `lifecycle::on_menu_event`, `lifecycle::on_window_event`, `lifecycle::on_run_event`).
- The UI talks to the backend only through `src/lib/ipc.ts`.
  When the page is not running inside Tauri (plain browser, unit tests), `ipc.ts` uses a complete in-memory mock backend that simulates jobs, so the whole UI can be developed, tested and screenshotted without the Rust side.

Thumbnails are loaded through Tauri's asset protocol.
Its static scope is empty because the Editing Folder is chosen at runtime; `assets::allow_editing_folder` grants the Editing Folder recursively, on startup and whenever the Editing Folder is set.

Environment overrides (for tests and development):

- `VIDAI_DATA_DIR`: use this directory instead of the OS app data directory.
- `VIDAI_CLAUDE_BIN`: use this executable instead of searching for `claude`.
  Integration tests point it at a fake claude script that speaks the stream-json protocol.
- `VIDAI_OPENCODE2_BIN`: use this executable instead of searching for `opencode2` (section 7a, The OpenCode 2 program).
  Integration and end-to-end tests use the fake OpenCode 2 (`src-tauri/tests/support/fake-opencode2.py`) in its place.
- `VIDAI_E2E_OPENCODE_LOGIN` (`own` or `public`, debug builds only): the servers of the OpenCode 2 program get no key from VidAI, for the real smoke scenario (section 7a, The OpenCode 2 program).
- `VIDAI_SECRETS=memory`: keep secrets (the API keys) in memory instead of the OS keychain, so development runs and end-to-end tests never touch the real keychain.
  Nothing saved this way survives a restart.
- `VIDAI_E2E_SCRIPT`, `VIDAI_E2E_REPORT`: the end-to-end test hook of section 10 (debug builds only).
- `VIDAI_E2E_DELAY_MINUTE_MS`: how many milliseconds one minute of the start delay lasts (section 6, Start delay), a positive whole number, so end-to-end tests do not wait real minutes (debug builds only; release builds ignore it).
- `VIDAI_E2E_RETRY_SECOND_MS`: how many milliseconds one second of the retry waits lasts (section 6, Retrying after a model error), a positive whole number, so end-to-end tests do not wait minutes (debug builds only; release builds ignore it).
  A reset time the provider names is real time and is never shortened.

## 4. Data model

```ts
type VideoType = "long" | "short";
type ChannelVideoType = "auto" | "long" | "short";   // "Auto-detect" | "Always Long" | "Always Short"
type TypeSource = "override" | "channel" | "detected" | "assumed";   // where VideoView.videoType comes from, section 8
type ReviewSoftware = "fcp" | "premiere";       // "Final Cut Pro" | "Premiere Pro"
type ToolkitKind = "standard" | "own";           // CLAUDE_VE_ALL | CLAUDE_VE_ALL_OWN
type Theme = "system" | "light" | "dark";        // "system" follows the macOS appearance

interface Settings {
  editingFolder: string | null;
  reviewSoftware: ReviewSoftware;                // default: fcp on macOS, premiere on Windows (the only one there)
  maxConcurrentEdits: number;                    // 1..8, default 3
  model: string | null;                          // passed as --model; null = Claude Code's default
  effort: string | null;                         // passed as --effort; null = Claude Code's default
  activeToolkit: ToolkitKind;                    // default "standard"
  channels: Channel[];                           // display order
  theme: Theme;                                  // default "system"
  textSize: number;                              // body text size in px, 11..20, default 15 (the UI is designed at 13)
  startDelayMinutes: number;                     // 0..120, default 10; 0 = no delay
  maxModelRetries: number;                       // 0..50, default 5; 0 = no automatic retries
  setup: Setup;                                  // how edits run (section 7a), default "claudeSubscription"
  apiOptions: ApiOptions;                        // address, model and reasoning efforts of each API option
  noSleep: boolean;                              // the No Sleep checkbox of the main sidebar (section 11, Sleep prevention), default false; a preference of this machine, never exported
}
type Setup = "claudeSubscription" | "opencodeGo" | "anthropicApi" | "openaiApi";   // "Claude Code with Claude Subscription" | "OpenCode 2 with OpenCode Go Subscription" | "Claude Code with Anthropic Compatible API" | "OpenCode 2 with OpenAI Compatible API"
type ApiOption = "opencodeGo" | "anthropicApi" | "openaiApi";   // the setups that have an API key (required only for opencodeGo), an address, a model and efforts of their own
interface ApiOptions { opencodeGo: ApiOptionSettings; anthropicApi: ApiOptionSettings; openaiApi: ApiOptionSettings; }
interface ApiOptionSettings {
  baseUrl: string | null;                        // normalized address (section 7a, Options, addresses and protocols); null = the default address of the option
  model: string | null;                          // the model id of every edit on this option
  efforts: Record<string, string>;               // reasoning effort per model id ("low" | "medium" | "high" | "xhigh" | "max"); a model without an entry is on Default (nothing is sent)
}
type Harness = "claudeCode" | "opencode2";   // the program of a setup, "Claude Code" | "OpenCode 2"; not a setting, it follows from the setup (section 7a)
interface GeneralSettings { reviewSoftware: ReviewSoftware; maxConcurrentEdits: number; startDelayMinutes: number; maxModelRetries: number; }
interface AppearanceSettings { theme: Theme; textSize: number; }

interface Channel {
  id: string;                                    // uuid, stable across renames
  folderName: string;                            // directory name inside the Editing Folder
  videoType: ChannelVideoType;                   // default "auto"; "long" / "short" fix the type of every video
  long: ChannelProfile;
  short: ChannelProfile;
}
interface ChannelProfile { prompts: ChannelSlot[]; styles: ChannelSlot[]; }   // always exactly 5 of each
interface ChannelSlot { name: string; text: string; }   // slot 0 is always named "Default"; other names are 1 to 40 characters

interface Library {
  editingFolder: string | null;
  editingFolderExists: boolean;
  channels: ChannelView[];                       // the channels in Settings, same order
  discoveredFolders: string[];                   // non-reserved folders not yet added as channels
  running: number; queued: number;               // job counts for the toolbar
}
interface ChannelView { id: string; folderName: string; exists: boolean; videos: VideoView[]; }

interface VideoView {
  id: string;                                    // `${channelId}/${folderName}`
  channelId: string;
  folderName: string;
  path: string;                                  // absolute
  createdAt: string;                             // ISO 8601: creation time of the video folder, its modified time when the file system keeps none (the Age sort)
  detectedType: VideoType | null;                // null when there is no readable A-roll
  typeOverride: VideoType | null;                // chosen on the video row
  channelType: ChannelVideoType;                 // the channel's videoType
  videoType: VideoType;                          // the effective type, resolved as in section 8
  typeSource: TypeSource;                        // where videoType comes from
  arollCount: number;
  arollRotation: number | null;                  // 90, 180 or 270: clockwise turn that makes a sideways main A-roll upright; null otherwise
  output: VideoOutput;
  edited: boolean;                               // output.reviewFiles is not empty
  finalRendered: boolean;                        // output.finalFiles is not empty
  job: JobView | null;                           // latest job of this video
  actions: VideoAction[];                        // what the row may offer right now
}
interface VideoOutput {
  dir: string;
  reviewFiles: OutputFile[];                     // newest first
  finalFiles: OutputFile[];                      // newest first
  thumbnails: string[];                          // absolute paths, sorted by name
  metaFile: string | null;
  infoFile: string | null;                       // <video>/info.txt
}
interface OutputFile { path: string; name: string; modifiedAt: string; software: ReviewSoftware | null; }

type VideoAction = "start" | "pause" | "continue" | "stop" | "reEdit" | "renderFinal" | "startNow" | "archive";
type JobKind = "edit" | "reEdit" | "render";
type JobState = "queued" | "running" | "pausing" | "paused" | "stopping" | "stopped" | "failed" | "completed";

interface JobView {
  id: string;
  videoId: string;
  kind: JobKind;
  state: JobState;
  sessionId: string | null;
  toolkit: ToolkitKind;                          // toolkit this job started with
  model: string | null;                          // model and effort this job started with
  effort: string | null;
  videoType: VideoType;
  createdAt: string;                             // ISO 8601 UTC
  startedAt: string | null;
  endedAt: string | null;
  activeMs: number;                              // time spent running, pauses and queue time excluded
  runningSince: string | null;                   // set while running, so the UI can tick a clock
  lastActivity: string | null;                   // one short line, for example "Running ffmpeg"
  error: string | null;                          // user-readable, set for failed
  costUsd: number | null;
  progress: JobProgress | null;                  // null while a new job waits in the queue (section 6, Progress)
  startsAt: string | null;                       // ISO 8601 UTC; set only while queued and held back by the start delay
  setup: Setup;                                  // how this job's session runs (section 7a); `model` is the model of that setup
  harness: Harness | null;                       // the program this job's session runs in, derived from the setup when it started; null = Claude Code (before schema 5)
}
interface JobProgress {
  percent: number;                               // 0..100
  stage: string | null;                          // one short user-facing label, for example "Transcribing"
}

interface LogEntry {
  seq: number;                                   // increasing per job
  ts: string;
  kind: "status" | "assistant" | "tool" | "toolResult" | "user" | "error";
  text: string;                                  // one short readable line or the assistant's text
  detail: string | null;                         // full command / input / output, truncated to 4,000 chars
  nested: boolean;                               // produced by a sub-agent
}

interface VideoInputs { productLinks: string; notes: string; promptSlot: number; styleSlot: number; }   // remembered per video; the slots are indexes 0 to 4 into the prompts and styles of the video's type

type Platform = "macos" | "windows";

interface SystemStatus {
  appVersion: string;                            // VidAI's own version (tauri.conf.json), for example "0.1.0"
  platform: Platform;                            // the system VidAI runs on
  platformSupported: boolean;                    // false on a system VidAI does not run on (section 1)
  claude: { found: boolean; path: string | null; version: string | null; loggedIn: boolean; };
  gitBash: { found: boolean; path: string | null; } | null;   // Git for Windows (section 11); null on macOS
  opencode2: OpencodeCli;                        // the OpenCode 2 program, on every platform (section 7a)
  tools: { name: "ffmpeg" | "ffprobe" | "python3" | "node"; found: boolean; path: string | null; }[];
  machine: string | null;                        // one line about this computer, for example "Windows 11 24H2, Intel Core i7-12700, 32 GB, NVIDIA GeForce RTX 3060" (section 6, Machine facts); null when nothing is known
}

interface ClaudeModel {
  value: string;                                 // what is passed to --model, for example "opus"
  displayName: string;                           // for example "Opus 5.5"
  description: string;
  effortLevels: string[];                        // for example ["low","medium","high","xhigh","max"]; empty = no effort choice
}
interface ClaudeInfo {
  models: ClaudeModel[];                         // as reported by Claude Code, same order, without its own "default" entry
  defaultModel: string | null;                   // the `value` in `models` that Claude Code would use by itself (display only)
  defaultEffort: string | null;
  subscriptionType: string | null;               // for example "Claude Team"
  version: string | null;
  fetchedAt: string | null;                      // null = never fetched yet (cached list may be empty)
}

interface UsageLimit {
  key: string;                                   // "fiveHour", "weekly", or a model-scoped weekly key
  label: string;                                 // "5-hour limit", "Weekly limit", "Weekly limit (Opus)"
  usedPercent: number;                           // 0..100
  resetsAt: string | null;                       // ISO 8601 UTC
}
interface UsageStatus {
  available: boolean;                            // false when the plan reports no rate limits (or never fetched)
  limits: UsageLimit[];                          // fiveHour first, then weekly, then model-scoped ones
  fetchedAt: string | null;
  error: string | null;                          // last refresh error, user-readable
}

interface ToolkitStatus {
  active: ToolkitKind;
  standard: ToolkitFolder;                       // folderName is always "CLAUDE_VE_ALL"
  own: ToolkitFolder;                            // folderName is always "CLAUDE_VE_ALL_OWN"
}
interface ToolkitFolder { folderName: string; exists: boolean; path: string | null; }

interface ApiKeyStatus {
  configured: boolean;                           // a key is saved in VidAI for this option
  keyHint: string | null;                        // last 4 characters only, for example "...9f2c"
}
interface ApiKeyStatuses { opencodeGo: ApiKeyStatus; anthropicApi: ApiKeyStatus; openaiApi: ApiKeyStatus; }
interface ApiModel { id: string; displayName: string; }
interface ApiModels { option: ApiOption; baseUrl: string; models: ApiModel[]; fetchedAt: string | null; }   // the list of one option at one address
interface ApiTest { ok: boolean; message: string; }
interface OpencodeUsage {
  limits: UsageLimit[];                          // "fiveHour", "weekly", "monthly" as OpenCode reports them
  unavailable: string | null;                    // why there are none, user-readable
  fetchedAt: string | null;
  error: string | null;                          // last refresh error (the last limits are kept)
}
interface ClaudeRouting { baseUrl: string; source: "environment" | "claudeSettings"; }   // the user's own ANTHROPIC_BASE_URL
interface OpencodeCli {                          // the OpenCode 2 program (`opencode::harness::locate2`)
  found: boolean;
  path: string | null;
  version: string | null;                        // as `opencode2 --version` prints it, for example "2.2.6"
  supported: boolean;                            // VidAI drives this version: 2.x (2.0 or later)
}

interface ArchivedVideo {                        // one video removed from the main list with Archive (state.json, `archived`)
  videoId: string;                               // `<channelId>/<folderName>` when archived
  channelId: string;
  folderName: string;
  path: string;                                  // absolute path of the video folder when archived
  archivedAt: string;                            // ISO 8601 UTC
}

interface EditLogEntry {                         // what happened to a video (Edit Log in the main window; mirrored to `VidAI-edit-log.txt`)
  ts: string;                                    // ISO 8601 UTC
  videoId: string;                               // `<channelId>/<folderName>`
  folder: string;                                // video folder name, for humans
  event: string;                                 // `started`, `completed`, `failed`, `stopped`, `paused`, `continued`, `archived`, `unarchived`
  message: string;                               // what happened, one short line without the folder name ("Edit started (Claude Code)", "Finished (Claude Code)", "Needs attention: <reason>", "Stopped", "Paused", "Continued", "Archived", "Unarchived")
}

interface AppError { code: ErrorCode; message: string; }   // every command rejects with this shape; ErrorCode is the union of the codes below
```

Fields added in schema version 3, and where their behaviour is specified:

- `theme` and `textSize`: the appearance of the UI, applied as described in section 9, Appearance.
  They are preferences of the person at that Mac, so settings files never carry them (section 5).
- `startDelayMinutes`, `JobView.startsAt` and the `startNow` action: the start delay between job starts (section 6, Start delay).
- `maxModelRetries`: how often a job retries by itself after a model error (section 6, Retrying after a model error).
- `noSleep`: when true, the computer is kept awake until every edit has ended, not only while one runs (section 11, Sleep prevention).
  It is saved by `set_no_sleep`, is not part of the settings export, and files from before it existed load it as false.
- `JobView.progress`: the progress bar of a job (section 6, Progress).
- `VideoView.arollRotation`: the picture check of the type detection (section 8).
  It is 90, 180 or 270 when the picture check found the main A-roll stored sideways or upside down with no rotation flag, else null.

Fields added in schema versions 4 and 5 (`provider`, `opencode` with its `harness`, `JobView.provider`, `JobView.harness`, the cached OpenCode models) are replaced in version 9 by the ones below; files of those versions migrate as section 7a, Migration from 0.2.4, says.

Fields added in schema version 9: `setup` and `apiOptions` of the settings (they replace `provider` and `opencode`), `JobView.setup` (it replaces `JobView.provider`) and the cached model list of OpenCode Go in the state (`apiModels`, replacing `opencodeModels`); `JobView.harness` stays.

Error codes used across the boundary: `claudeNotInstalled`, `claudeNotLoggedIn`, `gitBashMissing` (Windows, section 11), `noEditingFolder`, `notFound`, `invalidInput`, `conflict` (for example a rename while a job is active), `io`, `internal`, `secretsUnavailable` (the saved API keys could not be read from the macOS Keychain, section 7a).

### Persistence

In the app data directory (`VIDAI_DATA_DIR` or the OS default for bundle id `com.vidai.desktop`):

- `settings.json`: the `Settings` object, plus a `schemaVersion` (currently 9).
  Version 1 files have no channel `videoType`; they load with `"auto"` for every channel.
  Version 2 files have no `theme`, `textSize` or `startDelayMinutes`; they load with `"system"`, 15 and 10.
  Versions 3 to 5 lack fields of the version 8 shape (`provider`, `opencode`, `opencode.harness`, `opencode.efforts`); the missing ones load with the Claude subscription, the default address and no model, the harness `"claudeCode"` (so does a harness this version does not know) and no efforts, and an effort entry with an empty model id or a level that is not on the ladder is dropped; the file is then migrated like a version 8 file.
  Version 6 files have one `prompt` and one `style` per channel video type; they load as slot 0 ("Default") of `prompts` and `styles`, with the other slots empty and named "Prompt 2" to "Prompt 5" and "Style 2" to "Style 5".
  On load every profile is made exactly five prompts and five styles (missing slots are empty and default-named, extra ones are dropped), slot 0 is named "Default", and other names are trimmed, cut to 40 characters and default-named when empty.
  In `state.json`, version 6 videos have no `inputs.promptSlot` or `inputs.styleSlot`; they load as 0, and a stored value outside 0 to 4 loads as 0.
  Version 7 files can name the harness `"opencode"`, the program of an earlier VidAI that this one no longer drives; it loads as `"opencode2"`, and so does the `harness` of a saved job in `state.json`.
  Version 8 files (VidAI 0.2.4 and earlier) have `provider` and `opencode` instead of `setup` and `apiOptions`; `store.rs` migrates them with the rules of section 7a, Migration from 0.2.4, and the next save writes version 9.
  In a version 9 file a `setup` this version does not know, or an API option as `setup` without a model, loads as `claudeSubscription`; an address that is not valid for its option loads as that option's default.
  Files from before `maxModelRetries` load with 5.
  Files from before `noSleep` load it as false.
  Numbers out of range (`maxConcurrentEdits`, `textSize`, `startDelayMinutes`, `maxModelRetries`) are clamped into range on load.
- `state.json`: per video id: `typeOverride`, `inputs`, latest job, cached type detection (keyed by file path, size, mtime), and the progress memory of the latest job (`progressMemory`: its finished milestones and when, section 6, Progress).
  Once for the whole app: `progressHistory`, how long the milestones of the last 10 completed jobs per kind and video type took; `archived`, the videos removed from the main list with Archive (keyed by video id); `editLog`, what happened to each video, oldest first (at most 2,000 entries, oldest dropped).
  It carries the same `schemaVersion`; jobs saved before version 3 have no `progress` or `startsAt` and load with both null, and files without `progressMemory` or `progressHistory` load them empty.
  Jobs saved before version 9 have `provider` instead of `setup` and load mapped as in section 7a, Migration from 0.2.4 (a job's `model`, `effort`, session and everything else stay as they were).
  `apiModels`, the models last fetched for OpenCode Go with their address (`ApiModels`), is optional; a saved `opencodeModels` is copied into it as in section 7a, Migration from 0.2.4.
  Lists of `anthropicApi` and `openaiApi` are never kept: an entry for them in an older file is ignored and dropped at the next save.
  Jobs saved before version 5 have no `harness` and load with null, Claude Code; an unknown `harness` (a hand-edited file, or written by a newer VidAI) loads as `claudeCode`.
  Files saved before archiving and the edit log existed load them empty.
- `logs/<jobId>.jsonl`: one `LogEntry` per line.
- In the Editing Folder: `VidAI-edit-log.txt`, one line per edit log entry (`[<ts>] <videoId> <event> - <message>`), appended whenever the entry is recorded.
  It is never deleted by VidAI, so the log survives an uninstall.
- `start-delay.json`: `{ "lastLaunch": "<ISO 8601 UTC>" }`, the time of the most recent job launch, so the start delay survives a restart (section 6, Start delay).
  A missing or unreadable file means no launch is known.
- `running-processes.tsv`: the crash watchdog's registry of the process trees of running jobs, one `<pid><TAB><command line>` line per process, rewritten whenever a job's tree changes and emptied when nothing runs.
  A small watchdog process (`sh`) waits on a pipe that only VidAI holds; when VidAI ends for any reason (quit, crash, force quit) the pipe closes and the watchdog sends SIGTERM, then SIGKILL three seconds later, to every listed process and the process groups they lead.
  On the next start the registry is swept again, and only processes whose command line still matches are touched (protection against reused process ids).

Writes are atomic (write a temp file in the same directory, fsync, rename).
The only change that does not write `state.json` at once is the time-based creep of a progress bar: it is kept in memory and written with the next save, at the latest after 10 seconds, and when VidAI quits.
A corrupt file is moved aside as `<name>.corrupt-<timestamp>` and replaced by defaults, never silently overwritten.

## 5. IPC contract

Commands (all async, all reject with `AppError`):

| Command | Arguments | Returns |
|---|---|---|
| `get_settings` | | `Settings` |
| `set_editing_folder` | `path` | `Settings` (also seeds the toolkit, section 7) |
| `update_general_settings` | `{ reviewSoftware, maxConcurrentEdits, startDelayMinutes, maxModelRetries }` | `Settings` |
| `update_appearance` | `{ theme, textSize }` | `Settings` (also applies them to the window, section 9, Appearance) |
| `set_no_sleep` | `{ on: boolean }` | `Settings` (also applies it to sleep prevention at once, section 11, Sleep prevention) |
| `set_model_selection` | `{ model: string or null, effort: string or null }` | `Settings` |
| `get_claude_info` | `{ refresh: boolean }` | `ClaudeInfo` (cached unless `refresh`) |
| `get_usage` | `{ refresh: boolean }` | `UsageStatus` (cached unless `refresh`) |
| `get_default_prompt` | | `string` |
| `add_channel` | `folderName` (existing folder) | `Settings` |
| `create_channel` | `folderName` (creates the folder) | `Settings` |
| `update_channel` | `id, { folderName?, videoType?, long?, short? }` | `Settings` |
| `remove_channel` | `id` | `Settings` |
| `reorder_channels` | `ids` | `Settings` |
| `export_settings` | `path` | |
| `import_settings` | `path` | `Settings` |
| `get_library` | | `Library` (archived videos are not listed) |
| `set_video_type_override` | `videoId, type or null` | `VideoView` |
| `get_video_inputs` | `videoId` | `VideoInputs` |
| `archive_video` | `videoId` | `ArchivedVideo` (only edited videos and failed edits; `invalidInput` otherwise, `conflict` when already archived) |
| `unarchive_video` | `videoId` | `VideoView` (`notFound` when not archived) |
| `get_archived` | | `ArchivedVideo[]` (every archived video, newest first, each `path` the folder's current path, so renaming a channel keeps its archive; entries whose folders no longer exist are removed first, but only while the Editing Folder is reachable) |
| `get_edit_log` | | `EditLogEntry[]` (oldest first) |
| `start_edit` | `videoId, inputs: VideoInputs` | `JobView` |
| `pause_job` | `videoId` | `JobView` |
| `continue_job` | `videoId` | `JobView` |
| `stop_job` | `videoId` | `JobView` |
| `re_edit` | `videoId, changes` | `JobView` |
| `render_final` | `videoId, { timelineExportPath: string or null, notes: string }` | `JobView` |
| `start_job_now` | `videoId` | `JobView` (starts a queued job now, skipping the start delay, section 6) |
| `get_job_log` | `videoId` | `LogEntry[]` (latest job, at most the last 5,000 entries) |
| `check_system` | | `SystemStatus` |
| `open_claude_login` | | opens a terminal running `claude auth login` |
| `open_claude_install` | | opens a terminal with the install command typed in |
| `get_toolkit_status` | | `ToolkitStatus` |
| `create_own_toolkit` | | `ToolkitStatus` |
| `set_active_toolkit` | `kind` | `ToolkitStatus` |
| `retry_secrets` | | reads the saved API keys again after the startup read failed (Try Again, section 7a) |
| `get_api_key_statuses` | | `ApiKeyStatuses` (the saved state of the key of each API option) |
| `set_api_key` | `option: ApiOption, key` | `ApiKeyStatuses` (the key of that option only) |
| `clear_api_key` | `option: ApiOption` | `ApiKeyStatuses` (when the setup is `opencodeGo`, edits go back to `claudeSubscription`, with `settings-changed`; options 3 and 4 stay selected without their key) |
| `set_setup` | `setup: Setup` | `Settings` (how edits run; an API option only with its model chosen, and for `opencodeGo` its key saved, `invalidInput` otherwise) |
| `set_api_base_url` | `option: ApiOption, baseUrl: string or null` | `Settings` (null or empty is the default address of the option; normalized by the rules of its protocol, section 7a, Options, addresses and protocols) |
| `set_api_model` | `option: ApiOption, model: string or null` | `Settings` (null on the selected option also selects `claudeSubscription`) |
| `set_api_effort` | `option: ApiOption, model: string, effort: string or null` | `Settings` (the reasoning effort of one model of that option; null is Default and removes the entry; a level outside `low`, `medium`, `high`, `xhigh`, `max` is refused) |
| `get_api_models` | `option: ApiOption, { refresh: boolean }` | `ApiModels` (live from the list address of the option's protocol, section 7a, when `refresh`; otherwise OpenCode Go's cached list, and an empty stand-in for the options that keep none) |
| `test_api` | `option: ApiOption` | `ApiTest` (one tiny request with the option's key, address and model; `invalidInput` without a chosen model, and for `opencodeGo` without a saved key; options 3 and 4 are tested without a key when none is saved) |
| `get_opencode_usage` | `{ refresh: boolean }` | `OpencodeUsage` (cached unless `refresh`; the OpenCode Go quota of the selected setup, section 7a) |
| `get_claude_routing` | | `ClaudeRouting` or null |
| `get_opencode2_cli` | | `OpencodeCli` (the `opencode2` program; always checked afresh) |
| `open_opencode2_install` | | opens a terminal (Terminal on a Mac, PowerShell on Windows) with the official OpenCode 2 installer typed in; rejects with `io` when the window cannot be opened |
| `open_path` | `path` | opens with the default app |
| `reveal_path` | `path` | shows in Finder / Explorer |
| `confirm_quit` | | pauses every running job, then exits the app |

Events (backend to UI):

| Event | Payload | Meaning |
|---|---|---|
| `library-changed` | none | something on disk or in a job changed, call `get_library` again |
| `job-updated` | `JobView` | a job changed state, its `lastActivity` or its `progress` (at most about once a second per job) |
| `job-log` | `{ videoId, jobId, entries: LogEntry[] }` | new log entries (batched, at most every 150 ms) |
| `usage-updated` | `UsageStatus` | the usage limits were refreshed |
| `claude-info-updated` | `ClaudeInfo` | the model list was refreshed |
| `quit-requested` | `{ running: number }` | the user tried to quit while jobs run; the UI confirms and calls `confirm_quit` |
| `settings-changed` | `Settings` | the settings changed without a command from the UI (the View menu's text size items, section 9, Appearance) |
| `opencode-usage-updated` | `OpencodeUsage` | the OpenCode quota was refreshed |

Channel command behaviour:

- `add_channel` and `create_channel` put the default prompt into prompt slot 0 ("Default") of Long and of Short; the other slots are empty.
  If `<channel>/Style/STYLE.md` exists, its text is copied into style slot 0 of both once (the file is only read).
- `update_channel` with a new `folderName` renames the folder on disk.
  It fails with `conflict` when the target exists or any video of the channel has an active job.
- `update_channel` with a `long` or `short` profile replaces it whole.
  It fails with `invalidInput` unless the profile has exactly five prompts and five styles and every name except slot 0 is 1 to 40 characters after trimming; slot 0 is always saved as "Default".
- `update_channel` with a `videoType` is allowed while jobs run, because a job keeps the type it started with (section 6).
- `remove_channel` removes the channel from VidAI only.
  The folder stays on disk and shows up again under `discoveredFolders`.
  It fails with `conflict` while the channel has an active job.
- Folder names are validated: not empty, no `/` or `:`, not reserved, not `.` or `..`, trimmed.
  Folder names are compared without letter case (as macOS does), so `tech` and `Tech` are the same channel.
- `set_editing_folder` fails with `conflict` while any job is active, because running Claude Code processes work inside the current folder.

Settings command behaviour:

- `update_general_settings` refuses a `maxConcurrentEdits` outside 1..8, a `startDelayMinutes` outside 0..120, a `maxModelRetries` outside 0..50, or a `reviewSoftware` the platform does not have (Final Cut Pro on Windows) with `invalidInput`, and nothing changes.
  After saving it lets the job queue react at once (a raised limit or a shorter start delay starts queued jobs, and `startsAt` follows a changed delay) and scans the library again, since a changed limit can add or remove `startNow`.
- `update_appearance` refuses a `textSize` outside 11..20 with `invalidInput`, and nothing changes.
  After saving it applies the theme and the text size to the window at once (section 9, Appearance).
- `set_setup` refuses an API option that has no chosen model, or `opencodeGo` without a saved key (the key of the other two is optional), with `invalidInput`, and nothing changes; it does not check the program (a missing program is a readiness problem, section 6).
  It is allowed while jobs run: running and paused sessions stay on the setup they started on, and only new jobs use the new one.
  After saving it refreshes the quota meters (section 7a).
- `set_api_key` saves the key of one API option (a blank key is `invalidInput`; `secretsUnavailable` when the saved keys could not be read, section 7a, Secrets) and returns the statuses of all three; `clear_api_key` removes it, and when that option is the selected `opencodeGo` the same change selects `claudeSubscription`; `anthropicApi` and `openaiApi` stay selected, because they work without a key.
- `set_api_base_url` normalizes the address by the rules of the option (`opencode::normalize_base_url`, section 7a, Options, addresses and protocols) and refuses one that cannot be used with `invalidInput`; null or empty resets it to the default.
- `set_api_model` saves the model of one option (null clears it, and on the selected option also selects `claudeSubscription`); `set_api_effort` remembers the reasoning effort of one model of one option (null forgets it).
- `get_api_models` with `refresh` true asks the option's service for its models (the UI does so for `anthropicApi` and `openaiApi` only when the user presses Fetch Models, and for `opencodeGo` when its card opens or is refreshed) and returns them; only OpenCode Go's list is cached in `state.json`; without `refresh` it returns that cached list when it is of the option's address, otherwise an empty stand-in; `test_api` sends the one tiny request of the option (section 7a, Test and errors).
- `export_settings` writes channels (video type, prompts and styles) and general settings to one JSON file, so a team can share them.
  `import_settings` merges by `folderName`: imported channels replace the video type, prompts and styles of channels with the same folder name and add the others.

Settings files (`export_settings` / `import_settings`):

- The file is JSON: `{ "format": "vidai-settings", "version": 2, "exportedAt", "general": { reviewSoftware, maxConcurrentEdits, startDelayMinutes, maxModelRetries, model, effort }, "channels": [{ folderName, videoType, long, short }] }`.
- A channel without `videoType` (files exported before it existed) imports as `"auto"`; missing prompts and styles import as empty.
- Version 1 files have one `prompt` and one `style` per video type; they import as slot 0 of `prompts` and `styles`.
  Imported profiles are made exactly five slots the same way as on load (see Persistence); `import_settings` refuses a file whose version is newer than 2.
- Never exported or imported: secrets, `editingFolder` (it belongs to one machine), `activeToolkit` (it depends on what exists on that disk), `theme` and `textSize` (preferences of the person at that Mac), `setup` and `apiOptions` (how edits run and each option's address, model and efforts: preferences of that machine, and the keys are secrets) and channel ids (each machine keeps its own).
- Import applies the general settings present in the file (the model and effort are checked against the known model list, `maxConcurrentEdits`, `startDelayMinutes` and `maxModelRetries` are clamped to their ranges) and keeps channels that are not in the file.
  A review software the platform does not have (Final Cut Pro in a file made on a Mac, imported on Windows) is left out and the current one is kept; the rest of the file still applies.
  Likewise a `settings.json` that names Final Cut Pro loads with Premiere Pro on Windows.
  A file without `startDelayMinutes` or `maxModelRetries` (made before they existed) keeps the current value.
  New channels are added at the end with a new id; their folder may not exist yet on this machine.
- A file with another `format`, a newer `version`, an invalid folder name, a folder name listed twice or an unknown `videoType` is refused with `invalidInput`, and nothing changes.

The library must stay fresh without user action.
The backend rescans (cheap, three levels deep, no recursion into `CLAUDE_VE`) on a 3 second timer while the window is visible, on window focus, and after every job event, and emits `library-changed` only when the result actually differs.

## 6. Jobs

### Which actions a video offers

`actions` is computed in Rust by one pure, unit-tested function.

| Situation | actions |
|---|---|
| job is `queued`, the start delay holds it (`startsAt` is set) and a slot is free | `startNow`, `stop` |
| job is `queued`, otherwise | `stop` |
| job is `running` | `pause`, `stop` |
| job is `pausing` or `stopping` | none |
| job is `paused` | `continue`, `stop` |
| no active job, not edited, job is `failed` | `continue`, `start`, `archive` |
| no active job, not edited, otherwise | `start` |
| no active job, edited, job is `failed` | `continue`, `reEdit`, `renderFinal`, `archive` |
| no active job, edited, otherwise | `reEdit`, `renderFinal`, `archive` |

`archive` removes the video from the main list (Archive in the main window keeps it; the job history is kept, so unarchiving restores it).
Archived videos and videos whose folders no longer exist are not listed.

"A slot is free" means fewer than `maxConcurrentEdits` latest jobs are `running`, `pausing` or `stopping`.

"Active" means `queued`, `running`, `pausing`, `paused` or `stopping`.
There is at most one active job per video.
Only the latest job per video is kept.

### State machine

- `start_edit`, `re_edit`, `render_final`, `continue_job` put the job in `queued`.
  The queue is first in, first out.
  At most `maxConcurrentEdits` jobs are in `running`, `pausing` or `stopping` at once.
  A changed limit applies at once: when `update_general_settings` or `import_settings` raises it, queued jobs start right away.
- `queued` to `running` when a slot is free and the start delay allows it (see Start delay): the Claude process is spawned and the message is sent.
- `running` to `pausing` on `pause_job`: interrupt the turn, wait for Claude to go idle, close the process, then `paused`.
  The session id is kept, so nothing is lost.
- `paused` to `queued` on `continue_job`: a new process resumes the same session with a "continue" message.
- `running`, `paused` or `queued` to `stopping` then `stopped` on `stop_job`: interrupt, then end the whole process tree.
  Working files stay on disk.
  A later Start Editing begins a new session.
- `running` to `completed` when Claude is finished (see below) and the expected output exists.
  Where jobs keep themselves going (see Keeping a job going), when the job is done by the rule of that section.
- `running` to `failed` when Claude is finished without the expected output, exits with an error, or reports an error result.
  Where jobs keep themselves going, a turn that ends before the work is done is not a failure: the job stays `running` and VidAI sends the next message itself; it fails only for the reasons listed in that section.
  `error` holds a short, human message (for example "Claude usage limit reached, resets at 4:30 PM" or "Claude finished without creating a review project").
- `continue_job` on a `failed` job resumes the same session and tells Claude what was missing.

### Start delay

`startDelayMinutes` (Settings, General, "Delay in between Video editing start", default 10, 0 to 120) spaces out the starts of new work, so several edits do not all want the CPU and GPU at the same moment.

- A launch is a queued job of any kind (`edit`, `reEdit`, `render`) going from `queued` to `running`.
  A continue (`continue_job` of a paused or failed job that has a session) is not a launch: the user resumes work that was already started.
  A continue of a job without a session starts the job's request again, so it is a launch.
- A launch needs a free slot and, in addition, one of: no job holds a slot (`running`, `pausing`, `stopping`), or at least `startDelayMinutes` have passed since the most recent launch.
  So the first job always starts at once, the second one `startDelayMinutes` after the first one started, and a job queued long after the previous launch starts at once.
- Every launch restarts the delay clock; a continue neither waits for the delay nor restarts its clock (it only needs a free slot, as before).
- The queue stays first in, first out: when the delay holds the first waiting launch, the launches behind it wait too, and they start one delay apart.
  Continues behind it may pass it when a slot is free.
- `startDelayMinutes = 0` turns the delay off: only the slots count.
- `JobView.startsAt` (ISO 8601 UTC) is set while a queued job waits because of the delay: the first waiting launch gets the last launch plus the delay, the next one more delay, and so on.
  It is null for every other job, and for every queued job when the delay is not what holds the queue (for example the delay has passed and the job only waits for a free slot).
  It follows changes at once (a changed setting, a job ahead leaving the queue, a launch), each change is announced with `job-updated` (with `lastActivity` "Waiting for the start delay", back to "Waiting for a free slot" or "Waiting to continue" when the delay no longer holds it) and a library rescan, since `startNow` depends on it.
- The queue is looked at again exactly when the delay of the first waiting launch runs out (a timer, no polling), when the setting changes (`update_general_settings`, `import_settings`), and whenever a job ends: a job that ends leaving no job in a slot lets the next launch start at once.
  The delay is measured on the wall clock; the timer re-checks it at least once a minute, so a Mac that slept or a changed clock cannot postpone a start by more than that.
  A last launch in the future (the clock was set back) counts as now, so nothing waits longer than one delay.
- `start_job_now` lets the user skip the delay for one queued job: it starts that job at once, ahead of the queue, and restarts the delay clock (it is a launch), then the other waiting jobs get their new `startsAt`.
  It still needs a free slot: otherwise it fails with `conflict` ("All 3 edit slots are in use.", or "The only edit slot is in use." with a limit of 1).
  A job that is not queued is returned unchanged; a video without a job fails with `notFound`.
- The time of the most recent launch is saved in `start-delay.json` (section 4, Persistence) at every launch and read when VidAI starts, so the delay holds across a restart.
  It is persisted rather than derived from the jobs because only the latest job of each video is kept, and `startedAt` does not change when a job without a session is continued, so the jobs alone cannot tell the last launch reliably.
  On startup nothing runs and queued jobs are turned into paused jobs or dropped (see Other job behaviour, their `startsAt` cleared), so the first launch after a restart starts at once unless a continued job already holds a slot; then the saved time applies.
- The end-to-end tests shorten the minute with `VIDAI_E2E_DELAY_MINUTE_MS` (section 3, debug builds only).

### One session per video

Every video is edited in Claude Code sessions of its own; no two videos ever share one.

- Each job runs its own `claude` process, started with exactly one of `--session-id <new uuid>` (a new session) or `--resume <the video's own session>` (continue, re-edit and render final of the same video).
  `--continue` is never used: it picks the most recent conversation of the working directory, which is the Editing Folder that every video shares.
- A new session id is a fresh random UUID; Start Editing always starts a new session.
  `reEdit` and `render` resume the session of the video's own latest job, `continue_job` the job's own session.
- The helper process for models and usage (`claude::control`) never carries a job: it has no session flag, runs with `--no-session-persistence`, and only answers control requests.
- Right before a `claude` process is spawned for a job, the session it is about to use is claimed under the job manager's lock.
  The claim is refused when the session belongs to another video: it is recorded as the session of another video's latest job (state.json), or another job's running process uses it.
  The job then starts a brand new session with the full instructions, like when Claude Code no longer has a session (section 6, Prompt composition), with the log line "This video's Claude session also belongs to another video, so a new session gets the full instructions."
  The other videos that recorded the same session forget it too (unless their own process is using it right now), with the log line "This video's Claude session was also recorded for another video, so it will not be resumed. The next run starts a new session with the full instructions.", so none of them later resumes a conversation that may belong to another video.
- Because claims happen under one lock and check the running processes, two live processes can never be started for the same session id.
- On startup, a session id that more than one video's latest job recorded (state.json edited or copied, or a video duplicated together with app state) is forgotten by all of them, with the same log line; their next run starts a new session with the full instructions.
- The same holds for sessions of the OpenCode 2 program (section 7a, The OpenCode 2 program): each job runs its own server, a session is resumed only by its own id, and the claim works the same way.
  OpenCode chooses the id of a new session (`ses_...`), so a new session is claimed right after the server created it (a fresh id is never taken); a resumed one is claimed before the server starts.
  The log lines then say "OpenCode session" instead of "Claude session".

### Setup of a job

A job records the setup its session runs on (`JobView.setup`, with `model` and `effort` of that setup) and the program it runs in (`JobView.harness`: Claude Code for `claudeSubscription` and `anthropicApi`, the OpenCode 2 program for `opencodeGo` and `openaiApi`), computed in `jobs::runner`:

- A new edit uses the current setup (section 7a): `claudeSubscription` with the model and effort of the top bar, or an API option with the model of Settings, Harness + API Keys and the reasoning effort remembered for that model (Default sends none), in the program `harness::for_new_job` decides from the setup.
- Re-Edit and Render Final resume the video's session, so they stay on the setup that session started with: on an API option with that job's option, model and program (a conversation written by one model family cannot be safely replayed to another, and one program cannot resume another's session), on `claudeSubscription` with the model and effort selected now, as before.
  Without a session to resume they use the current setup.
  Continue keeps the job's own setup, model, effort and program.
- When the job's own setup cannot run it at launch (the key of `opencodeGo` was removed, its model is no longer in the list fetched for its address, its program does not exist on this computer or is a version VidAI does not drive, or Claude Code was logged out on `claudeSubscription`), a launch that would resume a session starts a new session on the current setup instead, like a session Claude Code no longer has: the full instructions (section 6, Prompt composition, the fallback), the job records its new setup and program, and the log says "This video's session ran on OpenCode Go (glm-5.3), which cannot continue it now (No API key is saved for OpenCode Go). A new session on Claude Code with Claude Subscription gets the full instructions." (for a session of the OpenCode 2 program whose program is gone: "This video's session ran on OpenCode Go (glm-5.3) in the OpenCode 2 program, which cannot continue it now (OpenCode 2 is not installed on this Mac). A new session on Claude Code with Anthropic Compatible API (claude-sonnet-5-5) gets the full instructions.").
  A launch that starts a new session anyway fails with the reason, followed by "Fix it in Settings, Harness + API Keys, then press Continue Editing." ("No API key is saved for OpenCode Go. Fix it in Settings, Harness + API Keys, then press Continue Editing.", or "OpenCode 2 is not installed on this Mac. Fix it in Settings, Harness + API Keys, then press Continue Editing."; Windows says "this PC").
  Claude Code not being installed fails as before for a job in Claude Code; nothing else can help.
- The status line of a launch on an API option names the program, the service and the model: "Started a new Claude Code session on Anthropic Compatible API (model claude-sonnet-5-5)", "Started a new OpenCode 2 session on OpenCode Go (model glm-5.3)" and "Resumed the OpenCode 2 session on OpenCode Go (model glm-5.3)"; the services are named OpenCode Go, Anthropic Compatible API and OpenAI Compatible API.
  A launch on `claudeSubscription` says nothing more than before.
- A job on an API option gets its readable errors from what the service answered (section 7a, Test and errors), never "Claude Code is logged out" or "Claude usage limit reached".

Expected output per kind, checked on disk:

- `edit`: at least one review project file in `output`.
- `reEdit`: a review project file modified after the job started.
- `render`: a final render file modified after the job started.

### Driving Claude Code (verified against Claude Code 2.1.319)

Spawn, with the Editing Folder as working directory and the login-shell environment:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --permission-mode bypassPermissions [--model <model>] [--effort <effort>] \
  (--session-id <new uuid> | --resume <session uuid>)
```

- The process is started in its own process group so the whole tree (ffmpeg, Python, Whisper, sub-agents) can be ended.
- A job on `anthropicApi` (section 7a) also gets the variables of that option in its environment (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` or, with no key saved, `ANTHROPIC_AUTH_TOKEN` set to `no-key`, and the three `ANTHROPIC_DEFAULT_*_MODEL`), its `--model` is the model of Settings and its `--effort` is the reasoning effort remembered for that model (none on Default); a job on `claudeSubscription` gets none of them, and its environment is the user's own.
- A message is one JSON line on stdin:
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"parent_tool_use_id":null,"session_id":""}`.
- Interrupt is one JSON line on stdin:
  `{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}`.
  Claude answers with a `control_response` and stops its background tasks.
- stdout is one JSON object per line.
  Relevant types: `system` (subtypes `init`, `task_started`, `task_notification`, `background_tasks_changed`, and others), `assistant` (content blocks `text`, `thinking`, `tool_use`), `user` (tool results), `result`, `rate_limit_event`.
  Unknown types and subtypes must be ignored, never treated as errors.
- A `result` ends one turn, not the job.
  Claude often ends a turn while background tasks (renders, sub-agents) are still running, and starts a new turn by itself when they report back.
  The job is finished only when a `result` has arrived, no background task is active, and nothing new has started during a short settle time.
  Then VidAI closes stdin and the process exits with code 0.
- After `--resume`, Claude can emit an immediate empty `result` (`num_turns` 0) before it handles the new message.
  That result must not be counted as the answer to the message just sent.
- Closing stdin while idle makes the process exit cleanly.
- Hooks and settings from the user's own Claude Code configuration apply and are left alone.
- `--permission-mode bypassPermissions` is what `--dangerously-skip-permissions` sets: the Claude Code reference (checked with 2.1.325) calls the flag "equivalent to `--permission-mode bypassPermissions`", also with `-p`.
  So jobs keep the explicit mode; the transcripts of the owner's edits that ended early showed no permission denial at all.

### Keeping a job going

Some models (seen on OpenCode with `muse-spark-1.3-contributor`) end a turn with a sentence that announces the next step and no tool call, long before the work is done.
Claude Code then reports a normal `result`, and without this section the job would look finished and fail with "Claude finished without creating a review project".
In the owner's real OpenCode edits this happened 1 to 3 times per edit in the first 25 minutes, 0.2 to 10 minutes apart (median about 6), every such turn came after at least one tool call (typically 20 or more), and at most 2 early ends came between two progress milestones.
In the same transcripts no permission was ever denied; on the Claude subscription a whole edit ended its turn early zero times.

Where it applies: `opencode::keeps_jobs_going`, which is true on every platform VidAI runs on (Macs and Windows), for jobs on every setup and in every program (the OpenCode 2 program reports the same idle moments and tool calls through its translated stream, and its background commands and sub-agents count as background tasks, section 7a).
Nothing in it depends on the platform: it needs only the turns of the model and the files of the job.
A host that says no (a test) takes exactly the path above (finished when Claude goes quiet, then the output decides).

The decision is the pure module `jobs::keepgoing`, free of Claude Code types so another harness can reuse it: the harness reports each moment its model is idle (no turn running, no background task, nothing new for the settle time) with what the main conversation did since the last message (tool calls, whether it wrote `[OUTPUT COMPLETED]`) and the evidence (the expected output on disk, whether an edit's thumbnails and meta.txt are written, the number of finished progress milestones), and gets back: done, send this message, or stop.

When a job is done (checked at every idle moment, never while a background task runs or a turn is in progress):

| Kind | Deliverable (as Expected output per kind) | Done when |
|---|---|---|
| `edit` | a review project in `output` | the deliverable exists and `[OUTPUT COMPLETED]` was written in this run |
| `reEdit` | a review project modified after the job started | the same |
| `render` | a final render modified after the job started | the same |

Waiting for its own commands (an Intel Mac, a long local transcription):
A model that starts Whisper in the background of a shell (`&`) ends its turn to wait, and Claude Code does not track such a process as a task.
VidAI reads the CPU time of the job's process tree (`ps`, every 5 seconds, the model host itself left out): when some process used at least a tenth of a core since the last look, the computer is busy with the model's commands for the next 90 seconds.
At an idle moment of a job that is busy this way, with no deliverable and no marker, the model is not stuck: the turn counters are not touched, and instead of the keep-going message it gets the wait message (`prompt::WAIT_FOR_WORK`): "Your commands are still running and the computer is busy with them. Do not end your turn and do not poll in short loops: wait with one command that blocks until they finish (for example `wait`, or a loop that sleeps 30 seconds and checks the output, for up to 10 minutes), then go on with the next step. If a command shows no new output for 10 minutes, find out why and restart it."
Its log line is "Asked to wait for the running commands (n): the computer is busy with your background work", and at most one goes out every 5 minutes (the idle moments in between wait).
Such messages count only toward the ceiling.
A process that is not busy (a download that stalled, a gate waiting for memory) leaves the ordinary rules in force, so a hang is still found.
Where the CPU time cannot be read (Windows for now) nothing is ever busy and the ordinary rules apply.

Mixed cases:

- The deliverable without the marker: one message asks to finish the last steps (naming missing thumbnails and meta.txt of an edit); at the next idle moment the job is done whatever the model wrote, so a model is never nagged once its real deliverable exists.
- The marker without the deliverable: the model is asked to save it, at most twice; a third time fails with the missing output error of today ("Claude finished without creating a review project.").
- Neither: the turn ended early; the model is asked to keep going.

Going on: the message goes to the same live process and session (stream-json keeps it waiting for input); nothing is restarted.
It is a pure function of the job kind and the case (`prompt::continuation_body`, exact-text tests):

- Keep going (on every setup except `claudeSubscription` the last sentence before the completion one reads "Write each [VIDAI_PROGRESS <name>] marker as soon as its step is finished, in the message right after it, not several together at the end, and write [OUTPUT COMPLETED] in your last message once everything is done." instead of "Keep writing the [VIDAI_PROGRESS <name>] marker lines as steps finish, ..."; `prompt::continuation_body_on`): "The edit is not finished yet: there is no review project in the output folder." (re-edit: "The re-edit is not finished yet: there is no new review project version in the output folder."; render: "The final render is not finished yet: there is no new final render in the output folder.") then "Keep working now: do the next step with tool calls, and go on step by step until everything is done. Never end your turn after only announcing a step; do it in the same turn. Keep writing the [VIDAI_PROGRESS <name>] marker lines as steps finish, and write [OUTPUT COMPLETED] in your last message once everything is done."
- Finish: "The review project output/<file> is saved, but [OUTPUT COMPLETED] is not written yet, and the thumbnails and meta.txt are missing. Finish every remaining step now with tool calls (the thumbnails, meta.txt and info.txt), then write [OUTPUT COMPLETED] in your last message." (without the missing part when they are there; a re-edit and a render name their own file and remaining steps).
- Save: "You wrote [OUTPUT COMPLETED], but there is no review project in the output folder in MAIN_FOLDER. Save the REVIEW_OUTPUT_SOFTWARE review project there now with tool calls (a .fcpxml file for Final Cut Pro, a .xml or .prproj file for Premiere Pro), then write [OUTPUT COMPLETED] again." (re-edit and render: their own output).

The job stays `running` the whole time: no `failed` state, no error line, no Continue Editing in between.
Progress goes on with the same engine and never goes back.
The log gets one status line per message, numbered per run, with the message as its `detail`: "Asked to keep going (1): the turn ended before the edit was finished", "Asked to finish the last steps (2): the review project is saved, [OUTPUT COMPLETED] is not written yet", "Asked to save the review project (3): [OUTPUT COMPLETED] was written, but it is not in the output folder"; the row's activity shows the part before the colon until the model writes something new.
"Claude is finished, checking the output" is not logged on this path; a finished job says "Finished: <file>" as before.

Stopping for real reasons only, each with its readable error and Continue Editing as before:

- An API problem that Claude Code reports after its own retries (an error result, or a result whose text starts with "API Error"): in the words of the provider (section 7a, Test and errors; on the Claude subscription `jobs::errors::for_error_result`), with no further message.
  A temporary problem is first retried by VidAI itself (section 6, Retrying after a model error); the job stops at once, as here, when the problem is not temporary, when `maxModelRetries` is 0, or when the retries are used up.
- The process exits by itself or crashes, or prints nothing at all for the stall time in the middle of a turn ("Claude Code stopped responding (no activity for 20 minutes)."; done instead when the deliverable is there).
  While a tool call runs that was started with a time limit of its own (the `timeout` of a `Bash` call in milliseconds, which the OpenCode 2 program's instructions ask for on long commands), the stall time is that limit and two minutes, if longer: the tool ends by its own limit, so a transcription that is silent for 40 minutes on a slow computer is not a hang.
- Pause, Stop or quitting.
- A stuck model, by lack of progress, per run:
  - 3 idle moments in a row whose turns made no tool call at all: "The model stopped working on the edit: it ended 3 turns in a row without doing anything. Press Continue Editing to try again."
    A normal early end always came after tool calls, so this never trips on one.
  - 8 messages in a row without new work: a new progress milestone (a marker, a file, or the stream evidence of section 6, Progress) or a new file written in the video folder: "The model made no progress on the edit after being asked 8 times to keep going. Press Continue Editing to try again."
    The real edits had at most 2 between milestones; counting files too keeps a slow computer, where one milestone takes hours, from being ended while it renders.
  - The ceiling, 40 messages in one run (waiting messages included), the last safety net against a loop that burns the quota: "The final render is still not finished after VidAI asked 40 times to keep going, the most it asks in one run. Press Continue Editing to go on." (with the job's own word).
    At the observed rate that is several hours of work, far beyond the 25 to 40 minutes of a real edit; a deliverable that exists at the ceiling still completes the job.
  - The wording says "the model", not "Claude", because on an API option it is not Claude.

### Retrying after a model error

A model provider fails now and then for a few minutes (overloaded, rate limited, a network drop) and an edit that ran for an hour should not stay dead because of it.
`maxModelRetries` (Settings, General, "Retries after a model error", 0 to 50, default 5) is how many times in a row VidAI waits and then continues the same session by itself, exactly like Continue Editing (the job keeps its program and its session; `Plan::Continue` of `jobs/driver.rs`).
0 turns it off.
It is read when a failure happens, so a change applies to the running jobs as well.

What is retried (`jobs::retry::classify`, on the result text and the HTTP status in it):

- A status of 400, 408, 409, 425 or any 5xx (500, 502, 503, 504, 529 and the rest).
- 429 and any usage or rate limit; the wait honors the reset time the provider names (the rate limit event of Claude Code, or the epoch at the end of an OpenCode limit text) when it is later than the schedule's wait.
- A text that says overloaded, rate limit, internal server error, bad gateway, service unavailable, temporarily unavailable, gateway timeout, timed out, `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, socket hang up, fetch failed or network error.

What is never retried, and fails at once as before: a missing program or login (logged out), a status of 401, 402, 403 or 404, the OpenCode Go and Free usage limits, a budget or credit that is used up, a model that is not found, Pause, Stop and quitting, and the stuck-model rules above (they are not provider failures).

The waits before retry 1 to 5 are 30 seconds, 1 minute, 2 minutes, 5 minutes and 10 minutes; every later retry waits 15 minutes.
When the provider named a reset time later than that wait, VidAI waits until the reset instead.
The wait is measured on the wall clock, so a Mac that sleeps in between does not wait longer.

State and slot:

- There is no new job state.
  The job stays `running` while it waits, and so it keeps its slot and the queue behind it does not move: the provider is failing for everybody, so a queued job would only meet the same error.
  Pause or Stop ends the wait at once, frees the slot like any pause or stop, and nothing is retried afterwards.
  `startsAt` and the Start now action belong to queued jobs only and are not used.
- The job shows it: `lastActivity` says "Model error. Retrying at 14:32 (retry 3 of 5)" and the log gets "Model error (529 Overloaded). Retrying in 2 minutes (retry 3 of 5)", later "Retrying now (retry 3 of 5)".
- The running clock keeps counting during the wait.
  A usage limit whose reset is hours away therefore holds its slot for hours, until the reset or until the owner presses Stop.

The count of retries starts over when the job makes real progress (its finished milestones or its files written grew, the same notion as Keeping a job going) and when the owner presses Continue Editing (a new run starts at 0).
After `maxModelRetries` retries in a row without progress the job fails with the provider's error followed by "VidAI retried N times without success." and Continue Editing as before.
The quiet limit of Claude Code, where the process only stops with its limit seen on the event stream, no error result and no output, is retried the same way, waiting for the reset it announced.
The end-to-end tests shorten the waits with `VIDAI_E2E_RETRY_SECOND_MS` (section 3, debug builds only).

### Re-Edit backup

Before a Re-Edit starts, the launch copies `<video>/output/` to `<video>/backup-output-N/` (N the smallest number from 1 whose folder does not exist), so the earlier review project is never lost to the new one.
It is a copy, not a move, recursive and including `.fcpxmld` bundles; links to folders are skipped.
It is skipped when `output/` is missing or empty.
The log says "Copied the output folder to backup-output-N before the re-edit".
When the copy fails the launch fails with "Could not back up the output folder before the re-edit, so it was not started: <reason>", the Re-Edit does not start, and nothing in `output/` has been touched.
Continue and Render Final do not make a backup; a Continue that has no session to resume and so falls back to the Re-Edit does.

Locks of ended jobs:
The toolkit serializes heavy steps between sessions with `cpu.lock` and `gpu.lock` in the Editing Folder (a JSON file with the pid of the holder and a lease of 15 minutes that outlives it).
When VidAI ends the process tree of a job (pause, stop, quit, a stalled or failed run), a lock whose holder is one of the processes it just ended is removed, with the log line "Released the machine lock held by the ended session (cpu.lock)", so the next session does not wait for the lease.
A lock of any other process is never touched.

Pause, Stop, quit, restart and Continue:

- The manager closes the job's halt, under its lock, before it sends a pause or a stop (also when quitting); the driver writes a message only while holding the halt open, so no message is ever sent after one was asked for, also not during shutdown.
- A message already sent is interrupted like any turn; the job pauses or stops as before.
- A job recovered as paused after a restart has no process; nothing goes on until the owner presses Continue Editing.
- Continue Editing (and every launch) starts a new run with new counters, with the continue message of Prompt composition.

Finding and checking Claude Code:

- A GUI app does not inherit the shell `PATH`.
  The login-shell environment is captured once at startup (macOS: the user's shell run as a login interactive shell printing its environment between two markers, with stdin closed and a 10 second limit) and used for every child process, so `ffmpeg`, `python3`, `node` and `claude` resolve as they do in the user's terminal.
  The login interactive shell reads both kinds of startup files (zsh: `~/.zprofile`, where Homebrew's installer puts `brew shellenv`, and `~/.zshrc`, where the OpenCode installers and nvm put themselves); text the files print is ignored, and a question they ask gets no answer and goes on.
  csh and tcsh accept `-l` only alone, so they run with `-i` and read `~/.cshrc` or `~/.tcshrc`.
  When the user's shell fails at once (no environment printed), the capture is tried once more with `/bin/zsh`; a shell that is merely slow is ended at the limit and not tried again.
  When there is no captured environment, VidAI's own environment is used.
  Either way the well-known tool folders that are missing are appended to `PATH`, in this order: `~/.local/bin`, Homebrew's `bin` folder of this Mac's kind and then the other one (`/opt/homebrew/bin` then `/usr/local/bin` on Apple Silicon, the other way round on an Intel Mac), MacPorts' `/opt/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`.
- `claude` is looked up in this order: `VIDAI_CLAUDE_BIN`, the login-shell `PATH`, then well-known locations (`~/.local/bin`, `~/.claude/local`, then Homebrew's two `bin` folders in the order above).
  Homebrew lives in `/opt/homebrew` on Apple Silicon and in `/usr/local` on an Intel Mac; the other folder only exists on a Mac set up from one of the other kind (Migration Assistant), and its programs are built for the other processor, so this Mac's own comes first.
- Every program lookup on a Mac (`claude`, the OpenCode 2 program, `ffmpeg`, `ffprobe`, `python3`, `node`) passes over a file built only for the other processor (`platform::macho` reads the Mach-O header): an Intel Mac cannot run an `arm64`-only program, and Apple Silicon runs an `x86_64`-only one only with Rosetta 2 (otherwise macOS would offer to install it in a dialog).
  Scripts and files that cannot be read count as runnable; `VIDAI_CLAUDE_BIN` is taken as given.
- Login state comes from `claude auth status`, which prints JSON containing `loggedIn`.
- Every command that would start an edit first checks that its program is ready (`commands::jobs::ensure_ready`, which is `readiness::check`): the one decision of "Readiness of a launch" below, with its truth table.
  A session that resumes on its own setup is checked again when it launches (Setup of a job above).
  The UI then shows how to install (`curl -fsSL https://claude.ai/install.sh | bash`) or log in (`claude auth login`), with a button that opens a terminal and a Check Again button.

Models, effort and usage limits (all through the local Claude Code process, never a direct API call and never reading Claude's stored credentials):

- A Claude Code process started in stream-json mode answers control requests without making any model call.
  `{"subtype":"initialize"}` returns `models` (each with `value`, `displayName`, `description`, `supportedEffortLevels`), the account's `subscriptionType` and `claude_code_version`.
  `{"subtype":"get_settings"}` returns `applied.model` and `applied.effort`, the defaults Claude Code would use.
  `{"subtype":"get_usage"}` returns `rate_limits_available` and `rate_limits` with `five_hour`, `seven_day` and model-scoped weekly entries, each `{ utilization (percent), resets_at }` or null.
- The `rate_limit_event` lines of running jobs carry `rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization (0..1), resetsAt (epoch seconds)}` and update the usage display for free.
- `ClaudeInfo` is fetched at startup, on demand (`refresh`), and at most once a day otherwise; the last result is cached in `state.json` so the pickers are never empty after the first run.
- The model list and the usage limits are the Claude subscription's (its pickers and its meters), so the Claude Code process for them is started only while the setup is `claudeSubscription` (`claude::service::meters_wanted`): on `opencodeGo`, `anthropicApi` and `openaiApi` neither the startup fetch nor the schedule nor a `refresh` runs it, and nothing is logged about Claude Code (an OpenCode 2 setup never needs Claude Code, section 6, Readiness of a launch).
  Choosing the Claude subscription again refreshes both at once.
- `UsageStatus` is refreshed at startup, every 60 seconds while the window is visible, every 5 minutes while it is hidden but jobs run, on demand, and from every `rate_limit_event`.
  Refreshing must be light: one helper Claude Code process without MCP servers that is reused for the periodic requests is preferred over spawning a process per refresh.
  A failed refresh keeps the last values and sets `error`.
- New jobs (`edit`, `reEdit`, `render`) use the model and effort selected at that moment and remember them.
  Continuing a job reuses the job's own model and effort.
  This is the Claude subscription; on an API option the model and effort are the ones of Settings, Harness + API Keys (Setup of a job below).
- When the selected model does not support the selected effort, the effort is reset to null.
  When the selected model is no longer in the list, the selection falls back to null (Claude Code's default).

Other job behaviour:

- Sleep prevention has two modes, chosen by the No Sleep setting (section 11, Sleep prevention).
  With No Sleep off, the machine is kept awake while at least one job is running (macOS: a `caffeinate -i` child).
  With No Sleep on, it is kept awake until every job has ended: also while a job is queued, waiting out the start delay or waiting to retry after a model error.
  A `paused` job counts as ended.
- A system notification is shown when a job completes or fails.
  The notification permission is asked for when the first job of a run is started (not at launch), and only if it was never decided.
  Without the permission no notification is shown, silently; it is never an error.
- Quitting while jobs are active asks for confirmation, then pauses every running job (interrupt, end the tree) before exit (see "Window, menu and quitting" in section 9).
- A job on an API option sends no `rate_limit_event` to the Claude meters, and a refused key or a limit of the service is never taken for a lost Claude login.
- When a job finds Claude Code logged out, the remembered positive login check is forgotten, so the next command that would start Claude reports `claudeNotLoggedIn` and the UI shows the not-ready flow.
- On startup, a persisted job in `running`, `pausing` or `stopping` becomes `paused` (with a status log line saying VidAI was closed), or `stopped` if it never got a session.
  A persisted `queued` job becomes `paused` if it has a session, otherwise it is dropped.
  Nothing starts by itself on launch.
  Session ids recorded for more than one video are then forgotten (see One session per video).
- Log entries are human-readable.
  Tool calls become one line (for example "Bash: Render graphics at 1080" using the tool's description when there is one), with the full input in `detail`.
  Absolute paths in tool lines and tool results are shown relative to the video folder (`CLAUDE_VE/timeline.py`), or else to the Editing Folder (`MEMORY.md`, `Channel/Other Video/notes.md`); the original stays in `detail`.
  Claude's own messages are kept as written; the activity panel renders their Markdown (bold, italic, code, headings, lists, quotes, links as plain text), never as HTML.
  Thinking blocks are not logged.
  A job in the OpenCode 2 program is logged in the same vocabulary (its tools take Claude Code's names, section 7a), and the lines that name the program say OpenCode 2: "OpenCode 2 is running (model vidai/glm-5.3)", "OpenCode 2 reported an error: ...", "Sent the edit instructions to OpenCode 2", "Asked OpenCode 2 to continue", "Pausing: asking OpenCode 2 to stop the current step", "OpenCode 2 no longer has the earlier session, so a new session gets the full instructions."

### Readiness of a launch

What new edits need on this computer is ONE decision, made by one pure function with the same name on both sides: `readiness::Facts::problem` in `src-tauri/src/readiness.rs` (the backend, `ensure_ready`) and `problemOf` in `src/lib/readiness.ts` (the onboarding, the sidebar status and the route).
The rule in one sentence: only the program that does the editing is needed, with the service it runs on.
A person with no Claude subscription and no Claude Code can therefore install VidAI on any Mac or PC, choose option 2, 3 or 4, save an API key (option 2 needs one; options 3 and 4 only when their server does), choose a model, install the one program that option uses, and edit; a person with only a Claude subscription is never asked anything about API keys or OpenCode.

The inputs (`readiness::Facts`) are plain facts, so every combination is a unit test:

- the setup (`setup`); all four exist on every supported platform, so there is no platform gate;
- whether the setup's API key is saved and whether its model is chosen (`keySaved`, `modelChosen`; they count only for the three API options, and `keySaved` only for the option that needs a key, `ApiOption::key_required`: OpenCode Go; the key of `anthropicApi` and `openaiApi` is optional, because they are often a server on the user's own computer that needs none, so for them only the model is asked);
- Claude Code: not installed, installed but logged out, or ready (`claude`); on Windows also whether Git for Windows is missing (`gitBashMissing`);
- the OpenCode 2 program: not installed, installed in a version VidAI does not drive, or ready (`program`);
- whether the computer is prepared for edits (`prepared`: tools, Python environment and Whisper model; always true until that step exists, one more row at the end of the table).

The program that does the editing follows from the setup (`harness::for_new_job`): Claude Code for `claudeSubscription` and `anthropicApi`, the OpenCode 2 program for `opencodeGo` and `openaiApi`.
What blocks edits is the first of these that applies, in this order:

| Order | Applies when | Problem | What the person sees |
|---|---|---|---|
| 1 | the setup is an API option that needs a key (`opencodeGo`) and its key is not saved | `apiKeyMissing` | the card of that option (URL, key, model, Continue), Back returns to the choice of options |
| 2 | the setup is an API option and its model is not chosen | `apiModelMissing` | the same card |
| 3 | the program is Claude Code and Git for Windows is missing (Windows) | `gitBashMissing` | "Install Git for Windows" |
| 4 | the program is Claude Code and it is not installed | `claudeMissing` | "Install Claude Code" |
| 5 | the setup is `claudeSubscription` and Claude Code is logged out | `claudeLoggedOut` | "Log in to Claude Code" |
| 6 | the program is the OpenCode 2 program and it is not installed | `programMissing` | "Install OpenCode 2" |
| 7 | the program is the OpenCode 2 program and its version is not one VidAI drives | `programUnsupported` | "Install a supported OpenCode 2", with the reason |
| 8 | the computer is not prepared | `notPrepared` | no screen yet |

`apiKeyMissing` is never the problem of `anthropicApi` or `openaiApi`: with no key saved and a model chosen they are ready, and with neither only `apiModelMissing` is asked.
The texts of `ensure_ready` for the first two problems are "No API key is saved for <option label>. Edits are set to run on it (Settings, Harness + API Keys)." and "No model is chosen for <option label>. Edits are set to run on it (Settings, Harness + API Keys)."
A job launch that cannot resume says the same reasons with "Fix it in Settings, Harness + API Keys, then press Continue Editing." (Setup of a job).

Every card of the onboarding has Back to the choice of options, so no card needs a way out of its own.

Consequences, each a tested invariant over every combination of the inputs:

- `claudeSubscription` never asks for an API key, a model or the OpenCode 2 program, whatever is stored for them or installed.
- `apiKeyMissing` happens only on `opencodeGo`; `anthropicApi` and `openaiApi` need a chosen model and their program, never a key.
- `opencodeGo` and `openaiApi` never ask for Claude Code, a Claude login or Git for Windows.
- `anthropicApi` needs Claude Code installed (and Git for Windows on Windows), never a Claude login, and never the OpenCode 2 program.
- Facts the setup does not look at never change the answer: with the OpenCode 2 program the state of Claude Code does not matter, with Claude Code the state of the OpenCode 2 program does not, and the key and model of one option never matter to another.
- While what is saved for the API keys is not known (still loading, or the Keychain could not be read, which Settings says with Try Again) the UI does not ask for a key (only on `opencodeGo` is that status needed to decide anything); the backend then rejects with `secretsUnavailable`.

The table of examples `src-tauri/tests/fixtures/readiness-table.json` (every row named, with its facts, the program and the problem) is run by both `readiness::tests` and `src/lib/readiness.test.ts`, and both sides also run the invariants above over the whole domain, so the two functions cannot disagree.
The backend gathers the facts lazily (`readiness::check`): an edit on option 2 or 4 never runs `claude`, an edit on option 1 or 3 never runs `opencode2 --version`, and only option 1 runs `claude auth status`.
Every launch of a job checks again what its own session needs (Setup of a job).

What a person can do while a program is missing or logged out:

- Go Back to the choice of options from any onboarding card and pick another option; picking an option changes the setup only with the Continue of its card (`set_api_key`, `set_api_model`, then ONE `set_setup`), or with the Continue of the choice for option 1 (`set_setup` with `claudeSubscription`), so the setup is never half changed on the way.
- Change the setup while jobs are queued or running: running jobs and the sessions of earlier edits keep the setup they started with (Setup of a job); only new edits, and a job that must start a new session, use the new setup.
- Uninstall the program of the setup between two edits: the sidebar says "<Program> needs attention", the next Start Editing is refused with the reason (`invalidInput`, "OpenCode 2 is not installed on this Mac. Edits are set to run with OpenCode 2 (Settings, Harness + API Keys)."), the onboarding card for that program shows after Check Again, and Continue of an earlier edit in that program starts a new session on the current setup (Setup of a job).

### Prompt composition

The message for a new `edit` session is built from these parts, in this order, separated by blank lines:

```
MAIN_FOLDER = <video folder name>
CHANNEL_FOLDER = <channel folder name>
Channel Name: <channel folder name>
VIDEO_TYPE = <Long | Short>
MAIN_AROLL_ROTATION = The main A-roll file "<file name>" is stored <sideways | upside down> with no rotation flag. Rotate it <90 | 180 | 270> degrees clockwise to make it upright.      (only when VideoView.arollRotation is set, section 8)
BROLL_FOLDER = <b-roll folder name>
TOOLKIT_FOLDER = <CLAUDE_VE_ALL | CLAUDE_VE_ALL_OWN>
REVIEW_OUTPUT_SOFTWARE = <Final Cut Pro | Premiere Pro>
MACHINE = <Intel Mac | Windows PC> (<x64 | arm64>), <OS and version>      (this line and the next three only when not on an Apple Silicon Mac; each only when known)
MACHINE_CPU = <CPU name>, <n> cores, <n> threads
MACHINE_MEMORY = <n> GB
MACHINE_GPU = <adapter>; <adapter> (the vendor in parentheses when the name does not say it), or "none found"

THIS MACHINE:                              (only when not on an Apple Silicon Mac, see Machine facts below)
<the machine paragraph>

PRODUCT_LINKS =
<product links, one per line, may be empty>

PRODUCT_LINKS STEP (required):             (only when there is at least one link)
For every link in PRODUCT_LINKS, fetch the page (the WebFetch tool if you have it, otherwise curl in the shell) and find the product images: the og:image and JSON-LD "image" entries and the images of the product gallery, at full resolution, never icons, logos or sprites. Download them into CLAUDE_VE/product_images/ inside MAIN_FOLDER, never into CHANNEL_FOLDER or anywhere else. Use them as b-roll where the video talks about that product, and take product names and facts from the page text. If a page cannot be fetched (for example the shop blocks bots), say so in info.txt and carry on without it.

NOTES FOR THIS VIDEO:                      (only when notes are not empty)
<notes>

<the selected prompt of the channel for this video type, exactly as the user wrote it>

CHANNEL_STYLE (<Long 16:9 | Short 9:16>):
<the selected style of the channel for this video type, or "(empty)">

VidAI:
This edit was started from the VidAI app. There is no terminal and nobody can answer questions, so make your best guess and never wait for input.
The shared toolkit folder for this edit is TOOLKIT_FOLDER. Where older notes (for example MEMORY.md) say CLAUDE_VE_ALL, use TOOLKIT_FOLDER instead, and do not read from, write to or depend on any other toolkit folder.
<the style rule: when CHANNEL_STYLE has a style, "The channel style lives only in CHANNEL_STYLE above. Never create a Style folder, a Details folder or a STYLE.md, and never write the channel style into any file in CHANNEL_FOLDER; older notes and the toolkit's design kits that mention <channel>/Style/STYLE.md do not apply."; when it is empty, "CHANNEL_STYLE above is empty, so design a fitting style yourself, use it for this video, and save it in CHANNEL_FOLDER/Style/STYLE.md (create the Style folder when it is missing) so it can be used for future videos.">
VidAI marks this video as edited when a Final Cut Pro (.fcpxml) or Premiere Pro (.xml / .prproj) project file exists in the "output" folder in MAIN_FOLDER, so save the review project there.
When the REVIEW_OUTPUT_SOFTWARE output is fully done, clearly write "[OUTPUT COMPLETED]" in your last message.

Progress markers: VidAI shows a progress bar for this job. Each time one of these steps is finished, write its marker on a line by itself in a normal message of the main session (never in sub-agents). Steps may finish in any order; skip a step that does not apply.
[VIDAI_PROGRESS inspected] - the footage, MEMORY.md and the inputs are checked
[VIDAI_PROGRESS transcribed] - the A-roll transcript is ready
[VIDAI_PROGRESS planned] - the written edit plan is ready
[VIDAI_PROGRESS graphics_built] - every programmatic graphic and b-roll is built
[VIDAI_PROGRESS broll_ready] - the b-roll footage is conformed and the product images are prepared
[VIDAI_PROGRESS assembled] - the timeline is assembled and the audio is normalized
[VIDAI_PROGRESS checked] - the quality checks are done
[VIDAI_PROGRESS review_saved] - the review project is saved in the output folder
[VIDAI_PROGRESS extras_written] - the thumbnails, meta.txt and info.txt are written
```

The product images step needs no marker of its own: `broll_ready` already covers "the product images are prepared".
The style rule is in the composed message, and depends on whether the channel has a style for this video type, because existing Editing Folders keep their old MEMORY.md (seeding never overwrites it) and the bundled toolkit's notes and design kits still mention `<channel>/Style/STYLE.md`.
The marker lines are generated from the milestones of the job kind's progress model (see Progress below), so the prompt and the model cannot disagree.

A session on an API option (every setup except `claudeSubscription`) also gets this paragraph, between the VidAI paragraph and the progress markers (and so in the fallback below), and in every follow-up message VidAI starts a run with (continue, re-edit, render):
"Keep working until the job is done: VidAI cannot answer and only sees your tool calls and files, so do not end your turn until the work is complete and [OUTPUT COMPLETED] is written. Never end a turn with only a sentence about what you will do next: do that step with tool calls in the same turn, then go on to the next one. Write each [VIDAI_PROGRESS <name>] marker as soon as its step is finished, in the message right after it, never several together at the end."
Messages of a session on the Claude subscription stay exactly as written here.

A session in the OpenCode 2 program (`opencodeGo` and `openaiApi`) also gets this block, right before that paragraph (and so in the fallback below); sessions in Claude Code never carry it (`prompt::OPENCODE2_PROGRAM`).
The editing instructions and MEMORY.md were written for Claude Code, so it names OpenCode's own tools where they differ: commands run with the shell tool, which moves a command that outlives its timeout to the background, and sub-agents always run in the background; both report back with a message that wakes the session (section 7a, The OpenCode 2 program):

```
OPENCODE:
This edit runs in the OpenCode 2 program, not in Claude Code. Where the instructions or MEMORY.md name Claude Code's tools, use OpenCode's: the shell tool for commands, the read, write and edit tools for files, and the subagent tool for sub-agents (agent general; start several in one step when their work can run in parallel). Sub-agents always run in the background and report back with a <subagent> message when they finish. The shell tool moves a command that is still running after its timeout (2 minutes unless you give a longer one) to the background, where it goes on and reports back with a <shell> message when it ends; so give long commands such as transcription, renders and downloads a timeout in milliseconds that is long enough (for example 3600000 for an hour), and never start a command again while it still runs. When nothing is left to do but wait for sub-agents or background commands, end your turn: their reports wake you, and the edit goes on from there.
```

Everything else of the first message stays true in the OpenCode 2 program: it reads files such as MEMORY.md, starts sub-agents with its subagent tool, and loads the Editing Folder's CLAUDE.md as project instructions (section 7a).

Starting is refused with `invalidInput` when the prompt selected by `inputs.promptSlot` in the channel's profile for the video's effective type (section 8) is empty (the message names the slot and Long or Short), or when `promptSlot` or `styleSlot` is not 0 to 4.
`start_edit` saves the selection with the other inputs, and Continue, Re-Edit and Render Final compose with the video's stored selection.
An empty selected style behaves like an empty style before: the message asks the agent to save the style in `<channel>/Style/STYLE.md`.

Follow-up messages:

- Continue after pause: "Continue the video edit from where it was paused. Background tasks that were running were stopped, so check what finished and redo what did not. Work until the review output is complete."
  In the OpenCode 2 program, whose commands and sub-agents a pause stops (its background work is ended with the pause): "Continue the video edit from where it was paused. The commands and sub-agents that were running were stopped, so check what finished and redo what did not. Work until the review output is complete." (`prompt::continue_body_in`).
- Continue after failure: the same, plus one sentence naming what was missing.
  Both continue messages then add the paragraph "Keep writing the [VIDAI_PROGRESS <name>] marker lines as steps finish, also for steps that finished before the pause and were not marked yet."
- Re-edit: "RE-EDIT REQUEST. I reviewed the edit and want these changes:", the user's text, then: "Apply these changes and keep everything else as it is. Save a new review project version for REVIEW_OUTPUT_SOFTWARE in the output folder (next _vN number, keep the older versions), update the thumbnails and meta.txt only if the changes affect them, add the re-edit to info.txt, and write [OUTPUT COMPLETED] when done.", then the progress markers paragraph of a re-edit (`changes_applied` - the requested changes are made, `review_saved` - the review project is saved in the output folder).
- Render final: "I reviewed and approved the review project. Create the final output render now as described in the Final Output section, and save it in the output folder." When a timeline export path is given: "I changed the timeline in REVIEW_OUTPUT_SOFTWARE and exported it to: <path>. Use that export as the source of truth for the final render." Then the notes when not empty, then: "Write [OUTPUT COMPLETED] when the final render is done.", then the progress markers paragraph of a render (`render_started` - the final render is running, `rendered` - the final render file is complete).

The messages of Keeping a job going are not follow-ups in this sense: they go to the same live process and session and are composed as in section 6, Keeping a job going.

`reEdit` and `render` resume the session of the video's latest job.
When there is no session, or resuming fails because Claude Code no longer has it, a new session is started whose message is the full `edit` composition followed by a paragraph that says the video was already edited, the working files are in `CLAUDE_VE`, the current review project is `<newest review file>`, and then the follow-up message.
A job keeps the toolkit and video type it started with for its whole life, including continue.

### Machine facts

The bundled toolkit was written on an Apple Silicon Mac (section 7), so on any other computer (an Intel Mac, a Windows PC) the first message says what the computer is and how to adapt the toolkit, in every program that runs edits (Claude Code and the OpenCode 2 program).
On an Apple Silicon Mac nothing is added and the message is byte for byte the same as without this feature; the hardware decides, so the Intel build running under Rosetta on Apple Silicon adds nothing either.

`platform::machine` reads the facts once per run, on a background thread started at app start, with a time limit on every helper process and without console windows.
A fact that cannot be read is left out; it never fails a job.
No name, serial number or other identifier of the computer or its user is read.

| Fact | macOS | Windows |
|---|---|---|
| Operating system and version | `sw_vers -productVersion` | registry `CurrentBuildNumber` and `DisplayVersion` (builds from 22000 on are Windows 11) |
| Architecture of the hardware | `sysctl hw.optional.arm64` or `sysctl.proc_translated` is 1: Apple Silicon (also for an Intel build under Rosetta); otherwise Intel; the build's architecture only when `sysctl` cannot run | the machine's `PROCESSOR_ARCHITECTURE` in the registry (not changed by emulation) |
| CPU name | `sysctl machdep.cpu.brand_string` | registry `ProcessorNameString` |
| Cores and threads | `sysctl hw.physicalcpu`, `hw.logicalcpu` | `sysinfo` physical cores, the logical processors of the process |
| Memory | `sysctl hw.memsize` | `sysinfo` total memory |
| Graphics adapters and vendor | `system_profiler SPDisplaysDataType -json` (model and vendor only) | one Windows PowerShell call listing `Win32_VideoController` (name, PCI vendor id, driver vendor) |

CPU and adapter names lose trademark marks and clock speeds ("Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz" becomes "Intel Core i7-9750H"); memory is shown in whole GB.

The machine paragraph is one paragraph:

- It starts "This is <an Intel Mac | a Windows PC>, but the toolkit in TOOLKIT_FOLDER and its notes in MEMORY.md were written on an Apple Silicon Mac." (with the own toolkit: "but the notes in MEMORY.md were written on an Apple Silicon Mac, and tools in TOOLKIT_FOLDER may have been too."), then "Before you rely on a tool, check that it works here."
- On an Intel Mac it names the pieces that need Apple Silicon: the `mlx-whisper` transcriber (for example `faster-whisper` or `whisper.cpp`) and any VideoToolbox encoder that fails, since VideoToolbox runs on the Intel or AMD graphics but some encoders (such as ProRes) may be missing or slow.
  `aac_at`, the Swift / Apple Vision scripts, `fcntl.flock`, `vm_stat` and symlinks work on an Intel Mac, so they are not named; whether Rosetta 2 is installed does not matter there.
  It says that Homebrew lives in `/usr/local` on an Intel Mac, not in `/opt/homebrew` (the toolkit's notes may name the Apple Silicon folder).
  It says that when pip cannot install `faster-whisper` (no matching version, or a build from source that fails), the Python is newer than the Intel Mac builds of its parts, so the venv is made with an older Python (3.9 to 3.12, for example `/usr/bin/python3`); a real edit on an Intel Mac with Python 3.14 lost a quarter of an hour this way.
  It then names two things that stall an edit there: the Whisper gate (`vekit/whisper_gate.py`) waits with no time limit until 12 GB of memory is free, which a Mac with 8 or 16 GB may never have, so the model is told to lower `MIN_FREE_GB` to a third of this Mac's memory (named in GB when known) if it waits for more than a minute; and transcription and encoding on the CPU are several times slower than on Apple Silicon.
  In Claude Code they are started in the background with progress lines in a log file and never left waiting silently; in the OpenCode 2 program (its OPENCODE block says how commands run), the commands get a timeout long enough for that and write progress lines to a log file.
- On Windows it names the Apple-only pieces: `mlx-whisper`, VideoToolbox decoding and encoding (replaced by NVENC / NVDEC on an NVIDIA GPU, Quick Sync on an Intel GPU, AMF on an AMD GPU, as found; otherwise "find a hardware encoder that ffmpeg can use here"), the `aac_at` audio encoder, the Swift / Apple Vision scripts, the `fcntl.flock` file locks and `vm_stat` of the Whisper gate, and symlinks (copy instead); and it says that Bash commands run in Git Bash and a venv's Python is `.venv/Scripts/python.exe`.
- It ends: "Keep the same outputs and quality checks. Save every fix inside TOOLKIT_FOLDER in a way that keeps working on other machines: choose by platform at run time and never remove the Apple Silicon path. Note each fix in MEMORY.md so later edits reuse it."

It never contradicts the hardware encoding line of the default prompt (VideoToolbox on a Mac, NVENC / NVDEC on Windows, never the CPU); it only adds which graphics are present.
The text is generated and tested on exact text in `jobs::prompt`.

Only messages that start a new session carry the machine lines and paragraph: the first message of an edit, and the fallback below, which is a full `edit` composition.
A resumed session already read them in its first message, and Claude Code keeps sessions per computer, so a session never resumes on another machine; continue, re-edit and render messages to a resumed session stay unchanged.

### Progress

`JobView.progress` drives the completion bar of every video row and of the activity panel: `percent` (0 to 100) and `stage`, one short label of what the job works on now.
It is computed in Rust by `jobs::progress`, a pure, clock-injected module, and published by the job's driver.

Each job kind has a model: a weighted checklist of milestones, not a strict sequence (the work after the edit plan runs in parallel, so milestones can finish in any order).
The percent is the sum of the weights of the finished milestones, plus an estimate from active time for the unfinished ones (evidence 5 below).
The stage is the label of the first unfinished milestone in the order below, "Finishing up" when all are finished, and "Done" once the job is `completed`.
Two more labels are not milestones: "Getting the tools ready" while the job installs or tests its tools (see Setup below), and "Working on the edit" (re-edit: "Working on the changes", render: "Working on the render") once the bar is ahead of what the evidence confirms.

| Kind | Milestone (marker) | Weight | Cumulative | Stage while it is next |
|---|---|---|---|---|
| `edit` | `inspected` | 3 | 3 | Inspecting the footage |
| | `transcribed` | 12 | 15 | Transcribing |
| | `planned` | 15 | 30 | Planning the edit |
| | `graphics_built` | 34 | 74 with `broll_ready`, in either order | Building graphics |
| | `broll_ready` | 10 | | Preparing b-roll |
| | `assembled` | 9 | 83 | Assembling the timeline |
| | `checked` | 8 | 91 | Checking the edit |
| | `review_saved` | 5 | 96 | Writing the review project |
| | `extras_written` | 3 | 99 | Thumbnails and details |
| `reEdit` | `changes_applied` | 65 | 65 | Applying the changes |
| | `review_saved` | 30 | 95 | Saving the new version |
| `render` | `render_started` | 10 | 10 | Preparing the render |
| | `final_writing` (no marker, from the disk) | 60 | 70 | Rendering |
| | `rendered` | 25 | 95 | Writing the final file |

The weights follow the share of the active time at which each milestone ends in the owner's real edits (info.txt timings and a replay of the Claude Code transcripts of those edits): for a Short of about 25 minutes the transcript is ready at about 3.5, the plan at 7, the graphics at 20.5 and the review project at 23.5 minutes; a Long of about 40 minutes reaches them at about 8, 15, 34 and 40.
The calibration is written next to the model in `jobs::progress`.

A finished milestone implies the ones that must be done before it: `transcribed` implies `inspected`, `planned` implies `transcribed`, every milestone after the plan implies `planned`, and `review_saved` implies the graphics, b-roll, timeline and checks (and `changes_applied` for a re-edit); `final_writing` implies `render_started`, `rendered` implies `final_writing`.

Why the evidence below is wider than markers: in the owner's real OpenCode edits the model (`muse-spark-1.3-contributor`, in both programs) wrote every marker together in its last message, in the same minute as "Finished", 20 to 40 minutes after the work they name.
Replaying those logs through the earlier tracker showed it confirmed the transcript, then nothing: the plan was inferred only from a graphics sub-agent starting, and those edits had none (the lead built the graphics itself with the toolkit's scripts), so the bar crept to one point below the plan (29) and stayed there until the review project appeared.
On an Intel Mac the same plateau lasted for the whole job, and a job that had not transcribed anything showed it, because a Read of `transcribe.py` and background commands that installed or smoke-tested Whisper counted as transcription.

Evidence, most reliable first:

1. Markers: a line in a normal message of the main session that holds only `[VIDAI_PROGRESS <name>]` (Markdown emphasis or code around it is allowed, case and `-` / `_` do not matter).
   A marker inside a sentence is prose; markers of sub-agents never count.
   The activity log shows each marker line as a compact status entry with the milestone's done text (for example "Transcription done"), and an unknown name as "Progress: <name>"; the rest of the message stays assistant text.
2. Files in the output folder written after the job started (files that were already there, unchanged, when the run started never count), looked at about every 5 seconds: a review project in `output/` (`review_saved`), a thumbnail together with `meta.txt` (`extras_written`), a final render (`final_writing`; `rendered` once it has not changed for 20 seconds).
3. Files in the working folder of the video (`jobs::work`, an edit only), looked at in the same pass: every file of the video folder outside `output/`, written since the job started, down to 8 levels, at most 20000 entries and 300 ms, never following a link and skipping `.git`, `node_modules`, `__pycache__`, `.venv`, `.hyperframes` and caches.
   Only names count, never content, and only the part after the working folder `CLAUDE_VE` (the name of a video never changes what its files are):
   - an audio file (`wav`, `mp3`, `m4a`, ...): `inspected` (the footage was looked at and its audio extracted);
   - a transcript (a text file in a folder or with a name that says transcript, or any `srt` / `vtt`): `transcribed`;
   - a plan (a text or script file whose name has the word plan, timeline, spec, cue, EDL, storyboard or shot list), once the footage was looked at: `planned`;
   - anything in a folder named `gfx...`, `graphic...`, `hyperframes`, `remotion`, `compositions`, `cards` or `overlays` (the sources, then the renders), once the footage was looked at: `planned`, because the graphics are built from the plan;
   - anything named `qa`, `qa_...` or `...-qa`: the quality check needs the picture with its graphics and b-roll, so `graphics_built`, `broll_ready` (both implied, never learned from) and `assembled`.
   In the owner's edits these appeared at: audio 1 to 4 minutes, transcript 2 to 8, plan 4 to 20, graphics sources 1 to 3 minutes after the plan and the renders at 8 to 26, the quality-check sheet 2 to 3 minutes before the review project.
   The number of such files also counts as work done for the stuck-model rule (Keeping a job going).
4. The stream, keyword-based and not tied to one toolkit: a Bash command or task about Whisper or transcribing (`inspected`); the main session reading a transcript data file, or writing a plan-like or graphics file (the same names as above, also inside a sub-agent for graphics; `transcribed` and `planned`); a transcription sub-agent completing (`transcribed`: the completion of a shell command that runs Whisper is not, because a command that starts the transcription in the background ends when it has started it); a sub-agent or task about graphics, HyperFrames, animations or cards starting (`planned`); every such graphics sub-agent started after the plan completing (`graphics_built`); every b-roll, conform, stabilization or product image sub-agent started after the plan completing (`broll_ready`); a thumbnail or meta sub-agent completing (`extras_written`); for a render, a render or encode command at 2160 / 4K or for the final file (`render_started`).
   Only a `completed` task notification counts; a stopped or failed task is done again later.
5. Time: see Pacing below.

Setup is not the work.
A command or task that installs, creates an environment, smoke-tests, downloads a model or tool, or asks for `--help` or `--version` (words install, venv, brew, pip, smoke, a download of a model, Whisper, ffmpeg, node or Python, and the like) is setup, however often it names Whisper: it never counts as transcription, never starts a step, and its time is not counted by the estimate.
While one runs the stage is "Getting the tools ready"; and before the footage was looked at, once any setup was seen, the stage stays that and the bar stays in its first 2 points until real work starts.
On an Intel Mac without ffmpeg, Node and a Whisper that works, a job spent half an hour on this; the bar stayed at 2 and said so.

Pacing (evidence 5):

- The model has a typical timeline: the active time at which each milestone is typically finished (the defaults of the table, or the medians of this Mac's history, below), and the stretch each one takes from the milestone whose end it follows (the b-roll and the graphics both follow the plan; the timeline follows both).
- The job is put on that timeline at its anchor: the finished milestone that is typically reached last, at the active time it was finished (the start of the job when nothing is finished).
  The thumbnails and the b-roll are not anchors: they run beside the main work.
  The job's pace is that milestone's active time over its typical time, between 0.5 and 6 (an Intel Mac is several times slower than the Apple Silicon edits of the defaults); without such a milestone it is 1.
  Setup time is left out of the time since the anchor.
- Each unfinished milestone is credited the share of its weight that the typical timeline has reached since the anchor, in its own stretch, so the bar moves at the typical speed of that part of the edit.
  A milestone the timeline expected before the anchor (the b-roll when the graphics were confirmed first) starts its stretch at the anchor, and a stretch starts when what it waits for ends.
- The stage (the first unfinished milestone) stays one point short of its value until the typical end of its stretch.
  When the job is later than that without evidence, the estimate goes on into the following milestones with a slow-down that never stops: the time past the typical end counts at 30% of the typical speed at first, and then logarithmically less (the scale is 10% of the typical total time), so the bar keeps moving but ever slower, and once the bar is 2 points past the value of the stage the stage reads "Working on the edit" (no step the evidence does not support) until a step is confirmed.
- Never past the files: a milestone that only a file confirms (the review project, the thumbnails, a final render) is never credited by time, and the bar never goes above the value of everything before the first of them that is unfinished plus all but one point of its weight (an edit without a review project: 95; re-edit: 94; a render without the final file: 69).
- The bar never goes backwards, so evidence that the job is behind its estimate holds the bar until the estimate catches up.

The weights below are replayed against the owner's real edits: with the file evidence, the 5 minute curve of the edit that stood at 29 for 5 to 8 minutes now rises 0, 33, 62, 92, 99, and the Intel job that stood at 29 for 55 minutes shows 2 until real work starts.

Typical times come from the last 10 completed jobs of the same kind and video type on this Mac (`progressHistory`): once at least 3 of them have a milestone, its median replaces the default; with a learned total only, every default is scaled by it.
What the files and the stream confirmed counts as seen, so the history learns from edits whose model never wrote a marker; milestones that were only implied are not recorded.
Until then the defaults measured on the owner's edits apply.

Rules:

- A new job (also a re-edit or render after an edit) has `progress` null while it waits in the queue and starts from 0 with its own model when it runs.
- Progress never goes backwards within a job, and stays at 99 at most until the job is `completed`; then it is exactly 100 with the stage "Done".
- It freezes while the job is pausing, paused, stopping, stopped or failed (only a running job's progress changes), and goes on from the same value and the same finished milestones on Continue, also after a restart of VidAI (`progressMemory`).
  Pauses do not count as time.
- It is published with `job-updated` when the percent or the stage changes, at most about once a second per job (a new stage at once).
  `state.json` is written on a new stage and otherwise at most every 10 seconds.

## 7. Toolkit

- The standard toolkit lives in `<Editing Folder>/CLAUDE_VE_ALL`.
- Whenever the Editing Folder is set, and on every app start, VidAI seeds what is missing from `resources/toolkit.tar.gz`: the `CLAUDE_VE_ALL` folder, `MEMORY.md` and `CLAUDE.md`.
  Each of the three is created only when it does not exist.
  Existing files and folders are never changed.
  Symlinks inside the archive must be restored as symlinks.
  Archive entries with absolute paths, `..`, links pointing outside their folder, hard links or special files make the archive invalid.
  The items are extracted into a temporary sibling folder first and renamed into place, so a crash never leaves a half-extracted `CLAUDE_VE_ALL` that would later count as existing.
- The archive never contains a Python environment or secrets.
  Claude creates `.venv` on the first edit.
- The toolkit was written on a Mac: it transcribes with `mlx-whisper` (Macs only), decodes and encodes with VideoToolbox and `aac_at`, has Swift / Apple Vision scripts in its notes, limits Whisper with `fcntl.flock` and `vm_stat`, and links shared graphics folders with symlinks.
  On an Intel Mac or a Windows PC the app itself works fully, and the first message of every edit names the computer and these pieces, and asks Claude to swap in equivalents that work there and to save each fix in the toolkit folder so that it chooses by platform at run time, keeps the Apple Silicon path, and is noted in `MEMORY.md` for later edits (section 6, Machine facts).
  So the toolkit adapts itself once per kind of computer, during edits.
  VidAI never changes the toolkit itself.
- "Create my own toolkit" (Settings) creates an empty `<Editing Folder>/CLAUDE_VE_ALL_OWN` containing only a short `README.md` saying Claude builds its tools here.
  Claude fills it during edits.
- Both toolkits stay on disk side by side.
  `activeToolkit` decides which one new jobs use, through `TOOLKIT_FOLDER` in the prompt.
  Choosing `own` is only possible once it exists.
  Switching never moves, renames or deletes anything.
- `scripts/snapshot-toolkit.sh "<Editing Folder>"` rebuilds the bundled archive from a real Editing Folder.
  It stages a copy (the source is only read); the shipped toolkit needs no key of any service.
  The script fails if any reference to a `.env` file, or a file or text of the removed third-party judgment helper, is left in the staged toolkit, naming what to remove from the source Editing Folder first, so a later snapshot cannot bring either back unnoticed.

## 7a. Harness + API Keys

Settings, Harness + API Keys is the one place that says how edits run: which program does the editing and which service the model comes from.
The choice is one of four options (the `Setup` type, section 4); the three that use a service each have their own API key, address, model and reasoning efforts.
The key is required only for OpenCode Go; for the Anthropic and OpenAI compatible APIs it is optional (The key is optional below), because those are often a model server on the user's own computer.

### The four options

| Id | Label | Program | Service | Default address | Key |
|---|---|---|---|---|---|
| `claudeSubscription` | Claude Code with Claude Subscription | Claude Code | the user's own Claude login | none | none |
| `opencodeGo` | OpenCode 2 with OpenCode Go Subscription | OpenCode 2 (`opencode2`) | OpenCode Go | `https://opencode.ai/inference/go/anthropic` | its own, required |
| `anthropicApi` | Claude Code with Anthropic Compatible API | Claude Code | any Anthropic compatible API | `https://api.anthropic.com` | its own, optional |
| `openaiApi` | OpenCode 2 with OpenAI Compatible API | OpenCode 2 (`opencode2`) | any OpenAI compatible API | `https://opencode.ai/inference/go/v1` | its own, optional |

- `settings.json` defaults to `claudeSubscription`; a new install is asked to choose by the onboarding when something blocks edits (section 9, Onboarding).
- The three API options (`ApiOption`: `opencodeGo`, `anthropicApi`, `openaiApi`) each keep their own address (null = the default above), model, reasoning efforts (`Settings.apiOptions`) and key (Secrets), so switching options never loses anything.
- An API option can be selected (`set_setup`) only with its model chosen, and for `opencodeGo` also with its key saved (`ApiOption::key_required`; `anthropicApi` and `openaiApi` can be selected without a key); Settings shows the reason otherwise.
  The program is not checked there: a missing or unsupported program is a readiness problem that the onboarding and the program row show (section 6, Readiness of a launch).
- The program follows from the setup (`harness::for_new_job`): Claude Code for `claudeSubscription` and `anthropicApi`, the OpenCode 2 program for `opencodeGo` and `openaiApi`.
  A session stays in the program it started in (`JobView.harness`, section 6, Setup of a job).
- What each option needs on this computer is the table of section 6, Readiness of a launch: option 1 Claude Code installed and logged in, option 2 and 4 the OpenCode 2 program in a supported 2.x and never Claude Code or a Claude login, option 3 Claude Code installed (and Git for Windows on Windows) and never a login.
- All four options exist on macOS and on Windows (section 11); nothing about them depends on the platform.
- A job on an API option keeps itself going when its model ends a turn early, and its messages ask it to keep working (section 6, "Keeping a job going" and Prompt composition).
- The model and the effort of `claudeSubscription` are chosen in the top bar of the main window (section 9); those of an API option are chosen in Settings, Harness + API Keys, and the top bar only shows them.

### Secrets

- The API keys are stored only in the OS keychain, through `secrets.rs`, and never in `settings.json`, `state.json`, a log or a settings export; the UI only ever gets a status with the last four characters.
- macOS: all of VidAI's secrets live in one Keychain item, a generic password with service `com.vidai.desktop` holding a small JSON object with one text field per API option (`opencode-go-api-key`, `anthropic-api-key`, `openai-api-key`), and VidAI reaches the Keychain only through Apple's `/usr/bin/security` tool, run as a child process.
  Why: macOS decides per program whether an item may be read without the Keychain password dialog, and an item created through the Security framework names the program that created it.
  VidAI is ad-hoc signed (there is no Apple Developer ID), so every new build, and each slice of the universal binary, is a different program to the Keychain; macOS then asks for the login password, for one read possibly twice (once for the item's access list, once for its partition list), and "Always Allow" does not carry over to the next build.
  `/usr/bin/security` is signed by Apple with a stable identity (`identifier "com.apple.security" and anchor apple`).
  An item created by it trusts that identity, so whichever VidAI build runs, the program that reads the item is always the same one and macOS asks nothing.
  This is how Claude Code keeps its own login in the Keychain.
- The invocations (module `secrets/security_cli.rs`):
  - read: `security find-generic-password -s com.vidai.desktop -a <account> -w`; the text arrives on stdout (printed in hex when it is not printable ASCII, which VidAI's own items never are); exit code 44 means there is no such item.
  - write: the command `add-generic-password -s com.vidai.desktop -a <account> -T /usr/bin/security -X <hex of the text>` is sent on the standard input of `security -i`, never in the argument list, where other programs could see it; the hex encoding means no quoting can break it.
    `-i` reports some failures with exit code 0, so every write is read back before it counts; a command line has a limit of about 4000 characters, so a write whose line is longer is refused (`invalidInput`, far above any key).
  - delete: `security delete-generic-password -s com.vidai.desktop -a <account>`.
  - Every call has a hard time limit (30 seconds; 180 seconds for the old items of the migration, which can show the dialog) after which the child is killed and the read counts as failed; nothing the tool prints is logged, and an error names the exit code and, except for a write, the tool's own first line.
- An item is never updated in place: `security add-generic-password -U` asks macOS to change the access list of the item, which can show a dialog.
  The item therefore takes turns between two accounts, `vidai-keys-v2-a` and `vidai-keys-v2-b`, and the JSON object has a `generation` number.
  A save empties the account that is not current, writes the new generation there (read back), and only then removes the former current one, so a complete item exists at every moment however the app ends.
  The current item is the one with the higher generation; an item that is not valid JSON makes the keys unreadable instead of being skipped.
  Removing the last key removes both items; when nothing is saved there is no item.
- That item is read at most once per run of the app, at startup (both accounts, which no dialog can come from), and the result is kept in memory.
  Job launches, renders, the status and hint displays, Test, Fetch Models, the model list and the quota refresh use the copy in memory; saving or removing a key writes through to the Keychain and updates that copy.
- Migration from earlier versions, never losing a key and also when interrupted at any point.
  Versions 0.2.0 to 0.2.2 kept one item created through the Security framework (account `vidai-keys`), and versions before that a separate item of an optional key VidAI no longer supports (the retired key, `secrets::RETIRED_KEY`, which is dropped); their access lists name the build that created them.
  When neither new item exists at startup, the first start reads the old combined item through `security`; this is the one read that can show the Keychain password dialog, once.
  It then writes the keys to the new item with `legacyRemoved: false` (read back), only then removes the old items and writes the keys again with `legacyRemoved: true`.
  An interruption before the first write leaves the old items, which the next start migrates again; one after it leaves the new item with `legacyRemoved: false`, and the old items are removed with the next save (never at startup, never read again).
  Removing the last key while old items could not be removed keeps an empty new item, so a removed key cannot come back from an old item.
  What the owner sees: on the first start after updating, the password dialog of the old item, as many dialogs as macOS needs for that one read of the old item (the ones he sees today at every start, at most two) and possibly one more for removing it; macOS cannot be avoided there, because only the build that created the old item may read it silently.
  If he denies it, VidAI starts as if no key were saved, nothing is changed, and Try Again reads again.
  Every later start, on every build and slice, shows no dialog.
- The item of VidAI 0.2.3 and 0.2.4 has the fields of those versions (the OpenCode key `opencode-api-key` and the retired one); they are read as section 7a, Migration from 0.2.4, says, and the next write leaves the item with the new fields only.
- When the read fails (the dialog was denied, the tool timed out, the Keychain is locked), VidAI starts normally, behaves as if no key is saved, refuses to save a key over what it could not read (`secretsUnavailable`), and does not ask again by itself; Settings says so with Try Again (`retry_secrets`), the only other moment a read happens.
- The trade-off, stated plainly: any program running as the same user can run `security find-generic-password` and read the keys without a dialog, as it can read Claude Code's login (same mechanism) or a key file readable by the user.
  What the Keychain still gives is encryption at rest and a locked Keychain when the user is logged out; the per-application protection that an Apple Developer ID signature would give (only VidAI may read its item) is not available without one.
- Windows keeps each key in the Credential Manager one credential per API option (section 11, Secrets), which shows no dialog.
- Tests use an in-memory secret store, and the read-once logic is tested behind a seam with a counting stand-in for the Keychain; the `security` invocations are tested against a fake `security` program (every failure, timeout, migration interruption point, quotes, newlines and non-ASCII text) and, on macOS, against the real `/usr/bin/security` with a scratch keychain file of its own (created with a password the test chooses, never in the search list, deleted afterwards); no test touches the login keychain.

### Options, addresses and protocols

- `claudeSubscription` runs Claude Code on the user's own login with the user's own environment: VidAI sets none of the variables below.
  When the user's own environment or Claude Code's settings file (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`; on Windows `%USERPROFILE%\.claude\settings.json`) already sets `ANTHROPIC_BASE_URL`, VidAI leaves it alone and says so plainly under option 1 in Settings, Harness + API Keys (`get_claude_routing`), because "Claude Subscription" would then not mean what it says.
  A settings file also wins over the variables of a job on `anthropicApi`, a limit VidAI does not work around.
- `opencodeGo` (OpenCode 2): the OpenCode 2 program (below) with the OpenCode Go key.
  Default address `https://opencode.ai/inference/go/anthropic` (Go); pay-as-you-go OpenCode is `https://opencode.ai/inference/anthropic`, entered by hand.
  Model list: `GET <address>/v1/models` (Anthropic's list form), the key as bearer token, following `has_more` with `after_id`.
  Test: `POST <address>/v1/messages` with `max_tokens` 1, the chosen model and the key as bearer token.
  How the program is given address, key and model: The OpenCode 2 program below (`launch2::route`).
- `anthropicApi` (Claude Code): a job gets exactly these variables in its environment, and nothing else changes: `ANTHROPIC_BASE_URL` (the address), `ANTHROPIC_API_KEY` (the key, which Claude Code sends as `x-api-key`: api.anthropic.com requires that form and gateways accept it; with no key saved it is not set, see The key is optional), and `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_HAIKU_MODEL` all set to the chosen model, so the edit (`--model <model>`), its sub-agents and its background tasks all use it; `--effort <level>` is added only when a reasoning effort is remembered for the model.
  With a key, the `ANTHROPIC_AUTH_TOKEN` of the user's own environment is removed from the job's environment, so no token of the user's ever competes with the key.
  Without a key, `ANTHROPIC_API_KEY` of the user's own environment is removed and `ANTHROPIC_AUTH_TOKEN` is set to the placeholder `no-key` (`opencode::NO_KEY_TOKEN`; The key is optional).
  Models offered for choosing, only when the user presses Fetch Models: `GET <address>/v1/models` with `x-api-key: <key>` (no `x-api-key` header when no key is saved) and `anthropic-version: 2023-06-01` (Anthropic's list form, following `has_more` with `after_id`; a list of OpenAI's form from a gateway is read as well).
  Test: `POST <address>/v1/messages` with `max_tokens` 1, the chosen model and the same two headers (the version header only, when no key is saved).
- `openaiApi` (OpenCode 2): the run configuration's provider `vidai` uses the package `@ai-sdk/openai-compatible` with `baseURL` set to the address (which already ends in `/v1`) and the key through the variable `VIDAI_API_KEY` (`{env:VIDAI_API_KEY}`); with no key saved the provider has no `apiKey` setting and `VIDAI_API_KEY` is not set (The key is optional); OpenCode's own providers are never used for it.
  The provider is always VidAI's own `vidai`, named "OpenAI Compatible API (VidAI)", whatever the address.
  A saved key reaches OpenCode 2 in `VIDAI_API_KEY` only (the user's own `VIDAI_API_KEY` is removed first); `opencodeGo` uses `OPENCODE_API_KEY` instead, and never both.
  Models offered for choosing, only when the user presses Fetch Models: `GET <address>/models` (OpenAI's list form, `{"data":[{"id":...}]}`, other fields such as Ollama and LM Studio add are ignored) with `Authorization: Bearer <key>` (no `Authorization` header when no key is saved).
  Test: `POST <address>/chat/completions` with `max_tokens` 1, the chosen model and the same header (none when no key is saved).

Addresses (`opencode::normalize_base_url(option, url)`; null, an empty text, or the default address of the option is stored as null):

- For every option: the text is trimmed and a trailing `/` removed; `https://` is required and plain `http://` is allowed only for `localhost`, `127.0.0.1` and `[::1]`; a user name, password, query or fragment is refused with `invalidInput`.
- `opencodeGo` and `anthropicApi` use the Anthropic form (Claude Code and OpenCode 2's Anthropic package append `/v1/messages` themselves): a trailing `/v1/messages` or `/v1` is removed.
- `openaiApi` uses the OpenAI form: a trailing `/chat/completions` is removed and `/v1` is kept, because it is part of the address.

The API key of an option:

- It is entered in Settings, Harness + API Keys (or the onboarding), stored under the option's own field of the keychain item (Secrets), shown as its last four characters, and removable.
  Removing the key of the selected `opencodeGo` switches edits back to `claudeSubscription` (`clear_api_key`); removing the key of the selected `anthropicApi` or `openaiApi` keeps it selected, because those work without a key.
  Settings is its only source: never a `.env` file or VidAI's own environment.
- It is registered with the log scrubber (`[api key]`) and never appears in arguments, logs, `state.json`, the activity panel or an error.

The model:

- `opencodeGo`: a searchable list fetched live from the option's list address above, cached in `state.json` with its address (`apiModels`).
  A saved model that the last list of the address does not have is shown as no longer offered, and a launch then cannot use it.
- `anthropicApi` and `openaiApi` point at any compatible service, often a model server on this computer (Ollama, LM Studio, vLLM, a LiteLLM proxy), so the list is never fetched by itself and never decides anything.
  Model: a text box for the model id as the service names it, saved on Return or when leaving the field.
  Fetch Models (once the URL is set; the key too only for `opencodeGo`) asks the service for its models (`GET <url>/v1/models` with `x-api-key` for option 3, `GET <url>/models` with a bearer key for option 4, each without that header when no key is saved) and shows them to choose from; choosing fills the text box.
  A model that is not in the list can still be typed (local servers and gateways name models freely).
  The fetched list is shown in the screen only and is not kept; nothing fetches it at startup, on selecting the option or on saving a key, and a launch never checks the model against it.
- The choice of every option is saved per option in `settings.json` (`apiOptions.<option>.model`, `set_api_model`, which clears an empty text and refuses an id with spaces or control characters) and is the only model of that option (the top bar does not choose it); the top bar, the activity panel and Test show the model by its id when no list names it.

The reasoning effort:

- A Select under the model, Default or Low, Medium, High, Extra high, Max, remembered per option and model id in `settings.json` (`apiOptions.<option>.efforts`, `set_api_effort`); changing the model shows the effort remembered for that model.
  Default sends nothing.
  In Claude Code (`anthropicApi`) a chosen level is sent as `--effort <level>`; its effect behind a gateway is not verified.
  In the OpenCode 2 program (`opencodeGo`, `openaiApi`) it is the model variant of that name when the server's catalog for the model offers it (`launch2::variant_for_effort`); otherwise the model runs on its default and the log says why.

Test and errors:

- Test (`test_api`) sends the one tiny request of the option and reports "OpenCode Go answered with GLM-5.3." (the service and the model) or the reason; Settings says that it sends one tiny request.
- Errors, in the words of `opencode::http::failure_text`, for Test, the model list and jobs of every API option: a refused key (401), a model not allowed for the plan or a free model used outside OpenCode's own apps (403), a model not offered (404, `model_not_found`), a Go window reached (429 `GoUsageLimitError` with `metadata.limitName` "5 hour", "weekly" or "monthly"), a budget reached (429 `BudgetLimitError`, "Policy budget exceeded"), the free limit (`FreeUsageLimitError`), a balance used up (402), an overdue invoice, other rate limits (429) and the service's own trouble (5xx).
  The service of a job is chosen from the option's address (`Service::for_base_url`), on every option: an `opencode.ai` or `*.opencode.ai` address keeps the OpenCode texts; any other address uses these generic texts:
  - Key refused: "The service did not accept the API key. Check that you copied the whole key, or make a new one with the service."
  - 403: "The service does not allow the model X for this key: it is not in your plan. Choose another model in Settings, Harness + API Keys."
  - 404: "The service does not offer the model X at this address. Choose another model in Settings, Harness + API Keys."
  - 429: "The service is limiting requests right now. Try again in a minute."
  - 5xx: "The service is having problems right now (error N). Try again later."
  - Other HTTP: "The service answered with an unexpected error (HTTP N)."
  - Budget: "A budget limit of the service is reached. Raise it with the service, or wait until it resets."
  - Free limit: "The free limit of the service is reached. Try again later, or choose a paid model."
  - Balance: "Your balance with the service is used up. Add credit with the service."
  - Overdue invoice: "Your account with the service has an overdue invoice. Settle it with the service."
  - Nothing recognizable: "The service reported an error."
  An unrecognized report of the program stays "Claude Code reported an error: <first line>" or "OpenCode 2 reported an error: <first line>".
  Texts about the local OpenCode 2 server itself (it stopped the turn, refused the message, could not start) keep naming OpenCode 2.
- Every request VidAI makes to a service has short time limits, follows no redirect, uses `http` without a proxy only for this computer, identifies itself as `VidAI/<version>`, and never puts the key in a message.

### The key is optional

Only `opencodeGo` needs its API key (`ApiOption::key_required` in `model.rs`, `keyRequired` in `src/lib/setup.ts`).
`anthropicApi` and `openaiApi` point at any compatible service, which is often a model server on the user's own computer (Ollama, LM Studio, vLLM, a LiteLLM proxy) that asks for no key, so for them the key is optional and edits need only a chosen model (section 6, Readiness of a launch: `apiKeyMissing` happens only on option 2).
Everything below holds when no key is saved for that option; with a key saved the options behave exactly as described above.

- Option 3 (`anthropicApi`, `opencode::job_env`): `ANTHROPIC_API_KEY` is removed from the job's environment, so the user's own key is never sent to the server, and `ANTHROPIC_AUTH_TOKEN` is set to the placeholder `no-key` (`opencode::NO_KEY_TOKEN`).
  Claude Code then has credentials of its own kind and never falls back to the user's Claude subscription login; no real key and no login reaches the server.
  Claude Code sends `Authorization: Bearer no-key` to the address, which a server that needs no key ignores.
  With a key it is the other way round: `ANTHROPIC_API_KEY` is the key (sent as `x-api-key`) and `ANTHROPIC_AUTH_TOKEN` is removed.
- Option 4 (`openaiApi`, `launch2::without_key`): the `apiKey` setting is left out of the provider `vidai` of the run configuration (OpenCode 2.2.6 refuses `apiKey: false`) and `VIDAI_API_KEY` is not set, so the requests carry no `Authorization` header.
- Fetch Models and Test (`opencode/http.rs`) send no key header: neither `Authorization` nor `x-api-key` (option 3 still sends `anthropic-version`).
  A 401 answer to a request that carried no key says "The service wants an API key. Enter one in Settings, Harness + API Keys." instead of blaming a key that was never sent.
  Both are available as soon as the URL is set (the URL always has a value, its default address), and Test still needs a chosen model.
- Removing the key of option 3 or 4 keeps that option selected (`clear_api_key`); only removing OpenCode Go's key puts edits back on `claudeSubscription`.
  A job whose option has no key launches as above; only `opencodeGo` without a key cannot launch ("No API key is saved for OpenCode Go.").
- The UI says it (section 9): the field is "API Key (optional)" on options 3 and 4, with "Leave it empty if your server needs no key." as its hint, and the remove dialog says edits then run without a key.
  Nothing else about the key changes: it is stored and removed as under Secrets, and a blank key is still refused by `set_api_key`.

### Migration from 0.2.4

An install of VidAI 0.2.4 or earlier keeps working with what it had (`store.rs`, `secrets.rs`; the file formats are in section 4, Persistence):

- `provider` `claude` becomes `setup` `claudeSubscription`.
- The old OpenCode address, model and efforts are copied into `apiOptions.opencodeGo`, always, and so is the old OpenCode key (the field `opencode-api-key` is read as `opencode-go-api-key`).
- `provider` `opencode` with the harness `opencode2` (or only the provider, for a file from before the harness existed with the OpenCode 2 program) becomes `opencodeGo`.
- `provider` `opencode` with the harness `claudeCode` becomes `anthropicApi`, and the old address, model, efforts and key are also copied into `apiOptions.anthropicApi` and the key field `anthropic-api-key`.
  The old address is stored explicitly (a null old address means the old Go default, `https://opencode.ai/inference/go/anthropic`), because the default address of `anthropicApi` is another one now.
  The job variables change with it: the key is now `ANTHROPIC_API_KEY` instead of `ANTHROPIC_AUTH_TOKEN`, which the Go gateway accepts.
- `provider` `opencode` without a model becomes `claudeSubscription`, as before.
- `apiOptions.openaiApi` starts with the default address, no model and no efforts.
- Jobs in `state.json`: `provider` `claude` (or none) becomes `setup` `claudeSubscription`, `opencode` with the harness `claudeCode` (or none) `anthropicApi`, and `opencode` with the harness `opencode2` `opencodeGo`; `model`, `effort`, `harness` and the session stay as they were, so Continue and Re-Edit resume the sessions as before.
- `opencodeModels` of `state.json` becomes `apiModels.opencodeGo`; no list is copied for `anthropicApi`, which keeps none.
- The retired optional key of VidAI 0.2.4 (`secrets::RETIRED_KEY`) is dropped: it is not read into any field, the next write of the keychain item leaves it out, and on Windows its credential is deleted at startup, best-effort (an error is ignored and the deletion is tried again at the next start).
- Order, so that no key is lost and an interruption only repeats the step: the keychain item is written first (when the migration chose `anthropicApi`, at once, with the new fields, read back, as a new generation), and `settings.json` is written at version 9 only after that succeeded.
  Without that case nothing is written at startup: the in-memory view maps the old field already, and the next save writes the item in the new form.
  While the key copy of a migration to `anthropicApi` is pending, settings changes are kept in memory only, and `settings.json` is written (as version 9) only after the keychain write succeeded: at startup after the keychain read, or from `retry_secrets`.
  While the keys could not be read at startup, the step waits for Try Again and the settings stay version 8 on disk.
- The settings export never contains keys (as before) and carries neither `setup` nor `apiOptions`; an old export file imports exactly as before.

### The program of a setup

- `harness::for_new_job` is the one place that decides the program of a new job, from the setup (table above); a session stays in the program it started in (`JobView.harness`, section 6, Setup of a job).
- Readiness follows the setup (section 6, Readiness of a launch): with the OpenCode 2 program Claude Code is needed neither installed nor logged in, and the onboarding, the sidebar status and Settings, System ask for the program of the setup (section 9).
- `harness::AgentProcess` is what the job engine needs from a running agent (start, send a message, interrupt, close, its process tree); the OpenCode 2 program reports the same event vocabulary (`claude::protocol::StreamEvent`), so the log, the progress, the turn tracking and Keeping a job going work unchanged.

### The OpenCode 2 program

The OpenCode 2 program is `opencode2` (2.x), driven through its own headless server, one server per run of a job, on this computer only.
Its HTTP API is `/api/...`, with server-sent events at `/api/event` (`opencode::harness::server2`, `events2`, `launch2`); the server process, the local HTTP client and the reader of the event stream are in `opencode::harness::child`.
It was chosen over `opencode2 run` because it is one process per message and an interrupt is a kill, and because the server reports background work and its reports, which a job must wait for.

Finding it (`opencode::harness::locate2`): `VIDAI_OPENCODE2_BIN` (the only candidate when set); otherwise the candidates are every `opencode2`, then every `opencode`, each on the login-shell `PATH` and then in the folders the installers use (`~/.opencode/bin`, Homebrew's two `bin` folders, `~/.local/bin`); on Windows each is also looked for with `PATHEXT` (`.exe`, `.cmd`) and in `%LOCALAPPDATA%\Microsoft\WinGet\Links`, `%USERPROFILE%\.opencode\bin`, `%APPDATA%\npm`, `%USERPROFILE%\scoop\shims` and `%USERPROFILE%\.local\bin` (section 11).
On a Mac the official installer (`curl -fsSL https://opencode.ai/v2/install | bash`) writes the 2.x binary as `~/.opencode/bin/opencode` plus an `opencode2` shim that runs the `opencode` next to it; npm's `@opencode/cli` links both `opencode` and `opencode2` to its binary (one candidate, asked once); Homebrew provides `opencode`.
The first candidate that reports a 2.x version is the program, so a 2.x `opencode` is picked up without any shim, and a shim left behind after an older installer replaced the binary next to it (it then runs 1.x) does not hide a 2.x program elsewhere.
When no candidate reports 2.x, an `opencode2` counts as found but not supported, with the version it reports; a 1.x `opencode` alone means OpenCode 2 is not installed.
Its version is what `--version` prints (with auto-update off, at most 45 seconds); 2.2.6 prints `opencode v2.2.6`.
VidAI drives 2.x, 2.0 or later (`get_opencode2_cli`, `open_opencode2_install`); where it is missing or not supported a launch on `opencodeGo` or `openaiApi` is refused (`programMissing`, `programUnsupported`, section 6, Readiness of a launch), with the reason.
The program belongs to the setups `opencodeGo` and `openaiApi`; a session stays in the program it started in, and jobs that cannot continue there fall back the same way (section 6, Setup of a job).

A run (`opencode::harness::server2::Server2`):

1. VidAI starts, in a process group of its own, with the Editing Folder as working directory and a pipe to its stdin:
   `opencode2 serve --stdio --hostname 127.0.0.1 --port 0`.
   With `--stdio` the server picks a free port itself (OpenCode's own default would be 4096 and up, where the user's own server may listen), ends when its stdin closes (so it never outlives VidAI, also after a crash), and removes its password from the environment of the commands it runs.
2. It reads the address from the first line the server prints, `{"url":"http://127.0.0.1:<port>"}` (at most 30 seconds).
3. Every request carries the run's password as HTTP basic auth (user `opencode`) and the Editing Folder as the header `x-opencode-directory` (percent-encoded, as `encodeURIComponent` does); it goes to 127.0.0.1 without a proxy.
4. `GET /api/event` is subscribed first (server-sent events of every session of the server, `{"id","created","type","location","data"}`; the first one is `server.connected`), so nothing of the session is missed.
5. The model (`Server2::choose_model`): on `opencodeGo`, OpenCode's own provider of the address (`opencode-go` for the Go address, `opencode` for pay-as-you-go) runs it only when `GET /api/model` lists it there and that provider would use VidAI's key: `GET /api/integration/<provider>` lists the provider's connections in the order OpenCode uses them, and the first must be the variable `OPENCODE_API_KEY`.
   A login stored in OpenCode's own database comes before the variable and cannot be overridden by the configuration, so with one VidAI's own provider `vidai` runs the model instead; so does any other address of `opencodeGo`, and a model OpenCode's catalog does not list (yet).
   On `openaiApi` VidAI's own provider `vidai` always runs the model (below).
6. A new session is `POST /api/session` with a title ("VidAI: <channel>/<video>"), the model (`{"providerID","id"}`), the Editing Folder as its location (`{"directory"}`; this route ignores the header) and the session's permission rules: everything allowed (`{"action":"*","resource":"*","effect":"allow"}`) and `question` denied, which removes the question tool; the last matching rule decides and a session's rules come after the agent's and every configured rule, also for its sub-agents.
   OpenCode 2 has no plan mode tools.
   A permission request that still comes (`permission.asked`, from a plugin) is answered `once`; a form (`form.created`: a question of a plugin's tool, or an MCP server's request in the Editing Folder) is cancelled with a message that tells the model to go on without an answer (`events2::QUESTION_CANCELLED`).
   A resumed session is checked with `GET /api/session/<id>`; a 404 (`SessionNotFoundError`) is reported as Claude Code reports a session it does not have, so the fallback of section 6 starts a new session with the full instructions.
   A resumed session that ran on another model (the route changed, for example because OpenCode now has a login of its own) is moved to the model first (`POST /api/session/<id>/model`).
7. A message is `POST /api/session/<id>/prompt` with `{"text"}`, answered at once while the turn runs; it is queued (`session.inbox.enqueued`) and joins the current busy period of the session or starts one (`session.inbox.delivered`).
   A message OpenCode refuses ends the turn at once with an error that says why; a server that died meanwhile reports its own end, with its last stderr line.
8. Pause and Stop are `POST /api/session/<id>/interrupt`: the running step and its commands stop at once, and the busy period ends as interrupted.
   An interrupt leaves background work running, and its reports would start the session again, so VidAI also ends the session tree's background commands (`GET /api/experimental/job?sessionID=<id>&descendants=true&status=running`, then `DELETE /api/shell/<id>` for each) and interrupts its sub-agents (`POST /api/session/<child>/interrupt`), and interrupts every busy period of the job that still starts until the server is closed.
9. Closing the run closes the stdin pipe (the server shuts down) and sends SIGTERM to the server's process group; the commands it started run in process groups of their own and are ended with the job's process tree (`platform::process::ProcessTree`), as for Claude Code.

The environment (`launch2::server_env`) is the login-shell environment without `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `OPENCODE_PASSWORD` (which OpenCode 2 reads before `OPENCODE_SERVER_PASSWORD`), `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_API_KEY`, `VIDAI_API_KEY` and `OPENCODE_FLAGS` of the user's own, plus:

- `OPENCODE_API_KEY` (only on `opencodeGo`): the key (never an argument, a file, a log line or an error; registered with the log scrubber); it is also the key of OpenCode's own providers when OpenCode has no stored login.
- `VIDAI_API_KEY` (only on `openaiApi` with a saved key, never together with `OPENCODE_API_KEY`): the key of that option, which the provider `vidai` of the run configuration reads (`{env:VIDAI_API_KEY}`); no provider of OpenCode itself reads this variable, and the key is handled like the one above.
- `OPENCODE_SERVER_PASSWORD`: a new random password per run.
- `OPENCODE_DISABLE_AUTOUPDATE=1`.
- `OPENCODE_CONFIG_CONTENT`: the run configuration (`launch2::run_config`), in OpenCode 2's own keys, merged by OpenCode above every configuration file of the user (which VidAI never touches) and below an administrator's managed settings; for the default address, the model `glm-5.3`, the Editing Folder `/Users/editor/Editing` and the home folder `/Users/editor`:

```
{"$schema":"https://opencode.ai/config.json","formatter":false,"instructions":["/Users/editor/Editing/CLAUDE.md","/Users/editor/.claude/CLAUDE.md"],"lsp":false,"providers":{"vidai":{"models":{"glm-5.3":{"name":"glm-5.3"}},"name":"OpenCode (VidAI)","package":"@ai-sdk/anthropic","settings":{"apiKey":"{env:OPENCODE_API_KEY}","baseURL":"https://opencode.ai/inference/go/anthropic/v1"}}},"share":"disabled","snapshots":false}
```

How the address and model become OpenCode 2's `provider/model` (`launch2::route`): on `opencodeGo`, the default Go address is OpenCode's provider `opencode-go`, the pay-as-you-go address `opencode`, each of which knows the protocol, limits and price of every model of its catalog; any other address is VidAI's own provider `vidai`, Anthropic's API at `<address>/v1` (OpenCode 2's Anthropic package sends `<baseURL>/messages` with the key as `x-api-key`), the way Claude Code reaches it.
On `openaiApi` it is always VidAI's own provider `vidai`, named "OpenAI Compatible API (VidAI)", with the package `@ai-sdk/openai-compatible`, `baseURL` the address as it is (it ends in `/v1`; the package sends `<baseURL>/chat/completions`) and the key `{env:VIDAI_API_KEY}` (left out of the configuration when no key is saved, section 7a, The key is optional), whatever the address, the default (OpenCode Go's OpenAI form) included: OpenCode's own providers are never used for it.
On `opencodeGo` the key is `{env:OPENCODE_API_KEY}` in the configuration, which OpenCode 2 substitutes; OpenCode's own providers need no configuration, the variable is their key.
OpenCode 2 answers `GET /api/model` with each model's resolved settings, the key included, so VidAI never logs that answer.
No snapshots are taken of the Editing Folder (it holds gigabytes of footage); OpenCode 2 runs no language servers and starts no formatter unless configured, and both are switched off anyway.

What else applies, like Claude Code's own settings: the user's own configuration (`~/.config/opencode`: MCP servers, plugins, skills, agents), skills in `~/.claude/skills`, and `AGENTS.md` files from the Editing Folder up to the home folder.
OpenCode 2 does not read `CLAUDE.md` by itself, so the run configuration names the Editing Folder's `CLAUDE.md` and `~/.claude/CLAUDE.md` as instructions (a file that does not exist is skipped); an `AGENTS.md` in the Editing Folder is read as well.
`MEMORY.md` is read because the instructions say so.
Sessions live in OpenCode's own store (by default `~/.local/share/opencode/opencode.db`), so a later server, also after VidAI restarted, resumes a session by its id.
A plain `opencode2 serve` does not resume interrupted work by itself (only its `--service` mode does), so nothing of a paused job runs on until Continue.

Background work:

- The shell tool (`shell`, input `command`, `workdir`, `timeout`, `background`) stops waiting for a command after its timeout (2 minutes unless the model gives a longer one) and moves it to the background, where it goes on; `background: true` starts it there.
- The sub-agent tool (`subagent`, input `agent`, `description`, `prompt`, `model`, `sessionID` for a follow-up) always runs its child session in the background.
- Both answer at once with `metadata.status` `running`; when the command ends or the child goes idle, a report (`<shell ...>` or `<subagent ...>`) is queued for the session that started it (`session.inbox.enqueued`, item `synthetic` with `metadata.source` `shell` or `subagent`), which starts a new busy period of that session.
- So the job engine sees them as Claude Code's background tasks: started, then finished by the report; a job is finished only when no turn runs and no background work is left (section 6, Keeping a job going), and an idle moment never comes while a sub-agent or a command still works.
- While the main session waits for background work only, VidAI compares it with the server's job list every 30 seconds; work the list does not have twice in a row ended without a report reaching VidAI and is not waited for any longer, so a lost report cannot hold a job forever.
- The OPENCODE block of the first message (section 6, Prompt composition, `prompt::OPENCODE2_PROGRAM`) names these tools and says that sub-agents and long commands report back, that a long command needs a long enough timeout, and to end the turn when only waiting for them.

The event stream (`opencode::harness::events2`, recorded from 2.2.6 in `src-tauri/tests/fixtures/opencode2-stream/`) is translated into the vocabulary of Claude Code, so the job engine reads it the same way:

| OpenCode 2 | Job engine event |
|---|---|
| main session busy (`session.execution.started`) | `system` `init` with the session id and model |
| `session.text.ended` (the whole text) | assistant text; nested in a sub-agent's session |
| a sub-agent's prompt (`session.inbox.enqueued`, item `user`, in its session) | nested user text |
| `session.tool.called` (with the input) | assistant `tool_use`, named and shaped as Claude Code's tools (`shell` is `Bash` with `run_in_background`, `read`, `write` and `edit` are `Read`, `Write` and `Edit` with `file_path`, `subagent` is `Agent` with `subagent_type`, keys in snake_case) |
| `session.tool.success` / `session.tool.failed` | user `tool_result` (failed: `is_error`) |
| `session.tool.progress` of a running tool | `system` `task_progress` (activity, nothing logged) |
| a command or sub-agent that goes on in the background | also `system` `task_started` (`local_bash` / `local_agent`, backgrounded) |
| its report queued for the main session | `system` `task_notification` with the report's state and text |
| its report queued for a sub-agent's session | `system` `task_updated` completed |
| the main session's terminal event (`session.execution.succeeded`, `.failed`, `.interrupted`) | one `result` per message that joined the busy period (success, error, or interrupted after an interrupt); a busy period of its own (woken by a report) gets one |
| `session.retry.scheduled` for a usage limit | an error `result` at once |
| any other retry | `system` `api_retry` |
| `permission.asked`, `form.created` | answered, no event |

Reasoning, deltas, steps, usage, shells, instructions, catalog and heartbeat events are dropped; unknown events and fields are ignored.
Costs are the sum of the steps' `cost` (`session.step.ended`, also of sub-agents).

Limits and errors:

- Errors arrive as `session.execution.failed` with OpenCode 2's error (`{"type","message","status","response":{"body"}}`, for example `provider.auth` with 401 and the gateway's body, or `provider.no-route` "Model unavailable: opencode/<model>"); they become "API Error: <status> <body>" (or the message) and are worded by `opencode::http::failure_text` like a job on `anthropicApi` in Claude Code; anything else is "OpenCode 2 reported an error: <first line>".
- A Go, free or budget limit is not retried by OpenCode 2 (the busy period fails with `provider.go-limit`, `provider.free-limit` or `provider.budget-limit`, status 429 and the gateway's body with the limit's name); should a retry for one be scheduled anyway, the job ends at once with the limit in OpenCode's words instead of waiting ("The weekly limit of your OpenCode Go plan ...").
- A busy period interrupted without VidAI asking (the server shutting down) is an error ("OpenCode 2 stopped the turn (shutdown).").
- A server that cannot start fails the job with "The OpenCode 2 program could not be started: <reason>".
- The log names the program "OpenCode 2" ("OpenCode 2 is running (model vidai/glm-5.3)", "Started a new OpenCode 2 session", "Pausing: asking OpenCode 2 to stop the current step").

Test switch (debug builds only): with `VIDAI_E2E_OPENCODE_LOGIN` (section 7a, The OpenCode 2 program) the servers start without VidAI's key and the user's `ANTHROPIC_API_KEY`, VidAI's own provider gets no key, and OpenCode's own provider of the address is used whatever login it has.
OpenCode 2 has no way to ignore a stored login, so `public` and `own` start the same server: on the program's own login, or without one on OpenCode's public free tier.

What was verified with the real program (OpenCode 2.2.6 on an Apple Silicon Mac, free model `big-pickle` only, with every OpenCode folder in a scratch folder):

- The recordings in `src-tauri/tests/fixtures/opencode2-stream/`: two turns with the write, shell, read and edit tools, an interrupt in the middle of a 20 second command (the command is killed at once and the busy period ends as interrupted), an unknown model, a refused key at VidAI's own provider (401 from the gateway), a session resumed by a new server, a command in the background and a sub-agent with their reports waking the session, a permission request answered `once`, and a question form cancelled with a message (the model went on).
  The Editing Folder's `CLAUDE.md`, named as instructions in the run configuration, was followed; `--stdio`, the JSON address line, the password variable and closing stdin (the server ended within a tenth of a second) behaved as described.
- The real smoke test of the job engine (`tests/opencode2_engine.rs`, `real_opencode2_smoke`, run by hand with `VIDAI_REAL_OPENCODE2` and `VIDAI_E2E_OPENCODE_LOGIN=public`): a trivial edit on the pay-as-you-go address in OpenCode's provider `opencode`, a command in the background, a pause in the middle of a command (the background command was ended too), Continue in the same session through a new server, and completion with a review project.

What could be checked only against OpenCode 2's source (`packages/server`, `packages/core`, `packages/schema`, HEAD of 2.3.0) and the fake, not with the real program:

- A Go, free or budget limit (no such key was used); the shape follows `session/to-session-error.ts`.
- VidAI's own provider with a valid key (only a refused key was sent), and OpenCode's own providers on VidAI's key (only the public free tier was used); which provider a stored login makes OpenCode use was read from `integration.ts`.
- A sub-agent interrupted by a pause (the real run paused with a command in the background, not a sub-agent), and the job list check for lost reports.
- A global form of an MCP server.

Open questions:

- OpenCode 2 with a real Go key or pay-as-you-go balance, a usage limit, and a sub-agent paused in the middle of its work (section 7a, The OpenCode 2 program, what could be checked only against the source).
- OpenCode 2 reads the Editing Folder's `CLAUDE.md` through a path in its configuration, which it treats as a glob pattern, so an Editing Folder whose path has `*`, `?`, `[` or `{` in it may not have its `CLAUDE.md` read.
- OpenCode 2's API is young (the source moved from 2.2.6 to 2.3.0 while this was written); its routes and events are checked against the recordings, and a later 2.x that changes them needs new recordings.
- The real smoke used the public free tier because the OpenCode CLI login found on the development Mac had an expired key; a run with a real Go key (`own` or VidAI's own key) is still to be made.
- Whether a Go key works with OpenCode's `opencode-go` provider for every model the Go address lists (VidAI's own provider covers models the catalog does not list).

Starting the server (`opencode::harness::child`):

- A server may take long to start: the first start on a Mac that never ran OpenCode can migrate a database, unpack itself and let macOS check the new program.
  The limit is 180 seconds (30 seconds were not enough on an Intel Mac, where an OpenCode job failed twice with "OpenCode did not start within 30 seconds").
  While it waits the job's log says "Still waiting for OpenCode to start (8 s)" after 8 seconds and every 15 seconds after that, naming the program ("OpenCode 2").
- OpenCode 2 prints its own address (`{"url":...}` with `--stdio`), so the server needs no port beforehand and no probe.
- A start that fails says why: the last four lines the server printed (standard output other than the listening line, and standard error, both split at line ends and at carriage returns, and the half line a progress display leaves) are put into the error, for example "The OpenCode 2 program could not be started: OpenCode ended before it was ready (Error: cannot open the database)".
  A server that is alive but has said nothing for the whole limit fails with "OpenCode did not become ready within 180 seconds, and it printed nothing. To see what it is waiting for, run \"<path> serve\" in Terminal; if that hangs too, reinstall OpenCode".
  The server is ended whatever the reason.
- The limits (`jobs::Timings::server_start`) are shortened by the tests with the fakes, which start as `FAKE_OPENCODE_START` says (`tests/opencode_startup.rs`: a slow start, a start that never gets ready, an early exit with output, a progress display without line ends, a server that does not print its listening line).

Isolation of the user's own OpenCode configuration (`launch2::isolate_user_config`):

- A job never loads the user's MCP servers, plugins, agents, commands or project configuration of OpenCode: nothing of them belongs in a video edit, and an MCP server that cannot connect delays the first message of every server by about 33 seconds (OpenCode waits for it).
  The user's skills and the `CLAUDE.md` files named in the run configuration are not part of this (they cost nothing at startup and carry instructions).
- OpenCode 2 takes its global config folder from `OPENCODE_CONFIG_DIR` when that is set (checked against 2.2.6: `GET /api/config` then lists only that folder), so it gets an empty private folder (`opencode2-config`) and `OPENCODE_CONFIG_PROJECT_DISABLE=1`.
- Best effort: when the private folder cannot be made, the job runs as before.

### OpenCode quota

What OpenCode's public source shows (github.com/anomalyco/opencode, read in November 2026): the gateway itself is not public any more (`packages/console/app/src/lib/inference-proxy.ts` forwards to a private service), but its client code (`packages/core/src/usage-limits.ts`) and the last public version of the gateway (`packages/console/app/src/routes/zen/go/v1/usage.ts`, `packages/console/core/src/subscription.ts`) show:

- A Go plan reports its three windows at `GET <Go root>/v1/usage` (for the default address `https://opencode.ai/inference/go/v1/usage`) with the key as bearer token: `{"usage":{"rolling"|"weekly"|"monthly":{"status":"ok"|"rate-limited","percent":0..100,"resetsAt":ISO}}}`, a share of each window and when it resets, no dollars.
- Inference answers carry no rate-limit headers (only `retry-after` on a 429), so Claude Code reports nothing about these windows itself; `usage.opencode.allowance` comes on `message_delta` and is not known to survive into Claude Code's stream-json output.

So the meters use that endpoint and nothing else (`opencode::usage`):

- While the setup is an API option whose address is an OpenCode Go address (a Go address is one on `opencode.ai` whose path starts with `/inference/go`: the default of `opencodeGo` and of `openaiApi`, or one entered by hand under any option) the sidebar's usage panel shows "5h", "Week" (and "Month" in the popover) as OpenCode reports them, titled "OpenCode Go usage", "As OpenCode reports it for this API key.", with the reset times, a Refresh and a link to the OpenCode console.
  The key asked with is the selected option's own.
- When there is nothing true to show they say "not available" with the reason and the console link, never a number VidAI made up: an address that is not a Go address (pay-as-you-go, api.anthropic.com, another gateway: no such windows), a key the endpoint refuses (it may need the "Usage: Read" permission), a workspace without Go (403 `EntitlementError`), or no key.
- It is refreshed on the schedule of the Claude limits (section 6): at startup, every 60 seconds while the window is visible, every 5 minutes while it is hidden and a job runs, on demand, and when the setup, the key or the address changes; a failed refresh keeps the last values and sets `error`.
  Only while the setup is an API option; the Claude helper is not asked then, and on `claudeSubscription` the panel shows the Claude limits as before.

What could be checked only against OpenCode's source and docs, not with a real key (the tests use a local stand-in that answers as the source does), and is to be checked once a key is saved in the app:

- Whether `GET /inference/go/v1/usage` answers an `oc_sk_` API key at all (OpenCode's own client calls it with a console login token and an `x-opencode-org-id` header), and with which key permission; the exact shape and units of its answer today, and whether its single set of windows is per model or for the workspace.
- The bodies of a 403 for a model outside the plan or a free model, of a 404 for an unknown model, and of a 401 for a revoked key on `/v1/messages`.
- The 429 of an exhausted Go window as Claude Code reports it in its error result (the `GoUsageLimitError` body with `metadata.limitName`, after Claude Code's own retries).
- That Claude Code with `ANTHROPIC_API_KEY` (sent as `x-api-key`), or with `ANTHROPIC_AUTH_TOKEN=no-key` when no key is saved, never sends a Claude login to the gateway or the API, and that the three alias variables reach its sub-agents and background tasks.
- Whether a gateway behind `anthropicApi` applies `--effort` (it is sent when a level is chosen, the effect is not verified), how its `/v1/models` pages a long list (OpenCode's sends everything with `has_more: false`), and that a real key of `https://api.anthropic.com` works with the list and Test requests of section 7a.
- `openaiApi` with a real key: the list at `<address>/models`, Test at `<address>/chat/completions` and the provider `vidai` of OpenCode 2 with `@ai-sdk/openai-compatible` (only the fake and the source stand behind them).

## 8. Long / Short detection

- The main A-roll is the largest A-roll file in the video folder.
- Its display size is the coded size with the rotation applied (a 3840x2160 file rotated 90 or 270 degrees is vertical).
- Taller than wide means Short, otherwise Long.
- MP4 / MOV family files are parsed directly in Rust (track header size and matrix), with no external tool.
  Other containers fall back to `ffprobe` from the login-shell `PATH` when it exists.
- When nothing can be read the type is unknown: the UI shows it as assumed Long with a hint, and the user can set it.
- Some cameras (for example a Nikon Z 6 turned sideways) write files with no rotation information at all, so the metadata says landscape while the picture is vertical.
  The picture check below catches those; the channel's video type setting and the video's own choice still override any detection.

### Picture check

After the metadata, VidAI looks at the picture of the main A-roll to tell whether it is stored sideways or upside down with no rotation flag.

- Seven frames are sampled, evenly spread between 5 % and 95 % of the duration, with the file's rotation flag applied (the picture as players show it) and scaled to at most 960 pixels.
- Faces are found in each frame, each with its roll angle, confidence and size.
  Only the largest face of a frame counts, and only when its confidence is at least 0.5 and it covers at least 0.2 % of the frame.
- A face's roll votes for the clockwise turn that makes it upright (0, 90, 180 or 270 degrees) when it is within 30 degrees of that quarter turn.
  A roll in between (a moving head) does not vote.
- The picture needs a turn only when at least 3 frames have a face and at least 70 % of them vote for the same non-zero turn.
  Otherwise the picture counts as upright and the metadata result stands.
- A 90 or 270 degree turn swaps the display width and height, so a 3840x2160 file filmed with the camera turned sideways is a Short.
  A 180 degree turn keeps the type.
  Either way the turn is reported as `VideoView.arollRotation`, and the first message of an edit names the file and the turn (section 6, Prompt composition).
- The thresholds were tuned on real footage: sideways Nikon A-rolls, flagged Sony and phone A-rolls, and b-roll of the same shoots (see `src-tauri/src/orientation.rs`).
- On macOS the frames are read with AVFoundation and the faces found with Apple Vision by `vidai-orient`, a small command line helper built from `src-tauri/helpers/orient` and bundled inside the app next to the app binary.
  It prints only the face measurements (no image data), never uses the network, and ends itself after 20 seconds; VidAI kills it after 30.
- On Windows the frames are read with `Windows.Media.Editing` (the nearest key frame, as players show it) and the faces found with `Windows.Media.FaceAnalysis`, both part of Windows, so nothing is installed or downloaded.
  The app binary itself is the helper, started again as a separate process (section 11), with the same output and the same decision.
  It also prints only the face measurements and never uses the network; it ends itself after 30 seconds and VidAI kills it after 45.
  The Windows face detector is made for upright faces and reports neither a roll angle nor a confidence.
  So each frame is searched turned each way (0, 90, 180 and 270 degrees clockwise), and the turn that shows a face gives that frame's faces, with that turn as their roll and a confidence of 1.
  The detector sometimes also accepts a face a quarter turn off, so when several turns show a face, each of them is searched again tilted 20 degrees either way and the turn found most often wins; a tie leaves the frame without a face.
- On other platforms the picture check is not available and the metadata result stands.
- The check takes about a quarter of a second per file on macOS, and a few seconds on Windows (about 3 seconds for a 720p clip and under 9 for a 4K clip on the CI runner, five checks at once).
  During library scans it runs in the background, at most two at a time, so a scan never waits for it: a new video shows the metadata result first and the final type a moment later.
  When a job starts, a check that has not run yet runs first, so the job starts with the final type.

### Cache

Results are cached per video by the main A-roll's path, size and modification time, together with the detector version.
An entry written by an older detector (before the picture check existed) is detected again once.

- When the picture check ran, its turn is cached, including "no turn" when it found no clear faces.
- When the platform cannot decode the picture, "no turn" is cached for that file version.
- When the helper is missing, or the check failed for a reason that may pass (time limit, crash), nothing is cached for the picture: the metadata result is used, the check is not retried during this session, and it runs again after the next start of VidAI.
- A video whose format needs a decoder the platform does not ship counts as such a failure, because installing the decoder makes it pass.
  On Windows these are HEVC (common for phones and Sony cameras; the "HEVC Video Extensions" from the Microsoft Store), AV1 and VP9, and any format Media Foundation reports as having no decoder.

### Effective type

A video's effective type (`VideoView.videoType`, and the type a new job starts with) is resolved in this order, with `typeSource` saying which step decided:

1. `override`: the video's own `typeOverride`, chosen on the video row.
2. `channel`: the channel's `videoType` when it is `long` or `short`.
3. `detected`: the type detected from the A-roll.
4. `assumed`: Long, when nothing could be read.

`detectedType` always reports the detection, whatever decides the effective type.
A job keeps the type it started with, so changing the override or the channel setting never changes a job that exists.

## 9. User interface

Look and feel: a calm, dense, professional Mac utility.
System font, light and dark mode following the system unless the user chooses one (Appearance below), one accent colour, generous hit targets, no decoration for its own sake.
Every state has a designed appearance: loading, empty, error, disabled, long names (video folder names are long, and can be Hindi in Devanagari), narrow window.
Every action gives feedback within 100 ms.
A toast is feedback about something that just happened on the current screen: it closes when the user leaves that screen (or Settings section), and its wording never refers to positions such as "below".
Toasts stack at the bottom right, up to 460 pt wide (less in a narrow window), so a title such as "New edits run with OpenCode 2 on OpenAI Compatible API" stays on one line; they close by themselves after 4 seconds (8 for an error).
Keyboard: Cmd+, opens Settings, Esc closes dialogs, Cmd+S saves in editors, Cmd+F focuses search, Cmd+Return submits a job sheet.
On Windows every shortcut uses Ctrl instead of Cmd, and every key hint says so (section 11, User interface on Windows).

### Window, menu and quitting (macOS)

- Closing the main window (red button, Cmd+W) only hides it.
  VidAI keeps running in the Dock and running edits continue; a click on the Dock icon shows the window again.
- The app menu is minimal: VidAI (About, Services, Hide, Hide Others, Show All, Quit), Edit (Undo, Redo, Cut, Copy, Paste, Select All, so text fields work), View (Make Text Bigger, Make Text Smaller, Default Text Size, see Appearance) and Window (Minimize, Zoom, Close Window, Bring All to Front).
  No menu item uses Cmd+, Cmd+F or Cmd+S, so these keys reach the web UI.
- Quit (the menu item and Cmd+Q) is VidAI's own menu item, not AppKit's `terminate:`, which would end the app without asking.
  With `queued`, `running`, `pausing` or `stopping` jobs it shows the window (it may be hidden) and emits `quit-requested`; the UI confirms and calls `confirm_quit`.
  Without such jobs the app quits at once.
- Quitting through AppKit itself (Quit in the Dock menu, logging out, shutting down) cannot wait for a confirmation: running jobs are paused without asking, waiting at most 10 seconds, and the crash watchdog ends whatever is left.
- The traffic-light buttons sit 18 pt from the left edge, vertically centred on the top bar at every text size (Appearance).
- One VidAI per data directory, on every platform: the first copy locks `<data dir>/instance.lock` (an OS file lock, released however the process ends) and listens on a loopback port it writes to `<data dir>/instance.json` with a random token and its process id.
  A later launch on the same data directory (`open -n` on macOS, a second click on Windows) finds the lock taken, asks the running copy to show and focus its window, and exits before it shows a window or touches any state; it waits up to 5 seconds for the answer and exits either way.
  Windows lets a process take the foreground only when it owns it or was started by the process that does (Explorer, for a click in the Start menu), so before asking, the later launch hands that right to the running copy (`AllowSetForegroundWindow` with the process id, `platform::allow_to_take_foreground`); its window then comes to the front also when it is open behind other windows, and a minimized window comes back when it is restored.
  The lock is keyed by the data directory, not the bundle id, so copies with their own `VIDAI_DATA_DIR` (development, the end-to-end tests next to an installed VidAI) never block each other (`src-tauri/src/instance.rs`).

### Main window

- Sidebar: "All Channels" and one entry per channel, each with three counts after its name, `[N/E/D]`, and a small live indicator when something in it is running.
  N (not edited) is the listed videos with no output yet and no active job, E (editing) the videos with an active job of any kind (queued, running, pausing, paused, stopping), D (edited) the videos that are edited or final rendered with no active job.
  Archived videos are not listed and not counted.
  The three counts add up to the videos of the channel (the same buckets as the filter: To edit, In progress, Edited), so a video with a failed job counts by what it has on disk, as N without output and as D with a review project or a final render; the filter's Edited is exactly D.
  All Channels shows the sums over every channel; a channel whose folder is missing shows no counts.
  A channel with at least one failed job (needs attention) gets a light red background (`danger-soft`), also All Channels when any channel has one; the selected row keeps its selection background and shows a red outline instead, and hover and press darken the red.
  Hover shows, and the accessible name says, the counts in words with the zeros left out, for example "2 not edited, 4 editing, 1 edited, needs attention".
  At the bottom, from the top: the status of what the setup needs (Claude Code or the OpenCode 2 program; ready / needs attention), the No Sleep checkbox (below), the usage limits panel (below), and the entries Archive, Edit Log and Settings (with its shortcut), each a row with an icon like the channel entries.
  Archive and Edit Log open their page in the content area of the main window (below); the open one is marked as selected and clicking it again returns to the videos.
  While edits run with the OpenCode 2 program (`opencodeGo` and `openaiApi`) the status is that program's: "OpenCode 2 ready", "Checking OpenCode 2" or "OpenCode 2 needs attention" ("The OpenCode 2 program is not installed." or the version problem), with "Edits run with the OpenCode 2 program" in its tooltip.
  A problem of the setup itself (the key of OpenCode Go or the model of an API option it lacks, section 6, Readiness of a launch) is shown as needs attention with its reason.
  The No Sleep checkbox is one compact row above the usage limits panel, in the same type size as the status row and with its box in the column of the status dot.
  Its label is "No Sleep", and clicking the label or pressing Space on the focused box toggles it.
  A hint on hover and focus says: "Keeps this computer from sleeping until every edit has finished, failed or been stopped. The display can still turn off."
  The choice is saved at once (`set_no_sleep`, `Settings.noSleep`), the box shows it before the answer comes, and it goes back with an error toast ("Could not change No Sleep") when saving fails.
  What the box does is in section 11, Sleep prevention.
- Top bar (always visible, above the list): on the left the search, the filter (All, To edit, In progress, Edited), the sort (a small menu of three items: Name, Age, Status) and a summary such as "2 editing, 1 queued".
  On the right: the Model picker and the Effort picker.
- Model picker: "Default (<name>)" first, then the models from `ClaudeInfo` with their description, a Refresh item, and a loading / error state.
  Effort picker: "Default" plus the selected model's effort levels; hidden or disabled when the model has none.
  Both apply to edits started from now on, and say so in a hint.
- While edits run on an API option (section 7a) the Model and Effort pickers are replaced by one quiet element naming the service and the model ("OpenCode Go · GLM-5.3", "Anthropic API · <model>", "OpenAI API · <model>", the model alone in a narrow bar), whose click opens Settings, Harness + API Keys, and the usage meters show the OpenCode Go quota when the address is a Go address (section 7a, OpenCode quota).
  Its tooltip and accessible name say the setup: "New edits run with OpenCode 2 on OpenCode Go with GLM-5.3. Change it in Settings, Harness + API Keys."
- Usage limits panel, at the bottom of the sidebar above Archive: one compact row per limit stacked vertically ("5h", a thin bar, "20%"; "Week", "Opus" or "Month" in the same way), the label at the left, the bar filling the middle and the whole percentage at the right, normal below 70%, warning from 70%, critical from 90%.
  The panel is one button with the sidebar's row padding and hover, and its popover opens to the right of the sidebar.
  Hover or click shows the full label, the exact percentage, when it resets (local time and "in 3h 12m"), when it was last refreshed, and a Refresh button.
  When limits are not available for the plan the panel is replaced by nothing, not by an error, and leaves no gap.
  Usage is not kept across launches, so until Claude Code first answers after VidAI starts (a few seconds, longer on Windows) two quiet placeholder rows of the same size ("5h –", "Week –" with an empty track) hold the meters' place; a first answer that fails or reports no limits removes them.
- Archive and Edit Log are pages of the main window, not of Settings: the entries sit at the bottom of the sidebar, a click replaces the video list and the activity panel with the page (the sidebar stays), the top bar shows the title and Done, and Done, Esc and picking a channel return to the video list.
  Cmd+, still opens Settings from them.
- Archive (sidebar entry above Settings): a page in the content area with every archived video, newest first, each with its path, when it was archived, and Unarchive.
  A toast confirms archiving ("Archived <video>. Find it in Archive.") and unarchiving; entries whose folders no longer exist are removed from the list by themselves.
- Edit Log (sidebar entry below Archive): a page in the content area with what happened to each video, newest first, each as the video folder name, the message (which names the event: started, finished, needs attention, stopped, paused, continued, archived, unarchived) and the time.
- Video list: one flat list.
  With "All Channels" selected it holds the videos of every channel together, sorted as a whole, with no channel headers; each row shows "Channel Name / Video Folder Name", the channel part quieter, and both parts are cut off cleanly when space is short.
  With one channel selected a row shows the folder name only.
  Search and filter work across the whole list; the empty states are the same as before, and a channel whose folder is missing shows its notice when that channel is selected.
  The sort menu has exactly three items.
  Name sorts A-Z (natural sort of the video folder name) and Z-A when picked again.
  Age sorts newest first (by `VideoView.createdAt`, ties in descending natural name order) and oldest first when picked again.
  Status sorts by `statusRank` in `src/lib/status.ts`, from each video's job and outputs: Needs attention (failed job), Not edited, Editing (any other active job: queued, running, pausing, paused, stopping, for an edit or a re-edit), Edited, Rendering (a running render job), Final rendered; picked again it lists exactly the reverse order, and videos of the same status are newest first in both.
  Picking another item starts it in its first direction (Name A-Z, Age newest first, Status in the order above, needs attention first); the active item shows a small arrow (up is ascending), and so does the menu button.
  The default is Age, newest first.
  Each row shows: video folder name (with its channel, see above), the type badge, a status pill, the job's stage and percent ("Building graphics - 46%"), the last activity line and a running clock while editing, and the action buttons from `actions`.
  When space is short the last activity line is cut off first, then the stage; the percent always stays.
  The stage is only ever a step the evidence supports (section 6, Progress): while the bar is ahead of what is confirmed it reads "Working on the edit", and while tools are installed "Getting the tools ready"; the last activity line (for example "Asked to keep going (2)" or "Asked to wait for the running commands (3)") says what VidAI asked of the model and never names a step, so the two lines do not contradict each other.
  A failed row shows its error instead of the stage and percent.
- Activity panel tabs: the tab the user last chose (Log or Outputs) is remembered, and every video opened next shows it until the user picks the other one.
  Before the first choice a video opens on Outputs when it is edited and has no active or failed job, otherwise on the Log.
  The choice is local UI state, not saved across launches.
- Progress bar: a 2 px bar along the bottom edge of the row, full row width, that takes the place of the row separator while it is shown and never changes the row height.
  It fills from left to right and glides to each new value (instantly with reduced motion).
  Running jobs fill in the accent colour; queued jobs without progress show only a faint track; pausing, paused, stopping and stopped jobs freeze in a muted grey; failed jobs freeze in the danger colour.
  A completed job fills to 100% in the success colour, stays for 2.5 seconds, fades out and leaves a clean row.
  A stopped bar shows only while the pill says Stopped, and finished jobs without any reported progress (older jobs) show no bar.
  Rows without an active or recent job show no bar and no track.
  The bar is a `progressbar` (0 to 100, the whole percent, "46%, paused" while frozen) named "Progress of <video>, <stage>".
- Start delay on a row: a queued job with `startsAt` in the future shows a countdown that ticks every second, and falls back to "Waiting for a free slot" once the time has passed or when it has no `startsAt`.
  While the backend offers `startNow` (a slot is free, so only the delay holds the job) it says "Starts in 6 min" (under a minute "Starts in 40 s").
  Otherwise the job also waits for a free slot and may start later than `startsAt`, so it says "Earliest start in 6 min" (under a minute "Earliest start in 40 s").
  The UI tells the two apart only by whether `startNow` is in `actions`, never by counting slots itself.
  Like the last activity line, the countdown takes the room that is left on the row and is the first to be cut off.
  When the backend offers `startNow`, a quiet "Start now" button (ghost, icon only in a narrow list) comes first among the action buttons.
  A refused Start now shows a toast with the reason, and the job stays queued.
- Type badge: `Long 16:9` or `Short 9:16`, with a mark for where the type comes from: a pin for the user's own choice, a TV for the channel setting, a question mark for an assumed Long, and no mark when it is detected.
  Its tooltip says it in words, for example "Set by the channel: Always Short. Detected as Long 16:9.".
  Its menu offers Auto / Long / Short; the Auto item says what Auto resolves to ("Channel setting: Short 9:16", "Detected: Long 16:9" or "Not detected, assumed Long 16:9").
- Status pill wording: Not edited, Queued, Editing, Pausing, Paused, Stopping, Stopped, Needs attention (failed), Edited, Re-editing, Rendering, Final rendered.
- Button wording: Start Editing, Pause Editing, Continue Editing, Stop Editing, Re-Edit, Render Final 4K, Start now, Archive.
- Row menu: Open review project (newest), Show in Finder (Show in File Explorer on Windows), Open output folder, View activity.
- Start Editing opens a small sheet: the video, channel, type with where it comes from ("detected", "set by you", "set by the channel" or "assumed, no readable A-roll") and review software as read-only facts, product links (one per line, optional), notes (optional), both pre-filled with what was used last time.
  Under the facts are two dropdowns for the video's type: "Prompt" lists the channel's prompts of that type that are not empty, and "Style" lists the Default style and the other styles that are not empty.
  When the Default style is empty it reads "Default (empty - the agent designs one)".
  They are preselected with the slots stored for the video (`promptSlot`, `styleSlot`) while those are still offered, else with the Default style and the first offered prompt, and both are disabled while the last inputs load.
  The selection is sent as `promptSlot` and `styleSlot`.
  When no prompt of the type is filled in, the sheet shows the "prompt is empty" warning with Open Settings instead of the dropdowns, and Start Editing is disabled.
- Re-Edit opens a sheet with one required text area: what should change.
- Render Final 4K opens a sheet: optional "Use my exported timeline" file picker, optional notes.
- Stop Editing asks for confirmation and says the working files are kept.
- Activity panel (opens for the selected video): the channel and type with where it comes from, status, elapsed active time (once the job has run), the live log (auto-scroll that stops when the user scrolls up), and the outputs: review projects with an Open button, thumbnails as images, meta.txt and info.txt links.
  Its action buttons sit in one row with labels, except Archive, which is an icon button with a tooltip at the end of the row.
  Under the status the header shows the progress larger: the stage at the left, the percent at the right and a 6 px bar across the header, in the same colours as the row.
  For a queued job the stage is replaced by the start delay countdown, with the same wording as the row ("Starts in 6 min" while `startNow` is offered, "Earliest start in 6 min" otherwise), or "Waiting for a free slot", and Start now sits with the other actions.
  A completed bar folds away after the same moment as in the row, without making the content below jump.
  The session is shown quietly as the first 8 characters of `sessionId`, with a tooltip ("This video has its own Claude session." and the full id) and a copy button; a job without a session yet shows no session line.
  Above it, the line "Claude" names the model and effort of the job; for a job on an API option it is the short name of the service ("OpenCode Go", "Anthropic API" or "OpenAI API") with its model, followed by a "Program" line ("Claude Code" or "OpenCode 2 program"), and the session tooltip says which setup the session is on ("This video has its own Claude Code session, on Anthropic Compatible API." or "This video has its own OpenCode 2 session, on OpenCode Go.").

### Settings

- General: Editing Folder (choose, show path, show in Finder), review software, maximum simultaneous edits, delay between edit starts.
  Each of them saves on its own, without a Save button; a failed save shows a toast and puts back the saved value.
  "Delay between edit starts" is a minutes field (0 to 120, default 10) with the help "While an edit runs, the next one waits this long after the last start, so edits do not all load the processor and graphics card at once. The first edit always starts right away, and 0 turns the delay off."
  It saves on Return or when it loses focus, Up and Down step by one, and Esc puts back the saved value.
  Anything that is not a whole number from 0 to 120 is not saved and the field says "Enter a whole number of minutes from 0 to 120."
- Appearance: the theme and the text size (Appearance below).
- Channels: the channel list (reorder, add, new, remove) and "Found in Editing Folder" with one-click Add for each discovered folder.
  A channel editor with the name (renames the folder), the video type (Auto-detect, Always Long, Always Short, with one quiet line: "Use this when the camera records sideways and VidAI detects the wrong format."), and Long 16:9 / Short 9:16 tabs, each with a Prompt editor and a Style editor.
  Each editor has five slots: a compact slot picker lists them by name (with "(empty)" and "(edited)" marks), and the chosen slot shows its name field and its text.
  Slot 1 is named "Default" and its name cannot be edited; the other four have editable names (trimmed, 1 to 40 characters), and a wrong name shows an inline error and disables Save, the same rule the backend enforces.
  The name, the video type, and all ten prompts and ten styles of both tabs are saved together by Save, and a change in any slot counts as unsaved.
  Editors are large, monospace, show character counts, and have explicit Save and Revert with a clear unsaved-changes state and a guard when leaving.
  Prompt tools: Reset to default, Copy from the other type, Copy from another channel; they replace the text of the prompt slot shown, and the copies take the slot with the same position.
  Remove says clearly that the folder and its videos stay on disk.
- Toolkit: the two toolkits with their folder and whether they exist, a choice of which one is active, Create my own toolkit, Show in Finder.
- Harness + API Keys (nav label and heading; the one place for how edits run): a callout with Try Again above everything when the saved keys could not be read (`retry_secrets`).
  Then "How should VidAI run edits?": the four options of section 7a as radio cards, each with its label and one line:
  - Claude Code with Claude Subscription: "Uses your own Claude login. The model and effort are chosen in the top bar."
  - OpenCode 2 with OpenCode Go Subscription: "Uses your OpenCode Go subscription and its API key."
  - Claude Code with Anthropic Compatible API: "Uses any Anthropic Compatible API, with a key only if it needs one, without a Claude login."
  - OpenCode 2 with OpenAI Compatible API: "Uses any OpenAI Compatible API, with a key only if it needs one."
  The two API names are written the same way ("Anthropic Compatible API", "OpenAI Compatible API") in titles and in sentences.
  The radio of a card is drawn by the app (`radio` in `styles.css`), so it looks the same in light and dark mode: a ring, and when chosen a filled accent circle with a white dot; a card that cannot be chosen keeps a visible ring on a grey fill.
  Choosing a card is one change of the backend (`set_setup`), saved at once; a toast confirms it ("New edits run with OpenCode 2 on OpenCode Go"), and a refused one puts the saved choice back.
  Under the cards, inset like the heading above them: "An edit underway and the follow-ups of an earlier edit stay on the setup their session started on."
  An API card cannot be selected until its option can run an edit, and says why on the card: "Save an API key first." (OpenCode Go without its key), "Choose a model first." (OpenCode Go with a key but no model), "Type a model first." (options 3 and 4 without a model; their key is optional and never the reason), or "The saved keys could not be read. Try Again above." (the Keychain read failed).
  The program is not part of that: a missing program never disables a card (the program row below and the onboarding handle it).
  Every API card has a Configure toggle that opens its settings whether or not it is selected, and the selected API option starts open.
  The settings of an API option, in this order: "API URL" (pre-filled with the default address, saved on Return or when the field loses focus; Reset to Default is a button beside the field, so the help text above it has the full width); "API Key" (a password-style field with Save and, when a key is saved, Remove beside it, the saved state shown as the key hint under the label; both buttons have the same size); on options 3 and 4 the label is "API Key (optional)", with "No key saved. Leave it empty if your server needs no key." as the hint while none is saved, and the placeholder "Paste an API key if your server needs one"; Remove asks "Remove the API key?" and, on option 2, says that edits on it go back to Claude Code with Claude Subscription, and on options 3 and 4 that edits then run without a key, which works only if the server needs none (the option stays selected); the models (the searchable list with its loading, failed and no-match states, the model count and Refresh; it is fetched when the section opens and when the address or key changes; on options 3 and 4 Fetch Models is available as soon as the URL is set, with no key needed); "Reasoning effort" (the Select of section 7a, with a hint saying what it can do in the option's program); and Test (it says that it sends one tiny request; on options 3 and 4 it too needs only the URL and a model, and goes without a key when none is saved).
  Under option 1, a note when the user's own setup points Claude Code elsewhere (`get_claude_routing`, section 7a).
  Under the cards, the row of the program of the selected option: Claude Code (installed, version, and for option 1 logged in; on Windows the Git for Windows row) or OpenCode 2 (Installed / Not installed / Not supported with "Version 2.2.6 · <path>" and Check Again); when it is missing a warning shows the install command with an Install button that opens a terminal (`open_claude_install`, `open_opencode2_install`), and when the OpenCode 2 version is not supported the reason.
  The OpenCode 2 install command on a Mac is `curl -fsSL https://opencode.ai/v2/install | bash`; on Windows it is `winget install --id Anomaly.OpenCode --exact` (WinGet; OpenCode's own installer is bash-only, kept in `locate2.rs`).
  A change shows a toast; the same lines are kept in `VidAI-edit-log.txt` inside the Editing Folder.
- System: Claude Code (installed, version, logged in), the helper tools check, Check Again, Log in, and one quiet line about the computer under the helper tools ("This computer: Windows 11 24H2, Intel Core i7-12700, 32 GB, NVIDIA GeForce RTX 3060", `SystemStatus.machine`).
  On a Mac and on Windows also the group "OpenCode 2" ('VidAI starts the OpenCode 2 program on this computer for edits that run with it (options 2 and 4 in Harness + API Keys).': installed, version, location, Check Again, the installer warning when it is missing).
  While the setup's program is OpenCode 2 the Claude Code group says "Edits run with OpenCode 2 now, so Claude Code is not needed for them.", and on `anthropicApi` it says "Edits run with Claude Code on your API, so no Claude login is needed."
- Import / Export settings.

### Appearance

The theme and the text size are preferences of the person at that Mac (`Settings.theme`, `Settings.textSize`).
They are the one source of truth: the Rust core (`src-tauri/src/appearance.rs`) applies them to the window when it is created and whenever they change, and the UI only follows.

Settings, Appearance:

- Theme: a segmented control System, Light, Dark.
  System follows the macOS appearance, also when it changes while VidAI is open.
- Text size: a stepper with a small "A" (Make Text Smaller), the current size ("15 pt") and a large "A" (Make Text Bigger), one point per step from 11 to 20; each button is disabled at its limit.
  Away from the default (15) a "Reset to Default" button appears.
- Both apply within a frame and are saved at once, without a Save button.
  When saving fails, the previous value comes back and a toast says why.
- Keyboard, on every screen: Cmd+= or Cmd++ bigger, Cmd+- smaller, Cmd+0 the default size.
  The View menu has the same three items (shown as Cmd+=, Cmd+- and Cmd+0), disabled when they would not change anything.
  A menu item has only one shortcut, so `src-tauri/src/platform/appkit.rs` turns Cmd++ (Cmd+Shift+= on a US keyboard) into Make Text Bigger itself, wherever the focus is; one press is always exactly one step.
  A change from the menu is made by the Rust core, which then sends `settings-changed`.

Theme:

- Rust sets the app-wide native appearance (`AppHandle::set_theme`; System sets none and follows macOS).
  The title bar, menus, native dialogs and the web content's `prefers-color-scheme` follow it.
- The UI also sets `data-theme="light" | "dark"` on `<html>` from the same setting (none for System), which forces the colour tokens of `src/styles.css`; in the browser mock this is what applies the theme.
- The window background behind the page gets the theme's window colour (and follows a change of the macOS appearance), so nothing of the wrong theme shows before the page has painted.
- The main window is created hidden (`visible: false`) and shown by `appearance::setup` after the theme and the zoom are set, so there is no flash or jump at launch.

Text size:

- The UI is designed at 13 px with fixed px sizes, fixed row heights and a virtualized list.
  Instead of rewriting sizes, the webview's native page zoom scales the whole UI by `textSize / 13` (1.154 at the default 15).
  The page then sees a viewport of `window size / zoom` CSS px, so layout, hit testing, popover and tooltip placement, the activity panel resizer and the virtualized list's measurements stay consistent; saved panel widths are CSS px and keep their proportion of the UI.
- What the zoom does not scale is moved by Rust:
  - The traffic lights: Tauri 2.12 can place them only when the window is built, so `src-tauri/src/platform/appkit.rs` (AppKit calls, see section 10 for `unsafe`) makes the title bar container as tall as the top bar (`52 × zoom` pt), centres the three buttons in it 18 pt from the left, and does it again after every resize and after leaving full screen, when AppKit puts them back.
    `tauri.conf.json` therefore has no `trafficLightPosition`.
  - The minimum window size: 980 × 620 CSS px at every zoom, that is `980 × zoom` by `620 × zoom` pt, but never larger than the usable area of the window's screen less the window's frame (on Windows the title bar and borders, so the whole window fits; on macOS the title bar lies over the content and there is no frame); a smaller window grows when the size goes up.
    On a small screen at a large size the layout therefore gets narrower than 980 × 620 CSS px (down to about 830 × 500 on a 1280 × 800 screen at 20); the sidebar narrows to 212 px below 900 px, and long editors scroll.
- Two things in WebKit go wrong under page zoom and are avoided:
  - CSS container queries compare the zoomed width of a container (a 744 px top bar at text size 20 counts as 1145 px), so the top bar measures its own content width with a ResizeObserver and lists the breakpoints it is below in `data-topbar`; its content adapts with the `topbar-max-<N>:` variants of `src/styles.css` (`src/app/topBar.ts`).
  - The layout is fractional, and a scroll area's height and scroll height are rounded separately, so content that fits can look one pixel too tall; `ScrollArea` shows a scrollbar only for content that overflows by more than one pixel.
  - WebKit lays out the placeholder of a textarea with the zoom applied twice, so an empty text box above the default size would scroll sideways; `src/styles.css` limits the placeholder to the box's width.
- In the browser (tests, `npm run screenshots`) nothing is zoomed by the page; `scripts/screenshots.mjs` renders the zoom the app would use with a viewport of `points / zoom` CSS px and a device pixel ratio of `2 × zoom`.
  `npm run screenshots -- --platform=windows` renders the Windows interface the same way in Chromium (WebView2 is Chromium) into `artifacts/screenshots-windows/`, with a stand-in for the native title bar drawn by the script only (section 11).

### Onboarding

Shown on first run and whenever something blocking is wrong:

1. How should VidAI run edits?
   The four options of section 7a as radio cards with the same labels and one-line descriptions as Settings, Harness + API Keys, and Continue.
   The screen opens on this choice on a new install (no Editing Folder yet) whose stored setup is still `claudeSubscription`; otherwise the setup was already chosen, so it opens on the card that the readiness problem names (section 6, Readiness of a launch).
   Every card below has Back, which returns to the choice with the current option checked.
   The first step of the progress indicator is labelled "Setup".
   Only two things change the setup: Continue on the choice with option 1 (`set_setup` with `claudeSubscription`), and Continue on the card of an API option.
   Neither shows a setup-changed toast (the Settings toast does not apply here): the next card is the confirmation, and a toast would sit on top of it.
2. The cards of the chosen option.
   Option 1: the Claude Code install card when it is missing (on Windows "Install Git for Windows" comes first when that is missing: why Claude Code needs Git Bash, a Download Git button, Check Again, and an automatic re-check every few seconds), then the login card when Claude Code is logged out (Log in button, automatic re-check).
   Options 2, 3 and 4: one card with the API URL (pre-filled with the option's default address, Reset to Default), the API key ("API Key (optional)" on options 3 and 4, same as in Settings), the model and Continue (option 2 chooses from its list; options 3 and 4 have the text box and Fetch Models of section 7a, The model).
   Each field saves on its own as it is entered, as in Settings (the URL on Return or when leaving the field, the key with Save, the model when chosen).
   Continue makes exactly one `set_setup`; it is disabled until a model is chosen (option 2 also until its key is saved) and says why ("Save an API key first." on option 2, "Choose a model first." on option 2 and "Type a model first." on options 3 and 4), so an empty key never blocks Continue on options 3 and 4, and when the keys could not be read it offers Try Again.
   Then the program cards that the readiness problem names: for options 2 and 4 "Install OpenCode 2" (or "Install a supported OpenCode 2") when the program is missing or not supported; for option 3 the Git for Windows card on Windows and "Install Claude Code" when it is missing, never a login.
   No program is ever needed but the setup's: with option 2 or 4 nothing of Claude Code is installed, logged in or asked for; with option 1 nothing of OpenCode or an API key is asked.
   Which card shows when is the table "Readiness of a launch" in section 6, the same function that refuses a launch, so what the screens ask and what a launch refuses never differ.
3. Installing a program (Claude Code or OpenCode 2), on a Mac and on Windows.
   The card shows the install command with Copy and "Open Terminal to Install" ("Open PowerShell to Install" on Windows: a window the person asked for, not a console flash, section 11), then checks again by itself every few seconds.
   The text says what the button does ("Open Terminal to Install opens Terminal with the command typed in; press Return to run it", Enter on Windows).
   The status at the bottom left of a card ("Checking every few seconds", "Waiting for the install") never truncates: when it does not fit next to the buttons it takes its own line above them.
   When that route fails, the card says so plainly and asks the person to install the program themselves: the Terminal window could not be opened (`open_claude_install` or `open_opencode2_install` rejected), or the program is still not found 3 minutes after the window opened.
   It then shows the command to run in a terminal of the person's own and a link to the program's official install page, with Check Again; VidAI finds the program and checks its version (`check_system`) and goes on only when it finds a usable one.
   The failure reads "VidAI could not open Terminal to install <Program>." (PowerShell on Windows) with the error under it, or "<Program> is still not found, 3 minutes after the Terminal window opened."
   The card then offers Open Terminal to Install again, Check Again, and a button that opens the official install page (https://code.claude.com/docs/en/setup for Claude Code, https://opencode.ai/docs for OpenCode 2); the automatic re-check keeps running after the time limit.
4. Choose the Editing Folder (then the toolkit is seeded and the result is shown).
5. Add channels from the folders found.

On a system VidAI does not run on (section 1) the app says so, names the systems it runs on (Macs with Apple Silicon or an Intel processor, Windows 10 and 11 PCs with an x64 processor), and offers nothing else.

## 10. Quality bar

- TypeScript strict, ESLint and Prettier clean, `cargo fmt` and `cargo clippy -- -D warnings` clean.
- `unsafe` Rust is denied for the whole crate (`unsafe_code = "deny"` in `Cargo.toml`).
  The only exceptions are the functions of `src-tauri/src/platform/appkit.rs` that call AppKit, each with its own `#[allow(unsafe_code)]` and a `SAFETY` comment on every `unsafe` block.
- Unit tests for: action rules, scanner rules (with temp folders), output detection, type detection (fixture files), prompt composition (exact text), store (atomic write, corrupt file), protocol parsing (recorded lines), toolkit seeding (never overwrites, symlinks).
- An integration test drives the job manager end to end against a fake `claude` (start, background task then completion, pause, continue, stop, failure, resume-not-found fallback).
- The readiness decision (section 6, Readiness of a launch) is tested on both sides over every combination of its inputs, and with the table `src-tauri/tests/fixtures/readiness-table.json` that Rust and TypeScript both run; the start of the OpenCode servers by `tests/opencode_startup.rs`.
- Another drives it with the OpenCode 2 program (`tests/opencode2_engine.rs`) against a fake OpenCode 2 (`tests/support/fake-opencode2.py`, speaking the interface of section 7a, The OpenCode 2 program, with the event shapes of its recordings): start, keeping a job going, pause and continue in the same session, stop with the whole process tree, re-edit and render final, the session guard, a slot limit, restart recovery, the fallbacks when a session or the program is gone, a refused key, a Go limit, the keys never in the log, a crash, OpenCode's own provider used only on VidAI's key and a resumed session moved to another model, a sub-agent that works in the background while the job waits for it, a pause that also ends the background command and interrupts the sub-agent, a usage limit with and without a retry, and a question form.
  The `openaiApi` option runs through the same fake: the run configuration names the provider `vidai` with `@ai-sdk/openai-compatible` and `VIDAI_API_KEY`, never an OpenCode provider.
  It runs on Windows too, except three tests that stay Unix-only (section 11, OpenCode 2 and the newer features on Windows).
  It also has a smoke test with the real program, never part of a normal run (`real_opencode2_smoke`, ignored; `VIDAI_REAL_OPENCODE2=<path> VIDAI_E2E_OPENCODE_LOGIN=public cargo test --test opencode2_engine real -- --ignored`), on the public free tier with every OpenCode folder inside the test's temporary folder.
  All use the same engine under test and helpers (`tests/support/engine.rs`).
  The OpenCode 2 program's parts are also unit-tested: the event translation on the recordings (`tests/fixtures/opencode2-stream/`, and the engine's own turn tracking over a recording with background work), the command line, environment and run configuration as exact text, and finding the program and its version.
- UI tests run against the mock backend.
- One command runs everything: `npm run check`.
- End-to-end tests drive the real debug app, with its real Rust backend and real window, against the fake `claude`: `npm run e2e`, on macOS and on Windows (not part of `npm run check`, it needs a window on screen).
  - The debug build contains a hook (`src-tauri/src/e2e.rs`, compiled only with debug assertions) that is inactive unless `VIDAI_E2E_SCRIPT` is set.
    It then evaluates that script in the main webview once the page has loaded, appends every `vidai-e2e` event of the page to `VIDAI_E2E_REPORT`, hands lines from the app's stdin to the page (`!quit` quits like Cmd+Q, `!close` closes the window like its close button, `!menu <id>` runs an app menu item's code, also on Windows, which has no menu), answers the page's native requests itself (`host.native`: the window frame, content size, minimum size, full screen and zoom state, the theme the window is drawn in, resizing, maximizing, full screen), answers file dialogs with paths the page queued (a dialog without a queued answer fails instead of opening), and writes notifications to the report instead of showing them.
    On macOS it also runs the app as an accessory app (no Dock icon, no menu bar) whose window joins every Space, also the Space of another app in full screen (so the window is drawn, its page runs animation frames and screenshots work while the person keeps using the Mac), does not take keyboard focus at launch, keeps its page running as a visible page while other windows cover it (WebKit would otherwise count a covered page as hidden and stop its animations, so menus and dialogs would never finish closing; `platform::appkit::keep_page_visible_when_covered`), and answers the AppKit requests: the traffic-light frames, what a click at a point would reach, and Cmd key presses posted through AppKit like real ones.
    On Windows the minimum size it reports is the one VidAI gave the window, because Windows applies it only to a person's resize and not to a programmatic one; scenario 16 checks that a real drag of the window's corner stops there.
  - `scripts/e2e.mjs` builds the debug app when its sources changed (with its own bundle id, `com.vidai.desktop.e2e`, so the system never mixes it up with an installed VidAI that is running), gives every scenario its own app data folder, Editing Folder (with tiny generated landscape, portrait and rotated videos: made with ffmpeg when it is installed, else header-only MP4 files that carry the size and rotation VidAI reads) and fake Claude state folder in one work folder (the system temp folder, or `--out <folder>`), captures only the VidAI window for screenshots, checks the files on disk, and always ends the app and every process it started.
    After every scenario it checks that the app kept its data in the test data folder and never in the OS app data folder of its bundle id.
    After the app quit by itself, the processes of its tree that ran last must be gone within 15 seconds (quitting leaves no process behind).
    It writes `e2e-report.json` into the work folder: every scenario with its result (passed, failed with the reason, or skipped on this platform with the reason), its screenshots, its log lines and, on Windows, every window that showed up.
  - What differs between the platforms sits behind one small interface: `scripts/e2e/macos/platform.mjs` (the `.app` bundle, `ps`, `screencapture -l<window>`, the Swift helpers `winid` and `clipboard`) and `scripts/e2e/windows/platform.mjs` (section 11, Tests and CI).
    What the interface looks like on each platform (the shortcut key and its label, the file manager's name, the quit wording, what closing the window does, the review software, single instance) is listed once in `scripts/e2e/interface.mjs`, which the steps get as `ui.platform`; `ui.shortcut(key)` presses an app shortcut with the platform's key, `host.pressShortcut(key)` does it for real through the OS.
  - Scenarios (`scripts/e2e/scenarios/`) are user stories written with the DOM helpers of `scripts/e2e/page/harness.js`: find by role and accessible name, click, type, wait for text.
    Besides the job flows they cover the appearance (13), the start delay with the minute shortened by `VIDAI_E2E_DELAY_MINUTE_MS` (14), the progress bar through an edit, pause, stop, failure, re-edit and render at text size 20 in the smallest window (15), and the window itself at text sizes 11 to 20: the minimum size, the top bar, maximize and full screen and the text size keys pressed for real, plus on macOS the traffic lights and clicks on the top bar, and on Windows a real drag of the window's corner (16).
    A menu still closes while an opaque window of the runner covers VidAI's (11, `host.call("cover")`).
    On a Mac and on Windows, edits on `anthropicApi` (Claude Code pointed at a local stand-in for an Anthropic compatible gateway, which answers like its source does) run without a Claude login: a key saved through the onboarding, a model picked from its paged list, an edit whose fake Claude Code receives exactly `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, the three `ANTHROPIC_DEFAULT_*_MODEL` and `--model`, and no `ANTHROPIC_AUTH_TOKEN`, the top bar, the activity panel and Test, and the switch back to the Claude subscription and to the API option again; then the key is removed (the option stays selected, Test says the service wants a key when the stand-in refuses a request without one), the stand-in turns into a server that needs no key (Test and Fetch Models send no key header), and a second edit gets no `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN=no-key`; the key is in no file VidAI writes (19, skipped elsewhere with the reason); on Windows the same flow with the key in the Credential Manager's place (the end-to-end runs keep keys in memory).
    The list is sorted by Age, Name (A-Z, then Z-A) and back, an edited video is archived and unarchived through Archive in the sidebar, Edit Log lists what happened, and `VidAI-edit-log.txt` in the Editing Folder holds the same entries one per line with the line endings of the platform (23, `archive-edit-log`).
    With the fake OpenCode 2 (`VIDAI_OPENCODE2_BIN`) and Claude Code logged out, the onboarding chooses OpenCode 2 with OpenCode Go Subscription, Settings, Harness + API Keys shows it chosen, the sidebar says "OpenCode 2 ready", and an edit is paused and continued in the same session, an edit whose model ends its turn early is kept going and re-edited, and an edit is stopped with its whole tree; every server got the command line and environment of section 7a, no Claude Code process ran, and the key is in no file VidAI writes (21, `opencode-program`; the stand-in for the gateway is shared with 19 in `scripts/e2e/opencode-gateway.mjs`).
    The end-to-end runner never lets the OpenCode 2 program of the machine running the test take part: every scenario starts with it "not installed" (`VIDAI_OPENCODE2_BIN` pointing at nothing) unless it names its own, and a scenario can say that Claude Code is not installed either (`VIDAI_CLAUDE_BIN`).
    Scenarios that start on the onboarding choose their option on its first screen (section 9, Onboarding), on a Mac and on Windows.
    The journeys of the readiness table (section 6) run with the fakes, on a Mac and on Windows: a person with no Claude at all who chooses OpenCode 2 with OpenCode Go Subscription, enters a key and a model and completes an edit, with not one Claude Code process started (25, `no-claude-opencode2`), a Claude-only person who chooses Claude Code with Claude Subscription and is asked for no key and nothing of OpenCode (26, `claude-only`), and the selected program uninstalled between two edits, which turns the window into the install card and, once the program is back, finishes the second edit in a new server (27, `program-uninstalled`).
    On Windows the browser keys and the browser's context menu do nothing (17, real key presses and right clicks), and on a 1366 x 768 screen the window launches fitting, centred and not below its minimum, with nothing cut off at text sizes 15 and 20 (18, on CI only, where the runner may change the display mode; display scaling is not checked, because Windows applies a changed scaling only after signing out).
    Stop (04) checks that the job's whole process tree, as the OS sees it, is gone.
    A scenario that cannot run on a platform says why (`skip`), and the run reports it as skipped with that reason.
  - `npm run e2e -- --real` runs one smoke scenario with the real local Claude Code (model haiku, trivial prompts, about two minutes of work); it is never part of the default run.
    Two edits are started together with a start delay of one minute lasting 30 seconds: the second waits, then starts by itself, each runs in its own Claude session, the marker lines move the progress bar, and the first goes through a background task, pause, continue, completion and a re-edit.
  - `npm run e2e -- --real real-opencode` runs the smoke scenario of the real OpenCode 2 program (22, Macs only, never part of the default run): edits on the pay-as-you-go address with the free model `big-pickle`, in the OpenCode 2 program, in a scratch Editing Folder; a trivial edit is paused while a command runs, continued in the same session and completes with a review project; the OpenCode sessions it made are deleted afterwards (`opencode2 session delete`).
    The key saved through Settings is a stand-in: `VIDAI_E2E_OPENCODE_LOGIN` (`public` by default, or `own`) starts the servers without VidAI's key (section 7a).
  - `npm run e2e -- --target x86_64-apple-darwin` runs the scenarios against the Intel debug build (`src-tauri/target/x86_64-apple-darwin/debug/bundle/macos/VidAI.app`); on Apple Silicon it runs under Rosetta 2, so the Intel build is verified end to end without an Intel Mac.
- `cargo test --target x86_64-apple-darwin --manifest-path src-tauri/Cargo.toml` runs the Rust tests as Intel code (under Rosetta 2 on Apple Silicon); every test passes on both architectures.
  Under Rosetta the hardware still reports Apple Silicon, so what only an Intel Mac has is tested by injection instead: the program lookups (`claude`, the OpenCode 2 program) run against an Intel-style layout in a temporary folder (its own home, `/usr/local/bin` and `/opt/homebrew/bin` stand-ins in both orders, `PATH` empty or without the tool folders, a program only in `/usr/local/bin`, `~/.opencode/bin`, `~/.local/bin` or a Node version manager's folder, OpenCode 1.x and 2.x side by side, a stale `opencode2` shim) with recorded `--version` answers; the Mach-O check decides for an Intel Mac and for Apple Silicon with and without Rosetta; the machine facts come from recorded `sysctl`, `sw_vers` and `system_profiler` answers of an Intel Mac (Intel plus AMD graphics, Intel graphics only, an older vendor form), an Apple Silicon Mac and the Intel build under Rosetta; and the login-shell capture runs real zsh, bash and tcsh with startup files of the test's own (`.zprofile` and `.zshrc`, banners, a question, a slow file, a failing one).
  Run on an Intel Mac, the same tests also check that a program built only for Apple Silicon is passed over.
- No test may depend on the real Claude Code, the network, or the developer's real Editing Folder.
- Never use the em dash character anywhere (code, comments, UI text, docs); use a plain dash.

### Build and release (macOS)

- The minimum system is macOS 12 (`bundle.macOS.minimumSystemVersion`); the app binary and the helper are built for it.
- Each build command makes a signed `VidAI.app` and a `.dmg` with an Applications link, then checks them (`scripts/bundle-mac.mjs`):

  | Command                    | Target triple            | Runs natively on        | Output under `src-tauri/target/<triple>/release/bundle/` |
  | -------------------------- | ------------------------ | ----------------------- | -------------------------------------------------------- |
  | `npm run bundle:mac`       | `universal-apple-darwin` | Apple Silicon and Intel | `macos/VidAI.app`, `dmg/VidAI_<version>_universal.dmg`   |
  | `npm run bundle:mac:arm64` | `aarch64-apple-darwin`   | Apple Silicon           | `macos/VidAI.app`, `dmg/VidAI_<version>_aarch64.dmg`     |
  | `npm run bundle:mac:x64`   | `x86_64-apple-darwin`    | Intel                   | `macos/VidAI.app`, `dmg/VidAI_<version>_x64.dmg`         |

- The universal `.dmg` is the one the team downloads, because nobody can pick the wrong file.
  It carries both architectures, so it is larger (about 13 MB against about 9 MB for one architecture).
  The Intel build also runs on Apple Silicon under Rosetta 2, which is how it is tested there.
- The checks fail the build unless the app binary and `vidai-orient` inside the app (and inside the mounted `.dmg`) hold exactly the target's architectures (`lipo -archs`), every slice is built for the minimum macOS version (`vtool -show-build`), and the app passes `codesign --verify --deep --strict`.
- The Rust targets come from rustup: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
- `vidai-orient` is compiled by `src-tauri/build.rs` for both architectures on every macOS build and joined with `lipo`, giving the three sidecars Tauri looks for (`src-tauri/binaries/vidai-orient-<aarch64 | x86_64 | universal>-apple-darwin`), all from the same source.
- Signing: there is no Apple Developer ID, so bundles are ad-hoc signed (`bundle.macOS.signingIdentity` is `"-"` in `src-tauri/tauri.macos.conf.json`).
  Tauri signs the helper and the app binary and seals the whole bundle, which is what lets Gatekeeper offer "Open Anyway" instead of calling the app damaged.
  The app is not notarized; the README explains the one-time confirmation on first open.

## 11. Windows

VidAI runs on Windows 10 (1809 or later) and Windows 11 on x64, from the same codebase as macOS.
`platform::platform_supported` accepts macOS on Apple Silicon and Intel, and Windows on x64.
This section describes how the Rust core behaves on Windows; everything not mentioned here works as on macOS.
All Windows code sits behind `cfg(windows)`, mostly in `src-tauri/src/platform/`, and the macOS behaviour is unchanged.
No Windows code uses `unsafe` (section 10 allows it only in `platform/appkit.rs`, which is macOS-only): every Win32 API is used through a crate with a safe API (`win32job`, `sysinfo`, `keyring-core` with `windows-native-keyring-store`, `keepawake`, `same-file`, `windows-registry`, `winsafe`), and WinRT through the `windows` crate, whose WinRT calls are safe.
The macOS-only crates (`objc2` and its AppKit bindings) and modules (`platform::appkit`, `platform::macos`) are not built on Windows.

### Prerequisites

- Claude Code (for the options `claudeSubscription` and `anthropicApi`), installed with the native installer (`irm https://claude.ai/install.ps1 | iex`), WinGet (`winget install Anthropic.ClaudeCode`) or npm.
- Git for Windows (for Claude Code; the OpenCode 2 options never need it).
  Claude Code itself can run without it (it then uses PowerShell), but the toolkit and the editing notes are written for Bash, and Claude Code uses Git Bash for its Bash tool.
- OpenCode 2 (`opencode2`, for the options `opencodeGo` and `openaiApi`), installed with `winget install --id Anomaly.OpenCode --exact` or found where WinGet, npm and scoop put it (OpenCode 2 on Windows below).
  Every command that would start Claude checks for Git Bash after the installed check, and rejects with `gitBashMissing` and the message "VidAI needs Git for Windows (Git Bash), which Claude Code uses to run the editing tools. Install it from https://git-scm.com/downloads/win, then try again."
  `check_system` reports it as `SystemStatus.gitBash` (null on macOS), so the UI shows the Git for Windows step of the onboarding before anything about Claude Code (section 9, Onboarding), a "Git for Windows" row with Download in Settings, System, and "Claude Code needs attention" in the sidebar; a job command refused with `gitBashMissing` checks the system again, which brings up that step.
- WebView2, which Windows 11 has; the installer downloads it on Windows 10 when it is missing.

### Environment

- A Windows GUI app already has the user's environment, so there is no login shell to ask.
- That copy can be stale (VidAI may have been started before a tool was installed), so at startup `PATH` is rebuilt as a new terminal would see it: the machine `Path` and the user `Path` from the registry (with `%VARIABLES%` expanded), then the entries of VidAI's own `PATH` that are not in them.
- Every other variable is VidAI's own, unchanged.
- Variable names ignore letter case on Windows; the child environment always spells the variable `PATH`.
- `%USERPROFILE%\.local\bin` (the native installer's folder) is appended to `PATH` when missing.
- No `HOME` is added; the home folder is `USERPROFILE`.

### Finding and starting Claude Code

- `claude` is looked up in this order: `VIDAI_CLAUDE_BIN`, the `PATH` (with `PATHEXT`, as a terminal does, so `claude.exe` and `claude.cmd` are found), then `%USERPROFILE%\.local\bin\claude.exe` (native installer), `%USERPROFILE%\AppData\Local\Microsoft\WinGet\Links\claude.exe` (WinGet) and `%USERPROFILE%\AppData\Roaming\npm\claude.cmd` (npm).
- `platform::launch` turns the path found into a command:
  - an `.exe` is started directly;
  - an npm `.cmd` shim is never run through `cmd.exe` (its quoting rules make arguments such as the JSON of `--settings` unsafe); the shim is read and its target is started instead, the `claude.exe` of the npm package, or `node <script>` for a JavaScript target;
  - a JavaScript file is started with `node`;
  - a file that starts with `#!` (the fake `claude` of the tests, or a user's own wrapper) is run with Git Bash.
    Git Bash splits its command line by MSYS2 rules and would expand `{}`, `*`, `~` and `@file` in unquoted words, so every argument is passed in double quotes with `\` and `"` escaped, which MSYS2 reads back literally.
- Git Bash is found like Claude Code finds it: `CLAUDE_CODE_GIT_BASH_PATH`, then next to the `git` on `PATH`, then the usual install folders; the `bash.exe` of WSL in `System32` is never used.
- The helper tools of `SystemStatus` are found with `PATHEXT`; `python3` also matches `python` and the `py` launcher, and the Microsoft Store placeholders in `%LOCALAPPDATA%\Microsoft\WindowsApps` count only when they really run.

### Process trees

- Every child process is started with `CREATE_NO_WINDOW`, so no console window flashes up; everything it starts shares that hidden console.
- Every child is put into a Job Object of its own, created with "kill on job close", right after it is created.
  Nothing can leave the job, so the job always holds the whole tree: Claude Code, Git Bash, ffmpeg, Python, Whisper and sub-agents.
- VidAI holds the only handle to each job.
  Ending a tree closes that handle, which ends every process of the job at once.
  Windowless processes have no polite stop signal, so the grace period of section 6 does not apply; Pause and Stop still first ask Claude Code through stdin (interrupt, close stdin) as in section 6.
- When VidAI ends for any reason (quit, crash, ended in Task Manager), Windows closes the handles and ends every tree.
  That is the crash watchdog on Windows; there is no `sh` watchdog process.
- `running-processes.tsv` is still written (pid and command line of every process of a running job) and swept at the next start, with the same command-line check against reused process ids.

### Sleep prevention

- The Rust core decides in `sleep.rs`, for macOS and Windows alike, whether the computer is kept awake.
  It combines three facts: a job is running, a job is still being edited, and No Sleep is checked (`Settings.noSleep`, saved by `set_no_sleep`, applied at startup and at once when it changes).
- No Sleep off, the default: the computer is kept awake while at least one job runs (a job in `running`, `pausing` or `stopping`, that is, a live job process).
  A queued job does not hold it.
- No Sleep on: the computer is kept awake until editing has ended, that is, as long as at least one job is being edited.
  A job is being edited in the states `queued` (also while it waits for a free slot or for the start delay), `running` (also while it waits to retry after a model error and in every keeping-a-job-going and wait state of section 6), `pausing` and `stopping`.
  The states `paused`, `stopped`, `failed` and `completed` count as ended: a paused job was stopped by the user and does not hold the computer awake.
  `model::jobs_active` names these states, and the job manager reports a change after every state change of a job.
- When nothing is being edited the hold is released even though the box is checked, and the computer sleeps normally.
  Checking the box while a job waits starts the hold at once, unchecking it while no job runs ends it at once.
  The three facts are kept separately, so a change of one never undoes another.
- macOS: a `caffeinate -i -w <VidAI's pid>` child process holds it, so it also ends by itself when VidAI ends, even by a crash.
- Windows: a small thread holds a "system required" execution state (`SetThreadExecutionState` through `keepawake`).
- Like `caffeinate -i`, both keep the computer from sleeping when idle but let the display turn off, and both end with VidAI.
- The main window's sidebar has the No Sleep checkbox (section 9, Main window).

### Secrets

- The three API keys are stored in the Windows Credential Manager as generic credentials named `com.vidai.desktop/opencode-go-api-key`, `com.vidai.desktop/anthropic-api-key` and `com.vidai.desktop/openai-api-key`, with local persistence, so they never roam with the user profile.
  Windows shows no dialog, so the keys are read on demand (the read-once store of section 7a is the Mac's).
  A key of VidAI 0.2.4 is migrated as section 7a, Migration from 0.2.4, says: the credential `com.vidai.desktop/opencode-api-key` is read as the OpenCode Go key, copied to the new names (also to `com.vidai.desktop/anthropic-api-key` when the migration chose `anthropicApi`) and removed once the new ones read back; the credential of the retired optional key is deleted at startup, best-effort.
- `VIDAI_SECRETS=memory` and the in-memory store of the tests work as on macOS.

### Toolkit

- Creating symlinks needs a privilege most Windows users do not have, so the links of the toolkit archive (the `gfx/templates/*/shared` folders) are materialized as real copies of what they point to.
  They are copied once everything else is extracted, still inside the temporary seeding folder, so section 7's crash safety holds.
  Copies work on every file system (also exFAT and FAT32 drives) and survive moving or renaming the Editing Folder.
  A link whose target is not in the archive is left out; links that point into themselves or only at each other make the archive invalid.
- On every platform, archive names that Windows cannot store (reserved device names such as `CON` or `NUL` with any extension, the characters `<>:"|?*\`, control characters, a trailing dot or space) and names that differ only in letter case make the archive invalid, so one archive works on macOS and Windows.
- On a file system without hard links, a seed file is placed by creating a new file and copying into it, which never replaces an existing file either.
- A folder rename that a virus scanner briefly blocks ("access denied") is tried again for up to three seconds (`platform::rename`, which every atomic file replace of `store.rs` and the process registry also uses).
- Paths longer than 260 characters work in VidAI's own file operations, because the Rust standard library uses extended-length paths for them.

### Machine facts and the toolkit

- The first message of an edit on Windows states the machine facts (version, architecture, CPU, memory, graphics adapters with vendor) and the paragraph that tells Claude how to adapt the Apple Silicon toolkit (section 6, Machine facts).
- The facts come from the registry, `sysinfo` and one Windows PowerShell call for the video controllers (`Get-CimInstance Win32_VideoController`, passed as `-EncodedCommand`, without a console window, ended after 20 seconds); no `unsafe` code.
- The Windows CI job probes the runner and checks that the facts are complete and sane.

### Channel folders

- Besides the rules of section 5, a channel folder name may not contain `<>"|?*`, may not end with a dot or a space, and may not be a reserved device name such as `CON` or `NUL`.
- A rename that only changes the letter case is allowed, as on macOS: Windows also treats both names as the same folder.

### Helper tools, logs and the picture check

- `ffprobe` (the fallback of the type detection, section 8) is found as `ffprobe.exe` with `PATHEXT` and runs without a console window.
- The activity log shortens paths (section 6) in every form Windows tools write them: `C:\Users\...`, `C:/Users/...` and Git Bash's `/c/Users/...`, ignoring letter case.
- The picture check of section 8 runs in a second copy of the app binary (`platform::orientation::windows_helper`).
  `main` hands a start with the first argument `--vidai-picture-check` to the helper before anything of the app starts, so no window, tray or single-instance logic ever runs in it; any other start registers the running binary as the helper.
  The helper is started like every child (no console window, its own kill-on-close Job Object), so a crash or hang in a video decoder never touches the app.
  It uses the WinRT APIs `Windows.Media.Editing` (`MediaComposition.GetThumbnailAsync`) and `Windows.Media.FaceAnalysis` (`FaceDetector`, with `Gray8` frames) through the `windows` crate, whose WinRT calls are safe Rust; all of them work in an app without package identity.
  It is available when `FaceDetector.IsSupported` (asked once, in the app), so not on an N edition of Windows without the Media Feature Pack.
  With `VIDAI_PICTURE_CHECK_DEBUG` set, the helper writes notes on stderr (sizes, rotation flag, every turn that shows a face and its tilts) to explain a result.
- Windows decodes H.264 itself; HEVC (many phones and Sony cameras) needs the "HEVC Video Extensions" from the Microsoft Store.
  Without them such a file is a failure that may pass (section 8, Cache): the metadata result stands, the log names the extension, and the check runs again after the next start.
  The user sees the type from the metadata (a sideways file without a rotation flag stays Long) and can set the type on the video row.
- User-facing texts name the PC and Task Manager instead of the Mac and Activity Monitor.

### Window and appearance

- The window has the native Windows title bar (decorations on, with the caption buttons, snap layouts and resize borders), and the app's top bar sits directly below it.
  `src-tauri/tauri.windows.conf.json` repeats the main window without the macOS-only `titleBarStyle` and `hiddenTitle` (Tauri replaces arrays when it merges, a unit test keeps both files in step) and adds `zoomHotkeysEnabled: false`, `dragDropEnabled: true` and `scrollBarStyle: "fluentOverlay"` (thin Windows 11 overlay scrollbars, WebView2 125 or later).
- Theme and text size (section 9, Appearance) work through Tauri: the app theme (which also turns the native title bar dark or light, and follows Windows' light or dark app mode with System), the window background colour, the webview zoom and the minimum window size.
- The title bar and the window borders count against the screen: the minimum size is the smallest layout at the zoom, but never larger than the usable area of the screen minus the frame (outer size minus inner size), and a window that does not fit on its screen at launch (the default 1240 × 800 on a 1366 × 768 laptop) is made smaller, never below the minimum, and centred in the usable area by the size it is given (`appearance::content_room`, `launch_size`, `centred_position`; a resize takes effect a moment later, so the window's own measurement right after it is still the old size), since Windows does not keep a window on the screen by itself.
  The window is still created hidden and shown by `appearance::setup` once theme, zoom and size are set.
- There is no menu bar: the app menu of section 9 is macOS-only (`lifecycle::menu`).
  What it offers is reachable in the window: Settings, the text size and every other shortcut with Ctrl in the web layer, the version in Settings, System (instead of About), minimize, maximize and close with the caption buttons, and text editing with the standard Windows keys of text fields.
  The traffic lights and the Cmd++ handling of `platform::appkit` are macOS-only.

### User interface on Windows

Everything that differs comes from one module, `src/lib/platform.ts` (`usePlatform()`), fed by the platform the Rust core injects into the page before its scripts run (`window.__VIDAI_PLATFORM__`, the `Platform` type that `SystemStatus.platform` carries too); in the browser mock it is the `?platform=windows` query.

- Shortcuts: Ctrl instead of Cmd for Settings (Ctrl+,), search (Ctrl+F), saving a channel (Ctrl+S), submitting a job sheet (Ctrl+Enter) and the text size (Ctrl+= or Ctrl++, Ctrl+-, Ctrl+0); the Windows key never counts.
  Key hints show "Ctrl", "Enter" and "Esc" as separate key caps, running text writes "Ctrl+C", and `aria-keyshortcuts` says "Control+F".
- Wording: "Show in File Explorer" for Show in Finder, "this PC" for this Mac, Task Manager for Activity Monitor, PowerShell for Terminal (Open PowerShell to Install, press Enter), Windows Credential Manager for the Keychain, "light or dark mode of Windows" for the appearance of the Mac, and the install commands `irm https://claude.ai/install.ps1 | iex` (Claude Code) and `winget install --id Anomaly.OpenCode --exact` (OpenCode 2).
- Review software: Premiere Pro only. Settings, General shows it as a fact with "Final Cut Pro is only available on a Mac" instead of a choice, the Render Final 4K sheet accepts a Premiere Pro XML export and says so, and the backend refuses or leaves out Final Cut Pro (section 5).
- Quitting is closing the window, so the confirmation of section 9 says "Close VidAI?" and "Pause and Close".
- Window frame: no room is kept for traffic lights (the sidebar starts at the top, a full-width top bar has its normal padding, the onboarding has no band above it), and nothing in the page drags the window.
- Fonts: Segoe UI Variable (Segoe UI on Windows 10), Nirmala UI for Devanagari, and Cascadia Mono (Consolas) for code (`data-platform="windows"` on `<html>`, set before the first frame).
- Paths are shown as Windows writes them; file names and joined paths follow the separator of the path (`src/lib/paths.ts`).
- On both platforms a shown path wraps only after a separator, so no line starts with a separator and no name is cut in two; only a single name longer than the line wraps inside (`PathText`, `pathSegments`).

### No browser in the window

WebView2 is a browser, so the release build of the Windows app declines everything that would show it (`src/app/webviewGuard.ts`):

- Browser keys: reload (F5, Ctrl+R, Ctrl+F5, Shift+F5, Ctrl+Shift+R), find (Ctrl+F, F3, Ctrl+G), print (Ctrl+P), save page (Ctrl+S), view source (Ctrl+U), caret browsing (F7), history (Alt+Left, Alt+Right, the browser keys of some keyboards) and the developer tools (F12, Ctrl+Shift+I, J, C) have their default prevented in the page; WebView2 runs a browser accelerator only when the page lets the key's default happen, and the app's own Ctrl+F and Ctrl+S still work.
  Tauri 2.12 does not expose `AreBrowserAcceleratorKeysEnabled`, and reaching it through the WebView2 COM API would need `unsafe`.
- The context menu (Back, Reload, Save as, Print, Inspect) is prevented except in text fields, which keep Cut, Copy and Paste; Tauri does not expose `AreDefaultContextMenusEnabled` either.
- Browser zoom (Ctrl+Plus, Ctrl+Minus, Ctrl+0, Ctrl+wheel, pinch) is off through `zoomHotkeysEnabled: false` (WebView2's `IsZoomControlEnabled` and `IsPinchZoomEnabled`); the keys reach the app's text size instead.
- Dropped files never navigate the window: with `dragDropEnabled` Tauri handles drops itself and turns WebView2's external drop off.
- The Rust core turns the guard on before the page loads (`window.__VIDAI_WEBVIEW_GUARD__`, `guards_webview`): in release builds, and in debug builds only while the end-to-end hook runs, so scenario 17 checks it with real key presses.
  A developer's debug build keeps reload and the developer tools; the developer tools are off in release builds anyway.

### Closing and quitting

- Closing the window (its close button, Alt+F4, "Close window" on the taskbar) quits like Quit on the Mac (`lifecycle::close_action`, `jobs::request_quit`): with no `queued`, `running`, `pausing` or `stopping` job VidAI ends at once; otherwise the window stays, `quit-requested` asks the UI to confirm, and `confirm_quit` pauses every running job before the process ends.
  Cancel keeps everything running.
  Closing never ends edits without asking, which the job objects would otherwise do.
- Minimizing keeps everything running.
- Signing out, shutting down and the Restart Manager end the session with `WM_ENDSESSION`, which arrives as `RunEvent::Exit`: running jobs are paused without asking for at most 4 seconds (Windows treats an app that needs more than about 5 seconds as not responding), the logs and `state.json` are written, and the job objects end whatever is left.
  `state.json` is replaced atomically, so it is never half written; a job caught while pausing is recovered as paused at the next start (section 6).
- There is no system tray.

### Installer and app identity

- The NSIS installer installs for the current user without administrator rights, downloads the WebView2 runtime when it is missing, uses the app icon (`installerIcon`), and puts a VidAI shortcut in the Start menu.
- The publisher is "VidAI" (`bundle.publisher`): it is the company name of the executable and the publisher in Settings, Apps, which shows "VidAI" with the version of `tauri.conf.json`.
- The Start menu shortcut carries the bundle id as its AppUserModelID, which is what Windows needs to show notifications for an installed app; the notification plugin uses the same id (a run from `target\debug` or `target\release` shows its notifications without it).
- The window and taskbar icon is `icons/icon.ico` (16 to 256 px), embedded by `tauri-build`.
- The uninstaller leaves the app data alone unless the user ticks its "Delete the application data" box (unticked by default); the Editing Folder and the API keys in the Credential Manager are never touched.

### Opening things and the terminal

- `open_path` and `reveal_path` use the opener plugin, which opens files with their default app and shows them in Explorer.
- `open_claude_login`, `open_claude_install` and `open_opencode2_install` open a PowerShell window (Windows PowerShell, through `cmd /c start`) with the script passed as `-EncodedCommand`, so no script file is written and the execution policy does not matter.
  The install window shows `irm https://claude.ai/install.ps1 | iex`, mentions Git for Windows, and runs the installer only after Enter.
  The OpenCode 2 window shows `winget install --id Anomaly.OpenCode --exact` and runs it only after Enter too.
- The review software defaults to Premiere Pro (`ReviewSoftware::platform_default`), since Final Cut Pro does not exist on Windows.

### App data and bundle

- The app data directory is `%APPDATA%\com.vidai.desktop`.
- Every Windows binary, the test binaries included, embeds `src-tauri/windows-app-manifest.xml` (Common Controls 6, which Tauri needs, and long path support); `build.rs` links it and turns Tauri's own manifest off, because test binaries without it fail to start with `STATUS_ENTRYPOINT_NOT_FOUND`.
- `src-tauri/tauri.windows.conf.json` (merged by Tauri on Windows only) builds an NSIS installer that installs for the current user without administrator rights and downloads WebView2 when it is missing.

### OpenCode 2 and the newer features on Windows

Every feature that does not depend on the platform works on Windows as on macOS, and all four options of section 7a exist there:

- Archive and edit log: `state.json` holds them.
  The edit log is mirrored to `<Editing Folder>\VidAI-edit-log.txt`, one line per entry with the line endings of Windows text files (CRLF), so Notepad and every other program shows one entry per line; the mirror is appended with the standard library and never fails an edit.
  Paths are shown as Windows writes them (see User interface on Windows).
- List sorting (Name, Age, Status and direction) and the remembered activity tab are local UI state.
- Progress, start delay and the job flow are section 6.
- Keeping a job going (section 6) is on, for edits on every option except `claudeSubscription` (`opencode::keeps_jobs_going`).
  It needs nothing but the model's turns and the job's files, and is tested on Windows with the fake Claude Code in Git Bash (`tests/jobs_engine.rs`, scenarios 07 and 20).
- Settings, Harness + API Keys is exactly as on a Mac, in Windows wording (Credential Manager, this PC, `%USERPROFILE%\.claude\settings.json` and environment variables in the routing note): the four options, the keys, addresses, models, efforts, Test and the quota in the top bar.
- `claudeSubscription` and `anthropicApi` run Claude Code, which needs Git for Windows; `anthropicApi` needs no login.
- Where Claude Code's own settings file or environment already set `ANTHROPIC_BASE_URL`, the routing note of section 7a appears on Windows too.
- The keys are stored in the Credential Manager (Secrets above); a key never reaches the UI, the log, `state.json` or an error message.
- The onboarding is the one of section 9, and its install card for OpenCode 2 opens a PowerShell window like Claude Code's.

OpenCode 2 is offered on Windows exactly like on a Mac (this reverses the earlier decision to leave the program out):

- Finding it (`opencode::harness::locate2`): the candidates and the version check of section 7a, with `PATHEXT` (`.exe`, `.cmd`) on the `PATH` and in `%LOCALAPPDATA%\Microsoft\WinGet\Links` (WinGet, the official way), `%USERPROFILE%\.opencode\bin`, `%APPDATA%\npm` (npm global), `%USERPROFILE%\scoop\shims` and `%USERPROFILE%\.local\bin`; `VIDAI_OPENCODE2_BIN` works as everywhere.
- Installing it: the install card and Settings show `winget install --id Anomaly.OpenCode --exact`, which `locate2.rs` holds (the UI keeps no second copy), and open a PowerShell window like Claude Code's (Terminals below).
- The server of a run (`opencode2 serve --stdio ...`) is started with `CREATE_NO_WINDOW`, so no console window flashes, and inside a Job Object that kills the whole process tree when its handle closes (`platform::process`), so Pause, Stop and quitting end the server and everything it started, as for Claude Code.
- It never needs Git for Windows or a choice of shell: options 2 and 4 never ask for Git Bash, Claude Code or a login.
- `SystemStatus.opencode2` is filled on Windows like on a Mac, and `get_opencode2_cli`, `open_opencode2_install` and `set_setup` work there.
- Tests: `tests/opencode2_engine.rs` and `tests/opencode_startup.rs` run on Windows too, against the Python fake `fake-opencode2.py` (run through the machine's Python by `platform::launch`, not as an extensionless Unix script), except `pause_stops_background_commands_and_sub_agents`, `stop_ends_the_whole_process_tree` and the real smoke test, which stay Unix-only because the fake spawns POSIX `sleep` and `sh`; the Windows process tree is covered by the Git Bash fake in `jobs_engine`.
  The unit tests of `locate2` cover the Windows candidates, and scenario 21 runs on Windows against the fake; scenario 22 (the real program) stays macOS-only.
  Windows code is verified on the Mac with `cargo xwin clippy`; running these tests on Windows is still to be done.
- The real program on Windows has not been verified against a real Windows machine; only the fake, the unit tests and the source of OpenCode 2 stand behind it.

### Tests and CI

- The Windows interface is tested on every platform: Vitest runs the UI against the mock backend on macOS and on Windows (`src/app/platform.test.tsx`, `src/lib/platform.test.ts`, `src/app/webviewGuard.test.ts`), the Rust decisions are pure functions with unit tests (`lifecycle::close_action`, `jobs::quit_decision`, `jobs::terminate_pause_timeout`, `appearance::launch_size`, `instance`), and `npm run screenshots -- --platform=windows` renders every screen of the Windows variant.

- Unit and integration tests run on Windows.
  Tests that are Unix by nature (process groups and signals, symlinks, POSIX paths) are `cfg(unix)` and have Windows counterparts where the behaviour matters (process trees in jobs, toolkit links, locating Claude Code, the terminal scripts).
- The integration tests drive the same fake `claude` (`tests/support/fake-claude.sh`), which VidAI runs with Git Bash because of its `#!` line.
  In Git Bash the fake makes no wake-up FIFO (a Windows program cannot open an MSYS2 FIFO, and MSYS2's emulated FIFOs could hang fakes that start together), so each wait is a one-second sleep and a fake notices a dropped file within a second (`tests/support::wake_fakes` writes nothing on Windows).
- `.gitattributes` keeps LF line endings in every checkout, which the fakes, Prettier and the fixtures need.
- `tests/picture_check_windows.rs` runs the picture check with the app binary cargo built as the helper.
  Its clips are made at test time from one public domain portrait (`tests/fixtures/faces/portrait.jpg`, source and license in `portrait.txt`), with WIC and the H.264 encoder of Media Foundation, so no encoder is installed and no footage is stored: the face upright, sideways either way and upside down, no face, in 16:9, 9:16, 4:3, 3:4, square and 4K, with and without a rotation flag.
  The pure parts of the Windows helper (arguments, sampling, turning frames, face measurements, decoder errors) are unit tests on every platform.
- The end-to-end suite of section 10 (`npm run e2e`) runs on Windows too, against the debug `VidAI.exe` (`tauri build --debug --no-bundle` with the bundle id `com.vidai.desktop.e2e`, recorded in a stamp next to the build so a plain debug build is never taken for it).
  - The fake `claude` is copied into the work folder without an extension; VidAI sees its `#!` line and runs it with Git Bash, as in the integration tests.
    It has no wake-up FIFO there, so each fake notices a dropped file within a second, and waits get twice the time on Windows.
    The fake reports Git Bash process ids, which the runner looks up with Git Bash itself (`kill -0`).
  - `scripts/e2e/windows/helper.ps1` is one long-lived Windows PowerShell process with a small C# class compiled at start by the .NET Framework that every Windows has (no download): it finds the app's window by process id, captures only that window (`PrintWindow` with full content, else the screen at the window), saves, restores and reads the clipboard, sends real key presses and mouse drags (`SendInput`), lists the processes with their command lines and start times (a parent id may name a newer, unrelated process), and records every top-level window that shows up while the app runs (a WinEvent hook).
    A console window that shows up fails the scenario: no child process may flash one (Process trees above).
  - On CI the screen is made 1920 x 1080 first (runners start at 1024 x 768, which would cap the minimum window size at large text sizes); on a person's own PC the resolution is never changed.
    The small-screen scenario (18) sets 1366 x 768 for itself and puts 1920 x 1080 back afterwards, also when it fails.
  - The Windows expectations of the scenarios (Ctrl and its key caps, "Show in File Explorer", "Close VidAI?" and "Pause and Close", Premiere Pro, the Git for Windows row and the version in Settings, single instance, no drag regions in the page) are the Windows items of `scripts/e2e/interface.mjs`, one line each.
  - Windows counterparts of macOS-only checks: closing the window with a real Alt+F4 and with the close button, while an edit runs and not (09); a second launch on the same data folder ends and brings the first window to the front, once while the runner's helper has its own window in front of VidAI's and starts the second copy itself (as Explorer does for a click in the Start menu, which the test does not click), once while the window is minimized and the runner starts the second copy (`single-instance`); the browser keys (17) and the small screen (18); a real drag of the window's corner, real Ctrl text size keys, Ctrl+F and Ctrl with the mouse wheel, which must not zoom the page (16); the machine facts in the edit message (02).
- `.github/workflows/ci.yml` runs on `windows-latest` for pushes to `windows*` branches and on demand, in two jobs:
  - `windows`: the gates of `npm run check`, then `npm run tauri build`, uploads the installer as the artifact `VidAI-<version>-windows-x64-setup` (the version of `tauri.conf.json`, read by the workflow, which also names the file `VidAI_<version>_x64-setup.exe`, so a version bump changes nothing in the workflow), then tests it like a person (`scripts/e2e/windows/installer-smoke.mjs`): a silent per-user install, VidAI started from the installed copy in a normal run (its window, a screenshot, its data folder `%APPDATA%\com.vidai.desktop`, no console window), the window closed (VidAI ends, no process left), and a silent uninstall; the artifact `installer-test` holds the report and the screenshot.
  - `e2e`: `npm run e2e` with `--require-screenshots`; the artifact `e2e-windows` holds the screenshots, app logs, reports, `e2e-report.json`, the console output and the build log, also when scenarios fail.
  - Before the gates, the `windows` job adds the Media Foundation feature, which Windows Server (the runner) lacks and every Windows 10 and 11 desktop has; the picture check tests need it.
  - A manual run (workflow_dispatch) can leave out either job and pick scenarios, so an end-to-end iteration does not repeat every gate; npm and cargo are cached.

## 12. Web version

VidAI Web is the same product used in a web browser: a local server (`vidai-web`) runs the unchanged Rust core on the user's Mac or Windows PC, and the browser on that same computer shows the unchanged React UI.
Every feature of sections 1 to 11 works the same; this section lists only what differs.
The desktop apps are not affected: the web version adds `src-web/` and a transport in `src/lib/`, and changes nothing in `src-tauri/`.

### Architecture

- `src-web/` is its own Cargo crate (`vidai-web`, binary `vidai-web`) that depends on the core as a library (`vidai_lib`, by path).
  It never duplicates a command, a rule or a type: the server hands every request to the core's own command handler.
- The server builds a Tauri app with the same plugins, managed state and startup hooks as `src-tauri/src/lib.rs`, without the desktop-only parts (`appearance::setup`, the `lifecycle` hooks, the app menu, the e2e hook's window code).
  Its one window (`main`) is never shown; it exists because Tauri delivers a command to a webview (`Webview::on_message`).
  On macOS the server has no Dock icon (activation policy Accessory).
- The server uses the same app identifier and therefore the same data directory, settings, state, logs and saved API keys as the desktop app (`VIDAI_DATA_DIR` and the other environment variables of CLAUDE.md apply too).
  One copy per data directory still holds (`instance::claim`): while the desktop app runs, `vidai-web` prints why it cannot start and exits with status 1, and the other way round the desktop app's second-launch rule applies.
  A second `vidai-web` for the same data directory asks the first one to open the browser and exits.
- The UI is the regular `dist/` build of `src/`, embedded in the release binary and read from disk in debug builds.

### Server

- It listens on `127.0.0.1` only, port 14200 by default (`--port <n>`, `VIDAI_WEB_PORT`).
  When the port is taken it says so and exits with status 1.
- After the core is up it prints the address and opens it in the default browser (`--no-open` skips that).
- Access needs the access token: 32 random bytes, hex, stored in `<data dir>/web-token` (owner-only on Unix), created on the first start and kept.
  The printed address is `http://127.0.0.1:<port>/?token=<token>`.
  A `GET /` with the right `token` sets the cookie `vidai_web=<token>` (`HttpOnly`, `SameSite=Strict`, `Path=/`, one year) and redirects (303) to `/`, so the token leaves the address bar and bookmarks of `http://127.0.0.1:<port>/` keep working.
  Every other request needs that cookie; without it the answer is 401 with a short page that says to open the address printed by `vidai-web` (JSON `{ "kind": "unauthorized", ... }` under `/api/`).
  Tokens are compared in constant time.
- Every request must carry a `Host` of `127.0.0.1:<port>` or `localhost:<port>` (else 403), which stops DNS rebinding.
  Every request with an `Origin` header must have one of those two origins (else 403).
- Routes:
  - `GET /` and the files of the UI.
    Unknown paths without a file extension get `index.html`.
    `index.html` is served with `<script src="/vidai-env.js"></script>` inserted before its first script.
  - `GET /vidai-env.js` defines `window.__VIDAI_PLATFORM__` (the `model::Platform` of the server) and `window.__VIDAI_WEB__ = { version }`.
  - `POST /api/invoke/<command>` runs one command.
    The body is the JSON object of the command's arguments, exactly as the desktop UI passes them to Tauri's `invoke` (camelCase keys); `<command>` is the Tauri command name and may be a plugin command (`plugin:opener|open_path`, percent-encoded).
    Success is 200 with the JSON result; a command error is 400 with the JSON error value (the `AppError` shape of section 5, or the plugin's string); a command that is unknown or not allowed is 400 with Tauri's message as a JSON string.
    The commands are those of the core's own handler and of the opener and notification plugins, checked by Tauri's capability for the window `main` (`src-web/capabilities/`), so a new core command needs no server change.
  - `GET /api/events` is a Server-Sent Events stream: one message per backend event, `data: {"event": "<name>", "payload": <payload>}`, for every event of `bindings.rs` (a test compares the server's list with `src/lib/bindings.ts`).
    A comment line every 15 seconds keeps the connection alive.
    It starts with `data: {"event": "vidai-web://hello", "payload": {"instance": "<id>"}}`, where the id is new for every server start.
  - `GET /api/asset?path=<absolute path>` serves a file inside the current Editing Folder (the path and the folder are compared after resolving symlinks; anything else is 403, a missing file 404), with `Range` support and a content type from the file extension.
    It replaces Tauri's asset protocol (`assets.rs`), with the same scope.
    Its answers carry a sandboxing Content-Security-Policy of their own, so a file of the Editing Folder opened as a page cannot run scripts.
  - `POST /api/fs/list` with `{ "path": <string or null> }` lists one folder for the file picker: `{ "path", "parent", "name", "entries": [{ "name", "path", "kind": "folder" | "file" }] }`.
    `path` in the answer is the folder that was listed: the asked path when it is a folder, else its nearest existing parent folder (and `name` is then the last part of the asked path, else `null`), and the home folder for `null` or a path that is not absolute.
    `parent` is `null` at `/` and at the root of a Windows drive.
    `..` in an asked path is resolved by its text, without following symlinks.
    Entries are folders first, then files, each sorted by name without regard to case; symlinks count as what they point to; hidden entries (a leading dot, and on Windows the hidden or system attribute) are left out.
    A folder that cannot be read is 400 with an `AppError`.
  - `POST /api/fs/places` (body `{}`) gives the picker's shortcuts that exist: `[{ "name", "path", "kind": "home" | "desktop" | "documents" | "downloads" | "movies" | "volume" }]`, the volumes being `/Volumes/*` on macOS and the drives on Windows.
  - `POST /api/fs/create-folder` with `{ "parent", "name" }` makes one new folder and answers `{ "path" }`; the name must be one path part, and an existing name is an error.
    These three routes are the only ones that are not commands of the core; they change nothing but that one new folder.
- Every response carries a Content-Security-Policy equal to the desktop one without the Tauri schemes (unless the route sets its own), plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; API answers are `Cache-Control: no-store`.
- Ctrl+C (and SIGTERM on macOS) quits the way a confirmed quit does in the desktop app: running and waiting edits are paused first (section 9, Window, menu and quitting), the server says how many, and a second Ctrl+C ends it at once.

### What runs where

- File and folder pickers are a dialog of the page itself (`src/features/filepicker/`), fed by the server's `/api/fs` routes, because a browser cannot give a page real paths and a native dialog opened by a background program would come up behind the browser.
  It has the same three uses as the native dialogs (choose a folder, choose a file with the given filters, choose where to save with a file name and a question before replacing an existing file), a list of places (home, Desktop, Documents, Downloads, Movies or Videos, the other volumes or drives), the path as breadcrumbs, a field to type or paste a path, New Folder, and full keyboard use.
  Hidden files and folders are not listed.
- Open, Reveal, Open Terminal for the Claude login and the notifications are done by the server, as in the desktop app.
- The usage meters (Claude plan and OpenCode Go) refresh on the schedule the desktop app uses while its window is visible, whenever at least one page is connected to the event stream; the server does this itself with the core's refresh functions, because the core looks at the visibility of its window, which is never shown here.
- Web links (`api.openUrl`) open in a new browser tab.
- Thumbnails come from `/api/asset`.

### User interface in the browser

- `src/lib/ipc.ts` picks the web backend when `window.__VIDAI_WEB__` exists (`src/lib/web.ts`, `Api.backend === "web"`).
  `web.ts` gives Tauri's JavaScript API a transport (HTTP for `invoke`, the event stream for `listen`) and then reuses `createTauriApi`, so the generated bindings stay the single description of the commands.
- The platform is the server's (`__VIDAI_PLATFORM__`), so fonts, wording and paths match the computer; shortcuts follow the same rule.
- There is no window frame: no traffic-light inset, no drag regions, no window controls; the page fills the browser tab and its title is `VidAI`.
- Text size (section 9, Appearance) is applied by the page itself as CSS `zoom` on the root element with `appearance::zoom_factor`.
  Cmd/Ctrl with `=`, `+`, `-` and `0` are left to the browser's own zoom; the other shortcuts work as in the app where the browser lets a page have the key.
  Hints and tooltips leave out a shortcut the browser keeps for itself (`PlatformInfo.offersShortcut`: the zoom keys, and Cmd+`,` on a Mac, where Settings is reached with its sidebar button).
  The page also sets `--page-zoom` on the root element: popups (menus, selects, tooltips) are positioned with it so they stay at their anchor, and the size limits of dialogs, sheets and toasts divide the viewport by it so they fit a small browser window.
  Neither exists in the desktop app, where the property is not set.
- The layout never gets less than 980 x 620 CSS px (`MIN_LAYOUT_SIZE` in `src/app/appearance.ts`), the same floor as the desktop app's smallest window (`MIN_LAYOUT_SIZE` in `appearance.rs`), which is 980 x zoom by 620 x zoom on screen.
  A browser window smaller than that does not squeeze the layout: the page scrolls in both directions as needed, on the app's own background.
  Dialogs, sheets, the file picker, toasts, menus and the "VidAI is not running" notice are fixed to the visible browser window, so they stay fully visible whatever the scroll position; the desktop app has no such floor in the page and no scrollbars.
- The library rescans when the tab becomes visible or gets focus (the desktop app does this on window focus).
- When the event stream breaks, a full-page notice says that VidAI is not running and how to start it, and the page keeps trying to reconnect.
  When the stream is back the page reloads, so it never shows stale state; the same happens when the instance id of `hello` changes.
- Closing the tab changes nothing: edits keep running in the server, and opening the address again shows their current state.
- Several tabs may be open at once; all get every event.

### Running and building

- `npm run web` builds the UI and runs the release server.
  `npm run web:dev` runs the debug server, which reads `dist/` from disk.
- `npm run web:bundle` writes a self-contained folder and zip under `artifacts/web/` (the binary with the UI embedded, `resources/`, the picture-check helper on macOS); `-- --target x86_64-pc-windows-msvc` cross-builds the Windows one on a Mac with cargo-xwin.
- Debug builds of the server know two more environment variables, for tests: `VIDAI_WEB_NO_BROWSER` (never start a browser; print `Open VidAI Web in your browser: <address>` instead) and `VIDAI_WEB_DIST` (read the UI from that folder instead of `dist/`).
- `src-web/Cargo.toml` turns on Tauri's `custom-protocol` feature: the core and the server each build a Tauri context, and without it both would embed an `Info.plist` and a release build would not link.
- `npm run web:check` is fmt, Clippy (`-D warnings`) and the tests of `src-web/`; `npm run e2e:web` drives the real server with the fake Claude Code in a headless browser (start an edit, live log, pause, continue, stop, settings, reconnect).
- On Windows `vidai-web.exe` is a console program: the user starts it from a terminal or by double-click and its console window stays open as the place to stop it.
  The rule of section 11 that no console window may flash up still holds for every process the core starts.
  The core runs inside a Tauri application with one window that is never shown, so the server needs what a Tauri app needs: WebView2 on Windows (part of Windows 11, and of an up to date Windows 10), nothing extra on macOS.

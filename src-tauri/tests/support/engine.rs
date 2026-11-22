//! The job engine under test, shared by the integration tests of the programs that edit
//! (tests/jobs_engine.rs for Claude Code, tests/opencode_engine.rs for the OpenCode program,
//! tests/opencode2_engine.rs for the OpenCode 2 program): a
//! fake `JobHost` with a temporary store, Editing Folder and fake state folder, the real
//! `JobManager`, and the helpers that wait for states, files and log lines.
#![allow(dead_code)] // Not every test crate uses every helper.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tempfile::TempDir;

use vidai_lib::error::{AppError, AppResult, ErrorCode};
use vidai_lib::jobs::{JobHost, JobManager, Notice, Timings};
use vidai_lib::model::{
    ApiOption, Channel, ChannelProfile, ChannelVideoType, JobState, JobView, ReviewSoftware, Setup,
    VideoInputs, VideoOutput, VideoType,
};
use vidai_lib::opencode::ApiSetup;
use vidai_lib::scanner::VideoContext;
use vidai_lib::store::{Durability, Store};

pub const CHANNEL_ID: &str = "chan";
pub const CHANNEL_FOLDER: &str = "Tech";
/// Upper bound of every wait for something the test expects. Waits end as soon as the condition
/// holds, so this only decides how long a real hang takes to fail: generous, so that a machine
/// busy with many test runs at once is never mistaken for a hang.
pub const WAIT: Duration = Duration::from_secs(90);

pub struct FakeHost {
    pub store: Store,
    pub editing: PathBuf,
    pub program: PathBuf,
    pub state: PathBuf,
    pub scenario: Mutex<String>,
    pub not_ready: Mutex<Option<AppError>>,
    pub notices: Mutex<Vec<Notice>>,
    /// What the job engine knows about each API option (nothing saved unless a test sets it up).
    pub api: Mutex<HashMap<ApiOption, ApiSetup>>,
    /// `JobHost::keeps_jobs_going` (off unless a test turns it on).
    pub keeps_going: std::sync::atomic::AtomicBool,
    /// The OpenCode 2 program (`JobHost::opencode2_program`): the fake, once a test sets it up.
    pub opencode2_program: Mutex<Option<PathBuf>>,
    /// More variables of the login-shell environment (for the fakes' switches).
    pub extra_env: Mutex<Vec<(String, String)>>,
}

/// The review project the fake saves for this platform's review software (an FCPXML for Final
/// Cut Pro on macOS, a Premiere Pro XML on Windows), like the real flow.
pub fn review_extension() -> &'static str {
    match ReviewSoftware::platform_default() {
        ReviewSoftware::Fcp => "fcpxml",
        ReviewSoftware::Premiere => "xml",
    }
}

impl JobHost for FakeHost {
    fn store(&self) -> &Store {
        &self.store
    }

    fn resolve_video(&self, video_id: &str) -> AppResult<VideoContext> {
        let (channel_id, folder) = video_id
            .split_once('/')
            .ok_or_else(|| AppError::not_found("bad id"))?;
        let settings = self.store.settings();
        let channel = settings
            .channels
            .iter()
            .find(|c| c.id == channel_id)
            .ok_or_else(|| AppError::not_found("unknown channel"))?;
        let path = self.editing.join(&channel.folder_name).join(folder);
        if !path.is_dir() {
            return Err(AppError::not_found(format!(
                "The video folder is missing: {}",
                path.display()
            )));
        }
        Ok(VideoContext {
            video_id: video_id.into(),
            channel_id: channel_id.into(),
            channel_folder: channel.folder_name.clone(),
            video_folder: folder.into(),
            editing_folder: self.editing.clone(),
            path: path.clone(),
            video_type: VideoType::Long,
            broll_folder: "Broll".into(),
            main_aroll: None,
            aroll_rotation: None,
            output: self.scan_output(&path),
        })
    }

    fn scan_output(&self, video_dir: &Path) -> VideoOutput {
        // The app's own output detection: a Premiere Pro XML counts only with `<xmeml`.
        vidai_lib::scanner::scan_output(video_dir)
    }

    fn claude_program(&self, setup: Setup) -> AppResult<PathBuf> {
        match self.not_ready.lock().unwrap().clone() {
            // A job on an API option needs no Claude login, only Claude Code itself.
            Some(err)
                if setup == Setup::ClaudeSubscription
                    || err.code == ErrorCode::ClaudeNotInstalled =>
            {
                Err(err)
            }
            _ => Ok(self.program.clone()),
        }
    }

    fn opencode2_program(&self) -> AppResult<PathBuf> {
        self.opencode2_program
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| {
                AppError::invalid_input(format!(
                    "OpenCode 2 is not installed on this {}.",
                    if cfg!(windows) { "PC" } else { "Mac" }
                ))
            })
    }

    fn api_setup(&self, option: ApiOption) -> ApiSetup {
        self.api
            .lock()
            .unwrap()
            .get(&option)
            .cloned()
            .unwrap_or_else(|| {
                ApiSetup::new(option, &vidai_lib::model::Settings::default(), None, None)
            })
    }

    fn keeps_jobs_going(&self) -> bool {
        self.keeps_going.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn child_env(&self) -> HashMap<String, String> {
        let mut env = super::base_env();
        env.extend([
            (
                "FAKE_STATE".into(),
                self.state.to_string_lossy().into_owned(),
            ),
            (
                "FAKE_SCENARIO".into(),
                self.scenario.lock().unwrap().clone(),
            ),
        ]);
        env.extend(self.extra_env.lock().unwrap().iter().cloned());
        env
    }

    fn notify(&self, notice: Notice) {
        self.notices.lock().unwrap().push(notice);
    }
}

/// The fake `claude` (tests/support/fake-claude.sh), as one executable shared by every test.
pub fn fake_program() -> PathBuf {
    super::installed(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/fake-claude.sh"))
}

pub struct Env {
    pub _dir: TempDir,
    pub host: Arc<FakeHost>,
    pub jobs: JobManager,
}

/// Engine timings for the tests. The fake answers interrupts and exits when stdin closes, so the
/// limits on those waits only catch hangs and are as generous as `WAIT`. The settle time is what
/// a job must stay idle before it counts as finished: the fake can look idle for a moment
/// between two lines (a finished background task is reported before the turn it starts, as with
/// the real Claude Code), so it is long enough for any scheduling delay, while still short
/// enough to keep the tests quick. The stall timeout never fires in a test. Saving the log and the
/// job state and re-reading the process tree (with `ps`) are paced like in the app, only a few
/// times faster, so that many test processes at once do not flood the machine with them.
pub fn timings() -> Timings {
    Timings {
        settle: Duration::from_secs(1),
        interrupt_timeout: WAIT,
        exit_timeout: WAIT,
        kill_grace: Duration::from_millis(300),
        stall_timeout: Duration::from_secs(60 * 60),
        log_interval: Duration::from_millis(100),
        progress_interval: Duration::from_millis(250),
        tree_refresh: Duration::from_secs(5),
        // Each Env sets the delay setting (0 unless a test asks for one) and its own minute.
        start_delay_minute: Duration::from_secs(60),
        // A retry wait of 30 "seconds" lasts 150 ms.
        retry_second: Duration::from_millis(5),
        server_start: Default::default(),
    }
}

impl Env {
    pub fn new(scenario: &str) -> Self {
        Self::with_videos(scenario, &["Video A"], 3)
    }

    pub fn with_videos(scenario: &str, videos: &[&str], max: u32) -> Self {
        Self::with_delay(scenario, videos, max, 0, Duration::from_secs(60))
    }

    /// With a start delay of `delay_minutes` minutes of `minute` each.
    pub fn with_delay(
        scenario: &str,
        videos: &[&str],
        max: u32,
        delay_minutes: u32,
        minute: Duration,
    ) -> Self {
        Self::build(
            scenario,
            videos,
            max,
            delay_minutes,
            Timings {
                start_delay_minute: minute,
                ..timings()
            },
        )
    }

    /// With jobs that keep themselves going (SPEC section 6, "Keeping a job going"), as on an
    /// Apple Silicon Mac, and the given settle time.
    pub fn keeping_going(scenario: &str, settle: Duration) -> Self {
        let env = Self::build(
            scenario,
            &["Video A"],
            3,
            0,
            Timings {
                settle,
                ..timings()
            },
        );
        env.host
            .keeps_going
            .store(true, std::sync::atomic::Ordering::SeqCst);
        env
    }

    pub fn build(
        scenario: &str,
        videos: &[&str],
        max: u32,
        delay_minutes: u32,
        timings: Timings,
    ) -> Self {
        let dir = TempDir::new().unwrap();
        let root = super::real_path(dir.path());
        let editing = root.join("Editing");
        for v in videos {
            fs::create_dir_all(editing.join(CHANNEL_FOLDER).join(v)).unwrap();
        }
        let state = root.join("fake-state");
        fs::create_dir_all(&state).unwrap();
        let program = fake_program();
        let store = Store::open_with(root.join("data"), Durability::Unsynced).unwrap();
        store
            .update_settings(|s| {
                s.editing_folder = Some(editing.to_string_lossy().into_owned());
                s.max_concurrent_edits = max;
                s.start_delay_minutes = delay_minutes;
                // Retries after a model error are opt-in per test (`Env::retries`).
                s.max_model_retries = 0;
                s.model = Some("opus".into());
                s.effort = Some("high".into());
                s.channels = vec![Channel {
                    id: CHANNEL_ID.into(),
                    folder_name: CHANNEL_FOLDER.into(),
                    video_type: ChannelVideoType::Auto,
                    long: ChannelProfile::with_defaults(
                        "Edit this video.".into(),
                        "Yellow captions.".into(),
                    ),
                    short: ChannelProfile::default(),
                }];
                Ok(())
            })
            .unwrap();
        let host = Arc::new(FakeHost {
            store,
            editing,
            program,
            state,
            scenario: Mutex::new(scenario.into()),
            not_ready: Mutex::new(None),
            notices: Mutex::new(Vec::new()),
            api: Mutex::new(HashMap::new()),
            keeps_going: std::sync::atomic::AtomicBool::new(false),
            opencode2_program: Mutex::new(None),
            extra_env: Mutex::new(Vec::new()),
        });
        let jobs = JobManager::new(host.clone(), timings);
        Self {
            _dir: dir,
            host,
            jobs,
        }
    }

    /// Allows `n` retries after a model error (the tests default to none).
    pub fn retries(&self, n: u32) {
        self.host
            .store
            .update_settings(|s| {
                s.max_model_retries = n;
                Ok(())
            })
            .unwrap();
    }

    pub fn scenario(&self, s: &str) {
        *self.host.scenario.lock().unwrap() = s.into();
    }

    pub fn vid(name: &str) -> String {
        format!("{CHANNEL_ID}/{name}")
    }

    pub fn video_dir(&self, name: &str) -> PathBuf {
        self.host.editing.join(CHANNEL_FOLDER).join(name)
    }

    pub fn start(&self, name: &str) -> JobView {
        self.jobs
            .start_edit(
                &Self::vid(name),
                VideoInputs {
                    product_links: "https://shop.example/1".into(),
                    notes: "Keep it short.".into(),
                    ..VideoInputs::default()
                },
            )
            .unwrap()
    }

    pub fn job(&self, name: &str) -> JobView {
        self.jobs.job(&Self::vid(name)).expect("job exists")
    }

    pub fn wait_state(&self, name: &str, state: JobState) -> JobView {
        let deadline = Instant::now() + WAIT;
        loop {
            let job = self.job(name);
            if job.state == state {
                return job;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {state:?}, job is {job:#?}\nlog: {:#?}",
                self.log_texts(name)
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn wait_file(&self, path: &Path) {
        let deadline = Instant::now() + WAIT;
        while !path.exists() {
            assert!(Instant::now() < deadline, "timed out waiting for {path:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Waits until the log contains a line with `text`.
    pub fn wait_log(&self, name: &str, text: &str) {
        let deadline = Instant::now() + WAIT;
        while !self.log_texts(name).iter().any(|t| t.contains(text)) {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for log line {text:?}: {:#?}",
                self.log_texts(name)
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn log_texts(&self, name: &str) -> Vec<String> {
        self.jobs
            .job_log(&Self::vid(name))
            .unwrap()
            .into_iter()
            .map(|e| e.text)
            .collect()
    }

    /// The recorded calls of the fake claude, oldest first: `key=value` maps plus the stdin.
    pub fn calls(&self) -> Vec<(HashMap<String, String>, String)> {
        let Ok(list) = fs::read_to_string(self.host.state.join("calls")) else {
            return Vec::new();
        };
        list.lines()
            .map(|pid| {
                let info = fs::read_to_string(self.host.state.join(format!("call.{pid}"))).unwrap();
                let map = info
                    .lines()
                    .filter_map(|l| l.split_once('='))
                    .map(|(k, v)| (k.to_owned(), v.to_owned()))
                    .collect();
                let stdin = fs::read_to_string(self.host.state.join(format!("in.{pid}")))
                    .unwrap_or_default();
                (map, stdin)
            })
            .collect()
    }

    /// The text of the first user message a call received.
    pub fn message_of(stdin: &str) -> String {
        let line = stdin
            .lines()
            .find(|l| l.contains("\"type\":\"user\""))
            .expect("a user message");
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        v["message"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    pub fn notices(&self) -> Vec<Notice> {
        self.host.notices.lock().unwrap().clone()
    }

    pub fn release(&self, name: &str) {
        fs::write(self.host.state.join(format!("release.{name}")), "").unwrap();
        super::wake_fakes(&self.host.state);
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        // Never leave fake processes behind, even when a test fails.
        let _ = self.jobs.pause_all_for_quit(WAIT);
    }
}

/// A path the fake printed (`$PWD`), as a native path. Git Bash on Windows prints `/c/Users/...`.
pub fn native_path(printed: &str) -> PathBuf {
    #[cfg(windows)]
    if let Some(rest) = printed.strip_prefix('/')
        && let Some((drive, rest)) = rest.split_once('/')
        && drive.len() == 1
    {
        return PathBuf::from(format!(
            "{}:\\{}",
            drive.to_uppercase(),
            rest.replace('/', "\\")
        ));
    }
    PathBuf::from(printed)
}

/// Whether a process the fake reported (`$$`, `$!`) still runs. On Windows those are Git Bash
/// (MSYS) process ids, so Git Bash itself is asked.
#[cfg(windows)]
pub fn alive(pid: u32) -> bool {
    let env: HashMap<String, String> = std::env::vars().collect();
    let bash = vidai_lib::platform::windows::git_bash(&env).expect("Git Bash is installed");
    std::process::Command::new(bash)
        .args(["-c", &format!("kill -0 {pid}")])
        .output()
        .is_ok_and(|o| o.status.success())
}

/// Whether a process that is not a Git Bash one (the fake OpenCode 2 is a Python program, its pid
/// a Windows one) still runs: `alive` on a Mac, `tasklist` on Windows.
#[cfg(windows)]
#[allow(dead_code)] // Not every test crate needs it.
pub fn alive_native(pid: u32) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")))
}

#[cfg(unix)]
#[allow(dead_code)] // Not every test crate needs it.
pub fn alive_native(pid: u32) -> bool {
    alive(pid)
}

#[cfg(unix)]
pub fn alive(pid: u32) -> bool {
    std::process::Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .map(|o| {
            let stat = String::from_utf8_lossy(&o.stdout);
            let stat = stat.trim();
            !stat.is_empty() && !stat.starts_with('Z')
        })
        .unwrap_or(false)
}
pub const OPENCODE_KEY: &str = "oc_sk_SECRETOPENCODE987";
pub const OPENCODE_URL: &str = "http://127.0.0.1:9/inference/go/anthropic";
pub const OPENCODE_VARS: [&str; 5] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

impl Env {
    /// `option` set up with the test key, the test address and `model`, and selected for new
    /// edits.
    fn use_api(&self, option: ApiOption, setup: Setup, model: &str) {
        self.host.api.lock().unwrap().insert(
            option,
            ApiSetup {
                option,
                key: Some(OPENCODE_KEY.into()),
                base_url: OPENCODE_URL.into(),
                model: Some(model.into()),
                offered: None,
            },
        );
        self.host
            .store
            .update_settings(|s| {
                s.setup = setup;
                s.api_options.get_mut(option).model = Some(model.into());
                Ok(())
            })
            .unwrap();
    }

    /// The Anthropic Compatible API (Claude Code through a gateway) set up with a key and `model`,
    /// and selected for new edits.
    pub fn use_anthropic_api(&self, model: &str) {
        self.use_api(ApiOption::AnthropicApi, Setup::AnthropicApi, model);
    }

    /// The Anthropic Compatible API set up without a key (a server that needs none) and `model`,
    /// selected for new edits.
    pub fn use_anthropic_api_without_key(&self, model: &str) {
        self.use_anthropic_api(model);
        self.remove_api_key(ApiOption::AnthropicApi);
    }

    /// Remembers a reasoning effort for a model of `option`, as Settings does.
    pub fn set_api_effort(&self, option: ApiOption, model: &str, effort: &str) {
        self.host
            .store
            .update_settings(|s| {
                s.api_options
                    .get_mut(option)
                    .efforts
                    .insert(model.into(), effort.into());
                Ok(())
            })
            .unwrap();
    }

    pub fn select(&self, setup: Setup) {
        self.host
            .store
            .update_settings(|s| {
                s.setup = setup;
                Ok(())
            })
            .unwrap();
    }

    /// Changes what the engine knows about `option` (its address, key).
    pub fn edit_api(&self, option: ApiOption, change: impl FnOnce(&mut ApiSetup)) {
        let mut api = self.host.api.lock().unwrap();
        change(api.get_mut(&option).expect("the option is set up"));
    }

    pub fn remove_api_key(&self, option: ApiOption) {
        self.edit_api(option, |api| api.key = None);
    }
}

impl Env {
    /// The `variant` (reasoning effort) each message the fake OpenCode received for `session` asked
    /// for, oldest first; an OpenCode 2 session has it in its model.
    pub fn opencode_variants(&self, session: &str) -> Vec<Option<String>> {
        let path = self.host.state.join(format!("prompts.{session}"));
        let Ok(text) = fs::read_to_string(path) else {
            return Vec::new();
        };
        text.lines()
            .map(|l| {
                let v: serde_json::Value = serde_json::from_str(l).unwrap();
                v["variant"]
                    .as_str()
                    .or_else(|| v["model"]["variant"].as_str())
                    .map(str::to_owned)
            })
            .collect()
    }

    /// The messages the fake OpenCode received for `session`, oldest first: the model each asked
    /// for and the text.
    pub fn opencode_prompts(&self, session: &str) -> Vec<(serde_json::Value, String)> {
        let path = self.host.state.join(format!("prompts.{session}"));
        let Ok(text) = fs::read_to_string(path) else {
            return Vec::new();
        };
        text.lines()
            .map(|l| {
                let v: serde_json::Value = serde_json::from_str(l).unwrap();
                let text = v["text"].as_str().unwrap_or_default().to_owned();
                (v["model"].clone(), text)
            })
            .collect()
    }
}

/// The fake OpenCode 2 program (tests/support/fake-opencode2.py), as one executable shared by
/// every test.
pub fn fake_opencode2() -> PathBuf {
    super::installed(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/fake-opencode2.py"))
}

impl Env {
    /// OpenCode Go set up with a key and `model` and selected for new edits; the OpenCode 2
    /// program is the fake.
    pub fn use_opencode2_program(&self, model: &str) {
        self.use_api(ApiOption::OpencodeGo, Setup::OpencodeGo, model);
        *self.host.opencode2_program.lock().unwrap() = Some(fake_opencode2());
    }

    /// The OpenAI Compatible API set up with a key and `model` and selected for new edits; the
    /// OpenCode 2 program is the fake.
    pub fn use_opencode2_openai(&self, model: &str) {
        self.use_api(ApiOption::OpenaiApi, Setup::OpenaiApi, model);
        *self.host.opencode2_program.lock().unwrap() = Some(fake_opencode2());
    }

    /// The OpenAI Compatible API set up without a key (a server that needs none) and `model`,
    /// selected for new edits; the OpenCode 2 program is the fake.
    pub fn use_opencode2_openai_without_key(&self, model: &str) {
        self.use_opencode2_openai(model);
        self.remove_api_key(ApiOption::OpenaiApi);
    }

    /// The OpenCode 2 program is gone from this computer.
    pub fn remove_opencode2_program(&self) {
        *self.host.opencode2_program.lock().unwrap() = None;
    }

    /// The recorded servers of the fake OpenCode 2, oldest first, as `key=value` maps.
    pub fn opencode2_calls(&self) -> Vec<HashMap<String, String>> {
        let Ok(list) = fs::read_to_string(self.host.state.join("opencode2.calls")) else {
            return Vec::new();
        };
        list.lines()
            .map(|pid| {
                fs::read_to_string(self.host.state.join(format!("call.{pid}")))
                    .unwrap()
                    .lines()
                    .filter_map(|l| l.split_once('='))
                    .map(|(k, v)| (k.to_owned(), v.to_owned()))
                    .collect()
            })
            .collect()
    }

    /// A variable of the login-shell environment, for the fakes' switches.
    pub fn set_env(&self, name: &str, value: &str) {
        let mut env = self.host.extra_env.lock().unwrap();
        env.retain(|(k, _)| k != name);
        env.push((name.to_owned(), value.to_owned()));
    }
}

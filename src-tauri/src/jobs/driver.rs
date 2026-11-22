//! One thread per running job: prepares the launch, drives the Claude process, decides when
//! Claude is finished, handles pause and stop, and reports the [`Outcome`] to the manager.
//!
//! The driver owns its `Session` and `ProcessTree`. It receives the session's events and the
//! manager's requests on one channel ([`DriverMsg`]) and waits on it with a timeout, so there is
//! no polling and every wait is bounded. It takes the manager lock only through the small
//! `Inner` methods (`set_session`, `set_progress`, `finish_driver`), never while writing to the
//! process or waiting for it.
//!
//! Completion (SPEC section 6): a `result` ends one turn, not the job. The job is finished when
//! the `TurnTracker` says every message is answered, no turn is in progress, no background task
//! is active, and nothing has arrived for the settle time. Then stdin is closed, the process
//! exits by itself, leftovers of the process tree are ended, and the expected output is checked
//! on disk.
//!
//! Keeping a job going (SPEC section 6, where `JobHost::keeps_jobs_going` says so): when Claude
//! looks finished, the driver does not close the process at once. It asks `jobs::keepgoing`
//! whether the job is really done, from the evidence (the completion marker, the expected output
//! on disk, the progress), and otherwise sends the next message itself, in the same live
//! session, until the job is done or there is a real reason to stop. A continuation is written
//! only while the job's [`Halt`] is open: the manager closes it before it asks for a pause or a
//! stop, so none is ever sent after one.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};

use crate::claude::protocol::{Block, NO_CONVERSATION_FOUND, StreamEvent, TurnResult};
use crate::claude::session::{
    Activity, ExitInfo, Observed, Session, SessionConfig, SessionEvent, SessionMode, TurnTracker,
};
use crate::error::ErrorCode;
use crate::harness::AgentProcess;
use crate::jobs::errors;
use crate::jobs::host::Notice;
use crate::jobs::keepgoing::{self, Decision, Evidence, Keeper, Limits, Turn};
use crate::jobs::log::{Describer, Draft, Paths, first_line};
use crate::jobs::manager::{Inner, Plan};
use crate::jobs::progress::{Milestone, Tracker};
use crate::jobs::prompt::{self, EditPrompt, SidewaysAroll};
use crate::jobs::retry;
use crate::jobs::runner::{self, Choice, Problem, Runner};
use crate::model::{ApiOption, Harness, Setup};
use crate::model::{JobKind, JobView, LogKind, VideoOutput, VideoType};
use crate::opencode;
use crate::opencode::harness::child::Gateway;
use crate::opencode::harness::server2::{self, Server2, SessionStart};
use crate::opencode::http::{Service, failure_text_for};
use crate::platform::process::{self, ProcInfo, ProcessTree};

/// Messages to a driver: its process's events and the manager's requests.
#[derive(Debug)]
pub(crate) enum DriverMsg {
    Session(SessionEvent),
    Pause,
    Stop,
}

/// Whether the driver may still send a message of its own. The manager closes it, under its
/// lock, before it sends a pause or a stop; the driver writes a continuation only while holding
/// it open, so a continuation is either written before the request or not at all. The lock is
/// held for one short write to the process's stdin, nothing else.
#[derive(Debug, Clone, Default)]
pub(crate) struct Halt(Arc<Mutex<bool>>);

impl Halt {
    /// No continuation is sent any more.
    pub(crate) fn close(&self) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = true;
    }

    fn is_closed(&self) -> bool {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `f` unless the halt is closed, keeping it open meanwhile.
    fn while_open<T>(&self, f: impl FnOnce() -> T) -> Option<T> {
        let closed = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        (!*closed).then(f)
    }
}

/// How a job's run ended.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Outcome {
    Completed { file: Option<String> },
    Failed(String),
    Paused,
    Stopped,
}

/// How one Claude process ended.
enum ProcessEnd {
    Finished,
    /// The job is done (decided while keeping it going).
    Completed(String),
    ResumeNotFound,
    /// Nothing was spawned: the session belongs to another video (`Inner::claim_session`).
    SessionTaken,
    Paused,
    Stopped,
    Failed(String),
    /// The model provider failed in a way that may pass; `message` is the error to show if the
    /// job gives up (`Driver::wait_to_retry`).
    ModelError {
        failure: retry::Failure,
        message: String,
    },
}

/// What a launch in the OpenCode program needs besides the program and the environment.
struct OpencodeRun {
    option: ApiOption,
    /// `None` on an option whose key is optional and not saved.
    key: Option<String>,
    /// The normalized address (`None`: the default).
    base_url: Option<String>,
    model: String,
    /// The title of a new session (so OpenCode spends no model call on one).
    title: String,
}

/// Everything a launch needs, prepared before any process starts.
struct Launch {
    /// The program the session runs in (`JobView::harness`).
    harness: Harness,
    /// Set for the OpenCode program.
    opencode: Option<OpencodeRun>,
    program: PathBuf,
    cwd: PathBuf,
    env: std::collections::HashMap<String, String>,
    mode: SessionMode,
    message: String,
    /// The message for a new session if `--resume` fails because the session is gone.
    fallback: String,
    /// What to say in the log when the message is sent.
    sent_line: String,
    video_dir: PathBuf,
}

impl Launch {
    /// Switches to a brand new session that gets the full instructions (the session cannot be
    /// resumed, or belongs to another video). In the OpenCode program the id is OpenCode's
    /// choice; the one made here is not used.
    fn fall_back(&mut self) {
        self.mode = SessionMode::New(uuid::Uuid::new_v4().to_string());
        self.message = self.fallback.clone();
        self.sent_line = "Sent the full instructions to the new session".into();
    }

    /// The program as the log names it.
    fn program_name(&self) -> &'static str {
        match self.harness {
            Harness::ClaudeCode => "Claude Code",
            Harness::Opencode2 => "OpenCode 2",
        }
    }
}

pub(crate) fn run(
    inner: Arc<Inner>,
    job: JobView,
    plan: Plan,
    origin: Option<Plan>,
    tx: Sender<DriverMsg>,
    rx: Receiver<DriverMsg>,
    halt: Halt,
) {
    let progress = Tracker::start(inner.host.as_ref(), &job);
    let mut driver = Driver {
        keeps_going: inner.host.keeps_jobs_going(),
        keeper: Keeper::new(Limits::DEFAULT, progress.work_shown()),
        turn: Turn::default(),
        halt,
        inner: Arc::clone(&inner),
        progress,
        job,
        tx,
        rx,
        activity: None,
        cost: None,
        last_progress: Instant::now(),
        limit: None,
        retries: 0,
        retry_work: 0,
        origin: origin.clone(),
    };
    driver.retry_work = driver.progress.work_shown();
    let outcome = match driver.prepare(plan, origin) {
        Err(message) => Outcome::Failed(message),
        Ok(launch) => driver.run_launch(launch),
    };
    driver.flush_progress(true);
    if let Outcome::Completed { .. } = outcome {
        driver
            .progress
            .record_completion(inner.host.store(), &driver.job);
    }
    if matches!(&outcome, Outcome::Failed(message) if *message == errors::logged_out()) {
        inner.host.notify(Notice::LoginLost);
    }
    let job = driver.job.clone();
    drop(driver);
    inner.finish_driver(&job, outcome);
}

struct Driver {
    inner: Arc<Inner>,
    job: JobView,
    tx: Sender<DriverMsg>,
    rx: Receiver<DriverMsg>,
    activity: Option<String>,
    cost: Option<f64>,
    progress: Tracker,
    last_progress: Instant,
    /// `Some(reset)` once any process of this run hit a usage limit.
    limit: Option<Option<i64>>,
    /// This job keeps itself going (`JobHost::keeps_jobs_going`); otherwise it ends when Claude
    /// goes quiet, as before.
    keeps_going: bool,
    /// The decisions of keeping the job going, for this run (a Continue starts a new one).
    keeper: Keeper,
    /// What the main conversation did since the last message was sent.
    turn: Turn,
    halt: Halt,
    /// How the job started (for a retry of a job that has no session yet).
    origin: Option<Plan>,
    /// Retries after a model error since the job last made progress (SPEC section 6, "Retrying
    /// after a model error"), and the work the job had shown at the last failure.
    retries: u32,
    retry_work: usize,
}

/// The state of one running Claude process.
struct Proc {
    /// Claude Code or the OpenCode program (`harness::AgentProcess`).
    session: Box<dyn AgentProcess>,
    tree: ProcessTree,
    tracker: TurnTracker,
    describer: Describer,
    /// `Some(reset)` once a `rate_limit_event` said the limit is reached.
    limit: Option<Option<i64>>,
    /// An error result that still has to be handled.
    error: Option<TurnResult>,
    /// An interrupt was sent; its aborted result is expected and not an error.
    interrupting: Option<String>,
    /// The halt was found closed: a pause or stop is on its way, nothing more is decided.
    halted: bool,
    interrupt_answered: bool,
    last_tree_refresh: Instant,
    /// CPU time of the processes of the job's tree (the model host itself left out) at the last
    /// refresh, and when; what the model's own commands do to the computer.
    cpu: BTreeMap<u32, u64>,
    cpu_at: Instant,
    /// The computer is busy with the model's commands until then.
    busy_until: Option<Instant>,
    /// When the model was last asked to wait for its running commands.
    last_wait_message: Option<Instant>,
}

/// A process of the job's tree must use at least this share of a core between two refreshes to
/// count as busy; a download or an idle server does not.
const BUSY_CPU_SHARE: f64 = 0.1;
/// Busy stays true this long after the last time something was, so a command that works in bursts
/// is not taken for finished.
const BUSY_HOLD: Duration = Duration::from_secs(90);
/// The model that waits for its busy commands is reminded at most this often.
const WAIT_MESSAGE_EVERY: Duration = Duration::from_secs(300);

impl Driver {
    fn log(&self, draft: Draft) {
        self.inner.log(&self.job.video_id, &self.job.id, draft);
    }

    fn timings(&self) -> &crate::jobs::manager::Timings {
        &self.inner.timings
    }

    // ----- preparation -----

    /// The executable for `runner`, or what is wrong with it.
    fn program_for(&self, runner: &Runner) -> Result<PathBuf, Problem> {
        if let Some(option) = runner.setup.api_option() {
            let api = self.inner.host.api_setup(option);
            if let Some(problem) = runner::api_problem(runner, &api) {
                return Err(problem);
            }
        }
        if runner.harness == Harness::Opencode2 {
            return self
                .inner
                .host
                .opencode2_program()
                .map_err(|err| Problem::Api(err.message));
        }
        self.inner
            .host
            .claude_program(runner.setup)
            .map_err(|err| match err.code {
                ErrorCode::ClaudeNotLoggedIn => Problem::LoggedOut(errors::logged_out()),
                ErrorCode::ClaudeNotInstalled => Problem::NotInstalled(
                    if cfg!(windows) {
                        "Claude Code is not installed on this PC. Install it, then press Continue Editing."
                    } else {
                        "Claude Code is not installed on this Mac. Install it, then press Continue Editing."
                    }
                    .to_owned(),
                ),
                _ => Problem::Other(err.message),
            })
    }

    /// The executable for this job, on its own runner or, when a resumed session cannot run
    /// there now, on the current selection (`runner::choose`). Returns the log line of such a
    /// switch; the job then records its new runner.
    fn choose_program(&mut self, resuming: bool) -> Result<(PathBuf, Option<String>), String> {
        let own = Runner::of(&self.job);
        let problem = match self.program_for(&own) {
            Ok(program) => return Ok((program, None)),
            Err(problem) => problem,
        };
        let current = runner::current(&self.inner.host.store().settings());
        let mut current_program = None;
        let choice = runner::choose(&own, Some(problem), resuming, &current, || {
            match self.program_for(&current) {
                Ok(program) => {
                    current_program = Some(program);
                    None
                }
                Err(problem) => Some(problem),
            }
        });
        match (choice, current_program) {
            (Choice::SwitchTo(runner, line), Some(program)) => {
                if let Some(job) = self
                    .inner
                    .set_runner(&self.job.video_id, &self.job.id, &runner)
                {
                    self.job = job;
                }
                Ok((program, Some(line)))
            }
            (Choice::Fail(message), _) => Err(message),
            (Choice::Keep | Choice::SwitchTo(..), _) => {
                Err("Claude Code could not be started for this job.".to_owned())
            }
        }
    }

    fn prepare(&mut self, plan: Plan, origin: Option<Plan>) -> Result<Launch, String> {
        // A continue without a session starts the job's original request again.
        let plan = match (plan, &self.job.session_id) {
            (Plan::Continue { .. }, None) => match origin {
                Some(origin) if !matches!(origin, Plan::Continue { .. }) => origin,
                _ => Plan::Continue {
                    after_failure: None,
                },
            },
            (plan, _) => plan,
        };
        let resuming = match &plan {
            Plan::Edit => false,
            Plan::ReEdit { resume, .. } | Plan::Render { resume, .. } => resume.is_some(),
            Plan::Continue { .. } => self.job.session_id.is_some(),
        };
        let (program, switched) = self.choose_program(resuming)?;
        let host = &self.inner.host;
        let ctx = host
            .resolve_video(&self.job.video_id)
            .map_err(|e| e.message)?;
        if !ctx.editing_folder.is_dir() {
            return Err(errors::editing_folder_missing(&ctx.editing_folder));
        }
        if !ctx.path.is_dir() {
            return Err(errors::video_folder_missing(&ctx.path));
        }
        let store = host.store();
        let settings = store.settings();
        let channel = settings
            .channels
            .iter()
            .find(|c| c.id == ctx.channel_id)
            .ok_or("This video's channel is no longer in VidAI.")?;
        let profile = match self.job.video_type {
            VideoType::Long => &channel.long,
            VideoType::Short => &channel.short,
        };
        let mut env = host.child_env();
        let harness = self.job.harness();
        let mut opencode_run = None;
        if let Some(option) = self.job.setup.api_option() {
            // `choose_program` made sure the key and the model are there.
            let setup = host.api_setup(option);
            // The key is optional on options 3 and 4 (`ApiOption::key_required`).
            let key = setup.key.as_deref();
            let model = self.job.model.as_deref();
            let Some(model) = model.filter(|_| key.is_some() || !option.key_required()) else {
                return Err("The API option is not set up. Fix it in Settings, Harness + API Keys, then press Continue Editing.".to_owned());
            };
            if let Some(key) = key {
                self.inner.logs.add_secret_as(key, opencode::SCRUBBED);
            }
            match harness {
                // Claude Code pointed at OpenCode's gateway.
                Harness::ClaudeCode => opencode::job_env(&mut env, &setup.base_url, key, model),
                // The OpenCode 2 program gets the key in their own variable (`opencode::harness`).
                Harness::Opencode2 => {
                    opencode_run = Some(OpencodeRun {
                        option,
                        key: key.map(str::to_owned),
                        base_url: Some(setup.base_url.clone()),
                        model: model.to_owned(),
                        title: format!("VidAI: {}/{}", ctx.channel_folder, ctx.video_folder),
                    });
                }
            }
        }
        let job_setup = self.job.setup;
        let inputs = store.video(&self.job.video_id).inputs;
        let edit = EditPrompt {
            video_folder: &ctx.video_folder,
            channel_folder: &ctx.channel_folder,
            video_type: self.job.video_type,
            broll_folder: &ctx.broll_folder,
            toolkit: self.job.toolkit,
            review_software: settings.review_software,
            product_links: &inputs.product_links,
            notes: &inputs.notes,
            channel_prompt: profile.prompt_text(inputs.prompt_slot),
            channel_style: profile.style_text(inputs.style_slot),
            sideways_aroll: ctx.aroll_rotation.zip(ctx.main_aroll.as_deref()).map(
                |(rotation, file_name)| SidewaysAroll {
                    file_name,
                    rotation,
                },
            ),
            machine: Some(host.machine_facts()),
            setup: job_setup,
            harness,
        };
        let newest = ctx.output.review_files.first().map(|f| f.name.clone());

        let new_session = || SessionMode::New(uuid::Uuid::new_v4().to_string());
        let (mode, body, sent_line): (SessionMode, Option<String>, &'static str) = match &plan {
            Plan::Edit => (new_session(), None, "Sent the edit instructions to Claude"),
            Plan::ReEdit { changes, resume } => (
                resume.clone().map_or_else(new_session, SessionMode::Resume),
                Some(prompt::re_edit_body(changes)),
                "Sent the re-edit request to Claude",
            ),
            Plan::Render { request, resume } => (
                resume.clone().map_or_else(new_session, SessionMode::Resume),
                Some(prompt::render_body(
                    request.timeline_export_path.as_deref(),
                    &request.notes,
                )),
                "Asked Claude to render the final output",
            ),
            Plan::Continue { after_failure } => (
                self.job
                    .session_id
                    .clone()
                    .map_or_else(new_session, SessionMode::Resume),
                Some(prompt::continue_body_in(*after_failure, harness)),
                "Asked Claude to continue",
            ),
        };
        // The OpenCode 2 program is named as such; Claude Code's lines stay as they were.
        let sent_line = match harness {
            Harness::ClaudeCode => sent_line.to_owned(),
            Harness::Opencode2 => sent_line.replace("Claude", "OpenCode 2"),
        };
        let fallback = match &body {
            Some(body) => prompt::compose_fallback(&edit, newest.as_deref(), body),
            None => prompt::compose_edit(&edit),
        };
        let message = match (&mode, &body) {
            (SessionMode::Resume(_), Some(body)) => prompt::follow_up_on(body, job_setup),
            // A new session gets everything: the plain composition for an edit, otherwise the
            // composition plus what was done before plus the request.
            _ => fallback.clone(),
        };
        if harness.is_opencode_program() && opencode_run.is_none() {
            return Err(
                "Only an edit on OpenCode Go or an OpenAI Compatible API can run in the OpenCode 2 program. Check Settings, Harness + API Keys, then press Continue Editing."
                    .to_owned(),
            );
        }
        // A re-edit changes the whole project: keep the output of before as it is (SPEC section 2).
        // A failed copy fails the launch, so the re-edit never starts without its backup.
        if matches!(plan, Plan::ReEdit { .. }) {
            match crate::jobs::backup::backup_output(&ctx.path) {
                Ok(Some(dir)) => {
                    let name = dir.file_name().unwrap_or_default().to_string_lossy();
                    self.log(Draft::status(format!(
                        "Copied the output folder to {name} before the re-edit"
                    )));
                }
                Ok(None) => {}
                Err(err) => {
                    return Err(format!(
                        "Could not back up the output folder before the re-edit, so it was not started: {err}"
                    ));
                }
            }
        }
        let mut launch = Launch {
            harness,
            opencode: opencode_run,
            program,
            cwd: ctx.editing_folder.clone(),
            env,
            mode,
            message,
            fallback,
            sent_line,
            video_dir: ctx.path.clone(),
        };
        if let Some(line) = switched {
            self.log(Draft::status(line));
            launch.fall_back();
        }
        Ok(launch)
    }

    // ----- running -----

    fn run_launch(&mut self, mut launch: Launch) -> Outcome {
        let mut fell_back = false;
        // A fresh random session id is never taken; the bound only guards against a broken
        // generator.
        let mut taken = 0;
        loop {
            let end = self.run_process(&launch);
            match self.quiet_limit_retry(end, &launch) {
                ProcessEnd::SessionTaken if taken < 3 => {
                    taken += 1;
                    self.log(Draft::status(match launch.harness {
                        Harness::ClaudeCode => "This video's Claude session also belongs to another video, so a new session gets the full instructions.",
                        Harness::Opencode2 => "This video's OpenCode session also belongs to another video, so a new session gets the full instructions.",
                    }));
                    launch.fall_back();
                }
                ProcessEnd::SessionTaken => {
                    return Outcome::Failed(format!(
                        "{} could not start a session of its own for this video.",
                        launch.program_name()
                    ));
                }
                ProcessEnd::ResumeNotFound if !fell_back => {
                    fell_back = true;
                    self.log(Draft::status(format!(
                        "{} no longer has the earlier session, so a new session gets the full instructions.",
                        launch.program_name()
                    )));
                    launch.fall_back();
                }
                ProcessEnd::ResumeNotFound => {
                    return Outcome::Failed(format!(
                        "{} could not resume or start the session.",
                        launch.program_name()
                    ));
                }
                // When Claude ended quietly after hitting a usage limit, a missing output says so.
                ProcessEnd::Finished => return self.check_output(&launch.video_dir, self.limit),
                ProcessEnd::Completed(file) => return Outcome::Completed { file: Some(file) },
                ProcessEnd::Paused => return Outcome::Paused,
                ProcessEnd::Stopped => return Outcome::Stopped,
                ProcessEnd::Failed(message) => return Outcome::Failed(message),
                ProcessEnd::ModelError { failure, message } => {
                    if let Err(outcome) = self.wait_to_retry(&failure, &message) {
                        return outcome;
                    }
                    self.limit = None;
                    // The same session goes on, like Continue Editing; a job that never got a
                    // session starts its own request again.
                    let plan = Plan::Continue {
                        after_failure: None,
                    };
                    launch = match self.prepare(plan, self.origin.clone()) {
                        Ok(launch) => launch,
                        Err(message) => return Outcome::Failed(message),
                    };
                    fell_back = false;
                }
            }
        }
    }

    /// Waits before the next retry after a model error, or says how the job ends instead:
    /// retries used up, a pause or a stop (SPEC section 6, "Retrying after a model error").
    /// The job stays `running` and keeps its slot meanwhile.
    fn wait_to_retry(&mut self, failure: &retry::Failure, message: &str) -> Result<(), Outcome> {
        let max = self.inner.host.store().settings().max_model_retries;
        let shown = self.progress.work_shown();
        if shown > self.retry_work {
            self.retries = 0;
        }
        self.retry_work = shown;
        if self.retries >= max {
            return Err(Outcome::Failed(if self.retries == 0 {
                message.to_owned()
            } else {
                errors::retries_used_up(message, self.retries)
            }));
        }
        self.retries += 1;
        let retry_number = self.retries;
        let now = self.now();
        let unit = self.timings().retry_second.as_secs_f64();
        let scheduled = Duration::from_secs_f64(retry::gap(retry_number).as_secs_f64() * unit);
        let wait = retry::wait(scheduled, failure.reset, now);
        let at = now + chrono::Duration::from_std(wait).unwrap_or_default();
        let count = format!("retry {retry_number} of {max}");
        self.log(Draft::status(format!(
            "Model error ({}). Retrying in {} ({count})",
            failure.what,
            retry::in_words(wait)
        )));
        let activity = format!(
            "Model error. Retrying at {} ({count})",
            retry::clock(at, now)
        );
        self.activity = None;
        self.inner
            .set_progress(&self.job.video_id, &self.job.id, Some(activity), None, None);
        // On the wall clock with short waits: the time of a reset is a wall clock time, and a Mac
        // that slept must not wait out the rest of a long wait.
        while let Ok(left) = (at - self.now()).to_std() {
            if left.is_zero() {
                break;
            }
            match self.rx.recv_timeout(left.min(Duration::from_secs(1))) {
                Ok(DriverMsg::Stop) | Err(RecvTimeoutError::Disconnected) => {
                    return Err(Outcome::Stopped);
                }
                Ok(DriverMsg::Pause) => return Err(Outcome::Paused),
                // Late events of the process that ended.
                Ok(DriverMsg::Session(_)) | Err(RecvTimeoutError::Timeout) => {}
            }
        }
        self.log(Draft::status(format!("Retrying now ({count})")));
        self.activity = Some(format!("Retrying ({count})"));
        Ok(())
    }

    fn run_process(&mut self, launch: &Launch) -> ProcessEnd {
        // A request that arrived before anything started needs no process at all.
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                DriverMsg::Stop => return ProcessEnd::Stopped,
                DriverMsg::Pause => return ProcessEnd::Paused,
                DriverMsg::Session(_) => {}
            }
        }
        // One session per video: the session must not belong to another video, and no other
        // live process may use it. A new session of the OpenCode program gets its id from
        // OpenCode, so it is claimed once the server made it (a fresh id is never taken).
        let resumed = match &launch.mode {
            SessionMode::Resume(id) => Some(id.clone()),
            SessionMode::New(id) if launch.harness == Harness::ClaudeCode => Some(id.clone()),
            SessionMode::New(_) => None,
        };
        if let Some(session_id) = resumed {
            if !self
                .inner
                .claim_session(&self.job.video_id, &self.job.id, &session_id)
            {
                return ProcessEnd::SessionTaken;
            }
            self.job.session_id = Some(session_id);
        }
        let (session, mut detail, describer) = match self.start_agent(launch) {
            Ok(started) => started,
            Err(end) => return end,
        };
        if launch.harness == Harness::ClaudeCode && self.job.setup.api_option().is_some() {
            detail.push_str(&format!(" on {}", self.job.setup.service_name()));
        }
        let mut settings: Vec<String> = Vec::new();
        if let Some(model) = &self.job.model {
            settings.push(format!("model {model}"));
        }
        if let Some(effort) = &self.job.effort {
            settings.push(format!("effort {effort}"));
        }
        if !settings.is_empty() {
            detail = format!("{detail} ({})", settings.join(", "));
        }
        self.log(Draft::status(detail));
        let now = Instant::now();
        let mut proc = Proc {
            tree: ProcessTree::new(session.pid()),
            session,
            tracker: TurnTracker::new(now),
            describer,
            limit: None,
            error: None,
            interrupting: None,
            halted: false,
            interrupt_answered: false,
            last_tree_refresh: now,
            cpu: BTreeMap::new(),
            cpu_at: now,
            busy_until: None,
            last_wait_message: None,
        };
        self.refresh_tree(&mut proc);
        self.turn = Turn::default();
        // A failed write means the process already died; its exit is reported next.
        if proc.session.send_user(&launch.message).is_ok() {
            proc.tracker.message_sent(Instant::now());
            self.log(
                Draft::new(LogKind::User, launch.sent_line.clone())
                    .with_detail(launch.message.clone()),
            );
        }
        let end = self.drive(&mut proc, &launch.mode);
        if proc.limit.is_some() {
            self.limit = proc.limit;
        }
        end
    }

    /// Starts the job's program: one Claude Code process, or one OpenCode server with its
    /// session (a new session's id is claimed here). Returns it with the first words of its log
    /// line and the describer of its stream.
    fn start_agent(
        &mut self,
        launch: &Launch,
    ) -> Result<(Box<dyn AgentProcess>, String, Describer), ProcessEnd> {
        let tx = self.tx.clone();
        let on_event = move |e| {
            let _ = tx.send(DriverMsg::Session(e));
        };
        let describer = Describer::with_paths(Paths::new(&launch.cwd, &launch.video_dir));
        let Some(run) = &launch
            .opencode
            .as_ref()
            .filter(|_| launch.harness.is_opencode_program())
        else {
            let config = SessionConfig {
                program: launch.program.clone(),
                cwd: launch.cwd.clone(),
                env: launch.env.clone(),
                mode: launch.mode.clone(),
                model: self.job.model.clone(),
                effort: self.job.effort.clone(),
            };
            let session = Session::spawn(&config, on_event)
                .map_err(|err| ProcessEnd::Failed(errors::spawn_failed(&err)))?;
            let detail = match &launch.mode {
                SessionMode::New(_) => "Started a new Claude Code session",
                SessionMode::Resume(_) => "Resumed the Claude Code session",
            };
            return Ok((Box::new(session), detail.to_owned(), describer));
        };
        let start = match &launch.mode {
            SessionMode::New(_) => SessionStart::New {
                title: run.title.clone(),
            },
            SessionMode::Resume(id) => SessionStart::Resume(id.clone()),
        };
        let program = launch.program_name();
        let not_started = |err: std::io::Error| {
            ProcessEnd::Failed(format!(
                "The {program} program could not be started: {}",
                self.inner.logs.scrub(&err.to_string())
            ))
        };
        // A start that takes long says so in the log, once in a while.
        let waiting = |notice: &str| self.log(Draft::status(notice.replace("OpenCode", program)));
        let private_dir = self.inner.host.store().data_dir().to_owned();
        let mut config = server2::ServerConfig::for_job(
            launch.program.clone(),
            launch.cwd.clone(),
            &launch.env,
            Gateway {
                option: run.option,
                key: run.key.as_deref(),
                base_url: run.base_url.as_deref(),
                model_id: &run.model,
                effort: self.job.effort.as_deref(),
            },
            start,
            &private_dir,
        );
        config.limits = self.timings().server_start;
        let server = Server2::start(&config, on_event, &waiting).map_err(not_started)?;
        let session_id = server.session_id().to_owned();
        let describer = describer.for_opencode2();
        let server: Box<dyn AgentProcess> = Box::new(server);
        if launch.mode.is_resume() {
            return Ok((server, format!("Resumed the {program} session"), describer));
        }
        if !self
            .inner
            .claim_session(&self.job.video_id, &self.job.id, &session_id)
        {
            server.close();
            return Err(ProcessEnd::SessionTaken);
        }
        self.job.session_id = Some(session_id);
        Ok((
            server,
            format!("Started a new {program} session"),
            describer,
        ))
    }

    /// The main loop of one process.
    fn drive(&mut self, proc: &mut Proc, mode: &SessionMode) -> ProcessEnd {
        let tick = self.timings().progress_interval.min(Duration::from_secs(1));
        loop {
            let now = Instant::now();
            let mut wake = now + tick;
            if let Some(settle) = proc.tracker.settle_deadline(self.timings().settle)
                && !proc.halted
            {
                wake = wake.min(settle);
            }
            match self.rx.recv_timeout(wake.saturating_duration_since(now)) {
                Ok(DriverMsg::Session(SessionEvent::Line(event))) => self.observe(proc, &event),
                Ok(DriverMsg::Session(SessionEvent::Exited(info))) => {
                    return self.exited_by_itself(proc, info, mode);
                }
                Ok(DriverMsg::Pause) => return self.pause(proc),
                Ok(DriverMsg::Stop) => return self.stop(proc),
                Err(RecvTimeoutError::Timeout) => {}
                // Cannot happen: the driver holds a sender itself.
                Err(RecvTimeoutError::Disconnected) => return self.stop(proc),
            }
            self.flush_progress(false);
            if proc.last_tree_refresh.elapsed() >= self.timings().tree_refresh {
                self.refresh_tree(proc);
            }
            if let Some(error) = proc.error.take() {
                if error.is_resume_not_found() && mode.is_resume() {
                    self.close_and_wait(proc);
                    return ProcessEnd::ResumeNotFound;
                }
                self.close_and_wait(proc);
                return self.error_end(&error, proc.limit);
            }
            let now = Instant::now();
            if proc.tracker.is_finished(now, self.timings().settle) && !proc.halted {
                if self.keeps_going {
                    if let Some(end) = self.idle(proc) {
                        return end;
                    }
                    continue;
                }
                self.log(Draft::status("Claude is finished, checking the output"));
                self.close_and_wait(proc);
                return ProcessEnd::Finished;
            }
            // A tool call that was given a longer time limit is silent up to that limit.
            let stall = proc.tracker.stall_limit(self.timings().stall_timeout);
            if proc.tracker.quiet_for(now) >= stall
                && !matches!(proc.tracker.activity(), Activity::WaitingForBackground(_))
            {
                let minutes = stall.as_secs() / 60;
                if self.keeps_going {
                    // Silence in the middle of a turn is not a turn that ended early: the
                    // process is stuck. Done only if the work is there.
                    self.close_and_wait(proc);
                    return match self.deliverable() {
                        Some(file) => ProcessEnd::Completed(file),
                        None => ProcessEnd::Failed(errors::stalled(minutes)),
                    };
                }
                if proc.tracker.answered_once() {
                    self.log(Draft::status(format!(
                        "No activity for {minutes} minutes after Claude's last answer; treating the job as finished"
                    )));
                    self.close_and_wait(proc);
                    return ProcessEnd::Finished;
                }
                self.end_tree(proc);
                return ProcessEnd::Failed(errors::stalled(minutes));
            }
        }
    }

    fn now(&self) -> DateTime<Utc> {
        self.inner.host.now()
    }

    /// The file that proves this job did its work, if it is on disk now.
    fn deliverable(&self) -> Option<String> {
        let ctx = self.inner.host.resolve_video(&self.job.video_id).ok()?;
        expected_output(self.job.kind, &ctx.output, self.started())
    }

    fn started(&self) -> Option<DateTime<Utc>> {
        self.job
            .started_at
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.with_timezone(&Utc))
    }

    /// Claude went idle while the job keeps itself going (SPEC section 6, "Keeping a job
    /// going"): asks `keepgoing` whether the job is done, and sends the next message in the same
    /// session when it is not. Returns how the process ended, or `None` while it goes on.
    fn idle(&mut self, proc: &mut Proc) -> Option<ProcessEnd> {
        if self.halt.is_closed() {
            // A pause or stop is on its way; it ends this process.
            proc.halted = true;
            return None;
        }
        // Look at the output folder now, so the files of the turn that just ended count.
        self.progress.probe_now();
        self.flush_progress(true);
        let kind = self.job.kind;
        let workers_busy = proc.busy_until.is_some_and(|until| until > Instant::now());
        if workers_busy
            && proc
                .last_wait_message
                .is_some_and(|at| at.elapsed() < WAIT_MESSAGE_EVERY)
            && self.deliverable().is_none()
        {
            // Reminded a moment ago: the commands are busy, so the model is waiting for them.
            return None;
        }
        let evidence = Evidence {
            deliverable: self.deliverable(),
            extras_missing: kind == JobKind::Edit
                && !self.progress.is_done(Milestone::ExtrasWritten),
            milestones: self.progress.work_shown(),
            workers_busy,
        };
        let turn = std::mem::take(&mut self.turn);
        match self.keeper.turn_ended(turn, &evidence) {
            Decision::Complete { file } => {
                self.close_and_wait(proc);
                Some(ProcessEnd::Completed(file))
            }
            Decision::MissingOutput => {
                self.close_and_wait(proc);
                Some(ProcessEnd::Failed(errors::missing_output(kind)))
            }
            Decision::Stuck(why) => {
                self.close_and_wait(proc);
                Some(ProcessEnd::Failed(errors::stuck(kind, why)))
            }
            Decision::Continue { nudge, number } => {
                let message = prompt::continuation_body_on(kind, &nudge, self.job.setup);
                match self.halt.while_open(|| proc.session.send_user(&message)) {
                    None => proc.halted = true,
                    Some(Ok(())) => {
                        proc.tracker.message_sent(Instant::now());
                        if nudge == keepgoing::Nudge::WaitForWork {
                            proc.last_wait_message = Some(Instant::now());
                        }
                        let line = keepgoing::status_line(kind, &nudge, number);
                        self.activity = line.split(':').next().map(str::to_owned);
                        self.log(Draft::status(line).with_detail(message));
                    }
                    // The process is gone; its exit is reported next.
                    Some(Err(_)) => {}
                }
                None
            }
        }
    }

    /// The `error` of a job whose turn ended with `error`, in the words of its provider.
    fn error_message(&self, error: &TurnResult, limit: Option<Option<i64>>) -> String {
        match self.job.setup {
            Setup::ClaudeSubscription => errors::for_error_result(error, limit, self.now()),
            _ if self.job.harness() == Harness::Opencode2 => errors::for_opencode2_program_result(
                error,
                self.job.model.as_deref(),
                self.service(),
            ),
            _ => errors::for_opencode_result(error, self.job.model.as_deref(), self.service()),
        }
    }

    /// Who answers the requests of this job: OpenCode for an OpenCode address, otherwise "the
    /// service" in every text (SPEC section 7a, "Test and errors").
    fn service(&self) -> Service {
        self.job
            .setup
            .api_option()
            .map_or(Service::OpenCode, |option| {
                Service::for_base_url(&self.inner.host.api_setup(option).base_url)
            })
    }

    /// A process that only stopped after a usage limit on the event stream, with no error result
    /// and no output, is retried like any other usage limit (SPEC section 6).
    fn quiet_limit_retry(&self, end: ProcessEnd, launch: &Launch) -> ProcessEnd {
        let (ProcessEnd::Finished, Some(reset)) = (&end, self.limit) else {
            return end;
        };
        match self.check_output(&launch.video_dir, Some(reset)) {
            Outcome::Failed(message) => ProcessEnd::ModelError {
                failure: retry::Failure {
                    what: "Usage limit".to_owned(),
                    reset: reset.and_then(|s| chrono::TimeZone::timestamp_opt(&Utc, s, 0).single()),
                },
                message,
            },
            _ => end,
        }
    }

    /// How a process ends that reported an error result: a failure of the model provider that may
    /// pass is retried, anything else fails the job.
    fn error_end(&self, error: &TurnResult, limit: Option<Option<i64>>) -> ProcessEnd {
        let message = self.error_message(error, limit);
        match retry::classify(error, limit) {
            Some(failure) => ProcessEnd::ModelError { failure, message },
            None => ProcessEnd::Failed(message),
        }
    }

    /// Feeds one line to the tracker, the log and the progress.
    fn observe(&mut self, proc: &mut Proc, event: &StreamEvent) {
        let mut observed = proc.tracker.observe(event, Instant::now());
        self.progress.observe(event);
        if let StreamEvent::Assistant(message) = event
            && !message.is_nested()
        {
            for block in &message.content {
                match block {
                    Block::ToolUse { .. } => self.turn.tool_calls += 1,
                    Block::Text(text) if keepgoing::has_completion_marker(text) => {
                        self.turn.marker = true;
                    }
                    _ => {}
                }
            }
        }
        // An API error that Claude Code ends a turn with, after its own retries, is a reason to
        // stop even when the result does not say it is an error; going on would only repeat it.
        if self.keeps_going
            && let Observed::TurnEnded(result) = &observed
            && result
                .text
                .as_deref()
                .is_some_and(|t| t.trim_start().starts_with("API Error"))
        {
            observed = Observed::Error(TurnResult {
                is_error: true,
                ..result.clone()
            });
        }
        let described = proc.describer.describe(event);
        let mut entries = described.entries;
        if proc.interrupting.is_some() {
            // The aborted turn's error is the expected answer to our interrupt.
            entries.retain(|e| {
                e.kind != LogKind::Error
                    || !matches!(event, StreamEvent::Result(r) if r.is_interrupted())
            });
        }
        if !entries.is_empty() {
            self.inner.logs.push(
                &self.job.video_id,
                &self.job.id,
                entries,
                &self.inner.now_iso(),
            );
        }
        if let Some(activity) = described.activity {
            self.activity = Some(activity);
        }
        match event {
            // The Claude plan's limits; a job on OpenCode says nothing about them.
            StreamEvent::RateLimit(info) if self.job.setup == Setup::ClaudeSubscription => {
                self.inner.host.notify(Notice::RateLimit(info.raw.clone()));
                if info.is_rejected() {
                    proc.limit = Some(info.resets_at);
                }
            }
            // The OpenCode 2 program would wait for their limit to reset (possibly days): the job
            // ends with the limit instead.
            StreamEvent::RateLimit(info)
                if self.job.harness().is_opencode_program() && info.is_rejected() =>
            {
                let session = self.job.session_id.clone().unwrap_or_default();
                proc.error.get_or_insert_with(|| {
                    crate::opencode::harness::events2::limit_result(info, &session)
                });
            }
            StreamEvent::Result(result) => {
                if let Some(cost) = result.total_cost_usd {
                    self.cost = Some(cost);
                }
            }
            StreamEvent::ControlResponse(response) => {
                if proc.interrupting.as_deref() == Some(response.request_id.as_str()) {
                    proc.interrupt_answered = true;
                }
            }
            StreamEvent::System(crate::claude::protocol::SystemEvent::TaskStarted { .. }) => {
                // Catch new processes early for the orphan registry.
                self.refresh_tree(proc);
            }
            _ => {}
        }
        match observed {
            Observed::Error(result) => {
                if !(proc.interrupting.is_some() && result.is_interrupted()) {
                    proc.error = Some(result);
                }
            }
            Observed::TurnEnded(_) => {
                if let Activity::WaitingForBackground(n) = proc.tracker.activity() {
                    let tasks = proc.tracker.background_tasks().join(", ");
                    let line = if n == 1 {
                        format!("Waiting for a background task: {tasks}")
                    } else {
                        format!("Waiting for {n} background tasks: {tasks}")
                    };
                    let line = first_line(&line);
                    self.log(Draft::status(line.clone()));
                    self.activity = Some(line);
                }
            }
            Observed::EmptyResult | Observed::Nothing => {}
        }
    }

    /// The process ended without being asked to.
    fn exited_by_itself(
        &mut self,
        proc: &mut Proc,
        info: ExitInfo,
        mode: &SessionMode,
    ) -> ProcessEnd {
        self.end_tree(proc);
        let stderr = info.last_stderr_line().unwrap_or("");
        if let Some(error) = proc.error.take() {
            if error.is_resume_not_found() && mode.is_resume() {
                return ProcessEnd::ResumeNotFound;
            }
            return self.error_end(&error, proc.limit);
        }
        if mode.is_resume() && stderr.contains(NO_CONVERSATION_FOUND) {
            return ProcessEnd::ResumeNotFound;
        }
        if info.success() && proc.tracker.answered_once() {
            return ProcessEnd::Finished;
        }
        if let Some(limit) = proc.limit {
            let reset = limit.and_then(|s| chrono::TimeZone::timestamp_opt(&Utc, s, 0).single());
            return ProcessEnd::ModelError {
                failure: retry::Failure {
                    what: "Usage limit".into(),
                    reset,
                },
                message: errors::usage_limit(reset, self.now()),
            };
        }
        let lower = stderr.to_lowercase();
        if lower.contains("/login") || lower.contains("not logged in") {
            return ProcessEnd::Failed(match self.job.setup {
                Setup::ClaudeSubscription => errors::logged_out(),
                _ => failure_text_for(self.service(), Some(401), stderr, None),
            });
        }
        if !stderr.is_empty() {
            self.log(Draft::error(first_line(stderr)).with_detail(info.stderr_tail.join("\n")));
        }
        ProcessEnd::Failed(errors::crashed(
            info.code,
            info.signal,
            info.last_stderr_line(),
        ))
    }

    /// Pause: interrupt the turn, wait for Claude to go idle, close the process.
    fn pause(&mut self, proc: &mut Proc) -> ProcessEnd {
        self.log(Draft::status(match self.job.harness() {
            Harness::ClaudeCode => "Pausing: asking Claude to stop the current step",
            Harness::Opencode2 => "Pausing: asking OpenCode 2 to stop the current step",
        }));
        match proc.session.interrupt() {
            Ok(id) => proc.interrupting = Some(id),
            Err(_) => {
                // stdin is gone: the process is ending anyway.
                self.close_and_wait(proc);
                return ProcessEnd::Paused;
            }
        }
        let deadline = Instant::now() + self.timings().interrupt_timeout;
        match self.wait_until(proc, deadline, |p| {
            p.interrupt_answered && p.tracker.activity() != Activity::Working
        }) {
            Wait::Stop => return self.stop(proc),
            Wait::Exited => {
                self.end_tree(proc);
                return ProcessEnd::Paused;
            }
            Wait::Done | Wait::Timeout => {}
        }
        self.close_and_wait(proc);
        ProcessEnd::Paused
    }

    /// Stop: interrupt, then end the whole process tree.
    fn stop(&mut self, proc: &mut Proc) -> ProcessEnd {
        self.log(Draft::status("Stopping"));
        if let Ok(id) = proc.session.interrupt() {
            proc.interrupting = Some(id);
            let deadline =
                Instant::now() + self.timings().interrupt_timeout.min(Duration::from_secs(2));
            if let Wait::Exited = self.wait_until(proc, deadline, |p| p.interrupt_answered) {
                self.end_tree(proc);
                return ProcessEnd::Stopped;
            }
        }
        self.refresh_tree(proc);
        proc.session.close();
        self.end_tree(proc);
        let deadline = Instant::now() + self.timings().kill_grace + Duration::from_secs(2);
        let _ = self.wait_until(proc, deadline, |_| false);
        ProcessEnd::Stopped
    }

    /// Closes stdin, waits for the exit (ending the tree if it takes too long), then ends
    /// whatever is left of the tree.
    fn close_and_wait(&mut self, proc: &mut Proc) {
        self.refresh_tree(proc);
        proc.session.close();
        let deadline = Instant::now() + self.timings().exit_timeout;
        match self.wait_until(proc, deadline, |_| false) {
            Wait::Exited => {}
            Wait::Stop | Wait::Done | Wait::Timeout => {
                self.end_tree(proc);
                let deadline = Instant::now() + Duration::from_secs(2);
                let _ = self.wait_until(proc, deadline, |_| false);
            }
        }
        self.end_tree(proc);
    }

    /// Ends every process of the tree that is still alive and forgets it in the registry.
    fn end_tree(&mut self, proc: &mut Proc) {
        let ended: std::collections::BTreeSet<u32> =
            proc.tree.entries().iter().map(|e| e.pid).collect();
        let terminated = proc.tree.terminate(self.timings().kill_grace);
        // The machine locks of the toolkit that the ended processes held would block the next
        // session for the rest of their lease.
        if let Ok(ctx) = self.inner.host.resolve_video(&self.job.video_id) {
            let released = crate::jobs::locks::release_held_by(&ctx.editing_folder, &ended);
            if !released.is_empty() {
                self.log(Draft::status(format!(
                    "Released the machine lock held by the ended session ({})",
                    released.join(", ")
                )));
            }
        }
        if !terminated {
            self.log(Draft::error(if cfg!(windows) {
                "Some processes of this job could not be ended. Check Task Manager."
            } else {
                "Some processes of this job could not be ended. Check Activity Monitor."
            }));
        }
        self.inner.register_processes(&self.job.id, Vec::new());
    }

    fn refresh_tree(&mut self, proc: &mut Proc) {
        proc.last_tree_refresh = Instant::now();
        if let Ok(alive) = proc.tree.refresh() {
            self.inner
                .register_processes(&self.job.id, proc.tree.entries());
            Self::note_cpu(proc, &alive);
        }
    }

    /// Notes whether the model's own commands (everything in the tree but the model host) use the
    /// computer: the CPU time of some process grew by a tenth of a core since the last refresh.
    fn note_cpu(proc: &mut Proc, alive: &[ProcInfo]) {
        let pids: Vec<u32> = alive
            .iter()
            .map(|p| p.pid)
            .filter(|pid| *pid != proc.tree.root())
            .collect();
        let times = process::cpu_times(&pids);
        let now = Instant::now();
        let wall = now.duration_since(proc.cpu_at).as_millis() as f64;
        let grew: u64 = times
            .iter()
            .filter_map(|(pid, now)| Some(now.saturating_sub(*proc.cpu.get(pid)?)))
            .sum();
        if wall >= 1000.0 && grew as f64 >= wall * BUSY_CPU_SHARE {
            proc.busy_until = Some(now + BUSY_HOLD);
        }
        proc.cpu = times;
        proc.cpu_at = now;
    }

    /// Processes lines until `done`, the exit, a stop request or the deadline. Pause requests are
    /// ignored here (a pause or stop is already in progress).
    fn wait_until(
        &mut self,
        proc: &mut Proc,
        deadline: Instant,
        done: impl Fn(&Proc) -> bool,
    ) -> Wait {
        loop {
            if done(proc) {
                return Wait::Done;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Wait::Timeout;
            }
            match self.rx.recv_timeout(left) {
                Ok(DriverMsg::Session(SessionEvent::Line(event))) => self.observe(proc, &event),
                Ok(DriverMsg::Session(SessionEvent::Exited(_))) => return Wait::Exited,
                Ok(DriverMsg::Stop) => return Wait::Stop,
                Ok(DriverMsg::Pause) => {}
                Err(RecvTimeoutError::Timeout) => return Wait::Timeout,
                Err(RecvTimeoutError::Disconnected) => return Wait::Exited,
            }
        }
    }

    /// Saves `lastActivity`, `costUsd` and `progress`, at most every `progress_interval` unless
    /// forced (a new progress stage goes out at once).
    fn flush_progress(&mut self, force: bool) {
        let interval = self.timings().progress_interval;
        let progress = self
            .progress
            .poll(self.inner.host.as_ref(), interval, force);
        if self.activity.is_none() && self.cost.is_none() && progress.is_none() {
            return;
        }
        let due = force || self.last_progress.elapsed() >= interval;
        if !due && progress.is_none() {
            return;
        }
        self.last_progress = Instant::now();
        let (activity, cost) = if due {
            (self.activity.take(), self.cost.take())
        } else {
            (None, None)
        };
        self.inner
            .set_progress(&self.job.video_id, &self.job.id, activity, cost, progress);
    }

    /// Checks the expected output of the job's kind on disk.
    fn check_output(&self, video_dir: &std::path::Path, limit: Option<Option<i64>>) -> Outcome {
        let output = self.inner.host.scan_output(video_dir);
        match expected_output(self.job.kind, &output, self.started()) {
            Some(file) => Outcome::Completed { file: Some(file) },
            None => Outcome::Failed(match limit {
                Some(reset) => errors::usage_limit(
                    reset.and_then(|s| chrono::TimeZone::timestamp_opt(&Utc, s, 0).single()),
                    self.now(),
                ),
                None => errors::missing_output(self.job.kind),
            }),
        }
    }
}

enum Wait {
    Done,
    Exited,
    Stop,
    Timeout,
}

/// The file that proves a job of `kind` did its work, if there is one: any review project for an
/// edit; a review project or final render modified after the job started for a re-edit or a
/// render. One second of tolerance covers file systems that store whole seconds.
pub(crate) fn expected_output(
    kind: JobKind,
    output: &VideoOutput,
    started: Option<DateTime<Utc>>,
) -> Option<String> {
    let fresh = |modified: &str| match (started, DateTime::parse_from_rfc3339(modified)) {
        (Some(started), Ok(modified)) => {
            modified.with_timezone(&Utc) >= started - chrono::Duration::seconds(1)
        }
        (None, _) => true,
        (Some(_), Err(_)) => false,
    };
    match kind {
        JobKind::Edit => output.review_files.first().map(|f| f.name.clone()),
        JobKind::ReEdit => output
            .review_files
            .iter()
            .find(|f| fresh(&f.modified_at))
            .map(|f| f.name.clone()),
        JobKind::Render => output
            .final_files
            .iter()
            .find(|f| fresh(&f.modified_at))
            .map(|f| f.name.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::OutputFile;

    fn file(name: &str, modified: &str) -> OutputFile {
        OutputFile {
            path: format!("/v/output/{name}"),
            name: name.into(),
            modified_at: modified.into(),
            software: None,
        }
    }

    #[test]
    fn expected_output_per_kind() {
        let started = DateTime::parse_from_rfc3339("2026-11-14T10:00:00.500Z")
            .unwrap()
            .with_timezone(&Utc);
        let output = VideoOutput {
            review_files: vec![file("v1.fcpxml", "2026-11-14T09:00:00Z")],
            ..VideoOutput::default()
        };
        assert_eq!(
            expected_output(JobKind::Edit, &output, Some(started)),
            Some("v1.fcpxml".into())
        );
        assert_eq!(
            expected_output(JobKind::ReEdit, &output, Some(started)),
            None
        );
        assert_eq!(
            expected_output(JobKind::Render, &output, Some(started)),
            None
        );
        let output = VideoOutput {
            review_files: vec![
                file("v2.fcpxml", "2026-11-14T10:00:00Z"),
                file("v1.fcpxml", "2026-11-14T09:00:00Z"),
            ],
            final_files: vec![file("final.mp4", "2026-11-14T10:30:00Z")],
            ..VideoOutput::default()
        };
        assert_eq!(
            expected_output(JobKind::ReEdit, &output, Some(started)),
            Some("v2.fcpxml".into())
        );
        assert_eq!(
            expected_output(JobKind::Render, &output, Some(started)),
            Some("final.mp4".into())
        );
        assert_eq!(
            expected_output(JobKind::Edit, &VideoOutput::default(), None),
            None
        );
    }
}

//! The job manager.
//!
//! Owns the latest job of every video, drives the state machine of SPEC section 6 (`queued`,
//! `running`, `pausing`, `paused`, `stopping`, `stopped`, `failed`, `completed`), starts a driver
//! thread per running job (`jobs::driver`), persists every change through
//! `Store::update_video`, emits `job-updated` and asks for library rescans, keeps the machine
//! awake while jobs run and shows a notification when a job completes or fails.
//!
//! Which queued job starts when is decided by `jobs::queue::schedule` (slots and the start
//! delay); a `jobs::timer::StartTimer` looks at the queue again when a delay runs out. Before a
//! driver spawns a Claude process it claims the session ([`Inner::claim_session`]), so no two
//! videos ever share a Claude session.
//!
//! Concurrency model:
//!
//! - One mutex ([`Inner::state`]) guards the queue, the running drivers and the decisions about
//!   them. Every state transition happens under it, so commands and drivers never race. The
//!   store is the source of truth for `JobView`s; it is only ever locked inside the manager lock
//!   (lock order: manager, then store), and nothing slow happens under the manager lock: no
//!   process is spawned or waited for, no pipe is written.
//! - Each running job has one driver thread that owns its Claude process and receives the
//!   process's events and the manager's requests (pause, stop) on one channel. Commands only send
//!   a message and return; the driver reports its outcome back with [`Inner::finish_driver`].
//! - Log entries go through `jobs::log::LogSink`, which writes and emits them from its own thread.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};

use crate::error::{AppError, AppResult};
use crate::jobs::driver::{self, DriverMsg, Halt, Outcome};
use crate::jobs::host::{JobHost, Notice};
use crate::jobs::log::{Draft, LogSink};
use crate::jobs::progress;
use crate::jobs::queue::{self, Gate, JobQueue, StartKind, free_slots};
use crate::jobs::runner::{self, Runner};
use crate::jobs::timer::StartTimer;
use crate::model::{
    CHANNEL_SLOTS, EditLogEntry, Harness, JobKind, JobState, JobView, LogEntry, MAX_LOG_ENTRIES,
    RenderFinalRequest, VideoInputs, VideoType, jobs_active,
};
use crate::platform::process::{self, OrphanWatchdog, RegistryEntry};

/// Name of the registry of running process trees in the app data directory (see
/// `platform::process`).
pub const PROCESS_REGISTRY_FILE: &str = "running-processes.tsv";

/// Name of the file in the app data directory that keeps the time of the most recent job launch
/// across restarts, for the start delay (SPEC section 6, "Start delay").
pub const START_DELAY_FILE: &str = "start-delay.json";

/// Every wait and grace period of the engine, injectable so tests run fast.
#[derive(Debug, Clone)]
pub struct Timings {
    /// Quiet time after Claude looks finished before stdin is closed.
    pub settle: Duration,
    /// How long a pause waits for Claude to acknowledge the interrupt and go idle.
    pub interrupt_timeout: Duration,
    /// How long to wait for the process to exit after stdin is closed.
    pub exit_timeout: Duration,
    /// Between SIGTERM and SIGKILL when ending a process tree.
    pub kill_grace: Duration,
    /// No output at all for this long (and no background task) means Claude is stuck.
    pub stall_timeout: Duration,
    /// Log entries are written and emitted at most this often.
    pub log_interval: Duration,
    /// `lastActivity` and `costUsd` are saved and emitted at most this often.
    pub progress_interval: Duration,
    /// How often the process tree of a running job is re-read for the orphan registry.
    pub tree_refresh: Duration,
    /// How long one minute of `Settings::start_delay_minutes` lasts (SPEC section 6, "Start
    /// delay"). One real minute in the app; tests and the end-to-end runner shorten it.
    pub start_delay_minute: Duration,
    /// How long one second of the retry schedule after a model error lasts (SPEC section 6,
    /// "Retrying after a model error"). One real second in the app; tests and the end-to-end
    /// runner shorten it. A provider's reset time is real time and is never scaled.
    pub retry_second: Duration,
    /// How long an OpenCode server may take to start, and when the log says it is still
    /// waiting (SPEC section 7a, "Starting the server").
    pub server_start: crate::opencode::harness::child::StartLimits,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            settle: Duration::from_secs(4),
            interrupt_timeout: Duration::from_secs(15),
            exit_timeout: Duration::from_secs(20),
            kill_grace: Duration::from_secs(5),
            stall_timeout: Duration::from_secs(20 * 60),
            log_interval: Duration::from_millis(150),
            progress_interval: Duration::from_secs(1),
            tree_refresh: Duration::from_secs(5),
            start_delay_minute: Duration::from_secs(60),
            retry_second: Duration::from_secs(1),
            server_start: Default::default(),
        }
    }
}

/// What a job was created to do. Kept for the job's whole life, so a job that never got a
/// session can be started again with its original request.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Plan {
    Edit,
    ReEdit {
        changes: String,
        /// The session of the video's previous job.
        resume: Option<String>,
    },
    Render {
        request: RenderFinalRequest,
        resume: Option<String>,
    },
    /// Continue after a pause, or after a failure of a job of that kind.
    Continue {
        after_failure: Option<JobKind>,
    },
}

struct Live {
    job_id: String,
    control: Sender<DriverMsg>,
    /// Closed before a pause or stop is sent, so the driver never sends a continuation after it
    /// (SPEC section 6, "Keeping a job going").
    halt: Halt,
    /// The session its current Claude process uses, once claimed ([`Inner::claim_session`]).
    session: Option<String>,
}

#[derive(Default)]
struct State {
    queue: JobQueue<Plan>,
    /// Jobs with a driver thread, by video id.
    live: HashMap<String, Live>,
    /// The request each job was created with, by job id.
    origins: HashMap<String, Plan>,
    quitting: bool,
    awake: bool,
    /// Whether the last [`Notice::EditingActive`] said that a job is still being edited.
    editing: bool,
    /// The most recent launch of new work, the start of the start delay clock (persisted in
    /// [`START_DELAY_FILE`]).
    last_launch: Option<DateTime<Utc>>,
}

pub(crate) struct Inner {
    pub(crate) host: Arc<dyn JobHost>,
    pub(crate) timings: Timings,
    pub(crate) logs: LogSink,
    state: Mutex<State>,
    /// Signalled whenever a driver ends.
    drivers_changed: Condvar,
    registry: Mutex<HashMap<String, Vec<RegistryEntry>>>,
    watchdog: Mutex<Option<OrphanWatchdog>>,
    /// Looks at the queue again when the start delay of a waiting job runs out.
    start_timer: StartTimer,
}

/// The job manager (managed Tauri state). Cheap to clone.
#[derive(Clone)]
pub struct JobManager {
    inner: Arc<Inner>,
}

fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse_iso(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// Starts the running clock.
fn enter_running(job: &mut JobView, now: DateTime<Utc>) {
    job.state = JobState::Running;
    job.running_since = Some(iso(now));
    if job.started_at.is_none() {
        job.started_at = Some(iso(now));
    }
}

/// Stops the running clock and adds the elapsed time to `active_ms`.
fn leave_running(job: &mut JobView, now: DateTime<Utc>) {
    if let Some(since) = job.running_since.take().as_deref().and_then(parse_iso) {
        let ms = (now - since).num_milliseconds().max(0) as u64;
        job.active_ms = job.active_ms.saturating_add(ms);
    }
}

/// The video folder name of a video id (`<channelId>/<folderName>`).
fn folder_of(video_id: &str) -> &str {
    video_id.split_once('/').map_or(video_id, |(_, f)| f)
}

/// Appends one line to the persistent edit log (the Edit Log page), best effort.
fn log_edit(store: &crate::store::Store, video_id: &str, event: &str, message: String) {
    let entry = EditLogEntry {
        ts: crate::model::now_iso(),
        video_id: video_id.to_owned(),
        folder: folder_of(video_id).to_owned(),
        event: event.to_owned(),
        message,
    };
    if let Err(err) = store.append_edit_log(entry) {
        eprintln!("vidai: could not append to the edit log: {err}");
    }
}

/// Refuses jobs for archived videos (hidden from the main list).
fn refuse_if_archived(store: &crate::store::Store, video_id: &str) -> AppResult<()> {
    if store.is_archived(video_id) {
        return Err(AppError::invalid_input(
            "This video is archived (see Archive at the bottom left). Unarchive it to edit again.",
        ));
    }
    Ok(())
}

impl JobManager {
    /// Creates the manager. Nothing runs until a job is started; call [`JobManager::recover`] once
    /// at startup.
    pub fn new(host: Arc<dyn JobHost>, timings: Timings) -> Self {
        let logs = LogSink::start(Arc::clone(&host), timings.log_interval);
        let last_launch = load_last_launch(host.store().data_dir());
        let inner = Arc::new_cyclic(|weak: &std::sync::Weak<Inner>| {
            let weak = weak.clone();
            Inner {
                host,
                timings,
                logs,
                state: Mutex::new(State {
                    last_launch,
                    ..State::default()
                }),
                drivers_changed: Condvar::new(),
                registry: Mutex::new(HashMap::new()),
                watchdog: Mutex::new(None),
                start_timer: StartTimer::start(move || match weak.upgrade() {
                    Some(inner) => {
                        let mut st = inner.lock();
                        inner.pump(&mut st);
                        true
                    }
                    None => false,
                }),
            }
        });
        Self { inner }
    }

    fn registry_path(&self) -> PathBuf {
        self.inner.registry_path()
    }

    /// Startup recovery (SPEC section 6, "Other job behaviour"): ends process trees a crashed
    /// VidAI left behind, then turns persisted `running` / `pausing` / `stopping` jobs into
    /// `paused` (or `stopped` without a session) and persisted `queued` jobs into `paused` (or
    /// drops them without a session). Nothing starts by itself. Session ids recorded for more than
    /// one video are forgotten by all of them ([`Inner::retire_session`]).
    pub fn recover(&self) {
        let swept = process::sweep_registry(&self.registry_path(), self.inner.timings.kill_grace);
        if swept > 0 {
            eprintln!("vidai: ended {swept} processes left over from a previous run");
        }
        let inner = &self.inner;
        let store = inner.host.store();
        let now = inner.host.now();
        for job in store.latest_jobs() {
            let video_id = job.video_id.clone();
            let has_session = job.session_id.is_some();
            let (next, line) = match job.state {
                JobState::Running | JobState::Pausing | JobState::Stopping if has_session => (
                    Some(JobState::Paused),
                    "VidAI was closed while this job was running. Press Continue Editing to resume it.",
                ),
                JobState::Running | JobState::Pausing | JobState::Stopping => (
                    Some(JobState::Stopped),
                    "VidAI was closed before Claude Code started this job.",
                ),
                JobState::Queued if has_session => (
                    Some(JobState::Paused),
                    "VidAI was closed while this job was waiting. Press Continue Editing to resume it.",
                ),
                JobState::Queued => (None, ""),
                _ => continue,
            };
            match next {
                Some(state) => {
                    let result = store.update_video(&video_id, |v| {
                        if let Some(j) = v.latest_job.as_mut().filter(|j| j.id == job.id) {
                            j.state = state;
                            j.running_since = None;
                            j.starts_at = None;
                            j.last_activity = Some(
                                if state == JobState::Paused {
                                    "Paused"
                                } else {
                                    "Stopped"
                                }
                                .to_owned(),
                            );
                            if state == JobState::Stopped {
                                j.ended_at = Some(iso(now));
                            }
                        }
                        Ok(())
                    });
                    if let Err(err) = result {
                        eprintln!("vidai: could not recover job {}: {err}", job.id);
                        continue;
                    }
                    inner
                        .logs
                        .push(&video_id, &job.id, vec![Draft::status(line)], &iso(now));
                }
                None => {
                    let result = store.update_video(&video_id, |v| {
                        if v.latest_job.as_ref().is_some_and(|j| j.id == job.id) {
                            v.latest_job = None;
                        }
                        Ok(())
                    });
                    if result.is_ok() {
                        let _ = store.remove_log(&job.id);
                    }
                }
            }
        }
        // A session recorded for more than one video (state.json edited or copied) is resumed by
        // none of them (SPEC section 6, "One session per video").
        let mut holders: HashMap<String, Vec<JobView>> = HashMap::new();
        for job in store.latest_jobs() {
            if let Some(sid) = job.session_id.clone() {
                holders.entry(sid).or_default().push(job);
            }
        }
        {
            let st = inner.lock();
            for jobs in holders.into_values().filter(|jobs| jobs.len() > 1) {
                for job in jobs {
                    inner.retire_session(&st, &job);
                }
            }
        }
        inner.logs.flush();
        inner.host.notify(Notice::LibraryChanged);
        let mut st = inner.lock();
        inner.pump(&mut st);
    }

    /// Starts the watchdog that ends running process trees if VidAI dies (see
    /// `platform::process::OrphanWatchdog`).
    pub fn start_orphan_watchdog(&self) {
        let mut watchdog = self
            .inner
            .watchdog
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if watchdog.is_none() {
            match OrphanWatchdog::start(self.registry_path()) {
                Ok(w) => *watchdog = Some(w),
                Err(err) => eprintln!("vidai: could not start the process watchdog: {err}"),
            }
        }
    }

    /// The latest job of a video.
    pub fn job(&self, video_id: &str) -> Option<JobView> {
        self.inner.host.store().video(video_id).latest_job
    }

    /// `start_edit`: saves the inputs as the video's remembered inputs and queues a new `edit`.
    pub fn start_edit(&self, video_id: &str, inputs: VideoInputs) -> AppResult<JobView> {
        let inner = &self.inner;
        let ctx = inner.host.resolve_video(video_id)?;
        let settings = inner.host.store().settings();
        let mut st = inner.lock();
        inner.refuse_if_active(video_id)?;
        if inputs.prompt_slot as usize >= CHANNEL_SLOTS
            || inputs.style_slot as usize >= CHANNEL_SLOTS
        {
            return Err(AppError::invalid_input(
                "Choose one of the prompts and styles.",
            ));
        }
        let prompt_slot = inputs.prompt_slot;
        inner.host.store().update_video(video_id, |v| {
            v.inputs = inputs;
            Ok(())
        })?;
        let channel = settings
            .channels
            .iter()
            .find(|c| c.id == ctx.channel_id)
            .ok_or_else(|| AppError::not_found("This video's channel is no longer in VidAI."))?;
        let profile = match ctx.video_type {
            VideoType::Long => &channel.long,
            VideoType::Short => &channel.short,
        };
        if profile.prompt_text(prompt_slot).trim().is_empty() {
            let kind = match ctx.video_type {
                VideoType::Long => "Long",
                VideoType::Short => "Short",
            };
            return Err(AppError::invalid_input(format!(
                "The {kind} prompt \"{}\" of the channel \"{}\" is empty. Write it in Settings, Channels first.",
                profile
                    .prompts
                    .get(prompt_slot as usize)
                    .map_or("", |s| s.name.as_str()),
                channel.folder_name
            )));
        }
        let runner = runner::current(&settings);
        inner.create(
            &mut st,
            video_id,
            JobKind::Edit,
            ctx.video_type,
            Plan::Edit,
            runner,
        )
    }

    /// `re_edit`: queues a `reEdit` that resumes the session of the video's latest job.
    pub fn re_edit(&self, video_id: &str, changes: &str) -> AppResult<JobView> {
        if changes.trim().is_empty() {
            return Err(AppError::invalid_input("Describe what should change."));
        }
        let changes = changes.to_owned();
        self.inner
            .create_follow_up(video_id, JobKind::ReEdit, |resume| Plan::ReEdit {
                changes,
                resume,
            })
    }

    /// `render_final`: queues a `render` that resumes the session of the video's latest job.
    pub fn render_final(&self, video_id: &str, request: RenderFinalRequest) -> AppResult<JobView> {
        let request = RenderFinalRequest {
            timeline_export_path: request
                .timeline_export_path
                .map(|p| p.trim().to_owned())
                .filter(|p| !p.is_empty()),
            notes: request.notes,
        };
        self.inner
            .create_follow_up(video_id, JobKind::Render, |resume| Plan::Render {
                request,
                resume,
            })
    }

    /// `continue_job`: a `paused` or `failed` job goes back into the queue; it resumes its own
    /// session with its own model, effort, toolkit and video type.
    pub fn continue_job(&self, video_id: &str) -> AppResult<JobView> {
        let inner = &self.inner;
        refuse_if_archived(inner.host.store(), video_id)?;
        let mut st = inner.lock();
        let job = inner.latest(video_id)?;
        let after_failure = match job.state {
            JobState::Paused => None,
            JobState::Failed => Some(job.kind),
            _ => {
                return Err(AppError::conflict(
                    "Only a paused job or a job that needs attention can continue.",
                ));
            }
        };
        let view = inner
            .set_job(video_id, &job.id, |j| {
                j.state = JobState::Queued;
                j.error = None;
                j.ended_at = None;
                j.last_activity = Some("Waiting to continue".into());
            })
            .ok_or_else(|| AppError::internal("Could not save the job."))?;
        st.queue.push(video_id, Plan::Continue { after_failure });
        inner.log(video_id, &job.id, Draft::status("Queued to continue"));
        log_edit(
            inner.host.store(),
            video_id,
            "continued",
            "Continued".to_owned(),
        );
        inner.pump(&mut st);
        Ok(inner.latest(video_id).unwrap_or(view))
    }

    /// `pause_job`: interrupts the running job; it becomes `paused` once Claude is idle and the
    /// process is closed.
    pub fn pause_job(&self, video_id: &str) -> AppResult<JobView> {
        let inner = &self.inner;
        let st = inner.lock();
        let job = inner.latest(video_id)?;
        let live = st.live.get(video_id).filter(|l| l.job_id == job.id);
        match (job.state, live) {
            (JobState::Running, Some(live)) => {
                let now = inner.host.now();
                let view = inner
                    .set_job(video_id, &job.id, |j| {
                        leave_running(j, now);
                        j.state = JobState::Pausing;
                        j.last_activity = Some("Pausing".into());
                    })
                    .ok_or_else(|| AppError::internal("Could not save the job."))?;
                live.halt.close();
                let _ = live.control.send(DriverMsg::Pause);
                Ok(view)
            }
            (JobState::Pausing, _) => Ok(job),
            _ => Err(AppError::conflict("Only a running job can be paused.")),
        }
    }

    /// `stop_job`: ends a running job's whole process tree, or stops a queued or paused job
    /// right away. Working files stay on disk.
    pub fn stop_job(&self, video_id: &str) -> AppResult<JobView> {
        let inner = &self.inner;
        let mut st = inner.lock();
        let job = inner.latest(video_id)?;
        let now = inner.host.now();
        match job.state {
            JobState::Running | JobState::Pausing => {
                let Some(live) = st.live.get(video_id).filter(|l| l.job_id == job.id) else {
                    return Err(AppError::internal("The job has no running process."));
                };
                let view = inner
                    .set_job(video_id, &job.id, |j| {
                        leave_running(j, now);
                        j.state = JobState::Stopping;
                        j.last_activity = Some("Stopping".into());
                    })
                    .ok_or_else(|| AppError::internal("Could not save the job."))?;
                live.halt.close();
                let _ = live.control.send(DriverMsg::Stop);
                Ok(view)
            }
            JobState::Stopping => Ok(job),
            JobState::Queued | JobState::Paused => {
                st.queue.remove(video_id);
                let view = inner
                    .set_job(video_id, &job.id, |j| {
                        j.state = JobState::Stopped;
                        j.ended_at = Some(iso(now));
                        j.starts_at = None;
                        j.last_activity = Some("Stopped".into());
                    })
                    .ok_or_else(|| AppError::internal("Could not save the job."))?;
                inner.log(
                    video_id,
                    &job.id,
                    Draft::status("Stopped. The working files are kept."),
                );
                // The jobs behind it move up: their startsAt changes.
                inner.pump(&mut st);
                Ok(view)
            }
            _ => Err(AppError::conflict("This job is not active.")),
        }
    }

    /// `start_job_now`: starts a `queued` job right away, skipping the rest of the start delay and
    /// the jobs ahead of it in the queue. A free `maxConcurrentEdits` slot is still needed
    /// (`conflict` otherwise). It counts as a launch: the delay clock restarts. A job that is not
    /// queued is returned unchanged (`notFound` when the video has no job).
    pub fn start_now(&self, video_id: &str) -> AppResult<JobView> {
        let inner = &self.inner;
        let mut st = inner.lock();
        let job = inner.latest(video_id)?;
        if job.state != JobState::Queued || st.quitting || !st.queue.contains(video_id) {
            return Ok(job);
        }
        let max = inner.host.store().settings().max_concurrent_edits;
        if free_slots(max, st.live.len()) == 0 {
            return Err(AppError::conflict(if max == 1 {
                "The only edit slot is in use.".to_owned()
            } else {
                format!("All {max} edit slots are in use.")
            }));
        }
        if let Some(plan) = st.queue.remove(video_id) {
            let now = inner.host.now();
            inner.restart_delay_clock(&mut st, now);
            inner.launch(&mut st, video_id, plan, now);
        }
        // The jobs that stay queued get their new startsAt.
        inner.pump(&mut st);
        Ok(inner.latest(video_id).unwrap_or(job))
    }

    /// `get_job_log`: the latest job's log, at most the last `MAX_LOG_ENTRIES` entries.
    pub fn job_log(&self, video_id: &str) -> AppResult<Vec<LogEntry>> {
        let Some(job) = self.job(video_id) else {
            return Ok(Vec::new());
        };
        self.inner.logs.flush();
        self.inner.host.store().read_log(&job.id, MAX_LOG_ENTRIES)
    }

    /// Applies changed settings right away: when `maxConcurrentEdits` was raised or the start
    /// delay was shortened, queued jobs start now instead of at the next job event, and the
    /// `startsAt` of waiting jobs follows a changed delay. Call after every settings change that
    /// can affect the queue (`update_general_settings`, `import_settings`).
    ///
    /// The library is always looked at again: a changed limit can add or remove `startNow` for a
    /// job the start delay holds (`scanner::compute_actions`) without changing any job, and the
    /// rescan announces `library-changed` only when the result differs.
    pub fn settings_changed(&self) {
        let inner = &self.inner;
        let mut st = inner.lock();
        inner.pump(&mut st);
        inner.host.notify(Notice::LibraryChanged);
    }

    /// Jobs that would be lost or interrupted by quitting: `queued`, `running`, `pausing` and
    /// `stopping` (paused jobs are safe).
    pub fn busy_count(&self) -> u32 {
        let st = self.inner.lock();
        (st.queue.len() + st.live.len()) as u32
    }

    /// Whether `confirm_quit` has started.
    pub fn is_quitting(&self) -> bool {
        self.inner.lock().quitting
    }

    /// `confirm_quit`: stops starting new jobs, pauses every running job (interrupt, end the tree)
    /// and waits up to `timeout` for all of them. Queued jobs stay queued and are recovered on the
    /// next start. Returns whether every job finished pausing in time (the orphan watchdog ends
    /// whatever is left when VidAI exits).
    pub fn pause_all_for_quit(&self, timeout: Duration) -> bool {
        let inner = &self.inner;
        let mut st = inner.lock();
        st.quitting = true;
        let now = inner.host.now();
        let running: Vec<(String, String)> = st
            .live
            .iter()
            .map(|(video, live)| (video.clone(), live.job_id.clone()))
            .collect();
        for (video_id, job_id) in running {
            let Some(job) = inner.host.store().video(&video_id).latest_job else {
                continue;
            };
            if job.id == job_id && job.state == JobState::Running {
                inner.set_job(&video_id, &job_id, |j| {
                    leave_running(j, now);
                    j.state = JobState::Pausing;
                    j.last_activity = Some("Pausing".into());
                });
                inner.log(&video_id, &job_id, Draft::status("VidAI is quitting"));
                if let Some(live) = st.live.get(&video_id) {
                    live.halt.close();
                    let _ = live.control.send(DriverMsg::Pause);
                }
            }
        }
        let deadline = Instant::now() + timeout;
        while !st.live.is_empty() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            st = inner
                .drivers_changed
                .wait_timeout(st, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        st.live.is_empty()
    }

    /// Final step before exit: writes pending log entries, lets go of sleep prevention and
    /// clears the process registry when nothing runs any more.
    pub fn shutdown(&self) {
        let inner = &self.inner;
        inner.logs.flush();
        if let Err(err) = inner.host.store().flush_state() {
            eprintln!("vidai: could not save the state: {err}");
        }
        let st = inner.lock();
        if st.live.is_empty() {
            inner.host.notify(Notice::KeepAwake(false));
            let _ = process::write_registry(&self.registry_path(), &[]);
        }
    }

    /// Waits until no driver runs (tests).
    pub fn wait_until_idle(&self, timeout: Duration) -> bool {
        let inner = &self.inner;
        let deadline = Instant::now() + timeout;
        let mut st = inner.lock();
        while !st.live.is_empty() || !st.queue.is_empty() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            st = inner
                .drivers_changed
                .wait_timeout(st, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }

    /// Video ids of the queue, in order (tests and diagnostics).
    pub fn queued_videos(&self) -> Vec<String> {
        self.inner.lock().queue.video_ids()
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn registry_path(&self) -> PathBuf {
        self.host.store().data_dir().join(PROCESS_REGISTRY_FILE)
    }

    pub(crate) fn now_iso(&self) -> String {
        iso(self.host.now())
    }

    fn latest(&self, video_id: &str) -> AppResult<JobView> {
        self.host
            .store()
            .video(video_id)
            .latest_job
            .ok_or_else(|| AppError::not_found("This video has no job."))
    }

    fn refuse_if_active(&self, video_id: &str) -> AppResult<()> {
        match self.host.store().video(video_id).latest_job {
            Some(job) if job.state.is_active() => Err(AppError::conflict(
                "This video already has an active job. Stop it first.",
            )),
            _ => Ok(()),
        }
    }

    pub(crate) fn log(&self, video_id: &str, job_id: &str, draft: Draft) {
        self.logs
            .push(video_id, job_id, vec![draft], &self.now_iso());
    }

    /// Changes the video's latest job if it is still `job_id`, saves it, emits `job-updated` and,
    /// when the state changed, asks for a library rescan. Call with the manager lock held.
    fn set_job(
        &self,
        video_id: &str,
        job_id: &str,
        f: impl FnOnce(&mut JobView),
    ) -> Option<JobView> {
        let result = self.host.store().update_video(video_id, |v| {
            let Some(job) = v.latest_job.as_mut().filter(|j| j.id == job_id) else {
                return Ok(None);
            };
            let before = job.state;
            f(job);
            if let Some(activity) = job.last_activity.as_mut() {
                *activity = self.logs.scrub(activity);
            }
            if let Some(error) = job.error.as_mut() {
                *error = self.logs.scrub(error);
            }
            Ok(Some((job.clone(), before != job.state)))
        });
        match result {
            Ok(Some((view, state_changed))) => {
                self.host.notify(Notice::JobUpdated(Box::new(view.clone())));
                if state_changed {
                    self.host.notify(Notice::LibraryChanged);
                }
                Some(view)
            }
            Ok(None) => None,
            Err(err) => {
                eprintln!("vidai: could not save job {job_id}: {err}");
                None
            }
        }
    }

    /// Creates a job, replacing (and deleting the log of) the video's previous job, and queues it.
    fn create(
        self: &Arc<Self>,
        st: &mut State,
        video_id: &str,
        kind: JobKind,
        video_type: VideoType,
        plan: Plan,
        runner: Runner,
    ) -> AppResult<JobView> {
        refuse_if_archived(self.host.store(), video_id)?;
        let settings = self.host.store().settings();
        let started_line = {
            let what = match kind {
                JobKind::Edit => "Edit",
                JobKind::ReEdit => "Re-edit",
                JobKind::Render => "Final render",
            };
            format!("{} started ({})", what, runner.describe())
        };
        let now = self.now_iso();
        let job = JobView {
            id: uuid::Uuid::new_v4().to_string(),
            video_id: video_id.to_owned(),
            kind,
            state: JobState::Queued,
            session_id: None,
            toolkit: settings.active_toolkit,
            model: runner.model,
            effort: runner.effort,
            video_type,
            created_at: now.clone(),
            started_at: None,
            ended_at: None,
            active_ms: 0,
            running_since: None,
            last_activity: Some("Waiting for a free slot".into()),
            error: None,
            cost_usd: None,
            progress: None,
            starts_at: None,
            setup: runner.setup,
            harness: Some(runner.harness),
        };
        let previous = self
            .host
            .store()
            .update_video(video_id, |v| Ok(v.latest_job.replace(job.clone())))?;
        if let Some(previous) = previous {
            st.origins.remove(&previous.id);
            self.logs.forget(&previous.id);
            if let Err(err) = self.host.store().remove_log(&previous.id) {
                eprintln!("vidai: {err}");
            }
        }
        st.origins.insert(job.id.clone(), plan.clone());
        st.queue.push(video_id, plan);
        self.log(video_id, &job.id, Draft::status("Queued"));
        log_edit(self.host.store(), video_id, "started", started_line);
        self.host.notify(Notice::JobUpdated(Box::new(job.clone())));
        self.host.notify(Notice::LibraryChanged);
        self.pump(st);
        Ok(self.latest(video_id).unwrap_or(job))
    }

    /// Re-edit and render: need an edited video without an active job.
    fn create_follow_up(
        self: &Arc<Self>,
        video_id: &str,
        kind: JobKind,
        plan: impl FnOnce(Option<String>) -> Plan,
    ) -> AppResult<JobView> {
        let ctx = self.host.resolve_video(video_id)?;
        if ctx.output.review_files.is_empty() {
            return Err(AppError::invalid_input(
                "This video has no review project yet. Start Editing first.",
            ));
        }
        let mut st = self.lock();
        self.refuse_if_active(video_id)?;
        let previous = self.host.store().video(video_id).latest_job;
        let resume = previous.as_ref().and_then(|j| j.session_id.clone());
        // The session stays on the setup (and the model) it was written with.
        let runner = runner::for_follow_up(
            previous.as_ref(),
            resume.as_deref(),
            &self.host.store().settings(),
        );
        self.create(
            &mut st,
            video_id,
            kind,
            ctx.video_type,
            plan(resume),
            runner,
        )
    }

    /// Records the runner a job switched to at launch (`runner::choose`), and returns the job.
    pub(crate) fn set_runner(
        &self,
        video_id: &str,
        job_id: &str,
        runner: &Runner,
    ) -> Option<JobView> {
        let _st = self.lock();
        self.set_job(video_id, job_id, |j| {
            j.setup = runner.setup;
            j.harness = Some(runner.harness);
            j.model = runner.model.clone();
            j.effort = runner.effort.clone();
        })
    }

    /// Looks at the queue: starts what the slots and the start delay allow (`queue::schedule`,
    /// the settings are read at every decision), updates the `startsAt` of the jobs that keep
    /// waiting and arms the start delay timer for the next time the delay opens.
    fn pump(self: &Arc<Self>, st: &mut State) {
        if st.quitting {
            self.start_timer.arm(None);
        } else {
            let settings = self.host.store().settings();
            let now = self.host.now();
            let kinds: Vec<StartKind> = st
                .queue
                .iter()
                .map(|(video_id, plan)| self.start_kind(video_id, plan))
                .collect();
            let schedule = queue::schedule(
                &kinds,
                Gate {
                    free_slots: free_slots(settings.max_concurrent_edits, st.live.len()),
                    holding: st.live.len(),
                    delay: self.start_delay(settings.start_delay_minutes),
                    // A clock moved backwards never makes a job wait longer than one delay.
                    last_launch: st.last_launch.map(|t| t.min(now)),
                    now,
                },
            );
            let waiting: Vec<(String, Option<DateTime<Utc>>, bool)> = st
                .queue
                .iter()
                .zip(&schedule.starts_at)
                .enumerate()
                .filter(|(i, _)| !schedule.launch.contains(i))
                .map(|(_, ((video_id, plan), at))| {
                    let continuing = matches!(plan, Plan::Continue { .. });
                    (video_id.to_owned(), *at, continuing)
                })
                .collect();
            if schedule.restarts_clock {
                self.restart_delay_clock(st, now);
            }
            for (video_id, plan) in st.queue.take_positions(&schedule.launch) {
                self.launch(st, &video_id, plan, now);
            }
            let mut changed = false;
            for (video_id, at, continuing) in waiting {
                changed |= self.set_starts_at(&video_id, at, continuing);
            }
            if changed {
                // `startNow` depends on `startsAt` (scanner::compute_actions).
                self.host.notify(Notice::LibraryChanged);
            }
            self.start_timer.arm(
                schedule
                    .wake_at
                    .map(|at| (at - now).to_std().unwrap_or_default()),
            );
        }
        self.update_awake(st);
    }

    /// How a queued job would start: a continue of a job that has a session resumes work that was
    /// already started; everything else is a launch of new work.
    fn start_kind(&self, video_id: &str, plan: &Plan) -> StartKind {
        let has_session = self
            .host
            .store()
            .video(video_id)
            .latest_job
            .is_some_and(|j| j.session_id.is_some());
        match plan {
            Plan::Continue { .. } if has_session => StartKind::Resume,
            _ => StartKind::Fresh,
        }
    }

    /// The start delay for a setting of `minutes`.
    fn start_delay(&self, minutes: u32) -> chrono::Duration {
        chrono::Duration::from_std(self.timings.start_delay_minute.saturating_mul(minutes))
            .unwrap_or(chrono::Duration::MAX)
    }

    /// Restarts the start delay clock at `now` and saves it, so it survives a restart.
    fn restart_delay_clock(&self, st: &mut State, now: DateTime<Utc>) {
        st.last_launch = Some(now);
        save_last_launch(self.host.store(), now);
    }

    /// Sets the `startsAt` of a job that stays queued, with a matching `lastActivity`. Returns
    /// whether it changed.
    fn set_starts_at(&self, video_id: &str, at: Option<DateTime<Utc>>, continuing: bool) -> bool {
        let at = at.map(iso);
        let Some(job) = self.host.store().video(video_id).latest_job else {
            return false;
        };
        if job.state != JobState::Queued || job.starts_at == at {
            return false;
        }
        let activity = match (&at, continuing) {
            (Some(_), _) => "Waiting for the start delay",
            (None, true) => "Waiting to continue",
            (None, false) => "Waiting for a free slot",
        };
        self.set_job(video_id, &job.id, |j| {
            j.starts_at = at;
            j.last_activity = Some(activity.into());
        })
        .is_some()
    }

    /// Moves a job taken out of the queue to `running` and starts its driver thread.
    fn launch(self: &Arc<Self>, st: &mut State, video_id: &str, plan: Plan, now: DateTime<Utc>) {
        let Some(job) = self.host.store().video(video_id).latest_job else {
            return;
        };
        if job.state != JobState::Queued {
            return;
        }
        let Some(job) = self.set_job(video_id, &job.id, |j| {
            enter_running(j, now);
            j.starts_at = None;
            j.last_activity = Some(
                match job.harness() {
                    Harness::ClaudeCode => "Starting Claude Code",
                    Harness::Opencode2 => "Starting OpenCode 2",
                }
                .into(),
            );
        }) else {
            return;
        };
        let origin = st.origins.get(&job.id).cloned();
        let (tx, rx) = mpsc::channel();
        let halt = Halt::default();
        st.live.insert(
            video_id.to_owned(),
            Live {
                job_id: job.id.clone(),
                control: tx.clone(),
                halt: halt.clone(),
                session: None,
            },
        );
        let inner = Arc::clone(self);
        let spawned = thread::Builder::new()
            .name(format!("vidai-job-{}", job.id))
            .spawn(move || driver::run(inner, job, plan, origin, tx, rx, halt));
        if let Err(err) = spawned {
            eprintln!("vidai: could not start a job thread: {err}");
            st.live.remove(video_id);
        }
    }

    fn update_awake(&self, st: &mut State) {
        let on = !st.live.is_empty();
        if on != st.awake {
            st.awake = on;
            self.host.notify(Notice::KeepAwake(on));
        }
        let editing = jobs_active(
            self.host
                .store()
                .latest_jobs()
                .into_iter()
                .map(|job| job.state),
        );
        if editing != st.editing {
            st.editing = editing;
            self.host.notify(Notice::EditingActive(editing));
        }
    }

    /// Saves `lastActivity`, `costUsd` and `progress` of a running job (throttled by the driver).
    /// A progress change that need not be persisted yet (the time-based creep) is kept in memory
    /// and written with the next save (see `progress::PERSIST_EVERY`).
    pub(crate) fn set_progress(
        &self,
        video_id: &str,
        job_id: &str,
        activity: Option<String>,
        cost: Option<f64>,
        progress: Option<progress::Update>,
    ) {
        let _st = self.lock();
        let store = self.host.store();
        let running = |j: &JobView| j.id == job_id && j.state == JobState::Running;
        let deferred = activity.is_none() && cost.is_none();
        let deferred = deferred && progress.as_ref().is_some_and(|p| !p.persist);
        let mut view = None;
        if let Some(update) = progress {
            // The engine's memory goes with the job's progress, in the same save.
            let _ = store.update_video_deferred(video_id, |v| {
                if v.latest_job.as_ref().is_some_and(running) {
                    v.progress_memory = Some(update.memory);
                }
                Ok(())
            });
            view = Some(update.view);
        }
        let apply = |j: &mut JobView| {
            if j.state != JobState::Running {
                return;
            }
            if let Some(activity) = activity {
                j.last_activity = Some(activity);
            }
            if cost.is_some() {
                j.cost_usd = cost;
            }
            if view.is_some() {
                j.progress = view;
            }
        };
        if !deferred {
            self.set_job(video_id, job_id, apply);
            return;
        }
        let updated = store.update_video_deferred(video_id, |v| {
            Ok(v.latest_job.as_mut().filter(|j| running(j)).map(|j| {
                apply(j);
                j.clone()
            }))
        });
        if let Ok(Some(job)) = updated {
            self.host.notify(Notice::JobUpdated(Box::new(job)));
        }
    }

    /// Claims `session_id` for the next Claude process of a running job, right before it is
    /// spawned (SPEC section 6, "One session per video"), and records it as the job's session.
    ///
    /// Refused (`false`) when the session belongs to another video: recorded as the session of
    /// another video's job, or used by another job's live process. The driver then starts a new
    /// session instead. The other videos that recorded it (and are not running on it right now)
    /// forget it too, so none of them resumes a conversation that may belong to another video.
    pub(crate) fn claim_session(&self, video_id: &str, job_id: &str, session_id: &str) -> bool {
        let mut st = self.lock();
        let live_elsewhere = st
            .live
            .iter()
            .any(|(v, l)| v != video_id && l.session.as_deref() == Some(session_id));
        let stored_elsewhere: Vec<JobView> = self
            .host
            .store()
            .latest_jobs()
            .into_iter()
            .filter(|j| j.video_id != video_id && j.session_id.as_deref() == Some(session_id))
            .collect();
        if live_elsewhere || !stored_elsewhere.is_empty() {
            for job in &stored_elsewhere {
                self.retire_session(&st, job);
            }
            return false;
        }
        if let Some(live) = st.live.get_mut(video_id).filter(|l| l.job_id == job_id) {
            live.session = Some(session_id.to_owned());
        }
        self.set_job(video_id, job_id, |j| {
            j.session_id = Some(session_id.to_owned())
        });
        true
    }

    /// Makes a job forget a session that is recorded for more than one video, unless its live
    /// process is using it right now. Its next run starts a new session with the full
    /// instructions. Call with the manager lock held.
    fn retire_session(&self, st: &State, job: &JobView) {
        let Some(session_id) = job.session_id.as_deref() else {
            return;
        };
        let in_use = st
            .live
            .get(&job.video_id)
            .is_some_and(|l| l.session.as_deref() == Some(session_id));
        if in_use {
            return;
        }
        self.set_job(&job.video_id, &job.id, |j| j.session_id = None);
        self.log(
            &job.video_id,
            &job.id,
            Draft::status(
                "This video's Claude session was also recorded for another video, so it will not be resumed. The next run starts a new session with the full instructions.",
            ),
        );
    }

    /// Replaces the registered processes of a job and rewrites the registry file.
    pub(crate) fn register_processes(&self, job_id: &str, entries: Vec<RegistryEntry>) {
        let mut registry = self.registry.lock().unwrap_or_else(PoisonError::into_inner);
        // The tree is re-read often and rarely changes: rewrite the file only when it does.
        let unchanged = if entries.is_empty() {
            registry.remove(job_id).is_none()
        } else {
            registry.insert(job_id.to_owned(), entries.clone()).as_ref() == Some(&entries)
        };
        if unchanged {
            return;
        }
        let all: Vec<RegistryEntry> = registry.values().flatten().cloned().collect();
        if let Err(err) = process::write_registry(&self.registry_path(), &all) {
            eprintln!("vidai: could not write the process registry: {err}");
        }
    }

    /// Applies a driver's outcome and frees its slot.
    pub(crate) fn finish_driver(self: &Arc<Self>, job: &JobView, outcome: Outcome) {
        self.register_processes(&job.id, Vec::new());
        let mut st = self.lock();
        if st
            .live
            .get(&job.video_id)
            .is_some_and(|l| l.job_id == job.id)
        {
            st.live.remove(&job.video_id);
        }
        let now = self.host.now();
        let folder = folder_of(&job.video_id).to_owned();
        let (state, activity, draft, notification) = match &outcome {
            Outcome::Completed { file } => {
                let line = match file {
                    Some(name) => format!("Finished: {name}"),
                    None => "Finished".to_owned(),
                };
                let (title, body) = match job.kind {
                    JobKind::Edit => ("Edit finished", format!("{folder} is ready for review.")),
                    JobKind::ReEdit => {
                        ("Re-edit finished", format!("{folder} is ready for review."))
                    }
                    JobKind::Render => (
                        "Final render finished",
                        format!("The final render of {folder} is ready."),
                    ),
                };
                (
                    JobState::Completed,
                    "Finished".to_owned(),
                    Draft::status(line),
                    Some((title.to_owned(), body)),
                )
            }
            Outcome::Failed(message) => (
                JobState::Failed,
                "Needs attention".to_owned(),
                Draft::error(message.clone()),
                Some((
                    "Edit needs attention".to_owned(),
                    format!("{folder}: {}", self.logs.scrub(message)),
                )),
            ),
            Outcome::Paused => (
                JobState::Paused,
                "Paused".to_owned(),
                Draft::status("Paused. Press Continue Editing to resume."),
                None,
            ),
            Outcome::Stopped => (
                JobState::Stopped,
                "Stopped".to_owned(),
                Draft::status("Stopped. The working files are kept."),
                None,
            ),
        };
        self.log(&job.video_id, &job.id, draft);
        self.set_job(&job.video_id, &job.id, |j| {
            leave_running(j, now);
            j.state = state;
            j.last_activity = Some(activity);
            if state == JobState::Completed {
                j.progress = Some(progress::completed());
            }
            j.error = match &outcome {
                Outcome::Failed(message) => Some(message.clone()),
                _ => None,
            };
            if matches!(
                state,
                JobState::Completed | JobState::Failed | JobState::Stopped
            ) {
                j.ended_at = Some(iso(now));
            }
        });
        if let Some((title, body)) = notification {
            self.host.notify(Notice::Notify { title, body });
        }
        let (event, message) = match (&outcome, state) {
            (Outcome::Completed { .. }, _) => (
                "completed",
                format!("Finished ({})", Runner::of(job).describe()),
            ),
            (Outcome::Failed(message), _) => (
                "failed",
                format!("Needs attention: {}", self.logs.scrub(message)),
            ),
            (_, JobState::Stopped) => ("stopped", "Stopped".to_owned()),
            (_, JobState::Paused) => ("paused", "Paused".to_owned()),
            _ => ("updated", "Updated".to_owned()),
        };
        log_edit(self.host.store(), &job.video_id, event, message);
        self.pump(&mut st);
        drop(st);
        self.drivers_changed.notify_all();
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.start_timer.close();
        self.logs.flush();
    }
}

/// The saved time of the most recent launch ([`START_DELAY_FILE`]), if there is a readable one.
fn load_last_launch(data_dir: &std::path::Path) -> Option<DateTime<Utc>> {
    let text = std::fs::read_to_string(data_dir.join(START_DELAY_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("lastLaunch")?.as_str().and_then(parse_iso)
}

/// Saves the time of the most recent launch. A failure only costs the delay after a restart, so
/// it is reported and otherwise ignored.
fn save_last_launch(store: &crate::store::Store, at: DateTime<Utc>) {
    let text = serde_json::json!({ "lastLaunch": iso(at) }).to_string();
    if let Err(err) = store.write_data_file(START_DELAY_FILE, text.as_bytes()) {
        eprintln!("vidai: could not save the start delay clock: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_clock_excludes_other_time() {
        let t0 = Utc::now();
        let mut job = JobView {
            id: "j".into(),
            video_id: "c/v".into(),
            kind: JobKind::Edit,
            state: JobState::Queued,
            session_id: None,
            toolkit: Default::default(),
            model: None,
            effort: None,
            video_type: VideoType::Long,
            created_at: iso(t0),
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
        };
        enter_running(&mut job, t0 + chrono::Duration::seconds(10));
        assert_eq!(
            job.started_at,
            Some(iso(t0 + chrono::Duration::seconds(10)))
        );
        leave_running(&mut job, t0 + chrono::Duration::seconds(12));
        assert_eq!(job.active_ms, 2_000);
        assert_eq!(job.running_since, None);
        // Paused for a minute, then running again for 3 seconds.
        enter_running(&mut job, t0 + chrono::Duration::seconds(72));
        leave_running(&mut job, t0 + chrono::Duration::seconds(75));
        assert_eq!(job.active_ms, 5_000);
        assert_eq!(
            job.started_at,
            Some(iso(t0 + chrono::Duration::seconds(10)))
        );
        // Leaving twice adds nothing.
        leave_running(&mut job, t0 + chrono::Duration::seconds(99));
        assert_eq!(job.active_ms, 5_000);
        assert_eq!(folder_of("chan/My Video"), "My Video");
    }
}

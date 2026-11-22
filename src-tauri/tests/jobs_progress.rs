//! End-to-end tests of the progress of a job (SPEC section 6, "Progress"): the real
//! `JobManager`, driver threads and Claude sessions against the fake `claude`
//! (tests/support/fake-claude.sh) in its `progress` scenario, which works through the steps of a
//! real edit one at a time (with or without progress markers) and waits for the test between
//! them. Like tests/jobs_engine.rs, nothing here touches the real Claude Code or the developer's
//! files, and every wait is bounded.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tempfile::TempDir;

mod support;
use vidai_lib::error::{AppError, AppResult};
use vidai_lib::jobs::{JobHost, JobManager, Notice, Timings};
use vidai_lib::model::{
    Channel, ChannelProfile, ChannelVideoType, JobKind, JobProgress, JobState, JobView, LogKind,
    Setup, VideoInputs, VideoOutput, VideoType,
};
use vidai_lib::scanner::VideoContext;
use vidai_lib::store::{Durability, Store};

const CHANNEL_ID: &str = "chan";
const CHANNEL_FOLDER: &str = "Kudrat";
const VIDEO: &str = "019 Hair Mask";
/// Upper bound of every wait for something the test expects. Waits end as soon as the condition
/// holds, so this only decides how long a real hang takes to fail: generous, so that a machine
/// busy with many test runs at once is never mistaken for a hang.
const WAIT: Duration = Duration::from_secs(90);

/// The stage and the percent each step of the fake's edit ends on (marker values of the edit
/// model: 3, 15, 30, then graphics 64 and b-roll 74, 83, 91, 96, 99).
const EDIT_STEPS: [(u32, &str); 9] = [
    (3, "Transcribing"),
    (15, "Planning the edit"),
    (30, "Building graphics"),
    (64, "Preparing b-roll"),
    (74, "Assembling the timeline"),
    (83, "Checking the edit"),
    (91, "Writing the review project"),
    (96, "Thumbnails and details"),
    (99, "Finishing up"),
];

struct FakeHost {
    store: Store,
    editing: PathBuf,
    program: PathBuf,
    state: PathBuf,
    notices: Mutex<Vec<Notice>>,
}

impl JobHost for FakeHost {
    fn store(&self) -> &Store {
        &self.store
    }

    fn resolve_video(&self, video_id: &str) -> AppResult<VideoContext> {
        let (channel_id, folder) = video_id
            .split_once('/')
            .ok_or_else(|| AppError::not_found("bad id"))?;
        let path = self.editing.join(CHANNEL_FOLDER).join(folder);
        Ok(VideoContext {
            video_id: video_id.into(),
            channel_id: channel_id.into(),
            channel_folder: CHANNEL_FOLDER.into(),
            video_folder: folder.into(),
            editing_folder: self.editing.clone(),
            path: path.clone(),
            video_type: VideoType::Short,
            broll_folder: "Broll".into(),
            output: self.scan_output(&path),
            main_aroll: None,
            aroll_rotation: None,
        })
    }

    fn scan_output(&self, video_dir: &Path) -> VideoOutput {
        // The app's own output detection: a Premiere Pro XML counts only with `<xmeml`.
        vidai_lib::scanner::scan_output(video_dir)
    }

    fn claude_program(&self, _setup: Setup) -> AppResult<PathBuf> {
        Ok(self.program.clone())
    }

    fn child_env(&self) -> HashMap<String, String> {
        let mut env = support::base_env();
        env.insert(
            "FAKE_STATE".into(),
            self.state.to_string_lossy().into_owned(),
        );
        env
    }

    fn notify(&self, notice: Notice) {
        self.notices.lock().unwrap().push(notice);
    }
}

/// Engine timings for the tests. The fake answers interrupts and exits when stdin closes, so the
/// limits on those waits only catch hangs and are as generous as `WAIT`. The settle time is what
/// a job must stay idle before it counts as finished: the fake can look idle for a moment
/// between two lines (a finished background task is reported before the turn it starts, as with
/// the real Claude Code), so it is long enough for any scheduling delay, while still short
/// enough to keep the tests quick. The stall timeout never fires in a test. Saving the log and the
/// job state and re-reading the process tree (with `ps`) are paced like in the app, only a few
/// times faster, so that many test processes at once do not flood the machine with them.
fn timings() -> Timings {
    Timings {
        settle: Duration::from_secs(1),
        interrupt_timeout: WAIT,
        exit_timeout: WAIT,
        kill_grace: Duration::from_millis(300),
        stall_timeout: Duration::from_secs(60 * 60),
        log_interval: Duration::from_millis(100),
        progress_interval: Duration::from_millis(250),
        tree_refresh: Duration::from_secs(5),
        start_delay_minute: Duration::from_secs(60),
        retry_second: Duration::from_secs(1),
        server_start: Default::default(),
    }
}

/// The fake `claude` (tests/support/fake-claude.sh), as one executable shared by every test.
fn fake_program() -> PathBuf {
    support::installed(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/fake-claude.sh"))
}

struct Env {
    /// Taken by `restart`, which hands it to the next `Env`.
    dir: Option<TempDir>,
    host: Arc<FakeHost>,
    jobs: JobManager,
}

impl Env {
    /// An Editing Folder with one Short video, and the fake in `scenario`.
    fn new(scenario: &str) -> Self {
        let dir = TempDir::new().unwrap();
        let root = support::real_path(dir.path());
        fs::create_dir_all(root.join("Editing").join(CHANNEL_FOLDER).join(VIDEO)).unwrap();
        fs::create_dir_all(root.join("fake-state")).unwrap();
        fs::write(root.join("fake-state").join("scenario"), scenario).unwrap();
        let store = Store::open_with(root.join("data"), Durability::Unsynced).unwrap();
        store
            .update_settings(|s| {
                s.editing_folder = Some(root.join("Editing").to_string_lossy().into_owned());
                s.channels = vec![Channel {
                    id: CHANNEL_ID.into(),
                    folder_name: CHANNEL_FOLDER.into(),
                    video_type: ChannelVideoType::Short,
                    long: ChannelProfile::default(),
                    short: ChannelProfile::with_defaults("Edit this Short.".into(), String::new()),
                }];
                Ok(())
            })
            .unwrap();
        Self::with_store(dir, store)
    }

    fn with_store(dir: TempDir, store: Store) -> Self {
        let root = support::real_path(dir.path());
        let host = Arc::new(FakeHost {
            store,
            editing: root.join("Editing"),
            program: fake_program(),
            state: root.join("fake-state"),
            notices: Mutex::new(Vec::new()),
        });
        let jobs = JobManager::new(host.clone(), timings());
        Self {
            dir: Some(dir),
            host,
            jobs,
        }
    }

    /// Quits like the app does (pause every running job, final cleanup), then starts again from
    /// what is on disk: a new store read from the data folder and a new job manager.
    fn restart(mut self) -> Self {
        assert!(self.jobs.pause_all_for_quit(WAIT));
        self.jobs.shutdown();
        let data = self.host.store.data_dir().to_path_buf();
        let dir = self.dir.take().unwrap();
        drop(self);
        let env = Self::with_store(dir, Store::open_with(data, Durability::Unsynced).unwrap());
        env.jobs.recover();
        env
    }

    fn vid() -> String {
        format!("{CHANNEL_ID}/{VIDEO}")
    }

    fn fake(&self, name: &str) -> PathBuf {
        self.host.state.join(format!("{name}.{VIDEO}"))
    }

    fn start(&self) -> JobView {
        self.jobs
            .start_edit(&Self::vid(), VideoInputs::default())
            .unwrap()
    }

    fn job(&self) -> JobView {
        self.jobs.job(&Self::vid()).expect("job exists")
    }

    fn wait_until<T>(&self, what: &str, mut check: impl FnMut(&JobView) -> Option<T>) -> T {
        let deadline = Instant::now() + WAIT;
        loop {
            let job = self.job();
            if let Some(value) = check(&job) {
                return value;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}; job is {job:#?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_state(&self, state: JobState) -> JobView {
        self.wait_until(&format!("{state:?}"), |j| {
            (j.state == state).then(|| j.clone())
        })
    }

    /// Waits until the fake finished `steps` steps and stopped for the next one.
    fn wait_reached(&self, steps: u32) {
        let path = self.fake("reached");
        let deadline = Instant::now() + WAIT;
        while fs::read_to_string(&path).unwrap_or_default().trim() != steps.to_string() {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for step {steps}; job is {:#?}",
                self.job()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Lets the fake go on with its next step.
    fn next(&self) {
        fs::write(self.fake("next"), "").unwrap();
        support::wake_fakes(&self.host.state);
    }

    /// Waits for the progress to reach `percent` (it may creep beyond it, never to `below`) and
    /// `stage`.
    fn wait_progress(&self, percent: u32, below: u32, stage: &str) -> JobProgress {
        let progress = self.wait_until(&format!("{percent}% {stage}"), |j| {
            j.progress
                .clone()
                .filter(|p| p.percent >= percent && p.stage.as_deref() == Some(stage))
        });
        assert!(
            progress.percent < below,
            "{progress:?} must stay below {below}"
        );
        progress
    }

    /// The progress of every `job-updated` event of the current job, in order.
    fn published(&self) -> Vec<Option<JobProgress>> {
        let id = self.job().id;
        self.host
            .notices
            .lock()
            .unwrap()
            .iter()
            .filter_map(|n| match n {
                Notice::JobUpdated(j) if j.id == id => Some(j.progress.clone()),
                _ => None,
            })
            .collect()
    }

    fn log(&self) -> Vec<(LogKind, String)> {
        self.jobs
            .job_log(&Self::vid())
            .unwrap()
            .into_iter()
            .map(|e| (e.kind, e.text))
            .collect()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        // Never leave fake processes behind, even when a test fails.
        let _ = self.jobs.pause_all_for_quit(WAIT);
    }
}

/// Percents of the published progress never go down.
fn assert_monotonic(published: &[Option<JobProgress>]) {
    let percents: Vec<u32> = published.iter().flatten().map(|p| p.percent).collect();
    assert!(
        percents.windows(2).all(|w| w[0] <= w[1]),
        "progress went backwards: {percents:?}"
    );
}

#[test]
fn progress_rises_through_the_milestones_and_is_100_when_done() {
    let env = Env::new("progress");
    let queued = env.start();
    // A queued job has no progress yet.
    assert_eq!(queued.progress, None);
    let next_values = EDIT_STEPS.iter().skip(1).map(|s| s.0).chain([100]);
    for ((step, (percent, stage)), below) in (1..).zip(EDIT_STEPS).zip(next_values) {
        env.wait_reached(step);
        env.wait_progress(percent, below, stage);
        env.next();
    }
    let done = env.wait_state(JobState::Completed);
    assert_eq!(
        done.progress,
        Some(JobProgress {
            percent: 100,
            stage: Some("Done".into())
        })
    );
    assert!(env.jobs.wait_until_idle(WAIT));

    let published = env.published();
    assert_eq!(published.first(), Some(&None), "queued without progress");
    assert_monotonic(&published);
    let percents: Vec<u32> = published.iter().flatten().map(|p| p.percent).collect();
    assert!(percents.iter().filter(|p| **p < 100).all(|p| *p <= 99));
    // Throttled: far fewer events than progress checks.
    assert!(
        published.len() < 150,
        "{} job-updated events",
        published.len()
    );

    // Marker lines are compact status entries in the log, never assistant text.
    let log = env.log();
    for line in [
        "Footage inspected",
        "Transcription done",
        "Edit plan written",
        "Graphics built",
        "Review project saved",
        "Thumbnails and details written",
    ] {
        assert!(
            log.contains(&(LogKind::Status, line.to_owned())),
            "{line}: {log:#?}"
        );
    }
    assert!(log.iter().all(|(_, t)| !t.contains("VIDAI_PROGRESS")));
    assert!(log.contains(&(
        LogKind::Assistant,
        "The edit plan is written: 41 shots, 23 graphics.".to_owned()
    )));

    // The first message asked for the markers.
    let history = env.host.store.progress_runs("edit/short");
    assert_eq!(history.len(), 1, "the finished job paces the next ones");
    assert_eq!(history[0].milestones.len(), 9);
    assert!(history[0].total_ms >= history[0].milestones["review_saved"]);
}

#[test]
fn progress_freezes_on_pause_and_continues_after() {
    let env = Env::new("progress");
    env.start();
    for (step, (percent, stage)) in (1..=3).zip(EDIT_STEPS) {
        env.wait_reached(step);
        env.wait_progress(percent, 64, stage);
        if step < 3 {
            env.next();
        }
    }
    env.jobs.pause_job(&Env::vid()).unwrap();
    let paused = env.wait_state(JobState::Paused);
    let frozen = paused.progress.clone().unwrap();
    assert!(frozen.percent >= 30 && frozen.percent < 64, "{frozen:?}");
    assert_eq!(frozen.stage.as_deref(), Some("Building graphics"));
    // Nothing moves while paused. (The state is saved just before its event goes out: count the
    // events once the driver is done.)
    assert!(env.jobs.wait_until_idle(WAIT));
    let events = env.published().len();
    std::thread::sleep(timings().progress_interval * 6);
    assert_eq!(env.job().progress, Some(frozen.clone()));
    assert_eq!(env.published().len(), events);

    // Continue: queued and running again from the same value, never lower.
    let queued = env.jobs.continue_job(&Env::vid()).unwrap();
    assert!(queued.progress.as_ref().unwrap().percent >= frozen.percent);
    // The resumed session goes on with step 4 (graphics).
    env.wait_reached(4);
    env.wait_progress(64, 74, "Preparing b-roll");
    for step in 5..=9 {
        env.next();
        env.wait_reached(step);
    }
    env.next();
    let done = env.wait_state(JobState::Completed);
    assert_eq!(done.progress.unwrap().percent, 100);
    assert_monotonic(&env.published());
}

#[test]
fn progress_survives_a_restart() {
    let env = Env::new("progress");
    env.start();
    for step in 1..=3 {
        env.wait_reached(step);
        if step < 3 {
            env.next();
        }
    }
    let before = env.wait_progress(30, 64, "Building graphics");
    // The new stage was written to disk at once.
    let on_disk = Store::open_with(env.host.store.data_dir(), Durability::Unsynced).unwrap();
    let saved = on_disk.video(&Env::vid());
    assert!(saved.latest_job.unwrap().progress.unwrap().percent >= 30);
    assert!(saved.progress_memory.unwrap().done.contains_key("planned"));

    let env = env.restart();
    let recovered = env.job();
    assert_eq!(recovered.state, JobState::Paused);
    let kept = recovered.progress.clone().unwrap();
    assert!(kept.percent >= before.percent, "{kept:?} < {before:?}");
    assert_eq!(kept.stage.as_deref(), Some("Building graphics"));

    // Continue after the restart: the finished milestones were remembered, so the graphics
    // marker lands exactly on its value (30 + 34), not just above the old percent.
    env.jobs.continue_job(&Env::vid()).unwrap();
    env.wait_reached(4);
    env.wait_progress(64, 74, "Preparing b-roll");
    for step in 5..=9 {
        env.next();
        env.wait_reached(step);
    }
    env.next();
    assert_eq!(
        env.wait_state(JobState::Completed)
            .progress
            .unwrap()
            .percent,
        100
    );
}

#[test]
fn progress_is_inferred_when_claude_writes_no_markers() {
    let env = Env::new("progress");
    fs::write(env.host.state.join("no_markers"), "").unwrap();
    env.start();
    // Step 2 runs Whisper and reads the transcript: transcribed.
    env.wait_reached(1);
    env.next();
    env.wait_reached(2);
    env.wait_progress(15, 30, "Planning the edit");
    env.next();
    // Step 4 starts the graphics sub-agent (the plan is done) and it finishes: graphics built.
    env.wait_reached(3);
    env.next();
    env.wait_reached(4);
    env.wait_progress(64, 74, "Preparing b-roll");
    for step in 5..=8 {
        env.next();
        env.wait_reached(step);
    }
    // The review project on disk implies the whole step after the plan.
    env.wait_progress(96, 99, "Thumbnails and details");
    env.next();
    // Thumbnails and meta.txt on disk.
    env.wait_reached(9);
    env.wait_progress(99, 100, "Finishing up");
    env.next();
    assert_eq!(
        env.wait_state(JobState::Completed)
            .progress
            .unwrap()
            .percent,
        100
    );
    assert_monotonic(&env.published());
    // Without markers there are no milestone lines in the log.
    assert!(
        env.log()
            .iter()
            .all(|(kind, text)| *kind != LogKind::Status || !text.ends_with(" done"))
    );
}

#[test]
fn a_new_job_for_the_same_video_starts_again_from_zero() {
    let env = Env::new("complete");
    env.start();
    let edit = env.wait_state(JobState::Completed);
    assert_eq!(edit.progress.unwrap().percent, 100);
    assert!(env.jobs.wait_until_idle(WAIT));

    fs::write(env.host.state.join("scenario"), "progress").unwrap();
    let queued = env.jobs.re_edit(&Env::vid(), "Shorter intro.").unwrap();
    assert_eq!(queued.kind, JobKind::ReEdit);
    assert_eq!(queued.progress, None, "a new job has no progress yet");
    // The re-edit model: changes applied (65), then the new review version (95).
    env.wait_reached(1);
    env.wait_progress(65, 95, "Saving the new version");
    env.next();
    env.wait_reached(2);
    env.wait_progress(95, 100, "Finishing up");
    env.next();
    let done = env.wait_state(JobState::Completed);
    assert_eq!(done.progress.unwrap().percent, 100);
    let published = env.published();
    assert_eq!(published.first(), Some(&None));
    assert_monotonic(&published);
    assert_eq!(env.host.store.progress_runs("reEdit/short").len(), 1);
}

/// What an edit whose model writes its markers only at the end shows while it works: the percent
/// and the stage the files alone give after each of the nine steps (SPEC section 6, Progress,
/// evidence 3), and the value the bar may not reach yet. The files of each step are written by the
/// fake (`batched`).
const BATCHED_STEPS: [(u32, u32, &str); 9] = [
    (3, 15, "Transcribing"),
    (15, 30, "Planning the edit"),
    (30, 64, "Building graphics"),
    // Graphics files appear, no milestone does: still the same stage.
    (30, 64, "Building graphics"),
    (30, 64, "Building graphics"),
    (30, 64, "Building graphics"),
    // The quality-check sheet: the graphics, the b-roll and the timeline are behind.
    (83, 91, "Checking the edit"),
    (96, 99, "Thumbnails and details"),
    (99, 100, "Finishing up"),
];

#[test]
fn a_model_that_writes_its_markers_at_the_end_still_moves_the_bar_with_its_files() {
    let env = Env::new("batched");
    env.start();
    let mut seen = Vec::new();
    for (step, (percent, below, stage)) in (1..).zip(BATCHED_STEPS) {
        env.wait_reached(step);
        let progress = env.wait_progress(percent, below, stage);
        seen.push(progress.percent);
        // Not one marker line so far: the milestones come from the files.
        assert!(
            !env.log()
                .iter()
                .any(|(_, text)| text == "Footage inspected"),
            "markers are held back until the end"
        );
        env.next();
    }
    let done = env.wait_state(JobState::Completed);
    assert_eq!(done.progress.as_ref().map(|p| p.percent), Some(100));
    assert!(
        env.log()
            .iter()
            .any(|(_, text)| text == "Footage inspected"),
        "the markers arrive at the end"
    );
    assert_monotonic(&env.published());
    assert!(seen.windows(2).all(|w| w[0] <= w[1]), "{seen:?}");
}

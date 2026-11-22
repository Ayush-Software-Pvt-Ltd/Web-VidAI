//! The progress of a running job (SPEC section 6, "Progress"): `JobView::progress`, a percent and
//! a short stage label for the bar on every video row.
//!
//! A job of each kind has a model: a weighted checklist of milestones ([`Milestone`]). The
//! percent is the sum of the weights of the finished milestones, plus a creep toward the next
//! one that grows with active running time, capped at 99 until the job is `completed` (then the
//! manager sets exactly 100, "Done"). Milestones may finish in any order (the step after the
//! edit plan runs in parallel), and a finished milestone implies the ones that must come before
//! it ([`Milestone::implies`]).
//!
//! Evidence, most reliable first:
//! 1. Markers: Claude writes `[VIDAI_PROGRESS <name>]` on a line by itself in a normal message of
//!    the main session each time a milestone is finished (the prompt lists the names, see
//!    [`marker_instructions`]). `jobs::log` shows such lines as compact status entries.
//! 2. Files on disk ([`OutputEvidence`]): a review project, thumbnails with meta.txt, or a final
//!    render written into `output/` after the job started.
//! 3. The working folder of the video ([`crate::jobs::work`]): kinds of files that appeared since
//!    the job started (audio, a transcript, a plan or timeline file, graphics, quality-check
//!    output). It does not depend on the program or the model that does the work.
//! 4. The stream ([`Progress::observe`]): generic keywords in tool calls, background tasks and
//!    sub-agents (transcription commands, writing a plan or graphics file, the graphics fan-out,
//!    ...). Never tied to one toolkit's file names.
//! 5. Time ([`Progress::current`]): the bar moves with active working time along the typical
//!    timeline of the model, from the last evidence on, across milestones that have no evidence
//!    yet, slowing down when the job is later than typical, and never past what the files
//!    allow: a milestone that only a file can confirm (the review project, the thumbnails, the
//!    final render) is never credited by time, so the bar never reaches its value before the
//!    file exists. The stage label is the first unfinished milestone; once the bar is ahead of
//!    what the evidence confirms, the label says only that the job is working.
//!
//! [`Progress`] is pure and clock-injected (every call takes the job's active milliseconds), so
//! it is unit-tested without waiting. [`Tracker`] is the small driver-side wrapper: it reads the
//! clock and the output folder, restores the engine of a continued job, throttles what is
//! published and decides when it is persisted.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;

use crate::claude::protocol::{Block, StreamEvent, SystemEvent};
use crate::jobs::host::JobHost;
use crate::jobs::work;
use crate::model::{JobKind, JobProgress, JobView, VideoOutput, VideoType};
use crate::store::{ProgressMark, ProgressMemory, ProgressRun, Store};

/// What a marker line looks like: `[VIDAI_PROGRESS transcribed]`.
pub const MARKER_TAG: &str = "VIDAI_PROGRESS";
/// The stage of a completed job.
pub const DONE_STAGE: &str = "Done";
/// The stage while the job installs or tests the tools it needs (a fresh computer has none of
/// them): setup commands are not the work, so the bar waits for the work.
pub const SETUP_STAGE: &str = "Getting the tools ready";
/// The stage once every milestone of the model is finished but the job is not completed yet.
pub const FINISHING_STAGE: &str = "Finishing up";
/// Highest percent before the job is `completed`.
pub const MAX_RUNNING_PERCENT: u32 = 99;

/// Shortest stretch the estimate is paced with, so tiny or inconsistent typical times never make
/// the bar jump.
const MIN_STRETCH_MS: f64 = 20_000.0;
/// The pace of a job (its time so far against the typical time) is clamped to this range; a slow
/// computer (an Intel Mac against the Apple Silicon edits of the defaults) is several times slower.
const PACE_RANGE: (f64, f64) = (0.5, 6.0);
/// Once the job is later than the typical end of the stage it is in, the estimate goes on with a
/// logarithmic slow-down whose scale is this share of the typical total time, at first at this
/// share of the typical speed (it is a guess now, not evidence).
const SLOWDOWN_SHARE: f64 = 0.1;
const SPILL_RATE: f64 = 0.3;
/// The bar may be this many points past the value of the stage the label names before the label
/// stops naming it.
const LABEL_SLACK: u32 = 2;
/// Milestones typically reached this early say little about the pace of the job.
const MIN_PACE_EVIDENCE_MS: u64 = 120_000;
/// A typical time is learned from history once this many finished jobs have it.
const MIN_HISTORY_RUNS: usize = 3;

// ---------------------------------------------------------------------------------------------
// Milestones and models
// ---------------------------------------------------------------------------------------------

/// One step of a job whose end can be confirmed. The marker name is [`Milestone::name`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Milestone {
    // edit
    Inspected,
    Transcribed,
    Planned,
    GraphicsBuilt,
    BrollReady,
    Assembled,
    Checked,
    /// edit and reEdit: a review project (or a new version of it) is saved in `output/`.
    ReviewSaved,
    ExtrasWritten,
    // reEdit
    ChangesApplied,
    // render
    RenderStarted,
    FinalWriting,
    Rendered,
}

impl Milestone {
    const ALL: [Milestone; 13] = [
        Milestone::Inspected,
        Milestone::Transcribed,
        Milestone::Planned,
        Milestone::GraphicsBuilt,
        Milestone::BrollReady,
        Milestone::Assembled,
        Milestone::Checked,
        Milestone::ReviewSaved,
        Milestone::ExtrasWritten,
        Milestone::ChangesApplied,
        Milestone::RenderStarted,
        Milestone::FinalWriting,
        Milestone::Rendered,
    ];

    /// The marker name (`[VIDAI_PROGRESS <name>]`), also the key in the persisted memory and
    /// history.
    pub fn name(self) -> &'static str {
        match self {
            Milestone::Inspected => "inspected",
            Milestone::Transcribed => "transcribed",
            Milestone::Planned => "planned",
            Milestone::GraphicsBuilt => "graphics_built",
            Milestone::BrollReady => "broll_ready",
            Milestone::Assembled => "assembled",
            Milestone::Checked => "checked",
            Milestone::ReviewSaved => "review_saved",
            Milestone::ExtrasWritten => "extras_written",
            Milestone::ChangesApplied => "changes_applied",
            Milestone::RenderStarted => "render_started",
            Milestone::FinalWriting => "final_writing",
            Milestone::Rendered => "rendered",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|m| m.name() == name)
    }

    /// The status line the activity log shows for its marker.
    pub fn done_text(self) -> &'static str {
        match self {
            Milestone::Inspected => "Footage inspected",
            Milestone::Transcribed => "Transcription done",
            Milestone::Planned => "Edit plan written",
            Milestone::GraphicsBuilt => "Graphics built",
            Milestone::BrollReady => "B-roll and product images ready",
            Milestone::Assembled => "Timeline assembled",
            Milestone::Checked => "Quality checks done",
            Milestone::ReviewSaved => "Review project saved",
            Milestone::ExtrasWritten => "Thumbnails and details written",
            Milestone::ChangesApplied => "Changes applied",
            Milestone::RenderStarted => "Render started",
            Milestone::FinalWriting => "Writing the final file",
            Milestone::Rendered => "Final render written",
        }
    }

    /// What counts as finished, for the prompt.
    fn hint(self) -> &'static str {
        match self {
            Milestone::Inspected => "the footage, MEMORY.md and the inputs are checked",
            Milestone::Transcribed => "the A-roll transcript is ready",
            Milestone::Planned => "the written edit plan is ready",
            Milestone::GraphicsBuilt => "every programmatic graphic and b-roll is built",
            Milestone::BrollReady => {
                "the b-roll footage is conformed and the product images are prepared"
            }
            Milestone::Assembled => "the timeline is assembled and the audio is normalized",
            Milestone::Checked => "the quality checks are done",
            Milestone::ReviewSaved => "the review project is saved in the output folder",
            Milestone::ExtrasWritten => "the thumbnails, meta.txt and info.txt are written",
            Milestone::ChangesApplied => "the requested changes are made",
            Milestone::RenderStarted => "the final render is running",
            Milestone::FinalWriting => "the final file is being written",
            Milestone::Rendered => "the final render file is complete",
        }
    }

    /// Milestones that must be finished when this one is (one level; [`Progress`] follows them
    /// transitively). Inside the step after the plan only the review project implies the others:
    /// it is exported from the finished graphics, b-roll, timeline and checks.
    pub fn implies(self) -> &'static [Milestone] {
        match self {
            Milestone::Transcribed => &[Milestone::Inspected],
            Milestone::Planned => &[Milestone::Transcribed],
            Milestone::GraphicsBuilt
            | Milestone::BrollReady
            | Milestone::Assembled
            | Milestone::Checked => &[Milestone::Planned],
            Milestone::ReviewSaved => &[
                Milestone::GraphicsBuilt,
                Milestone::BrollReady,
                Milestone::Assembled,
                Milestone::Checked,
                Milestone::ChangesApplied,
            ],
            Milestone::ExtrasWritten => &[Milestone::Transcribed],
            Milestone::FinalWriting => &[Milestone::RenderStarted],
            Milestone::Rendered => &[Milestone::FinalWriting],
            Milestone::Inspected | Milestone::ChangesApplied | Milestone::RenderStarted => &[],
        }
    }

    /// A milestone that must also be finished before this one starts, besides the one its stretch
    /// follows ([`Step::after`]): the timeline is assembled from the graphics and the b-roll.
    fn also_after(self) -> Option<Milestone> {
        match self {
            Milestone::Assembled => Some(Milestone::BrollReady),
            _ => None,
        }
    }

    /// Whether only a file can confirm it (the review project, the thumbnails with meta.txt, the
    /// final render). Time never credits such a milestone: the bar stays below its value until
    /// the file exists.
    pub fn needs_file(self) -> bool {
        matches!(
            self,
            Milestone::ReviewSaved
                | Milestone::ExtrasWritten
                | Milestone::FinalWriting
                | Milestone::Rendered
        )
    }

    /// Whether finishing it says where the job is on the typical timeline. The thumbnails and
    /// meta.txt come from a helper that runs beside the main work, and the b-roll runs beside
    /// the graphics (which take longer), so neither says anything about the pace of the job.
    fn anchors(self) -> bool {
        !matches!(self, Milestone::ExtrasWritten | Milestone::BrollReady)
    }
}

/// One milestone of a model.
#[derive(Debug, Clone, Copy)]
pub struct Step {
    pub milestone: Milestone,
    /// Percent points it adds when finished.
    pub weight: u32,
    /// What the job works on while this milestone is the next one (the `stage` label).
    pub stage: &'static str,
    /// The milestone whose end starts this stretch (`None`: the start of the job), for timing.
    pub after: Option<Milestone>,
    /// Typical active minutes from the start of the job to the end of this milestone, for a
    /// Short and for a Long video, when there is no history yet.
    pub typical_min: (f64, f64),
}

/// The milestones of one job kind, in the order the stage label follows (the first unfinished
/// one is the stage), and the typical active minutes of the whole job (Short, Long).
#[derive(Debug)]
pub struct Model {
    pub kind: JobKind,
    pub steps: &'static [Step],
    pub total_min: (f64, f64),
}

const fn step(
    milestone: Milestone,
    weight: u32,
    stage: &'static str,
    after: Option<Milestone>,
    typical_min: (f64, f64),
) -> Step {
    Step {
        milestone,
        weight,
        stage,
        after,
        typical_min,
    }
}

/// `edit`.
///
/// Calibration (active minutes, waiting for the creator excluded), from the info.txt files, the
/// "Lessons from" notes in MEMORY.md and a replay of the transcripts of the owner's real edits
/// through this module's inference:
///
/// - Short (Kudrat Care 001-019, Moi Phone, House of Apps; about 90 s of output): transcription
///   1.5-5 (prep and audio extract included), transcription to written plan 3-8, plan to review
///   project 15-20, total 19.5-30, typically about 25. Inside the last stretch 4 graphics agents
///   build 19-25 compositions; in the replays they started at 6-7 minutes and the last one
///   finished at 20-24, while the lead conformed b-roll, set the audio loudness and
///   re-transcribed for QA. The FCPXML followed about a minute after the last agent; thumbnails
///   and meta.txt came from a parallel agent that finished at 13-18.
/// - Long (Apna Trader 6991 / 4719 / 4718, Moi Phone 6121 / 7064, My Motor Talk 7082):
///   transcription 1.5-14 (3 for a 6.5-minute take, 7 for 23 minutes, 13 for 30), written plan
///   at 10-26, graphics fan-out of 20-30 (6-7 agents, 36-54 graphics) ending at 22-49, review
///   project at 27-60, typically about 40.
///
/// As a share of the whole time the milestones end at (Short / Long): inspected 3 / 2,
/// transcribed 14 / 19, planned 28 / 35, b-roll ~60 / ~56, graphics 82 / 80, assembled 86 / 85,
/// checked 90 / 89, review 94 / 94, extras 98 / 98. The weights follow those shares, rounded
/// toward the owner's own anchors (transcription about 15%, plan about 25%, all b-roll about
/// 70%): the cumulative values are 3, 15, 30, then 64 / 74 for graphics and b-roll in either
/// order, 83, 91, 96 and 99. The time creep fills the gaps, so the bar moves at a nearly even
/// speed on a typical edit and still lands on the right value whenever evidence arrives.
pub const EDIT: Model = Model {
    kind: JobKind::Edit,
    steps: &[
        step(
            Milestone::Inspected,
            3,
            "Inspecting the footage",
            None,
            (0.75, 1.0),
        ),
        step(
            Milestone::Transcribed,
            12,
            "Transcribing",
            Some(Milestone::Inspected),
            (3.5, 8.0),
        ),
        step(
            Milestone::Planned,
            15,
            "Planning the edit",
            Some(Milestone::Transcribed),
            (7.0, 15.0),
        ),
        step(
            Milestone::GraphicsBuilt,
            34,
            "Building graphics",
            Some(Milestone::Planned),
            (20.5, 34.0),
        ),
        step(
            Milestone::BrollReady,
            10,
            "Preparing b-roll",
            Some(Milestone::Planned),
            (15.0, 24.0),
        ),
        step(
            Milestone::Assembled,
            9,
            "Assembling the timeline",
            Some(Milestone::GraphicsBuilt),
            (21.5, 36.0),
        ),
        step(
            Milestone::Checked,
            8,
            "Checking the edit",
            Some(Milestone::Assembled),
            (22.5, 38.0),
        ),
        step(
            Milestone::ReviewSaved,
            5,
            "Writing the review project",
            Some(Milestone::Checked),
            (23.5, 40.0),
        ),
        step(
            Milestone::ExtrasWritten,
            3,
            "Thumbnails and details",
            Some(Milestone::ReviewSaved),
            (24.5, 41.5),
        ),
    ],
    total_min: (25.0, 42.5),
};

/// `reEdit`: revisions of the owner's edits took 6-9 minutes on a Short (all text pop-ups moved
/// and checked frame by frame, FCPXML re-exported); a Long takes longer.
pub const RE_EDIT: Model = Model {
    kind: JobKind::ReEdit,
    steps: &[
        step(
            Milestone::ChangesApplied,
            65,
            "Applying the changes",
            None,
            (5.0, 9.0),
        ),
        step(
            Milestone::ReviewSaved,
            30,
            "Saving the new version",
            Some(Milestone::ChangesApplied),
            (6.5, 11.0),
        ),
    ],
    total_min: (7.5, 12.5),
};

/// `render`: the 4K render of a 4-minute Long took 14.5 minutes, most of it rendering the
/// graphics at 4K before the shots and the final encode; a Short is a few minutes.
pub const RENDER: Model = Model {
    kind: JobKind::Render,
    steps: &[
        step(
            Milestone::RenderStarted,
            10,
            "Preparing the render",
            None,
            (1.0, 2.0),
        ),
        step(
            Milestone::FinalWriting,
            60,
            "Rendering",
            Some(Milestone::RenderStarted),
            (6.0, 12.0),
        ),
        step(
            Milestone::Rendered,
            25,
            "Writing the final file",
            Some(Milestone::FinalWriting),
            (8.0, 15.0),
        ),
    ],
    total_min: (9.0, 16.5),
};

/// The model of a job kind.
pub fn model(kind: JobKind) -> &'static Model {
    match kind {
        JobKind::Edit => &EDIT,
        JobKind::ReEdit => &RE_EDIT,
        JobKind::Render => &RENDER,
    }
}

/// The key of a kind and video type in the history, for example `edit/short`.
pub fn history_key(kind: JobKind, video_type: VideoType) -> String {
    let kind = match kind {
        JobKind::Edit => "edit",
        JobKind::ReEdit => "reEdit",
        JobKind::Render => "render",
    };
    let video_type = match video_type {
        VideoType::Long => "long",
        VideoType::Short => "short",
    };
    format!("{kind}/{video_type}")
}

// ---------------------------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------------------------

/// The prompt lines that list the markers of a kind's model (one line each on what counts as
/// finished). The paragraph around them is written in `jobs::prompt`.
pub fn marker_lines(kind: JobKind) -> String {
    model(kind)
        .steps
        .iter()
        // The disk shows when the final file is being written; no marker is asked for.
        .filter(|s| s.milestone != Milestone::FinalWriting)
        .map(|s| {
            format!(
                "[{MARKER_TAG} {}] - {}",
                s.milestone.name(),
                s.milestone.hint()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The "Progress markers" paragraph of the first message of a job of `kind` (exact text tested in
/// `jobs::prompt`).
pub fn marker_instructions(kind: JobKind) -> String {
    format!(
        "Progress markers: VidAI shows a progress bar for this job. Each time one of these steps is finished, write its marker on a line by itself in a normal message of the main session (never in sub-agents). Steps may finish in any order; skip a step that does not apply.\n{}",
        marker_lines(kind)
    )
}

/// Splits Claude's text into what is left after removing marker lines, and the marker names
/// found (lower case, `-` read as `_`), in order. A marker line holds only markers, optionally
/// wrapped in Markdown emphasis or code; a marker inside a sentence is prose, not a marker.
pub fn split_markers(text: &str) -> (String, Vec<String>) {
    let mut names = Vec::new();
    let mut kept = Vec::new();
    for line in text.lines() {
        match line_markers(line) {
            Some(found) => names.extend(found),
            None => kept.push(line),
        }
    }
    if names.is_empty() {
        return (text.to_owned(), names);
    }
    (kept.join("\n").trim().to_owned(), names)
}

/// The markers of a line that holds nothing else (besides spaces and `*`, `_`, `` ` ``, `>`, `-`).
fn line_markers(line: &str) -> Option<Vec<String>> {
    let mut names = Vec::new();
    let mut rest = line;
    let filler = |s: &str| s.chars().all(|c| c.is_whitespace() || "*_`>-".contains(c));
    while let Some(open) = rest.find('[') {
        if !filler(&rest[..open]) {
            return None;
        }
        let after = &rest[open + 1..];
        let close = after.find(']')?;
        let inner = after[..close].trim();
        let (tag, name) = inner.split_once(char::is_whitespace)?;
        if !tag.eq_ignore_ascii_case(MARKER_TAG) {
            return None;
        }
        let name = name.trim().to_ascii_lowercase().replace('-', "_");
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return None;
        }
        names.push(name);
        rest = &after[close + 1..];
    }
    (!names.is_empty() && filler(rest)).then_some(names)
}

/// The activity log line of a marker: the milestone's done text, or the raw name for one VidAI
/// does not know.
pub fn marker_log_line(name: &str) -> String {
    match Milestone::from_name(name) {
        Some(m) => m.done_text().to_owned(),
        None => format!("Progress: {name}"),
    }
}

// ---------------------------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------------------------

/// Typical active milliseconds from the start of a job to the end of each step of its model, and
/// of the whole job.
#[derive(Debug, Clone, PartialEq)]
pub struct Pacing {
    /// Same order as the model's steps.
    pub at_ms: Vec<u64>,
    pub total_ms: u64,
}

fn minutes(min: f64) -> u64 {
    (min * 60_000.0).round() as u64
}

fn median(values: &mut [u64]) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let mid = values.len() / 2;
    Some(if values.len() % 2 == 1 {
        values[mid]
    } else {
        (values[mid - 1] + values[mid]) / 2
    })
}

impl Pacing {
    /// The defaults measured on real edits (see [`EDIT`]).
    pub fn defaults(kind: JobKind, video_type: VideoType) -> Self {
        let pick = |(short, long): (f64, f64)| match video_type {
            VideoType::Short => minutes(short),
            VideoType::Long => minutes(long),
        };
        let model = model(kind);
        Self {
            at_ms: model.steps.iter().map(|s| pick(s.typical_min)).collect(),
            total_ms: pick(model.total_min),
        }
    }

    /// Learned from finished jobs of the same kind and video type on this Mac: once at least
    /// [`MIN_HISTORY_RUNS`] runs have it, the median of each milestone and of the total replaces
    /// the default. With a learned total only, every default is scaled by it.
    pub fn from_history(kind: JobKind, video_type: VideoType, runs: &[ProgressRun]) -> Self {
        let defaults = Self::defaults(kind, video_type);
        let learned = |values: Vec<u64>| {
            let mut values: Vec<u64> = values.into_iter().filter(|v| *v > 0).collect();
            if values.len() >= MIN_HISTORY_RUNS {
                median(&mut values)
            } else {
                None
            }
        };
        let total = learned(runs.iter().map(|r| r.total_ms).collect());
        let scale = total.map_or(1.0, |t| t as f64 / defaults.total_ms.max(1) as f64);
        let at_ms = model(kind)
            .steps
            .iter()
            .zip(&defaults.at_ms)
            .map(|(s, default)| {
                let name = s.milestone.name();
                learned(
                    runs.iter()
                        .filter_map(|r| r.milestones.get(name).copied())
                        .collect(),
                )
                .unwrap_or_else(|| (*default as f64 * scale).round() as u64)
            })
            .collect();
        Self {
            at_ms,
            total_ms: total.unwrap_or(defaults.total_ms),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Evidence from the output folder
// ---------------------------------------------------------------------------------------------

/// Files in the output folder (and `info.txt`) written since the job started.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OutputEvidence {
    pub review: bool,
    pub final_file: bool,
    /// A new final file that has not changed for a while (the encoder is done with it).
    pub final_settled: bool,
    pub thumbnails: bool,
    pub meta: bool,
}

/// How long a final file must stay unchanged to count as complete.
const FINAL_SETTLE: Duration = Duration::from_secs(20);

/// Reads which output files are new since `since` (the job's first start, with a second of
/// tolerance for file systems that store whole seconds). Not pure: it reads modification times.
pub fn output_evidence(output: &VideoOutput, since: SystemTime, now: SystemTime) -> OutputEvidence {
    let since = since - Duration::from_secs(1);
    let parsed = |iso: &str| {
        chrono::DateTime::parse_from_rfc3339(iso)
            .ok()
            .map(SystemTime::from)
    };
    let fresh = |t: Option<SystemTime>| t.is_some_and(|t| t >= since);
    let review = output
        .review_files
        .iter()
        .any(|f| fresh(parsed(&f.modified_at)));
    let finals: Vec<SystemTime> = output
        .final_files
        .iter()
        .filter_map(|f| parsed(&f.modified_at))
        .filter(|t| *t >= since)
        .collect();
    OutputEvidence {
        review,
        final_file: !finals.is_empty(),
        final_settled: finals
            .iter()
            .any(|t| now.duration_since(*t).is_ok_and(|age| age >= FINAL_SETTLE)),
        thumbnails: output.thumbnails.iter().any(|p| fresh(modified(p))),
        meta: output
            .meta_file
            .as_deref()
            .is_some_and(|p| fresh(modified(p))),
    }
}

/// An output file and its modification time.
type Stamp = (String, Option<SystemTime>);

fn modified(path: &str) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Every output file with its modification time, taken when a run of the job starts.
fn stamps(output: &VideoOutput) -> HashSet<Stamp> {
    let review = output.review_files.iter().map(|f| f.path.as_str());
    let finals = output.final_files.iter().map(|f| f.path.as_str());
    let thumbnails = output.thumbnails.iter().map(String::as_str);
    review
        .chain(finals)
        .chain(thumbnails)
        .chain(output.meta_file.as_deref())
        .map(|p| (p.to_owned(), modified(p)))
        .collect()
}

/// `output` without the files that are unchanged since `known` was taken, so a file the previous
/// job wrote a moment before this one started never counts for it.
fn without_known(mut output: VideoOutput, known: &HashSet<Stamp>) -> VideoOutput {
    let new = |p: &str| !known.contains(&(p.to_owned(), modified(p)));
    output.review_files.retain(|f| new(&f.path));
    output.final_files.retain(|f| new(&f.path));
    output.thumbnails.retain(|p| new(p));
    output.meta_file = output.meta_file.filter(|p| new(p));
    output
}

// ---------------------------------------------------------------------------------------------
// Inference from the stream
// ---------------------------------------------------------------------------------------------

/// What a background task or sub-agent works on, from its description.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Group {
    Transcription,
    Graphics,
    Broll,
    Extras,
    Render,
    /// Installing or testing tools: says nothing about any step of the work.
    Setup,
    Other,
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack.contains(n))
}

const TRANSCRIPTION_WORDS: &[&str] = &["whisper", "transcrib", "transcript"];
const GRAPHICS_WORDS: &[&str] = &[
    "graphic",
    "gfx",
    "hyperframes",
    "remotion",
    "animat",
    "motion",
    "composition",
    "cards",
    "pop-up",
    "popup",
    "overlay",
    "lower third",
    "title card",
];
const BROLL_WORDS: &[&str] = &[
    "b-roll",
    "broll",
    "b roll",
    "conform",
    "stabili",
    "mezzanine",
    "product",
    "cut-out",
    "cutout",
    "packshot",
];
const EXTRAS_WORDS: &[&str] = &["thumbnail", "meta.txt", "metadata"];
const RENDER_WORDS: &[&str] = &["render", "encode", "2160", "4k", "3840"];

/// Words of commands and tasks that prepare the computer instead of doing the work: installing
/// a transcriber, creating its environment, downloading its model, a smoke test. Seen on an
/// Intel Mac, where a job spent half an hour on them; none of it is transcribing, however often
/// it names Whisper.
const SETUP_WORDS: &[&str] = &[
    "install",
    "venv",
    "virtualenv",
    "brew ",
    "apt-get",
    "smoke",
    "pip ",
    "pip3 ",
    "--help",
    "--version",
];
/// What a download is of, to count as setup.
const SETUP_DOWNLOADS: &[&str] = &[
    "model", "whisper", "ffmpeg", "node", "python", "tarball", "weights",
];

/// Whether a command or task description (lower case) prepares tools rather than works.
fn is_setup(text: &str) -> bool {
    contains_any(text, SETUP_WORDS)
        || (contains_any(text, &["download", "curl ", "wget "])
            && contains_any(text, SETUP_DOWNLOADS))
        || (text.contains("check ")
            && contains_any(text, &["import", "binar", "packages", "available"]))
}

/// Classifies a task or sub-agent description (lower case). Setup first (it names the very tools
/// it is not using), then extras (a "thumbnail graphics" agent makes thumbnails), then the step
/// after the plan, then transcription.
fn classify(description: &str) -> Group {
    if is_setup(description) {
        Group::Setup
    } else if contains_any(description, EXTRAS_WORDS) {
        Group::Extras
    } else if contains_any(description, GRAPHICS_WORDS) {
        Group::Graphics
    } else if contains_any(description, BROLL_WORDS) {
        Group::Broll
    } else if contains_any(description, TRANSCRIPTION_WORDS) {
        Group::Transcription
    } else if contains_any(description, RENDER_WORDS) {
        Group::Render
    } else {
        Group::Other
    }
}

#[derive(Debug, Clone, Copy)]
struct Task {
    group: Group,
    done: bool,
    /// Started after the edit plan was finished.
    after_plan: bool,
    /// A foreground sub-agent, finished when its tool result arrives. (A background one answers
    /// at once that it was launched; its `task_notification` tells when it is finished.)
    ends_with_result: bool,
    /// A sub-agent, not a shell command. A command that starts the transcription in the
    /// background ends when it has started it, not when the transcript is written.
    agent: bool,
}

fn input_str<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).and_then(Value::as_str).unwrap_or("")
}

/// A flag of a tool input; Claude Code has sent it as a boolean and as the string "true".
fn flag(input: &Value, key: &str) -> bool {
    match input.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

// ---------------------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------------------

/// The progress of one job. Pure: every call takes the job's active milliseconds.
#[derive(Debug, Clone)]
pub struct Progress {
    model: &'static Model,
    pacing: Pacing,
    done: BTreeMap<Milestone, ProgressMark>,
    /// The highest percent reported so far (progress never goes backwards).
    shown: u32,
    /// Background tasks and sub-agents by task id (or tool use id for foreground sub-agents).
    tasks: HashMap<String, Task>,
    /// Setup commands and tasks running now, by tool use or task id, with their start.
    setup_open: HashMap<String, u64>,
    /// Setup commands and tasks that ended, as (start, end) in active milliseconds.
    setup_spans: Vec<(u64, u64)>,
    /// Setup work was seen at least once.
    setup_seen: bool,
}

impl Progress {
    pub fn new(kind: JobKind, pacing: Pacing) -> Self {
        Self {
            model: model(kind),
            pacing,
            done: BTreeMap::new(),
            shown: 0,
            tasks: HashMap::new(),
            setup_open: HashMap::new(),
            setup_spans: Vec::new(),
            setup_seen: false,
        }
    }

    /// Goes on from a persisted memory (a continued job, also after a restart) and the percent
    /// last shown, which stays the floor.
    pub fn restore(
        kind: JobKind,
        pacing: Pacing,
        memory: Option<&ProgressMemory>,
        shown: Option<u32>,
    ) -> Self {
        let mut progress = Self::new(kind, pacing);
        if let Some(memory) = memory {
            for (name, mark) in &memory.done {
                if let Some(m) = Milestone::from_name(name).filter(|m| progress.has(*m)) {
                    progress.done.insert(m, *mark);
                }
            }
            progress.shown = memory.percent;
        }
        progress.shown = progress
            .shown
            .max(shown.unwrap_or(0))
            .min(MAX_RUNNING_PERCENT);
        progress
    }

    fn has(&self, m: Milestone) -> bool {
        self.model.steps.iter().any(|s| s.milestone == m)
    }

    pub fn is_done(&self, m: Milestone) -> bool {
        self.done.contains_key(&m)
    }

    /// How many milestones are finished (seen or implied).
    pub fn finished(&self) -> usize {
        self.done.len()
    }

    /// Marks a milestone finished at `at_ms` (and what it implies). Milestones the model does not
    /// have are ignored. Returns whether anything changed.
    pub fn mark(&mut self, m: Milestone, at_ms: u64) -> bool {
        self.mark_inner(m, at_ms, false)
    }

    /// Marks a milestone finished because the evidence of a later one needs it (the quality-check
    /// output needs the graphics and the b-roll): like an implied milestone it is not seen, so it
    /// never goes into the history.
    fn mark_implied(&mut self, m: Milestone, at_ms: u64) -> bool {
        self.mark_inner(m, at_ms, true)
    }

    fn mark_inner(&mut self, m: Milestone, at_ms: u64, implied: bool) -> bool {
        let mut changed = false;
        if self.has(m) && !self.done.contains_key(&m) {
            self.done.insert(m, ProgressMark { at_ms, implied });
            changed = true;
        }
        for before in m.implies() {
            changed |= self.mark_inner(*before, at_ms, true);
        }
        changed
    }

    /// Reads one stream event: markers in the main session's text, and inference from tool calls,
    /// background tasks and sub-agents.
    pub fn observe(&mut self, event: &StreamEvent, at_ms: u64) {
        match event {
            StreamEvent::Assistant(message) => {
                let nested = message.is_nested();
                for block in &message.content {
                    match block {
                        Block::Text(text) if !nested => {
                            for name in split_markers(text).1 {
                                if let Some(m) = Milestone::from_name(&name) {
                                    self.mark(m, at_ms);
                                }
                            }
                        }
                        Block::ToolUse { id, name, input } => {
                            self.tool_use(id, name, input, nested, at_ms);
                        }
                        _ => {}
                    }
                }
            }
            StreamEvent::User(message) => {
                for block in &message.content {
                    if let Block::ToolResult { tool_use_id, .. } = block {
                        self.setup_ended(tool_use_id, at_ms);
                    }
                    if let Block::ToolResult { tool_use_id, .. } = block
                        && self
                            .tasks
                            .get(tool_use_id)
                            .is_some_and(|t| t.ends_with_result)
                    {
                        self.task_finished(tool_use_id, at_ms);
                    }
                }
            }
            StreamEvent::System(SystemEvent::TaskStarted {
                task_id,
                description,
                task_type,
                ..
            }) => {
                let description = description.as_deref().unwrap_or("").to_lowercase();
                let agent = task_type.as_deref().is_some_and(|t| t.contains("agent"));
                self.task_started(task_id, &description, false, agent, at_ms);
            }
            StreamEvent::System(SystemEvent::TaskNotification {
                task_id, status, ..
            }) => {
                self.setup_ended(task_id, at_ms);
                // Only a completed task counts: a stopped or failed one is done again later.
                if status.as_deref().is_none_or(|s| s == "completed") {
                    self.task_finished(task_id, at_ms);
                }
            }
            _ => {}
        }
    }

    fn tool_use(&mut self, id: &str, name: &str, input: &Value, nested: bool, at_ms: u64) {
        match name {
            "Bash" => {
                let text = format!(
                    "{} {}",
                    input_str(input, "command"),
                    input_str(input, "description")
                )
                .to_lowercase();
                let background = flag(input, "run_in_background");
                if is_setup(&text) {
                    self.setup_seen = true;
                    if !background {
                        self.setup_open.entry(id.to_owned()).or_insert(at_ms);
                    }
                } else if contains_any(&text, &["whisper", "transcrib"]) {
                    // Transcribing has started, so the footage was looked at.
                    self.mark(Milestone::Inspected, at_ms);
                }
                if self.model.kind == JobKind::Render
                    && contains_any(&text, &["render", "encode", "ffmpeg"])
                    && contains_any(&text, &["2160", "4k", "3840", "final"])
                {
                    self.mark(Milestone::RenderStarted, at_ms);
                }
            }
            "Write" | "Edit" | "MultiEdit" => {
                let kinds = work::kinds_of_path(input_str(input, "file_path"));
                self.observe_kinds(kinds, !nested, at_ms);
            }
            "Read" if !nested => {
                // A transcript is a data file; the script that makes one (transcribe.py) is not.
                let transcript = work::kinds_of_path(input_str(input, "file_path")).transcript;
                if transcript && self.is_done(Milestone::Inspected) {
                    self.mark(Milestone::Transcribed, at_ms);
                }
            }
            "Agent" | "Task" if !nested => {
                let description = format!(
                    "{} {}",
                    input_str(input, "description"),
                    input_str(input, "subagent_type")
                )
                .to_lowercase();
                if flag(input, "run_in_background") {
                    // Its task_started / task_notification tell when it runs and ends.
                    self.agent_signal(classify(&description), at_ms);
                } else {
                    self.task_started(id, &description, true, true, at_ms);
                }
            }
            _ => {}
        }
    }

    /// What a file the main session or a sub-agent writes says by its name (`jobs::work`). The
    /// plan and the graphics only count once the footage was looked at (a transcript or the
    /// start of transcription): a plan file written before any transcript is not planning from
    /// one. `main` is false inside a sub-agent, whose plan-like files are its own notes.
    fn observe_kinds(&mut self, kinds: work::Kinds, main: bool, at_ms: u64) {
        if self.model.kind != JobKind::Edit {
            return;
        }
        if kinds.audio {
            self.mark(Milestone::Inspected, at_ms);
        }
        if kinds.transcript {
            self.mark(Milestone::Transcribed, at_ms);
        }
        if ((kinds.plan && main) || kinds.graphics) && self.is_done(Milestone::Inspected) {
            // A plan (or graphics built from one) means the transcript is there.
            self.mark(Milestone::Planned, at_ms);
        }
        if kinds.quality_check {
            // The quality check looks at the assembled picture with its graphics and b-roll.
            for m in [Milestone::GraphicsBuilt, Milestone::BrollReady] {
                self.mark_implied(m, at_ms);
            }
            self.mark(Milestone::Assembled, at_ms);
        }
    }

    /// Reads what the working folder of the video shows (`jobs::work`).
    pub fn observe_work(&mut self, work: &work::WorkEvidence, at_ms: u64) {
        // In the order the work goes, so what one kind implies is in place for the next.
        self.observe_kinds(
            work::Kinds {
                audio: work.audio,
                ..work::Kinds::default()
            },
            true,
            at_ms,
        );
        self.observe_kinds(
            work::Kinds {
                transcript: work.transcript,
                ..work::Kinds::default()
            },
            true,
            at_ms,
        );
        self.observe_kinds(
            work::Kinds {
                plan: work.plan,
                graphics: work.graphics,
                ..work::Kinds::default()
            },
            true,
            at_ms,
        );
        self.observe_kinds(
            work::Kinds {
                quality_check: work.quality_check,
                ..work::Kinds::default()
            },
            true,
            at_ms,
        );
    }

    /// What starting a sub-agent or task of a group says on its own.
    fn agent_signal(&mut self, group: Group, at_ms: u64) {
        match (self.model.kind, group) {
            // The graphics fan-out starts from the finished plan.
            (JobKind::Edit, Group::Graphics) => {
                self.mark(Milestone::Planned, at_ms);
            }
            (JobKind::Edit, Group::Transcription) => {
                self.mark(Milestone::Inspected, at_ms);
            }
            (JobKind::Render, Group::Render) => {
                self.mark(Milestone::RenderStarted, at_ms);
            }
            _ => {}
        }
    }

    fn task_started(
        &mut self,
        task_id: &str,
        description: &str,
        ends_with_result: bool,
        agent: bool,
        at_ms: u64,
    ) {
        let group = classify(description);
        if group == Group::Setup {
            self.setup_seen = true;
            self.setup_open.entry(task_id.to_owned()).or_insert(at_ms);
        }
        self.agent_signal(group, at_ms);
        let after_plan = self.is_done(Milestone::Planned);
        self.tasks.entry(task_id.to_owned()).or_insert(Task {
            group,
            done: false,
            after_plan,
            ends_with_result,
            agent,
        });
    }

    /// A setup command or task ended (or a tool result came back for it).
    fn setup_ended(&mut self, id: &str, at_ms: u64) {
        if let Some(start) = self.setup_open.remove(id) {
            self.setup_spans.push((start, at_ms.max(start)));
            if self.setup_spans.len() > 256 {
                self.setup_spans.remove(0);
            }
        }
    }

    /// The active milliseconds from `from` to `to` that went into setup.
    fn setup_ms(&self, from: u64, to: u64) -> u64 {
        let overlap = |(start, end): (u64, u64)| end.min(to).saturating_sub(start.max(from));
        self.setup_spans.iter().map(|s| overlap(*s)).sum::<u64>()
            + self
                .setup_open
                .values()
                .map(|start| overlap((*start, to)))
                .sum::<u64>()
    }

    fn task_finished(&mut self, task_id: &str, at_ms: u64) {
        let Some(task) = self.tasks.get_mut(task_id) else {
            return;
        };
        if task.done {
            return;
        }
        task.done = true;
        let group = task.group;
        let agent = task.agent;
        // Every task of the group (that counts) is finished.
        let all_done = |counts: &dyn Fn(&Task) -> bool| {
            let mut tasks = self
                .tasks
                .values()
                .filter(|t| t.group == group && counts(t));
            let mut any = false;
            let all = tasks.all(|t| {
                any = true;
                t.done
            });
            any && all
        };
        let milestone = match (self.model.kind, group) {
            (JobKind::Edit, Group::Transcription) if agent && all_done(&|t| t.agent) => {
                Some(Milestone::Transcribed)
            }
            (JobKind::Edit, Group::Graphics) if all_done(&|t| t.after_plan) => {
                Some(Milestone::GraphicsBuilt)
            }
            // Product and b-roll helpers started early (during transcription) are only a part.
            (JobKind::Edit, Group::Broll) if all_done(&|t| t.after_plan) => {
                Some(Milestone::BrollReady)
            }
            (JobKind::Edit, Group::Extras) if all_done(&|_| true) => Some(Milestone::ExtrasWritten),
            _ => None,
        };
        if let Some(m) = milestone {
            self.mark(m, at_ms);
        }
    }

    /// Reads which files in the output folder are new since the job started.
    pub fn observe_output(&mut self, output: &OutputEvidence, at_ms: u64) {
        match self.model.kind {
            JobKind::Edit | JobKind::ReEdit => {
                if output.review {
                    self.mark(Milestone::ReviewSaved, at_ms);
                }
                if output.thumbnails && output.meta {
                    self.mark(Milestone::ExtrasWritten, at_ms);
                }
            }
            JobKind::Render => {
                if output.final_settled {
                    self.mark(Milestone::Rendered, at_ms);
                } else if output.final_file {
                    self.mark(Milestone::FinalWriting, at_ms);
                }
            }
        }
    }

    /// How fast this job is against the typical pace: the active time of the finished milestone
    /// (seen, not implied) that is typically reached last, over that typical time, clamped; 1
    /// without such evidence.
    fn pace(&self) -> f64 {
        self.model
            .steps
            .iter()
            .zip(&self.pacing.at_ms)
            .filter(|(s, typical)| s.milestone.anchors() && **typical >= MIN_PACE_EVIDENCE_MS)
            .filter_map(|(s, typical)| {
                let mark = self.done.get(&s.milestone).filter(|m| !m.implied)?;
                Some((*typical, mark.at_ms))
            })
            .max_by_key(|(typical, _)| *typical)
            .map_or(1.0, |(typical, at)| {
                (at as f64 / typical as f64).clamp(PACE_RANGE.0, PACE_RANGE.1)
            })
    }

    fn typical_at(&self, m: Option<Milestone>) -> u64 {
        m.and_then(|m| self.model.steps.iter().position(|s| s.milestone == m))
            .map_or(0, |i| self.pacing.at_ms[i])
    }

    /// Where the evidence puts the job on the typical timeline: the typical time at which the
    /// finished milestone that is typically reached last is finished, and the active time at
    /// which it was (the start of the job when nothing is finished).
    fn anchor(&self) -> (u64, u64) {
        self.model
            .steps
            .iter()
            .zip(&self.pacing.at_ms)
            .filter(|(s, _)| s.milestone.anchors())
            .filter_map(|(s, typical)| Some((*typical, self.done.get(&s.milestone)?.at_ms)))
            .max()
            .unwrap_or((0, 0))
    }

    /// The most the bar may show while the milestones that only a file confirms have no file: the
    /// value of everything before the first of them that is unfinished, plus all but one point
    /// of its own weight, plus what finished beyond it.
    fn file_ceiling(&self) -> u32 {
        let steps = self.model.steps;
        let Some(gate) = steps
            .iter()
            .position(|s| s.milestone.needs_file() && !self.is_done(s.milestone))
        else {
            return MAX_RUNNING_PERCENT;
        };
        let before: u32 = steps[..gate].iter().map(|s| s.weight).sum();
        let after: u32 = steps[gate + 1..]
            .iter()
            .filter(|s| self.is_done(s.milestone))
            .map(|s| s.weight)
            .sum();
        (before + steps[gate].weight.saturating_sub(1) + after).min(MAX_RUNNING_PERCENT)
    }

    /// The progress to show at `now_ms`. Never lower than anything returned before.
    ///
    /// The percent is what the evidence confirms (the weights of the finished milestones) plus an
    /// estimate for the unfinished ones from the active time since the evidence: the job is put
    /// on the typical timeline at the anchor, and each unfinished milestone is credited the
    /// share of its weight that the typical timeline has reached (a milestone that only a file
    /// confirms never fully). Until the typical end of the first unfinished milestone (the stage)
    /// that milestone stays one point below its value. After it, the job is later than typical
    /// without evidence, so the estimate goes on into the following milestones with a slow-down
    /// that never stops, and the stage reads "Working on ...", which claims no step.
    pub fn current(&mut self, now_ms: u64) -> JobProgress {
        let steps = self.model.steps;
        let base: u32 = steps
            .iter()
            .filter(|s| self.is_done(s.milestone))
            .map(|s| s.weight)
            .sum::<u32>()
            .min(MAX_RUNNING_PERCENT);
        let Some(frontier) = steps.iter().position(|s| !self.is_done(s.milestone)) else {
            self.shown = self.shown.max(base).min(MAX_RUNNING_PERCENT);
            return JobProgress {
                percent: self.shown,
                stage: Some(FINISHING_STAGE.to_owned()),
            };
        };
        let (anchor_typical, anchor_at) = self.anchor();
        let ms = |v: u64| v as f64;
        // Time spent installing or testing tools is not the work: the estimate waits for it.
        let working = now_ms
            .saturating_sub(anchor_at)
            .saturating_sub(self.setup_ms(anchor_at, now_ms));
        let raw = ms(anchor_typical) + ms(working) / self.pace();
        // The typical window of every unfinished milestone, in the order the steps are listed
        // (what a milestone waits for is listed before it). A stretch starts when what it waits
        // for ends: at its typical time when that is finished, at its own window when not. A
        // milestone the typical timeline expected before the evidence (the b-roll when the
        // graphics were confirmed first) has no evidence yet, so its stretch starts at the
        // evidence instead.
        let mut windows: Vec<Option<(f64, f64)>> = vec![None; steps.len()];
        for (i, s) in steps.iter().enumerate() {
            if self.is_done(s.milestone) {
                continue;
            }
            let ends = |m: Option<Milestone>| {
                m.map_or(0.0, |m| match steps.iter().position(|o| o.milestone == m) {
                    Some(j) if !self.is_done(m) => windows[j].map_or(0.0, |(_, end)| end),
                    _ => ms(self.typical_at(Some(m))),
                })
            };
            let typical_start = ms(self.typical_at(s.after));
            let end = ms(self.pacing.at_ms[i]).max(typical_start + MIN_STRETCH_MS);
            let stretch = end - typical_start;
            let mut start = ends(s.after).max(ends(s.milestone.also_after()));
            if end <= ms(anchor_typical) {
                start = start.max(ms(anchor_typical));
            }
            windows[i] = Some((start, start + stretch));
        }
        // Until the typical end of the stage the evidence has the job in, the stage stays a point
        // short of its value. After it the job is later than typical without evidence.
        let stage_end = windows[frontier].map_or(raw, |(_, end)| end);
        let overdue = raw - stage_end;
        let total = ms(self
            .pacing
            .total_ms
            .max(self.pacing.at_ms.iter().copied().max().unwrap_or(0)));
        // Before the footage is looked at, a computer that is still getting its tools ready has
        // no work to estimate: the bar stays in the first stage.
        let bootstrapping = self.setup_seen && !self.is_done(Milestone::Inspected);
        let (typical_now, spilled) = if bootstrapping {
            (raw.min(stage_end), false)
        } else if overdue <= 0.0 {
            (raw, false)
        } else {
            let scale = (total * SLOWDOWN_SHARE).max(MIN_STRETCH_MS);
            (
                stage_end + SPILL_RATE * scale * (1.0 + overdue / scale).ln(),
                true,
            )
        };
        let mut credit = 0.0;
        for (i, (s, window)) in steps.iter().zip(&windows).enumerate() {
            let Some((start, end)) = window else {
                continue;
            };
            let reached = ((typical_now - start) / (end - start)).clamp(0.0, 1.0);
            let weight = f64::from(s.weight);
            // The stage itself stays a point short of its value until it is overdue; a milestone
            // that only a file confirms always does.
            let held = (i == frontier && !spilled) || s.milestone.needs_file();
            let cap = if held {
                (weight - 1.0).max(0.0)
            } else {
                weight
            };
            credit += (weight * reached).min(cap);
        }
        let percent = (base + credit.floor() as u32)
            .min(self.file_ceiling())
            .min(MAX_RUNNING_PERCENT);
        self.shown = self.shown.max(percent).min(MAX_RUNNING_PERCENT);
        // The label names the stage while the estimate is inside it (and a little past its
        // value, so a stage that runs a moment over does not flicker).
        let stage = if bootstrapping || !self.setup_open.is_empty() {
            SETUP_STAGE
        } else if spilled && self.shown >= base + steps[frontier].weight + LABEL_SLACK {
            working_stage(self.model.kind)
        } else {
            steps[frontier].stage
        };
        JobProgress {
            percent: self.shown,
            stage: Some(stage.to_owned()),
        }
    }

    /// What to persist so a continued job goes on from here.
    pub fn memory(&self, job_id: &str) -> ProgressMemory {
        ProgressMemory {
            job_id: job_id.to_owned(),
            done: self
                .done
                .iter()
                .map(|(m, mark)| (m.name().to_owned(), *mark))
                .collect(),
            percent: self.shown,
        }
    }

    /// The history entry of this job once it completed after `total_ms` of active time.
    pub fn run_record(&self, total_ms: u64) -> ProgressRun {
        ProgressRun {
            milestones: self
                .done
                .iter()
                .filter(|(_, mark)| !mark.implied)
                .map(|(m, mark)| (m.name().to_owned(), mark.at_ms))
                .collect(),
            total_ms,
        }
    }
}

/// The stage label while the bar is ahead of what the evidence confirms.
fn working_stage(kind: JobKind) -> &'static str {
    match kind {
        JobKind::Edit => "Working on the edit",
        JobKind::ReEdit => "Working on the changes",
        JobKind::Render => "Working on the render",
    }
}

/// The progress of a completed job.
pub fn completed() -> JobProgress {
    JobProgress {
        percent: 100,
        stage: Some(DONE_STAGE.to_owned()),
    }
}

// ---------------------------------------------------------------------------------------------
// Driver side
// ---------------------------------------------------------------------------------------------

/// The output folder is looked at every this many publish intervals (`Timings::progress_interval`,
/// 1 s in the app: every 5 s).
const OUTPUT_PROBE_EVERY: u32 = 5;
/// A creep-only change is written to `state.json` at most every this many publish intervals (10 s
/// in the app); a new stage is written at once.
pub const PERSIST_EVERY: u32 = 10;

/// A progress change to publish.
#[derive(Debug, Clone, PartialEq)]
pub struct Update {
    pub view: JobProgress,
    pub memory: ProgressMemory,
    /// Write `state.json` now; otherwise the change is kept in memory until the next save.
    pub persist: bool,
}

/// The driver's handle on the engine of the job it runs: the clock, the output folder, and when
/// to publish and persist.
pub(crate) struct Tracker {
    engine: Progress,
    job_id: String,
    /// The job's active time when this run started.
    active_before_ms: u64,
    run_started: Instant,
    video_dir: Option<PathBuf>,
    since: Option<SystemTime>,
    /// The output files as they were when this run started.
    known: HashSet<Stamp>,
    /// The most files the video folder held that were written since the job started.
    work_files: usize,
    last_probe: Option<Instant>,
    published: Option<JobProgress>,
    last_publish: Option<Instant>,
    last_persist: Instant,
}

impl Tracker {
    /// Starts tracking a job that just entered `running`: a new job starts from 0, a continued
    /// one from its persisted memory and percent.
    pub(crate) fn start(host: &dyn JobHost, job: &JobView) -> Self {
        let store = host.store();
        let runs = store.progress_runs(&history_key(job.kind, job.video_type));
        let pacing = Pacing::from_history(job.kind, job.video_type, &runs);
        let memory = store
            .video(&job.video_id)
            .progress_memory
            .filter(|m| m.job_id == job.id);
        let engine = Progress::restore(
            job.kind,
            pacing,
            memory.as_ref(),
            job.progress.as_ref().map(|p| p.percent),
        );
        let video = host.resolve_video(&job.video_id).ok();
        let known = video
            .as_ref()
            .map(|c| stamps(&c.output))
            .unwrap_or_default();
        let video_dir = video.map(|c| c.path);
        let since = job
            .started_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(SystemTime::from);
        Self {
            engine,
            job_id: job.id.clone(),
            active_before_ms: job.active_ms,
            run_started: Instant::now(),
            video_dir,
            since,
            known,
            work_files: 0,
            last_probe: None,
            published: job.progress.clone(),
            last_publish: None,
            last_persist: Instant::now(),
        }
    }

    fn active_ms(&self) -> u64 {
        self.active_before_ms
            .saturating_add(self.run_started.elapsed().as_millis() as u64)
    }

    pub(crate) fn observe(&mut self, event: &StreamEvent) {
        let now = self.active_ms();
        self.engine.observe(event, now);
    }

    /// How much the job has shown of its work so far, for `jobs::keepgoing::Evidence::milestones`:
    /// the finished milestones plus the files written in the video folder. It only grows, so a
    /// model that keeps working without a milestone (a long render on a slow computer) is not
    /// taken for stuck, while one that does nothing is.
    pub(crate) fn work_shown(&self) -> usize {
        self.engine.finished() + self.work_files
    }

    /// Whether `m` is finished.
    pub(crate) fn is_done(&self, m: Milestone) -> bool {
        self.engine.is_done(m)
    }

    /// Looks at the output folder now instead of at the next probe, so a decision made right
    /// after a turn ended sees the files that turn wrote.
    pub(crate) fn probe_now(&mut self) {
        self.last_probe = None;
    }

    /// The change to publish now, if any: at most every `interval` (a new stage at once, or
    /// anything when `force`), persisted on a new stage or every [`PERSIST_EVERY`] intervals.
    pub(crate) fn poll(
        &mut self,
        host: &dyn JobHost,
        interval: Duration,
        force: bool,
    ) -> Option<Update> {
        let now = self.active_ms();
        if let (Some(dir), Some(since)) = (&self.video_dir, self.since)
            && self
                .last_probe
                .is_none_or(|t| t.elapsed() >= interval * OUTPUT_PROBE_EVERY)
        {
            self.last_probe = Some(Instant::now());
            let output = without_known(host.scan_output(dir), &self.known);
            let evidence = output_evidence(&output, since, SystemTime::now());
            self.engine.observe_output(&evidence, now);
            let seen = work::evidence(&work::scan(dir), since);
            self.work_files = self.work_files.max(seen.files);
            if self.engine.model.kind == JobKind::Edit {
                self.engine.observe_work(&seen, now);
            }
        }
        let view = self.engine.current(now);
        if self.published.as_ref() == Some(&view) {
            return None;
        }
        let new_stage = self.published.as_ref().map(|p| &p.stage) != Some(&view.stage);
        if !force && !new_stage && self.last_publish.is_some_and(|t| t.elapsed() < interval) {
            return None;
        }
        let persist = force || new_stage || self.last_persist.elapsed() >= interval * PERSIST_EVERY;
        self.published = Some(view.clone());
        self.last_publish = Some(Instant::now());
        if persist {
            self.last_persist = Instant::now();
        }
        Some(Update {
            memory: self.engine.memory(&self.job_id),
            view,
            persist,
        })
    }

    /// Records how long the stretches of a job that just completed took.
    pub(crate) fn record_completion(&self, store: &Store, job: &JobView) {
        let run = self.engine.run_record(self.active_ms());
        if let Err(err) = store.record_progress_run(&history_key(job.kind, job.video_type), run) {
            eprintln!("vidai: could not save the progress history: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::protocol::parse_line;
    use crate::model::OutputFile;
    use serde_json::json;

    const MIN: u64 = 60_000;

    fn edit() -> Progress {
        Progress::new(
            JobKind::Edit,
            Pacing::defaults(JobKind::Edit, VideoType::Short),
        )
    }

    fn event(v: Value) -> StreamEvent {
        parse_line(&v.to_string()).unwrap()
    }

    fn text(t: &str) -> StreamEvent {
        event(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": t}]}}))
    }

    fn nested_text(t: &str) -> StreamEvent {
        event(json!({"type": "assistant", "parent_tool_use_id": "agent1",
            "message": {"content": [{"type": "text", "text": t}]}}))
    }

    fn tool(name: &str, input: Value) -> StreamEvent {
        event(json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": format!("tu-{name}"), "name": name, "input": input}]}}))
    }

    fn task_started(id: &str, description: &str, task_type: &str) -> StreamEvent {
        event(
            json!({"type": "system", "subtype": "task_started", "task_id": id,
            "description": description, "task_type": task_type, "is_backgrounded": true}),
        )
    }

    fn task_done(id: &str, status: &str) -> StreamEvent {
        event(
            json!({"type": "system", "subtype": "task_notification", "task_id": id,
            "status": status, "summary": "done"}),
        )
    }

    fn evidence(review: bool, thumbnails: bool, meta: bool) -> OutputEvidence {
        OutputEvidence {
            review,
            thumbnails,
            meta,
            ..OutputEvidence::default()
        }
    }

    fn percent(p: &mut Progress, at: u64) -> u32 {
        p.current(at).percent
    }

    fn stage(p: &mut Progress, at: u64) -> String {
        p.current(at).stage.unwrap()
    }

    fn view(percent: u32, stage: &str) -> JobProgress {
        JobProgress {
            percent,
            stage: Some(stage.into()),
        }
    }

    #[test]
    fn markers_on_their_own_lines_are_found_and_removed() {
        assert_eq!(
            split_markers("[VIDAI_PROGRESS transcribed]"),
            (String::new(), vec!["transcribed".to_owned()])
        );
        assert_eq!(
            split_markers(
                "Transcript is ready.\n\n`[VIDAI_PROGRESS transcribed]`\n**[vidai_progress Planned]**"
            ),
            (
                "Transcript is ready.".to_owned(),
                vec!["transcribed".to_owned(), "planned".to_owned()]
            )
        );
        assert_eq!(
            split_markers("  [VIDAI_PROGRESS graphics-built] [VIDAI_PROGRESS broll_ready]  "),
            (
                String::new(),
                vec!["graphics_built".to_owned(), "broll_ready".to_owned()]
            )
        );
        // Prose that mentions a marker, other brackets and broken markers stay text.
        for prose in [
            "I will write [VIDAI_PROGRESS transcribed] when the transcript is ready.",
            "[VIDAI_PROGRESS transcribed] is next",
            "[OUTPUT COMPLETED]",
            "[VIDAI_PROGRESS]",
            "[VIDAI_PROGRESS <name>]",
            "[VIDAI_PROGRESS transcribed",
            "- [x] done",
        ] {
            assert_eq!(split_markers(prose), (prose.to_owned(), vec![]), "{prose}");
        }
        assert_eq!(marker_log_line("transcribed"), "Transcription done");
        assert_eq!(marker_log_line("coffee_break"), "Progress: coffee_break");
    }

    #[test]
    fn marker_names_round_trip_and_every_model_is_consistent() {
        for m in Milestone::ALL {
            assert_eq!(Milestone::from_name(m.name()), Some(m));
        }
        assert_eq!(Milestone::from_name("nope"), None);
        for model in [&EDIT, &RE_EDIT, &RENDER] {
            let total: u32 = model.steps.iter().map(|s| s.weight).sum();
            assert!(total <= MAX_RUNNING_PERCENT, "{:?}", model.kind);
            assert!(model.steps.iter().all(|s| s.weight > 0));
            for s in model.steps {
                assert!(s.typical_min.0 > 0.0 && s.typical_min.0 <= s.typical_min.1);
                assert!(s.typical_min.0 < model.total_min.0);
                assert!(s.typical_min.1 < model.total_min.1);
                if let Some(after) = s.after {
                    assert!(model.steps.iter().any(|o| o.milestone == after));
                }
            }
        }
        assert_eq!(EDIT.steps.iter().map(|s| s.weight).sum::<u32>(), 99);
        assert_eq!(history_key(JobKind::ReEdit, VideoType::Long), "reEdit/long");
        assert_eq!(
            marker_lines(JobKind::Render),
            "[VIDAI_PROGRESS render_started] - the final render is running\n[VIDAI_PROGRESS rendered] - the final render file is complete"
        );
    }

    #[test]
    fn a_new_job_starts_at_zero_and_markers_move_it_to_the_milestone_values() {
        let mut p = edit();
        assert_eq!(p.current(0), view(0, "Inspecting the footage"));
        p.observe(&text("[VIDAI_PROGRESS inspected]"), MIN);
        assert_eq!(p.current(MIN), view(3, "Transcribing"));
        p.observe(&text("Done.\n[VIDAI_PROGRESS transcribed]"), 4 * MIN);
        assert_eq!(p.current(4 * MIN), view(15, "Planning the edit"));
        p.observe(&text("[VIDAI_PROGRESS planned]"), 9 * MIN);
        assert_eq!(p.current(9 * MIN), view(30, "Building graphics"));
        for (marker, at, want, next) in [
            ("graphics_built", 20, 64, "Preparing b-roll"),
            ("broll_ready", 20, 74, "Assembling the timeline"),
            ("assembled", 21, 83, "Checking the edit"),
            ("checked", 23, 91, "Writing the review project"),
            ("review_saved", 24, 96, "Thumbnails and details"),
            ("extras_written", 25, 99, FINISHING_STAGE),
        ] {
            p.observe(&text(&format!("[VIDAI_PROGRESS {marker}]")), at * MIN);
            assert_eq!(p.current(at * MIN), view(want, next), "{marker}");
        }
        // Capped at 99 however long it takes; only completion makes 100.
        assert_eq!(percent(&mut p, 600 * MIN), 99);
        assert_eq!(completed(), view(100, "Done"));
    }

    #[test]
    fn milestones_out_of_order_add_up_the_same_and_imply_what_came_before() {
        let mut a = edit();
        a.mark(Milestone::BrollReady, 10 * MIN);
        // B-roll implies the plan (and everything before it).
        assert!(a.is_done(Milestone::Planned) && a.is_done(Milestone::Inspected));
        // The b-roll runs beside the graphics: it finishing says nothing about how far they are.
        assert_eq!(percent(&mut a, 10 * MIN), 40);
        // The stage is the first unfinished milestone: graphics, not the finished b-roll.
        assert_eq!(stage(&mut a, 10 * MIN), "Building graphics");
        a.mark(Milestone::GraphicsBuilt, 20 * MIN);
        let mut b = edit();
        b.mark(Milestone::GraphicsBuilt, 20 * MIN);
        assert_eq!(stage(&mut b, 20 * MIN), "Preparing b-roll");
        b.mark(Milestone::BrollReady, 20 * MIN);
        assert_eq!(percent(&mut a, 20 * MIN), 74);
        assert_eq!(percent(&mut b, 20 * MIN), 74);
        // The review project implies the whole step after the plan, but not the thumbnails.
        let mut c = edit();
        c.mark(Milestone::ReviewSaved, 24 * MIN);
        assert_eq!(c.current(24 * MIN), view(96, "Thumbnails and details"));
        // Marking again changes nothing; a milestone of another kind's model is ignored.
        assert!(!c.mark(Milestone::ReviewSaved, 25 * MIN));
        assert!(!c.mark(Milestone::Rendered, 25 * MIN));
    }

    #[test]
    fn the_bar_keeps_moving_without_evidence_and_never_passes_the_files() {
        // The edit that was stuck at 29 %: the transcript is done, nothing else is ever seen.
        let mut p = edit();
        p.mark(Milestone::Transcribed, 210_000);
        assert_eq!(p.current(210_000), view(15, "Planning the edit"));
        // Inside the stage it moves at the typical speed (7 points by the middle of it) and stays
        // a point below the next milestone at its end.
        assert_eq!(percent(&mut p, 315_000), 15 + 7);
        assert_eq!(percent(&mut p, 420_000), 15 + 14);
        let mut last = 0;
        let mut at_29 = 0;
        for minute in 4..=720u64 {
            let now = percent(&mut p, minute * MIN);
            assert!(now >= last, "never backwards");
            assert!(
                now < 96,
                "never the review project's value without its file"
            );
            if now == 29 {
                at_29 += 1;
            }
            last = now;
        }
        // It passed 29 after a few minutes; twelve hours later it is still above and below 96.
        assert!(at_29 <= 8, "{at_29} minutes at 29");
        assert!(last > 35, "{last}");
        // It goes on slowing down, never stopping: higher after two, three and five hours.
        let mut q = edit();
        q.mark(Milestone::Transcribed, 210_000);
        let curve: Vec<u32> = (0..12u64)
            .map(|step| percent(&mut q, (4 + step * 30) * MIN))
            .collect();
        assert!(curve.windows(2).all(|w| w[1] >= w[0]), "{curve:?}");
        assert!(
            curve[0] < curve[2] && curve[2] < curve[6] && curve[6] < curve[11],
            "{curve:?}"
        );
        // Evidence lands it on the milestone value, and the estimate goes on from there.
        let before = percent(&mut q, 400 * MIN);
        q.mark(Milestone::Planned, 400 * MIN);
        assert!(percent(&mut q, 400 * MIN) >= before.max(30));
    }

    #[test]
    fn the_stage_label_names_only_what_the_evidence_supports() {
        let mut p = edit();
        p.mark(Milestone::Transcribed, 4 * MIN);
        // Inside the stage: its name, a point short of the milestone.
        assert_eq!(p.current(5 * MIN), view(18, "Planning the edit"));
        assert_eq!(stage(&mut p, 6 * MIN), "Planning the edit");
        // Ahead of the evidence (an hour later): no step is named.
        let late = p.current(60 * MIN);
        assert_eq!(late.stage.as_deref(), Some("Working on the edit"));
        assert!(late.percent > 30);
        // Evidence for the plan brings the stage back, and the bar never goes down.
        p.mark(Milestone::Planned, 61 * MIN);
        let back = p.current(61 * MIN);
        assert_eq!(back.stage.as_deref(), Some("Building graphics"));
        assert!(back.percent >= late.percent);
        // Re-edit and render say what they work on in their own words.
        let mut r = Progress::new(
            JobKind::ReEdit,
            Pacing::defaults(JobKind::ReEdit, VideoType::Short),
        );
        assert_eq!(
            r.current(3 * 60 * MIN).stage.as_deref(),
            Some("Working on the changes")
        );
        let mut f = Progress::new(
            JobKind::Render,
            Pacing::defaults(JobKind::Render, VideoType::Short),
        );
        assert_eq!(
            f.current(3 * 60 * MIN).stage.as_deref(),
            Some("Working on the render")
        );
    }

    #[test]
    fn no_file_no_value_of_the_milestones_that_only_files_confirm() {
        for (kind, limit) in [
            (JobKind::Edit, 95),
            (JobKind::ReEdit, 94),
            (JobKind::Render, 69),
        ] {
            let mut p = Progress::new(kind, Pacing::defaults(kind, VideoType::Long));
            for hour in 0..100u64 {
                assert!(
                    percent(&mut p, hour * 60 * MIN) <= limit,
                    "{kind:?} at hour {hour}"
                );
            }
        }
        // The thumbnails written early do not lift the ceiling of the review project.
        let mut p = edit();
        p.observe_output(&evidence(false, true, true), 5 * MIN);
        assert!(p.is_done(Milestone::ExtrasWritten));
        assert!(percent(&mut p, 1000 * MIN) <= 98);
        // Nor do they say where the job is: the plan stage is still the next one.
        let mut q = edit();
        q.mark(Milestone::Transcribed, 4 * MIN);
        q.observe_output(&evidence(false, true, true), 5 * MIN);
        assert_eq!(stage(&mut q, 5 * MIN), "Planning the edit");
    }

    #[test]
    fn a_milestone_expected_earlier_than_the_evidence_starts_its_stretch_at_the_evidence() {
        // The graphics are confirmed first; the typical timeline had the b-roll done before them.
        let mut p = edit();
        p.mark(Milestone::GraphicsBuilt, 21 * MIN);
        assert_eq!(p.current(21 * MIN), view(64, "Preparing b-roll"));
        // The b-roll creeps, a point below its value, and the timeline waits for it.
        let creep = percent(&mut p, 24 * MIN);
        assert!((65..74).contains(&creep), "{creep}");
        // Long after, the estimate goes on into the assembly with a slow-down.
        let late = percent(&mut p, 60 * MIN);
        assert!(late > creep && late <= 95, "{late}");
    }

    #[test]
    fn progress_never_goes_backwards_when_a_parallel_milestone_arrives() {
        let mut p = edit();
        p.mark(Milestone::Planned, 9 * MIN);
        let before = percent(&mut p, 30 * MIN); // far into the graphics stretch
        assert!(before >= 55, "{before}");
        // B-roll finishes: the base rises by 10 but the estimate does not start over.
        p.mark(Milestone::BrollReady, 30 * MIN);
        assert!(percent(&mut p, 30 * MIN) >= before);
        let mut last = before;
        for minute in 30..600 {
            let now = percent(&mut p, minute * MIN);
            assert!(now >= last && now <= 95);
            last = now;
        }
    }

    #[test]
    fn a_slow_computer_is_given_its_own_pace() {
        // An Intel Mac: the transcript takes four times as long as the Apple Silicon default.
        let mut fast = edit();
        let mut slow = edit();
        fast.mark(Milestone::Transcribed, 3 * MIN + 30_000);
        slow.mark(Milestone::Transcribed, 14 * MIN);
        let f = percent(&mut fast, 5 * MIN);
        let s = percent(&mut slow, 14 * MIN + 90_000);
        assert!(s < f, "{s} < {f}");
        assert!(PACE_RANGE.0 <= 0.5 && PACE_RANGE.1 >= 6.0);
    }

    #[test]
    fn setup_is_not_the_work() {
        // A fresh Intel Mac: half an hour of installing, venvs and smoke tests that name Whisper.
        let mut p = edit();
        let bash = |id: &str, cmd: &str, desc: &str, background: bool| {
            event(json!({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": id, "name": "Bash", "input": {
                    "command": cmd, "description": desc, "run_in_background": background}}]}}))
        };
        let result = |id: &str| {
            event(json!({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": id, "content": "ok"}]}}))
        };
        p.observe(
            &bash(
                "b1",
                "brew install ffmpeg",
                "Install ffmpeg via Homebrew",
                false,
            ),
            20_000,
        );
        assert_eq!(stage(&mut p, 30_000), SETUP_STAGE);
        p.observe(&result("b1"), 2 * MIN);
        p.observe(
            &bash(
                "b2",
                "pip install faster-whisper",
                "Install faster-whisper",
                true,
            ),
            MIN,
        );
        let venv = "Create py3.9 venv with faster-whisper for Intel";
        p.observe(&task_started("t1", venv, "local_bash"), MIN);
        p.observe(&task_done("t1", "completed"), 6 * MIN);
        let smoke = "Smoke-test Hindi transcription on 30s slice";
        p.observe(&bash("b3", "python smoke.py", smoke, true), 7 * MIN);
        p.observe(&task_started("t2", smoke, "local_bash"), 7 * MIN);
        p.observe(&task_done("t2", "completed"), 8 * MIN);
        // Reading the script that transcribes is not reading a transcript.
        let script = json!({"file_path": "/Edit/CLAUDE_VE_ALL/transcribe.py"});
        p.observe(&tool("Read", script), 9 * MIN);
        assert!(!p.is_done(Milestone::Inspected) && !p.is_done(Milestone::Transcribed));
        // Half an hour later the bar has not moved and says what is going on.
        let at_half_hour = p.current(30 * MIN);
        assert!(at_half_hour.percent <= 2, "{at_half_hour:?}");
        assert_eq!(at_half_hour.stage.as_deref(), Some(SETUP_STAGE));
        // The real transcription starts: the stage is the work again.
        let launch = "Launch both Whisper passes";
        p.observe(
            &bash("b4", "python transcribe.py a.wav &", launch, true),
            31 * MIN,
        );
        assert!(p.is_done(Milestone::Inspected));
        assert_eq!(stage(&mut p, 31 * MIN), "Transcribing");
        // A command that only starts the transcription in the background ends when it has
        // started it: that is not a transcript.
        p.observe(&task_started("t3", launch, "local_bash"), 31 * MIN);
        p.observe(&task_done("t3", "completed"), 32 * MIN);
        assert!(!p.is_done(Milestone::Transcribed));
        // A setup command that is running now says so, and its time does not move the bar.
        let before = percent(&mut p, 33 * MIN);
        p.observe(
            &bash("b5", "pip install x", "Install a package", false),
            33 * MIN,
        );
        assert_eq!(stage(&mut p, 34 * MIN), SETUP_STAGE);
        p.observe(&result("b5"), 43 * MIN);
        assert_eq!(percent(&mut p, 43 * MIN), before);
        assert_ne!(stage(&mut p, 43 * MIN), SETUP_STAGE);
    }

    #[test]
    fn files_in_the_video_folder_confirm_the_steps_whatever_program_wrote_them() {
        let seen = |f: &dyn Fn(&mut work::WorkEvidence)| {
            let mut w = work::WorkEvidence::default();
            f(&mut w);
            w
        };
        let mut p = edit();
        // A plan file before any transcript is not planning from one.
        p.observe_work(&seen(&|w| w.plan = true), MIN);
        assert!(!p.is_done(Milestone::Planned));
        p.observe_work(&seen(&|w| w.audio = true), 90_000);
        assert!(p.is_done(Milestone::Inspected) && !p.is_done(Milestone::Transcribed));
        p.observe_work(&seen(&|w| w.transcript = true), 3 * MIN);
        assert_eq!(p.current(3 * MIN), view(15, "Planning the edit"));
        // The plan, then graphics sources and renders: the plan is done and graphics are the stage.
        p.observe_work(&seen(&|w| w.plan = true), 8 * MIN);
        assert_eq!(p.current(8 * MIN), view(30, "Building graphics"));
        let mut q = edit();
        q.observe_work(&seen(&|w| w.audio = true), MIN);
        q.observe_work(&seen(&|w| w.graphics = true), 10 * MIN);
        assert!(q.is_done(Milestone::Planned) && q.is_done(Milestone::Transcribed));
        // Quality-check output needs the picture with its graphics and b-roll: only the timeline
        // and the checks are left, and only what was seen is learned from.
        p.observe_work(&seen(&|w| w.quality_check = true), 28 * MIN);
        assert!(p.is_done(Milestone::GraphicsBuilt) && p.is_done(Milestone::BrollReady));
        assert!(p.is_done(Milestone::Assembled) && !p.is_done(Milestone::Checked));
        assert_eq!(stage(&mut p, 28 * MIN), "Checking the edit");
        let record = p.run_record(30 * MIN);
        assert!(record.milestones.contains_key("assembled"));
        assert!(!record.milestones.contains_key("graphics_built"));
        // The review project still needs its file.
        assert!(percent(&mut p, 60 * MIN) <= 95);
        // Re-edits and renders look at the output folder only.
        let mut r = Progress::new(
            JobKind::ReEdit,
            Pacing::defaults(JobKind::ReEdit, VideoType::Short),
        );
        r.observe_work(&seen(&|w| w.audio = true), MIN);
        assert!(r.done.is_empty());
        // A graphics file the stream shows being written counts at once, a plan only from the
        // main session.
        let mut s = edit();
        s.mark(Milestone::Transcribed, MIN);
        let page = json!({"file_path": "/v/CLAUDE_VE/gfx_src/hook/index.html"});
        s.observe(&tool("Write", page), 2 * MIN);
        assert!(s.is_done(Milestone::Planned));
        let mut n = edit();
        n.mark(Milestone::Transcribed, MIN);
        let notes = json!({"file_path": "/v/CLAUDE_VE/spec.json"});
        n.observe(
            &event(json!({"type": "assistant", "parent_tool_use_id": "agent1",
            "message": {"content": [{"type": "tool_use", "id": "w", "name": "Write",
            "input": notes}]}})),
            2 * MIN,
        );
        assert!(!n.is_done(Milestone::Planned));
    }

    #[test]
    fn pause_and_restart_resume_from_the_same_value() {
        let pacing = || Pacing::defaults(JobKind::Edit, VideoType::Long);
        let mut p = Progress::new(JobKind::Edit, pacing());
        p.mark(Milestone::Transcribed, 6 * MIN);
        let at_pause = p.current(8 * MIN);
        let memory = p.memory("job-1");
        assert_eq!(memory.job_id, "job-1");
        assert_eq!(memory.percent, at_pause.percent);
        // Active time does not grow while the job is paused; after Continue (or a restart) the
        // engine goes on from the persisted memory at the same active time.
        let mut resumed = Progress::restore(
            JobKind::Edit,
            pacing(),
            Some(&memory),
            Some(at_pause.percent),
        );
        assert_eq!(resumed.current(8 * MIN), at_pause);
        assert!(resumed.is_done(Milestone::Transcribed) && !resumed.is_done(Milestone::Planned));
        assert_eq!(
            resumed.current(10 * MIN).percent,
            p.current(10 * MIN).percent,
            "the creep goes on exactly as without the pause"
        );
        resumed.mark(Milestone::Planned, 12 * MIN);
        assert_eq!(resumed.current(12 * MIN).percent, 30);
        // A memory that never got written (crash right after a start): the persisted percent is
        // the floor, the milestones start over.
        let mut floor = Progress::restore(JobKind::Edit, pacing(), None, Some(42));
        assert_eq!(floor.current(0), view(42, "Inspecting the footage"));
        // Milestones of another kind in the memory are dropped.
        let mut other = memory.clone();
        other
            .done
            .insert("rendered".into(), ProgressMark::default());
        let restored = Progress::restore(JobKind::Edit, pacing(), Some(&other), None);
        assert_eq!(restored.memory("job-1").done, memory.done);
    }

    #[test]
    fn missing_markers_are_inferred_from_tools_tasks_and_files() {
        let mut p = edit();
        // A product helper starts early; it does not move the plan.
        let product = json!({"description": "Find product images", "run_in_background": "true"});
        p.observe(&tool("Agent", product), 30_000);
        p.observe(
            &task_started("prod", "Find product images", "local_agent"),
            30_000,
        );
        assert!(p.done.is_empty());
        let transcribe = json!({"command": "python3 tools/transcribe.py a.wav",
            "description": "Transcribe the A-roll", "run_in_background": true});
        p.observe(&tool("Bash", transcribe), MIN);
        assert!(p.is_done(Milestone::Inspected));
        // Shell commands that run Whisper end when the command ends, which says nothing about
        // the transcript; a transcription sub-agent that completes does.
        p.observe(&task_started("w1", "Whisper chunk pass", "local_bash"), MIN);
        p.observe(&task_done("w1", "completed"), 3 * MIN);
        assert!(!p.is_done(Milestone::Transcribed));
        p.observe(
            &task_started("w2", "Transcribe the A-roll", "local_agent"),
            MIN,
        );
        p.observe(&task_done("w2", "completed"), 4 * MIN);
        assert!(p.is_done(Milestone::Transcribed));
        assert_eq!(stage(&mut p, 4 * MIN), "Planning the edit");
        p.observe(&task_done("prod", "completed"), 6 * MIN);
        assert!(!p.is_done(Milestone::BrollReady), "started before the plan");
        // The graphics fan-out starts from the finished plan.
        for (id, d) in [("g1", "Build graphics A"), ("g2", "Build graphics B")] {
            let agent = json!({"description": d, "run_in_background": true});
            p.observe(&tool("Agent", agent), 9 * MIN);
            p.observe(&task_started(id, d, "local_agent"), 9 * MIN);
        }
        assert!(p.is_done(Milestone::Planned));
        assert_eq!(percent(&mut p, 9 * MIN), 30);
        p.observe(
            &task_started("b1", "Conform b-roll clips", "local_agent"),
            9 * MIN,
        );
        p.observe(&task_done("g1", "completed"), 15 * MIN);
        p.observe(&task_done("g2", "killed"), 16 * MIN);
        assert!(
            !p.is_done(Milestone::GraphicsBuilt),
            "a killed agent is not done"
        );
        p.observe(
            &task_started("g3", "Rebuild graphics B", "local_agent"),
            16 * MIN,
        );
        p.observe(&task_done("b1", "completed"), 17 * MIN);
        assert!(p.is_done(Milestone::BrollReady));
        p.observe(&task_done("g3", "completed"), 20 * MIN);
        assert!(!p.is_done(Milestone::GraphicsBuilt), "g2 never completed");
        // The review project in the output folder settles everything before it.
        p.observe_output(&evidence(true, false, false), 24 * MIN);
        assert_eq!(percent(&mut p, 24 * MIN), 96);
        p.observe_output(&evidence(true, true, false), 25 * MIN);
        assert!(
            !p.is_done(Milestone::ExtrasWritten),
            "thumbnails without meta.txt"
        );
        p.observe_output(&evidence(true, true, true), 25 * MIN);
        assert_eq!(percent(&mut p, 25 * MIN), 99);
        // Only what was seen goes into the history, implied milestones do not.
        let run = p.run_record(26 * MIN);
        assert_eq!(run.total_ms, 26 * MIN);
        let seen: Vec<&str> = run.milestones.keys().map(String::as_str).collect();
        assert_eq!(
            seen,
            [
                "broll_ready",
                "extras_written",
                "inspected",
                "planned",
                "review_saved",
                "transcribed"
            ]
        );
        assert_eq!(run.milestones["planned"], 9 * MIN);
    }

    #[test]
    fn plan_files_transcripts_and_foreground_agents_count_too() {
        // Writing a plan before any transcription started is not planning from a transcript.
        let mut p = edit();
        p.observe(
            &tool("Write", json!({"file_path": "/v/CLAUDE_VE/plan.md"})),
            10_000,
        );
        assert!(!p.is_done(Milestone::Transcribed));
        p.observe(&tool("Bash", json!({"command": "mlx_whisper a.wav"})), MIN);
        let transcript = json!({"file_path": "/v/CLAUDE_VE/transcript_full.json"});
        p.observe(&tool("Read", transcript), 3 * MIN);
        assert!(p.is_done(Milestone::Transcribed));
        let mut q = edit();
        q.observe(&tool("Bash", json!({"command": "whisper-cli a.wav"})), MIN);
        let timeline = json!({"file_path": "/v/CLAUDE_VE/timeline.py"});
        q.observe(&tool("Write", timeline), 4 * MIN);
        assert!(q.is_done(Milestone::Transcribed));
        // info.txt is not a plan.
        let mut r = edit();
        r.observe(&tool("Bash", json!({"command": "whisper a.wav"})), MIN);
        r.observe(&tool("Write", json!({"file_path": "/v/info.txt"})), 2 * MIN);
        assert!(!r.is_done(Milestone::Transcribed));
        // A foreground sub-agent is finished when its tool result arrives.
        let mut f = edit();
        let agent = json!({"description": "Build the title graphics"});
        f.observe(&tool("Agent", agent), 9 * MIN);
        assert!(f.is_done(Milestone::Planned));
        let result = json!({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "tu-Agent", "content": "built 12"}]}});
        f.observe(&event(result), 18 * MIN);
        assert!(f.is_done(Milestone::GraphicsBuilt));
        // Markers of sub-agents never count.
        let mut n = edit();
        n.observe(&nested_text("[VIDAI_PROGRESS planned]"), MIN);
        assert!(!n.is_done(Milestone::Planned));
    }

    #[test]
    fn re_edit_and_render_models() {
        let short = Pacing::defaults(JobKind::ReEdit, VideoType::Short);
        let mut r = Progress::new(JobKind::ReEdit, short);
        assert_eq!(stage(&mut r, 0), "Applying the changes");
        // Edit markers mean nothing to a re-edit.
        r.observe(&text("[VIDAI_PROGRESS transcribed]"), MIN);
        assert!(r.done.is_empty());
        r.observe_output(&evidence(true, false, false), 6 * MIN);
        assert_eq!(r.current(6 * MIN), view(95, FINISHING_STAGE));

        let long = Pacing::defaults(JobKind::Render, VideoType::Long);
        let mut f = Progress::new(JobKind::Render, long);
        assert_eq!(stage(&mut f, 0), "Preparing the render");
        let render = json!({"command": "python3 ve.py gfx V --res 2160",
            "description": "Render graphics at 4K"});
        f.observe(&tool("Bash", render), MIN);
        assert_eq!(f.current(MIN), view(10, "Rendering"));
        let writing = OutputEvidence {
            final_file: true,
            ..OutputEvidence::default()
        };
        f.observe_output(&writing, 12 * MIN);
        assert_eq!(f.current(12 * MIN), view(70, "Writing the final file"));
        let settled = OutputEvidence {
            final_settled: true,
            ..writing
        };
        f.observe_output(&settled, 15 * MIN);
        assert_eq!(f.current(15 * MIN), view(95, FINISHING_STAGE));
    }

    #[test]
    fn history_medians_pace_the_creep() {
        let run = |planned: u64, total: u64| ProgressRun {
            milestones: BTreeMap::from([("planned".to_owned(), planned * MIN)]),
            total_ms: total * MIN,
        };
        let defaults = Pacing::defaults(JobKind::Edit, VideoType::Short);
        // Fewer than three runs: the defaults.
        let two = [run(20, 50), run(22, 52)];
        assert_eq!(
            Pacing::from_history(JobKind::Edit, VideoType::Short, &two),
            defaults
        );
        // Three or more: the medians, and the other milestones scaled by the learned total.
        let runs = [run(20, 50), run(30, 60), run(18, 40), run(24, 70)];
        let learned = Pacing::from_history(JobKind::Edit, VideoType::Short, &runs);
        assert_eq!(learned.total_ms, 55 * MIN);
        assert_eq!(learned.at_ms[2], 22 * MIN);
        let scale = 55.0 / 25.0;
        assert_eq!(learned.at_ms[1], (3.5 * scale * MIN as f64).round() as u64);
        // A longer typical stretch makes the creep slower.
        let mut fast = edit();
        let mut slow = Progress::new(JobKind::Edit, learned);
        fast.mark(Milestone::Inspected, 0);
        slow.mark(Milestone::Inspected, 0);
        assert!(percent(&mut slow, 3 * MIN) < percent(&mut fast, 3 * MIN));
        // Long defaults are never faster than Short ones.
        let long = Pacing::defaults(JobKind::Edit, VideoType::Long);
        assert!(long.at_ms.iter().zip(&defaults.at_ms).all(|(l, s)| l >= s));
    }

    #[test]
    fn a_slow_job_paces_its_creep_slower() {
        let mut typical = edit();
        let mut slow = edit();
        typical.mark(Milestone::Transcribed, 4 * MIN);
        slow.mark(Milestone::Transcribed, 8 * MIN); // twice the typical time
        let t = percent(&mut typical, 4 * MIN + 150_000);
        let s = percent(&mut slow, 8 * MIN + 150_000);
        assert!(s < t, "{s} < {t}");
    }

    #[test]
    fn output_evidence_counts_only_files_written_since_the_start() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
        std::fs::write(path("thumbnail-1.png"), "").unwrap();
        std::fs::write(path("meta.txt"), "").unwrap();
        let now = SystemTime::now();
        let iso = |t: SystemTime| {
            chrono::DateTime::<chrono::Utc>::from(t)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        let file = |name: &str, t: SystemTime| OutputFile {
            path: path(name),
            name: name.into(),
            modified_at: iso(t),
            software: None,
        };
        let output = VideoOutput {
            review_files: vec![file("v1.fcpxml", now - Duration::from_secs(3600))],
            final_files: vec![file("final.mp4", now - Duration::from_secs(30))],
            thumbnails: vec![path("thumbnail-1.png")],
            meta_file: Some(path("meta.txt")),
            ..VideoOutput::default()
        };
        let since = now - Duration::from_secs(60);
        assert_eq!(
            output_evidence(&output, since, now),
            OutputEvidence {
                review: false,
                final_file: true,
                final_settled: true,
                thumbnails: true,
                meta: true
            }
        );
        // A final file still being written is not settled; files from before the start count
        // for nothing.
        let early = output_evidence(&output, since, now - Duration::from_secs(25));
        assert!(early.final_file && !early.final_settled);
        let later = output_evidence(&output, now + Duration::from_secs(5), now);
        assert_eq!(later, OutputEvidence::default());
        // Files that were there, unchanged, when the run started never count.
        let known = stamps(&output);
        assert_eq!(known.len(), 4);
        let left = without_known(output.clone(), &known);
        assert!(left.thumbnails.is_empty() && left.meta_file.is_none());
        assert!(left.review_files.is_empty() && left.final_files.is_empty());
        std::fs::write(path("meta.txt"), "changed").unwrap();
        let file = std::fs::File::options()
            .write(true)
            .open(path("meta.txt"))
            .unwrap();
        file.set_modified(now + Duration::from_secs(2)).unwrap();
        assert_eq!(
            without_known(output, &known).meta_file,
            Some(path("meta.txt"))
        );
    }
}

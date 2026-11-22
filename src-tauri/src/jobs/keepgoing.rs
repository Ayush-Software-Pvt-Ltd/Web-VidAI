//! Keeping a job going (SPEC section 6, "Keeping a job going").
//!
//! Some models end a turn with a sentence that announces the next step, without doing it. A turn that ends before the job's work is done is not a failure:
//! the harness tells the model to go on, in the same live session, until the work is really done
//! or there is a real reason to stop.
//!
//! This module is the pure decision, free of any harness type: whatever drives the model (Claude
//! Code today, another agent CLI later) reports each moment its model went idle as a [`Turn`]
//! plus the [`Evidence`] it sees on disk and in the progress, and [`Keeper::turn_ended`] answers
//! with a [`Decision`]: the job is complete, send the next message ([`Nudge`], whose text is
//! `jobs::prompt::continuation_body`), or stop because the model is stuck or the output is
//! missing. The harness only has to say when the model is idle (no turn running, no background
//! task, quiet for the settle time), count the tool calls of the main conversation, and notice
//! the completion marker.
//!
//! Where it applies is decided by one function, `opencode::keeps_jobs_going` (through
//! `JobHost::keeps_jobs_going`).

use crate::model::JobKind;

/// The line the instructions ask for when the work is fully done.
pub const COMPLETION_MARKER: &str = "[OUTPUT COMPLETED]";

/// Whether a message of the main conversation carries the completion marker (case does not
/// matter).
pub fn has_completion_marker(text: &str) -> bool {
    text.to_ascii_uppercase().contains(COMPLETION_MARKER)
}

/// The thresholds of [`Keeper`] (SPEC section 6 gives the reasoning).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Stuck after this many idle moments in a row whose turns made no tool call at all.
    pub idle_turns: u32,
    /// Stuck after this many continuations in a row that brought no new progress milestone.
    pub without_progress: u32,
    /// The most continuations one run of a job sends (a run starts at a launch or a Continue).
    pub ceiling: u32,
    /// How often the model is asked to save an output it said was done but is not there.
    pub save_requests: u32,
}

impl Limits {
    pub const DEFAULT: Limits = Limits {
        idle_turns: 3,
        without_progress: 8,
        ceiling: 40,
        save_requests: 2,
    };
}

impl Default for Limits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// What the model did since the previous idle moment (since the job's message, or since the
/// last continuation): one or more turns.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Turn {
    /// Tool calls of the main conversation (sub-agents not counted).
    pub tool_calls: u32,
    /// The main conversation wrote [`COMPLETION_MARKER`].
    pub marker: bool,
}

/// What the harness sees when the model went idle.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Evidence {
    /// The file that proves the job did its work (`driver::expected_output`): the review project
    /// of an edit or re-edit, the final render of a render.
    pub deliverable: Option<String>,
    /// An edit whose thumbnails and meta.txt are not written yet (always false for the other
    /// kinds).
    pub extras_missing: bool,
    /// How much the job has shown of its work (`jobs::progress::Tracker::work_shown`: finished
    /// milestones and files written); only its growth counts.
    pub milestones: usize,
    /// The model's own commands are busy on the computer right now (processes of the job using
    /// CPU, for example a transcription started in the background of a shell): a model that
    /// ended its turn is waiting for them, not stuck.
    pub workers_busy: bool,
}

/// Which message goes out next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Nudge {
    /// Nothing is delivered yet: keep working.
    KeepWorking,
    /// The deliverable exists but the marker was not written: finish what is left.
    Finish { file: String, extras_missing: bool },
    /// The marker was written but the deliverable is not there: save it.
    SaveOutput,
    /// Nothing is delivered, but the model's commands are still busy: wait for them (the model
    /// ended its turn to wait, and only a message wakes it up).
    WaitForWork,
}

/// Why a job that is not done stops anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stuck {
    /// This many idle moments in a row without a single tool call.
    IdleTurns(u32),
    /// This many continuations in a row without a new milestone.
    NoProgress(u32),
    /// The ceiling of continuations per run was reached.
    Ceiling(u32),
}

/// The answer to an idle moment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// The job is done.
    Complete { file: String },
    /// Send the message of `nudge`; `number` counts the continuations of this run from 1.
    Continue { nudge: Nudge, number: u32 },
    /// Not done, and going on would not help.
    Stuck(Stuck),
    /// The model kept saying it is done, but the deliverable is not there.
    MissingOutput,
}

/// The state of one run of a job. A new run (a launch, or the owner's Continue) starts a new
/// keeper, so a manual Continue resets every counter.
#[derive(Debug, Clone)]
pub struct Keeper {
    limits: Limits,
    sent: u32,
    idle_turns: u32,
    since_progress: u32,
    milestones: usize,
    marker_seen: bool,
    finish_sent: bool,
    save_sent: u32,
}

impl Keeper {
    /// A keeper for a run that starts with `milestones` finished (a continued job keeps its
    /// progress; only new milestones count as progress).
    pub fn new(limits: Limits, milestones: usize) -> Self {
        Self {
            limits,
            sent: 0,
            idle_turns: 0,
            since_progress: 0,
            milestones,
            marker_seen: false,
            finish_sent: false,
            save_sent: 0,
        }
    }

    /// Continuations sent in this run.
    pub fn continuations(&self) -> u32 {
        self.sent
    }

    /// The model went idle (no turn running, no background task, quiet for the settle time):
    /// decide whether the job is done, what to send next, or why to stop.
    ///
    /// - A deliverable with the marker (now or earlier in the run) is done. A deliverable
    ///   without it gets one [`Nudge::Finish`]; at the next idle moment it is done whatever the
    ///   model wrote, so a model is never nagged once its real deliverable exists.
    /// - The marker without a deliverable gets [`Nudge::SaveOutput`] up to
    ///   `Limits::save_requests` times, then [`Decision::MissingOutput`].
    /// - Otherwise the model ended early: [`Nudge::KeepWorking`], unless it is stuck (idle turns
    ///   in a row without a tool call, continuations without progress, or the ceiling).
    pub fn turn_ended(&mut self, turn: Turn, evidence: &Evidence) -> Decision {
        self.marker_seen |= turn.marker;
        if evidence.milestones > self.milestones {
            self.milestones = evidence.milestones;
            self.since_progress = 0;
        }
        // A model that waits for its own busy commands is neither idle nor without progress.
        let waiting = evidence.workers_busy && evidence.deliverable.is_none() && !turn.marker;
        self.idle_turns = if waiting || turn.tool_calls > 0 {
            0
        } else {
            self.idle_turns + 1
        };
        if let Some(file) = &evidence.deliverable {
            if self.marker_seen || self.finish_sent || self.sent >= self.limits.ceiling {
                return Decision::Complete { file: file.clone() };
            }
            self.finish_sent = true;
            return self.continue_with(Nudge::Finish {
                file: file.clone(),
                extras_missing: evidence.extras_missing,
            });
        }
        if self.sent >= self.limits.ceiling {
            return Decision::Stuck(Stuck::Ceiling(self.sent));
        }
        if turn.marker {
            if self.save_sent >= self.limits.save_requests {
                return Decision::MissingOutput;
            }
            self.save_sent += 1;
            return self.continue_with(Nudge::SaveOutput);
        }
        if waiting {
            self.sent += 1;
            return Decision::Continue {
                nudge: Nudge::WaitForWork,
                number: self.sent,
            };
        }
        if self.idle_turns >= self.limits.idle_turns {
            return Decision::Stuck(Stuck::IdleTurns(self.idle_turns));
        }
        if self.since_progress >= self.limits.without_progress {
            return Decision::Stuck(Stuck::NoProgress(self.since_progress));
        }
        self.continue_with(Nudge::KeepWorking)
    }

    fn continue_with(&mut self, nudge: Nudge) -> Decision {
        self.sent += 1;
        self.since_progress += 1;
        Decision::Continue {
            nudge,
            number: self.sent,
        }
    }
}

/// What a job of `kind` works on, as the log and the errors say it.
pub fn work_noun(kind: JobKind) -> &'static str {
    match kind {
        JobKind::Edit => "edit",
        JobKind::ReEdit => "re-edit",
        JobKind::Render => "final render",
    }
}

/// The one status line of a continuation in the job's log (its `detail` is the message), also
/// the row's activity until the model writes something new.
pub fn status_line(kind: JobKind, nudge: &Nudge, number: u32) -> String {
    match nudge {
        Nudge::KeepWorking => format!(
            "Asked to keep going ({number}): the turn ended before the {} was finished",
            work_noun(kind)
        ),
        Nudge::Finish { .. } => format!(
            "Asked to finish the last steps ({number}): {} is saved, [OUTPUT COMPLETED] is not written yet",
            match kind {
                JobKind::Edit => "the review project",
                JobKind::ReEdit => "the new review project version",
                JobKind::Render => "the final render",
            }
        ),
        Nudge::WaitForWork => format!(
            "Asked to wait for the running commands ({number}): the computer is busy with your background work"
        ),
        Nudge::SaveOutput => format!(
            "Asked to save {} ({number}): [OUTPUT COMPLETED] was written, but it is not in the output folder",
            match kind {
                JobKind::Edit => "the review project",
                JobKind::ReEdit => "the new review project version",
                JobKind::Render => "the final render",
            }
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work(tool_calls: u32) -> Turn {
        Turn {
            tool_calls,
            marker: false,
        }
    }

    fn nothing(milestones: usize) -> Evidence {
        Evidence {
            milestones,
            ..Evidence::default()
        }
    }

    fn delivered(extras_missing: bool) -> Evidence {
        Evidence {
            deliverable: Some("v1.fcpxml".into()),
            extras_missing,
            milestones: 8,
            workers_busy: false,
        }
    }

    fn keep_working(number: u32) -> Decision {
        Decision::Continue {
            nudge: Nudge::KeepWorking,
            number,
        }
    }

    #[test]
    fn the_marker_finds_its_line_in_any_case() {
        assert!(has_completion_marker("All done.\n\n[OUTPUT COMPLETED]"));
        assert!(has_completion_marker("**[Output Completed]**"));
        assert!(!has_completion_marker("OUTPUT COMPLETED"));
        assert!(!has_completion_marker("[VIDAI_PROGRESS review_saved]"));
    }

    #[test]
    fn a_deliverable_with_the_marker_is_done_at_once() {
        let mut k = Keeper::new(Limits::DEFAULT, 0);
        let turn = Turn {
            tool_calls: 4,
            marker: true,
        };
        assert_eq!(
            k.turn_ended(turn, &delivered(false)),
            Decision::Complete {
                file: "v1.fcpxml".into()
            }
        );
        assert_eq!(k.continuations(), 0);
    }

    #[test]
    fn a_marker_from_an_earlier_turn_still_counts() {
        let mut k = Keeper::new(Limits::DEFAULT, 0);
        let marked = Turn {
            tool_calls: 0,
            marker: true,
        };
        assert_eq!(
            k.turn_ended(marked, &nothing(3)),
            Decision::Continue {
                nudge: Nudge::SaveOutput,
                number: 1
            }
        );
        assert!(matches!(
            k.turn_ended(work(2), &delivered(false)),
            Decision::Complete { .. }
        ));
    }

    #[test]
    fn a_deliverable_without_the_marker_gets_one_finishing_request_and_no_more() {
        let mut k = Keeper::new(Limits::DEFAULT, 0);
        assert_eq!(
            k.turn_ended(work(5), &delivered(true)),
            Decision::Continue {
                nudge: Nudge::Finish {
                    file: "v1.fcpxml".into(),
                    extras_missing: true
                },
                number: 1
            }
        );
        // Whatever the model does next, even nothing, the deliverable is there: done.
        assert_eq!(
            k.turn_ended(work(0), &delivered(true)),
            Decision::Complete {
                file: "v1.fcpxml".into()
            }
        );
    }

    #[test]
    fn the_marker_without_a_deliverable_is_asked_to_save_then_fails() {
        let mut k = Keeper::new(Limits::DEFAULT, 0);
        let marked = Turn {
            tool_calls: 1,
            marker: true,
        };
        for number in 1..=2 {
            assert_eq!(
                k.turn_ended(marked, &nothing(5)),
                Decision::Continue {
                    nudge: Nudge::SaveOutput,
                    number
                }
            );
        }
        assert_eq!(k.turn_ended(marked, &nothing(5)), Decision::MissingOutput);
    }

    #[test]
    fn early_turn_ends_with_work_go_on_as_often_as_a_real_edit_needs() {
        // The real OpenCode edits: every early end came after at least one tool call, and a new
        // milestone arrived at least every third early end.
        let mut k = Keeper::new(Limits::DEFAULT, 0);
        let mut milestones = 0;
        for number in 1..=20 {
            if number % 2 == 0 {
                milestones += 1;
            }
            assert_eq!(
                k.turn_ended(work(1), &nothing(milestones)),
                keep_working(number)
            );
        }
        assert!(matches!(
            k.turn_ended(
                Turn {
                    tool_calls: 3,
                    marker: true
                },
                &delivered(false)
            ),
            Decision::Complete { .. }
        ));
    }

    #[test]
    fn idle_turns_in_a_row_are_stuck_and_any_tool_call_resets_them() {
        let mut k = Keeper::new(Limits::DEFAULT, 0);
        assert_eq!(k.turn_ended(work(0), &nothing(0)), keep_working(1));
        assert_eq!(k.turn_ended(work(0), &nothing(0)), keep_working(2));
        assert_eq!(k.turn_ended(work(1), &nothing(1)), keep_working(3));
        assert_eq!(k.turn_ended(work(0), &nothing(1)), keep_working(4));
        assert_eq!(k.turn_ended(work(0), &nothing(1)), keep_working(5));
        assert_eq!(
            k.turn_ended(work(0), &nothing(1)),
            Decision::Stuck(Stuck::IdleTurns(3))
        );
    }

    #[test]
    fn busy_turns_without_progress_are_stuck_after_the_limit() {
        let mut k = Keeper::new(Limits::DEFAULT, 4);
        for number in 1..=8 {
            assert_eq!(k.turn_ended(work(2), &nothing(4)), keep_working(number));
        }
        assert_eq!(
            k.turn_ended(work(2), &nothing(4)),
            Decision::Stuck(Stuck::NoProgress(8))
        );
        // A new milestone at the last moment resets the count instead.
        let mut k = Keeper::new(Limits::DEFAULT, 4);
        for number in 1..=8 {
            assert_eq!(k.turn_ended(work(2), &nothing(4)), keep_working(number));
        }
        assert_eq!(k.turn_ended(work(2), &nothing(5)), keep_working(9));
    }

    #[test]
    fn a_model_waiting_for_its_busy_commands_is_asked_to_wait_and_is_never_stuck() {
        // A slow computer: the transcription runs for an hour in the background of a shell and
        // the model ends its turn every minute or two to check on it.
        let busy = Evidence {
            milestones: 4,
            workers_busy: true,
            ..Evidence::default()
        };
        let mut k = Keeper::new(Limits::DEFAULT, 4);
        for number in 1..=30 {
            assert_eq!(
                k.turn_ended(work(0), &busy),
                Decision::Continue {
                    nudge: Nudge::WaitForWork,
                    number
                },
                "{number}"
            );
        }
        // The same turns on an idle computer are what they were: stuck after three without work.
        let mut k = Keeper::new(Limits::DEFAULT, 4);
        k.turn_ended(work(0), &nothing(4));
        k.turn_ended(work(0), &nothing(4));
        assert_eq!(
            k.turn_ended(work(0), &nothing(4)),
            Decision::Stuck(Stuck::IdleTurns(3))
        );
        // Waiting does not use up the room for real continuations (only the ceiling counts it),
        // and a deliverable or the marker is decided as ever, busy or not.
        let mut k = Keeper::new(Limits::DEFAULT, 4);
        for _ in 0..7 {
            k.turn_ended(work(1), &busy);
        }
        assert_eq!(k.turn_ended(work(2), &nothing(4)), keep_working(8));
        let mut k = Keeper::new(Limits::DEFAULT, 4);
        let done = Evidence {
            workers_busy: true,
            ..delivered(false)
        };
        let marked = Turn {
            tool_calls: 1,
            marker: true,
        };
        assert!(matches!(
            k.turn_ended(marked, &done),
            Decision::Complete { .. }
        ));
        // The ceiling still ends a run that waits forever.
        let mut k = Keeper::new(Limits::DEFAULT, 4);
        for _ in 0..40 {
            k.turn_ended(work(0), &busy);
        }
        assert_eq!(
            k.turn_ended(work(0), &busy),
            Decision::Stuck(Stuck::Ceiling(40))
        );
    }

    #[test]
    fn the_ceiling_ends_any_run_that_never_finishes() {
        let limits = Limits {
            without_progress: u32::MAX,
            ..Limits::DEFAULT
        };
        let mut k = Keeper::new(limits, 0);
        for number in 1..=40 {
            assert_eq!(
                k.turn_ended(work(1), &nothing(number as usize)),
                keep_working(number)
            );
        }
        assert_eq!(
            k.turn_ended(work(1), &nothing(99)),
            Decision::Stuck(Stuck::Ceiling(40))
        );
        // A deliverable that shows up at the ceiling still completes the job.
        assert!(matches!(
            k.turn_ended(work(1), &delivered(true)),
            Decision::Complete { .. }
        ));
    }

    #[test]
    fn status_lines_are_numbered_and_name_the_work() {
        assert_eq!(
            status_line(JobKind::Edit, &Nudge::KeepWorking, 2),
            "Asked to keep going (2): the turn ended before the edit was finished"
        );
        assert_eq!(
            status_line(JobKind::Render, &Nudge::KeepWorking, 1),
            "Asked to keep going (1): the turn ended before the final render was finished"
        );
        assert_eq!(
            status_line(
                JobKind::ReEdit,
                &Nudge::Finish {
                    file: "v2.fcpxml".into(),
                    extras_missing: false
                },
                3
            ),
            "Asked to finish the last steps (3): the new review project version is saved, [OUTPUT COMPLETED] is not written yet"
        );
        assert_eq!(
            status_line(JobKind::Edit, &Nudge::SaveOutput, 4),
            "Asked to save the review project (4): [OUTPUT COMPLETED] was written, but it is not in the output folder"
        );
    }
}

//! End-to-end tests of the job engine: the real `JobManager`, driver threads, Claude sessions,
//! process tree handling and log delivery, against a fake `claude` (tests/support/fake-claude.sh)
//! and a temporary Editing Folder and data directory. Nothing here touches the real Claude Code,
//! the network, the keychain or the developer's files. The engine under test and its helpers are
//! shared with the tests of the OpenCode program (tests/support/engine.rs).

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

mod support;
use support::engine::*;
use vidai_lib::error::{AppError, ErrorCode};
use vidai_lib::jobs::{JobManager, Notice, Timings};
use vidai_lib::model::{
    ApiOption, JobKind, JobState, JobView, LogKind, RenderFinalRequest, ReviewSoftware, Setup,
    ToolkitKind, VideoInputs, VideoType,
};

/// The fake saves the review project the real flow saves for the edit's review software, and
/// VidAI counts it: an FCPXML for Final Cut Pro, a Premiere Pro XML (`<xmeml`) for Premiere Pro.
/// A re-edit of the same session adds the next version in the same format.
#[test]
fn the_review_project_follows_the_review_software() {
    let softwares: &[(ReviewSoftware, &str)] = if cfg!(target_os = "macos") {
        &[
            (ReviewSoftware::Fcp, "fcpxml"),
            (ReviewSoftware::Premiere, "xml"),
        ]
    } else {
        // Final Cut Pro is refused on Windows (section 5).
        &[(ReviewSoftware::Premiere, "xml")]
    };
    for &(software, ext) in softwares {
        let env = Env::new("complete");
        env.host
            .store
            .update_settings(|s| {
                s.review_software = software;
                Ok(())
            })
            .unwrap();
        env.start("Video A");
        env.wait_state("Video A", JobState::Completed);
        env.jobs.re_edit(&Env::vid("Video A"), "Shorter.").unwrap();
        let done = env.wait_state("Video A", JobState::Completed);
        assert_eq!(done.kind, JobKind::ReEdit);
        let output = vidai_lib::scanner::scan_output(&env.video_dir("Video A"));
        let names: Vec<_> = output
            .review_files
            .iter()
            .map(|f| f.name.as_str())
            .collect();
        assert_eq!(
            names,
            [format!("Video A_v2.{ext}"), format!("Video A_v1.{ext}")],
            "{software:?}"
        );
        assert!(
            output
                .review_files
                .iter()
                .all(|f| f.software == Some(software)),
            "{software:?}: {:?}",
            output.review_files
        );
    }
}

#[test]
fn edit_uses_the_selected_prompt_and_style_and_remembers_them() {
    let env = Env::new("complete");
    env.host
        .store
        .update_settings(|s| {
            let long = &mut s.channels[0].long;
            long.prompts[2].text = "Fast prompt.".into();
            long.styles[3].text = "Neon captions.".into();
            Ok(())
        })
        .unwrap();
    env.jobs
        .start_edit(
            &Env::vid("Video A"),
            VideoInputs {
                prompt_slot: 2,
                style_slot: 3,
                ..VideoInputs::default()
            },
        )
        .unwrap();
    env.wait_state("Video A", JobState::Completed);
    let (_, stdin) = &env.calls()[0];
    let message = Env::message_of(stdin);
    assert!(message.contains("Fast prompt.\n\nCHANNEL_STYLE (Long 16:9):\nNeon captions."));
    assert!(!message.contains("Edit this video."));
    let inputs = env.host.store.video(&Env::vid("Video A")).inputs;
    assert_eq!((inputs.prompt_slot, inputs.style_slot), (2, 3));
}

#[test]
fn edit_runs_to_completion() {
    let env = Env::new("complete");
    let queued = env.start("Video A");
    assert_eq!(queued.kind, JobKind::Edit);
    assert_eq!(queued.model.as_deref(), Some("opus"));
    assert_eq!(queued.effort.as_deref(), Some("high"));
    assert_eq!(queued.toolkit, ToolkitKind::Standard);

    let job = env.wait_state("Video A", JobState::Completed);
    // The driver finishes its bookkeeping (slot, sleep prevention, notification) right after.
    assert!(env.jobs.wait_until_idle(WAIT));
    assert!(job.error.is_none());
    assert!(job.ended_at.is_some() && job.started_at.is_some());
    assert!(job.running_since.is_none());
    assert!(job.active_ms > 0);
    assert_eq!(job.cost_usd, Some(0.25));
    assert_eq!(job.last_activity.as_deref(), Some("Finished"));

    let calls = env.calls();
    assert_eq!(calls.len(), 1);
    let (call, stdin) = &calls[0];
    let sid = job.session_id.clone().unwrap();
    assert_eq!(call["mode"], "new");
    assert_eq!(call["sid"], sid);
    assert_eq!(
        call["args"],
        format!(
            "-p --input-format stream-json --output-format stream-json --verbose --permission-mode bypassPermissions --model opus --effort high --session-id {sid}"
        )
    );
    assert_eq!(native_path(&call["cwd"]), env.host.editing);
    let message = Env::message_of(stdin);
    assert!(message.starts_with("MAIN_FOLDER = Video A\nCHANNEL_FOLDER = Tech\n"));
    assert!(message.contains("PRODUCT_LINKS =\nhttps://shop.example/1"));
    assert!(message.contains("NOTES FOR THIS VIDEO:\nKeep it short."));
    assert!(message.contains("Edit this video.\n\nCHANNEL_STYLE (Long 16:9):\nYellow captions."));
    // The remembered inputs were saved.
    let inputs = env.host.store.video(&Env::vid("Video A")).inputs;
    assert_eq!(inputs.notes, "Keep it short.");

    let log = env.jobs.job_log(&Env::vid("Video A")).unwrap();
    let texts: Vec<&str> = log.iter().map(|e| e.text.as_str()).collect();
    assert!(
        texts.contains(&"Bash: Render graphics at 1080"),
        "{texts:#?}"
    );
    let tool = log
        .iter()
        .find(|e| e.text == "Bash: Render graphics at 1080")
        .unwrap();
    assert_eq!(tool.detail.as_deref(), Some("ffmpeg -i in.mp4 out.mp4"));
    assert!(
        texts.iter().all(|t| !t.contains("secret thoughts")),
        "thinking is not logged"
    );
    let finished = format!("Finished: Video A_v1.{}", review_extension());
    assert!(texts.contains(&finished.as_str()), "{texts:#?}");
    assert!(
        log.windows(2).all(|w| w[1].seq == w[0].seq + 1),
        "seq increases by one"
    );

    let notices = env.notices();
    let awake: Vec<bool> = notices
        .iter()
        .filter_map(|n| match n {
            Notice::KeepAwake(on) => Some(*on),
            _ => None,
        })
        .collect();
    assert_eq!(awake, vec![true, false]);
    let editing: Vec<bool> = notices
        .iter()
        .filter_map(|n| match n {
            Notice::EditingActive(on) => Some(*on),
            _ => None,
        })
        .collect();
    assert_eq!(
        editing,
        vec![true, false],
        "queued to completed is one stretch"
    );
    assert!(notices.iter().any(|n| matches!(n, Notice::Notify { title, body } if title == "Edit finished" && body == "Video A is ready for review.")));
    assert!(
        notices
            .iter()
            .any(|n| matches!(n, Notice::RateLimit(info) if info["status"] == "allowed"))
    );
    assert!(notices.iter().any(|n| matches!(n, Notice::LibraryChanged)));
    let states: Vec<JobState> = notices
        .iter()
        .filter_map(|n| match n {
            Notice::JobUpdated(j) => Some(j.state),
            _ => None,
        })
        .fold(Vec::new(), |mut acc, s| {
            if acc.last() != Some(&s) {
                acc.push(s);
            }
            acc
        });
    assert_eq!(
        states,
        vec![JobState::Queued, JobState::Running, JobState::Completed]
    );
    // Log events carry what get_job_log returns.
    let streamed: usize = notices
        .iter()
        .filter_map(|n| match n {
            Notice::JobLog(l) => Some(l.entries.len()),
            _ => None,
        })
        .sum();
    assert_eq!(streamed, log.len());
}

#[test]
fn background_task_after_the_first_result_keeps_the_job_running() {
    let env = Env::new("background");
    env.start("Video A");
    env.wait_log("Video A", "Waiting for a background task: Render final");
    // lastActivity is saved at most every progress interval.
    let deadline = Instant::now() + WAIT;
    loop {
        let activity = env.job("Video A").last_activity.unwrap_or_default();
        if activity == "Waiting for a background task: Render final" {
            break;
        }
        assert!(Instant::now() < deadline, "last activity is {activity:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
    // Many settle times pass while the task runs: the job stays open, stdin stays open.
    std::thread::sleep(timings().settle * 3);
    assert_eq!(env.job("Video A").state, JobState::Running);
    assert!(!env.host.state.join("closed_early").exists());
    env.release("background");
    let job = env.wait_state("Video A", JobState::Completed);
    assert!(
        !env.host.state.join("closed_early").exists(),
        "stdin was closed while the task ran"
    );
    assert_eq!(job.cost_usd, Some(0.30));
    let texts = env.log_texts("Video A");
    assert!(
        texts
            .iter()
            .any(|t| t == "Background task completed: Render final"),
        "{texts:#?}"
    );
}

#[test]
fn pause_then_continue_resumes_the_same_session() {
    let env = Env::new("slow");
    env.start("Video A");
    env.wait_log("Video A", "Bash: Long step");
    let pausing = env.jobs.pause_job(&Env::vid("Video A")).unwrap();
    assert_eq!(pausing.state, JobState::Pausing);
    assert!(pausing.running_since.is_none());
    let paused = env.wait_state("Video A", JobState::Paused);
    let sid = paused.session_id.clone().unwrap();
    assert!(paused.error.is_none() && paused.ended_at.is_none());
    let active_after_pause = paused.active_ms;
    assert!(active_after_pause > 0);
    // The interrupted turn's error result is not shown as an error.
    let log = env.jobs.job_log(&Env::vid("Video A")).unwrap();
    assert!(log.iter().all(|e| e.kind != LogKind::Error), "{log:#?}");
    let (first, stdin) = &env.calls()[0];
    assert_eq!(first["mode"], "new");
    assert!(stdin.contains("\"subtype\":\"interrupt\""));

    // Settings changed in the meantime: the job keeps its own model and effort.
    env.host
        .store
        .update_settings(|s| {
            s.model = Some("haiku".into());
            s.effort = None;
            Ok(())
        })
        .unwrap();
    let queued = env.jobs.continue_job(&Env::vid("Video A")).unwrap();
    assert!(matches!(queued.state, JobState::Queued | JobState::Running));
    let done = env.wait_state("Video A", JobState::Completed);
    assert_eq!(done.session_id.as_deref(), Some(sid.as_str()));
    assert!(done.active_ms >= active_after_pause);
    let calls = env.calls();
    assert_eq!(calls.len(), 2);
    let (second, stdin) = &calls[1];
    assert_eq!(second["mode"], "resume");
    assert_eq!(second["sid"], sid);
    assert!(second["args"].contains("--model opus --effort high --resume"));
    let message = Env::message_of(stdin);
    assert!(
        message.starts_with("Continue the video edit from where it was paused."),
        "{message}"
    );
    assert!(message.ends_with("and were not marked yet."), "{message}");
}

#[test]
fn stop_ends_the_whole_process_tree() {
    let env = Env::new("tree");
    env.start("Video A");
    env.wait_file(&env.host.state.join("tree.ready"));
    let pids: Vec<u32> = fs::read_to_string(env.host.state.join("tree.pids"))
        .unwrap()
        .lines()
        .map(|l| l.trim().parse().unwrap())
        .collect();
    assert_eq!(pids.len(), 3);
    assert!(pids.iter().all(|p| alive(*p)));
    // Let the driver register the tree, then stop.
    env.wait_state("Video A", JobState::Running);
    let stopping = env.jobs.stop_job(&Env::vid("Video A")).unwrap();
    assert_eq!(stopping.state, JobState::Stopping);
    let stopped = env.wait_state("Video A", JobState::Stopped);
    assert!(stopped.ended_at.is_some());
    let left: Vec<u32> = pids.iter().copied().filter(|p| alive(*p)).collect();
    assert!(left.is_empty(), "still running: {left:?}");
    assert!(
        env.log_texts("Video A")
            .iter()
            .any(|t| t == "Stopped. The working files are kept.")
    );
    // A stopped job offers Start again, which begins a new session.
    env.scenario("complete");
    env.start("Video A");
    let done = env.wait_state("Video A", JobState::Completed);
    assert_ne!(done.session_id, stopped.session_id);
    assert_eq!(env.calls()[1].0["mode"], "new");
}

#[test]
fn failure_without_output_then_continue_after_failure() {
    let env = Env::new("no_output");
    env.start("Video A");
    let failed = env.wait_state("Video A", JobState::Failed);
    assert_eq!(
        failed.error.as_deref(),
        Some("Claude finished without creating a review project.")
    );
    assert!(env.jobs.wait_until_idle(WAIT));
    assert!(
        env.notices()
            .iter()
            .any(|n| matches!(n, Notice::Notify { title, .. } if title == "Edit needs attention"))
    );
    env.jobs.continue_job(&Env::vid("Video A")).unwrap();
    let done = env.wait_state("Video A", JobState::Completed);
    assert!(done.error.is_none());
    assert_eq!(done.session_id, failed.session_id);
    let calls = env.calls();
    assert_eq!(calls[1].0["mode"], "resume");
    let message = Env::message_of(&calls[1].1);
    assert!(message.contains(
        "Work until the review output is complete. The last attempt ended without a review project file in the output folder."
    ));
}

#[test]
fn usage_limit_is_reported_with_the_reset_time() {
    let env = Env::new("usage_limit");
    env.start("Video A");
    let failed = env.wait_state("Video A", JobState::Failed);
    let error = failed.error.unwrap();
    assert!(
        error.starts_with("Claude usage limit reached, resets "),
        "{error}"
    );
    assert!(
        env.notices()
            .iter()
            .any(|n| matches!(n, Notice::RateLimit(info) if info["status"] == "rejected"))
    );
}

#[test]
fn a_re_edit_copies_the_output_to_a_backup_first() {
    let env = Env::new("complete");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let video = env.video_dir("Video A");
    let v1 = format!("Video A_v1.{}", review_extension());
    assert!(video.join("output").join(&v1).is_file());
    assert!(
        !video.join("backup-output-1").exists(),
        "an edit takes no backup"
    );
    for n in 1..=2 {
        env.jobs.re_edit(&Env::vid("Video A"), "Shorter.").unwrap();
        env.wait_state("Video A", JobState::Completed);
        env.wait_log(
            "Video A",
            &format!("Copied the output folder to backup-output-{n}"),
        );
        assert!(video.join(format!("backup-output-{n}")).join(&v1).is_file());
    }
    // The first backup holds the output as it was before the first re-edit.
    assert!(
        !video
            .join("backup-output-1")
            .join(format!("Video A_v2.{}", review_extension()))
            .exists()
    );
    assert!(
        video
            .join("backup-output-2")
            .join(format!("Video A_v2.{}", review_extension()))
            .is_file()
    );
    assert!(
        video
            .join("output")
            .join(format!("Video A_v3.{}", review_extension()))
            .is_file()
    );
}

#[test]
fn a_model_error_without_retries_fails_at_once() {
    let env = Env::new("model_error");
    env.start("Video A");
    let failed = env.wait_state("Video A", JobState::Failed);
    let error = failed.error.unwrap();
    assert!(
        error.starts_with("Claude Code reported an error: API Error: 529"),
        "{error}"
    );
    assert!(env.jobs.wait_until_idle(WAIT));
    assert_eq!(env.calls().len(), 1);
}

#[test]
fn a_model_error_is_retried_in_the_same_session_until_it_works() {
    let env = Env::new("model_error");
    env.retries(5);
    env.start("Video A");
    let done = env.wait_state("Video A", JobState::Completed);
    assert_eq!(done.error, None);
    let log = env.log_texts("Video A");
    // The waits are shortened in tests, so only the shape of the lines is checked here.
    for n in [1, 2] {
        let line = format!("(retry {n} of 5)");
        assert!(
            log.iter().any(
                |t| t.starts_with("Model error (529 Overloaded). Retrying in ")
                    && t.ends_with(&line)
            ),
            "{line}: {log:#?}"
        );
    }
    assert!(env.jobs.wait_until_idle(WAIT));
    let calls = env.calls();
    assert_eq!(calls.len(), 3, "one process per attempt");
    // Like Continue Editing: the retries resume the first session with a continue message.
    assert_eq!(calls[1].0["mode"], "resume");
    assert_eq!(calls[1].0["sid"], calls[0].0["sid"]);
    assert!(Env::message_of(&calls[1].1).starts_with("Continue the video edit"));
}

#[test]
fn retries_run_out_and_the_job_fails_saying_so() {
    let env = Env::new("model_error");
    fs::write(env.host.state.join("model_errors"), "10").unwrap();
    env.retries(2);
    env.start("Video A");
    let failed = env.wait_state("Video A", JobState::Failed);
    let error = failed.error.unwrap();
    assert!(error.contains("API Error: 529"), "{error}");
    assert!(
        error.ends_with("VidAI retried 2 times without success."),
        "{error}"
    );
    assert!(env.jobs.wait_until_idle(WAIT));
    assert_eq!(env.calls().len(), 3);
}

#[test]
fn a_waiting_retry_shows_when_holds_its_slot_and_can_be_paused() {
    let slow = Timings {
        retry_second: Duration::from_secs(1),
        ..timings()
    };
    let env = Env::build("model_error", &["Video A", "Video B"], 1, 0, slow);
    env.retries(5);
    env.start("Video A");
    env.wait_log("Video A", "Retrying in 30 seconds (retry 1 of 5)");
    let waiting = env.job("Video A");
    assert_eq!(waiting.state, JobState::Running);
    let activity = waiting.last_activity.unwrap();
    assert!(
        activity.starts_with("Model error. Retrying at ") && activity.ends_with("(retry 1 of 5)"),
        "{activity}"
    );
    // The waiting job keeps its slot: the next video stays queued.
    env.start("Video B");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(env.job("Video B").state, JobState::Queued);
    // Pause works during the wait, and frees the slot.
    env.jobs.pause_job(&Env::vid("Video A")).unwrap();
    env.wait_state("Video A", JobState::Paused);
    env.wait_state("Video B", JobState::Running);
    env.jobs.stop_job(&Env::vid("Video B")).unwrap();
    env.wait_state("Video B", JobState::Stopped);
    assert!(env.jobs.wait_until_idle(WAIT));
}

#[test]
fn a_quiet_usage_limit_waits_for_its_reset_and_retries() {
    let env = Env::new("quiet_limit");
    env.retries(1);
    env.start("Video A");
    env.wait_log("Video A", "(retry 1 of 1)");
    let waiting = env.job("Video A");
    assert_eq!(waiting.state, JobState::Running);
    env.jobs.stop_job(&Env::vid("Video A")).unwrap();
    env.wait_state("Video A", JobState::Stopped);
    assert!(env.jobs.wait_until_idle(WAIT));
}

#[test]
fn a_lost_login_is_reported_and_forgets_the_login_check() {
    let env = Env::new("logged_out");
    env.start("Video A");
    let failed = env.wait_state("Video A", JobState::Failed);
    assert_eq!(
        failed.error.as_deref(),
        Some(
            "Claude Code is logged out. Log in again (Settings, System), then press Continue Editing."
        )
    );
    assert!(env.notices().iter().any(|n| matches!(n, Notice::LoginLost)));
    // Other failures keep the login check.
    let env = Env::new("crash");
    env.start("Video A");
    env.wait_state("Video A", JobState::Failed);
    assert!(!env.notices().iter().any(|n| matches!(n, Notice::LoginLost)));
}

#[test]
fn crash_reports_the_last_stderr_line() {
    let env = Env::new("crash");
    env.start("Video A");
    let failed = env.wait_state("Video A", JobState::Failed);
    assert_eq!(
        failed.error.as_deref(),
        Some("Claude Code stopped unexpectedly (exit code 2): Error: boom")
    );
}

fn seed_edited_video(env: &Env, session: Option<&str>) {
    let out = env.video_dir("Video A").join("output");
    fs::create_dir_all(&out).unwrap();
    fs::write(out.join("Video A_v1.fcpxml"), "").unwrap();
    let old = filetime_past(&out.join("Video A_v1.fcpxml"));
    assert!(old);
    let job = JobView {
        id: "old-job".into(),
        video_id: Env::vid("Video A"),
        kind: JobKind::Edit,
        state: JobState::Completed,
        session_id: session.map(Into::into),
        toolkit: ToolkitKind::Standard,
        model: None,
        effort: None,
        video_type: VideoType::Long,
        created_at: "2026-11-01T10:00:00.000Z".into(),
        started_at: Some("2026-11-01T10:00:00.000Z".into()),
        ended_at: Some("2026-11-01T11:00:00.000Z".into()),
        active_ms: 1000,
        running_since: None,
        last_activity: None,
        error: None,
        cost_usd: None,
        progress: None,
        starts_at: None,
        setup: Setup::ClaudeSubscription,
        harness: None,
    };
    env.host
        .store
        .update_video(&Env::vid("Video A"), |v| {
            v.latest_job = Some(job);
            v.inputs = VideoInputs {
                product_links: "https://shop.example/1".into(),
                notes: String::new(),
                ..VideoInputs::default()
            };
            Ok(())
        })
        .unwrap();
    let entry = vidai_lib::model::LogEntry {
        seq: 1,
        ts: "2026-11-01T10:00:00.000Z".into(),
        kind: LogKind::Status,
        text: "old".into(),
        detail: None,
        nested: false,
    };
    env.host.store.append_log("old-job", &[entry]).unwrap();
    assert!(env.host.store.log_path("old-job").unwrap().exists());
}

/// Moves a file's modification time an hour into the past (std only, works on every platform).
fn filetime_past(path: &Path) -> bool {
    let past = SystemTime::now() - Duration::from_secs(3600);
    fs::File::options()
        .write(true)
        .open(path)
        .and_then(|f| f.set_modified(past))
        .is_ok()
}

#[test]
fn re_edit_falls_back_to_a_new_session_when_the_old_one_is_gone() {
    let env = Env::new("resume_missing");
    seed_edited_video(&env, Some("gone-session"));
    let job = env
        .jobs
        .re_edit(&Env::vid("Video A"), "Make the intro shorter.")
        .unwrap();
    assert_eq!(job.kind, JobKind::ReEdit);
    let done = env.wait_state("Video A", JobState::Completed);
    let calls = env.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].0["mode"], "resume");
    assert_eq!(calls[0].0["sid"], "gone-session");
    assert_eq!(
        Env::message_of(&calls[0].1).lines().next(),
        Some("RE-EDIT REQUEST. I reviewed the edit and want these changes:")
    );
    assert_eq!(calls[1].0["mode"], "new");
    let new_sid = done.session_id.clone().unwrap();
    assert_eq!(calls[1].0["sid"], new_sid);
    assert_ne!(new_sid, "gone-session");
    let message = Env::message_of(&calls[1].1);
    assert!(message.starts_with("MAIN_FOLDER = Video A\n"), "{message}");
    assert!(message.contains(
        "the current review project is output/Video A_v1.fcpxml. Build on that work instead of starting over.\n\nRE-EDIT REQUEST."
    ));
    assert!(message.contains("Make the intro shorter."));
    assert!(
        env.log_texts("Video A")
            .iter()
            .any(|t| t.starts_with("Claude Code no longer has the earlier session"))
    );
    // The old job and its log are gone: only the latest job per video is kept.
    assert!(!env.host.store.log_path("old-job").unwrap().exists());
}

#[test]
fn render_and_re_edit_need_a_new_output_file() {
    let env = Env::new("complete");
    seed_edited_video(&env, Some("existing"));
    fs::write(env.host.state.join("session.existing"), "Tech\nVideo A\n").unwrap();
    env.jobs
        .render_final(
            &Env::vid("Video A"),
            RenderFinalRequest {
                timeline_export_path: Some(" /tmp/export.fcpxml ".into()),
                notes: String::new(),
            },
        )
        .unwrap();
    // The fake writes a review project, not a final render.
    let failed = env.wait_state("Video A", JobState::Failed);
    assert_eq!(
        failed.error.as_deref(),
        Some("Claude finished without creating a final render.")
    );
    let message = Env::message_of(&env.calls()[0].1);
    assert!(message.contains("exported it to: /tmp/export.fcpxml. Use that export"));
    // Re-edit: the new review project counts.
    env.jobs.re_edit(&Env::vid("Video A"), "Brighter.").unwrap();
    let done = env.wait_state("Video A", JobState::Completed);
    assert_eq!(done.session_id.as_deref(), Some("existing"));
}

#[test]
fn concurrency_limit_and_fifo_queue() {
    let names = ["V1", "V2", "V3", "V4"];
    let env = Env::with_videos("hold", &names, 2);
    for n in names {
        env.start(n);
    }
    env.wait_file(&env.host.state.join("started.V1"));
    env.wait_file(&env.host.state.join("started.V2"));
    assert_eq!(env.job("V3").state, JobState::Queued);
    assert_eq!(env.job("V4").state, JobState::Queued);
    assert_eq!(
        env.jobs.queued_videos(),
        vec![Env::vid("V3"), Env::vid("V4")]
    );
    // A queued job can be stopped right away.
    let stopped = env.jobs.stop_job(&Env::vid("V4")).unwrap();
    assert_eq!(stopped.state, JobState::Stopped);
    // Starting again puts it at the back of the queue.
    env.start("V4");
    assert_eq!(
        env.jobs.queued_videos(),
        vec![Env::vid("V3"), Env::vid("V4")]
    );
    // Raising the limit takes effect at the next slot decision.
    env.host
        .store
        .update_settings(|s| {
            s.max_concurrent_edits = 3;
            Ok(())
        })
        .unwrap();
    env.release("V2");
    env.wait_state("V2", JobState::Completed);
    env.wait_file(&env.host.state.join("started.V3"));
    env.wait_file(&env.host.state.join("started.V4"));
    assert!(
        env.job("V3").started_at <= env.job("V4").started_at,
        "first in, first out"
    );
    for n in ["V1", "V3", "V4"] {
        env.release(n);
    }
    for n in ["V1", "V3", "V4"] {
        env.wait_state(n, JobState::Completed);
    }
    assert!(env.jobs.wait_until_idle(WAIT));
}

#[test]
fn raising_the_limit_starts_queued_jobs_at_once() {
    let names = ["R1", "R2", "R3"];
    let env = Env::with_videos("hold", &names, 1);
    for n in names {
        env.start(n);
    }
    env.wait_file(&env.host.state.join("started.R1"));
    assert_eq!(env.job("R2").state, JobState::Queued);
    env.host
        .store
        .update_settings(|s| {
            s.max_concurrent_edits = 3;
            Ok(())
        })
        .unwrap();
    // No job event happens in between: the settings change alone starts the queue.
    env.jobs.settings_changed();
    env.wait_file(&env.host.state.join("started.R2"));
    env.wait_file(&env.host.state.join("started.R3"));
    assert!(env.jobs.queued_videos().is_empty());
    for n in names {
        env.release(n);
    }
    for n in names {
        env.wait_state(n, JobState::Completed);
    }
}

#[test]
fn concurrency_never_exceeds_the_limit() {
    let names = ["A1", "A2", "A3"];
    let env = Env::with_videos("hold", &names, 1);
    for n in names {
        env.start(n);
    }
    env.wait_file(&env.host.state.join("started.A1"));
    std::thread::sleep(Duration::from_millis(200));
    assert!(!env.host.state.join("started.A2").exists());
    env.release("A1");
    env.wait_file(&env.host.state.join("started.A2"));
    assert!(!env.host.state.join("started.A3").exists());
    assert_eq!(env.job("A3").state, JobState::Queued);
    env.release("A2");
    env.release("A3");
    env.wait_state("A3", JobState::Completed);
}

#[test]
fn startup_recovery() {
    let env = Env::with_videos("complete", &["R1", "R2", "R3", "R4", "R5"], 3);
    let make = |name: &str, state: JobState, session: Option<&str>| {
        let job = JobView {
            id: format!("job-{name}"),
            video_id: Env::vid(name),
            kind: JobKind::Edit,
            state,
            session_id: session.map(Into::into),
            toolkit: ToolkitKind::Standard,
            model: None,
            effort: None,
            video_type: VideoType::Long,
            created_at: "2026-11-01T10:00:00.000Z".into(),
            started_at: Some("2026-11-01T10:00:00.000Z".into()),
            ended_at: None,
            active_ms: 5000,
            running_since: Some("2026-11-01T10:00:00.000Z".into()),
            last_activity: Some("Bash: Encode".into()),
            error: None,
            cost_usd: None,
            progress: None,
            starts_at: None,
            setup: Setup::ClaudeSubscription,
            harness: None,
        };
        env.host
            .store
            .update_video(&Env::vid(name), |v| {
                v.latest_job = Some(job);
                Ok(())
            })
            .unwrap();
    };
    make("R1", JobState::Running, Some("s1"));
    make("R2", JobState::Pausing, None);
    make("R3", JobState::Queued, Some("s3"));
    make("R4", JobState::Queued, None);
    make("R5", JobState::Completed, Some("s5"));

    env.jobs.recover();

    let r1 = env.job("R1");
    assert_eq!(r1.state, JobState::Paused);
    assert_eq!(r1.running_since, None);
    assert_eq!(r1.active_ms, 5000);
    assert!(env.log_texts("R1")[0].starts_with("VidAI was closed while this job was running"));
    assert_eq!(env.job("R2").state, JobState::Stopped);
    assert!(env.job("R2").ended_at.is_some());
    assert_eq!(env.job("R3").state, JobState::Paused);
    assert!(
        env.jobs.job(&Env::vid("R4")).is_none(),
        "queued without a session is dropped"
    );
    assert_eq!(env.job("R5").state, JobState::Completed);
    // Nothing starts by itself.
    std::thread::sleep(Duration::from_millis(200));
    assert!(env.calls().is_empty());
    assert!(env.jobs.wait_until_idle(Duration::from_millis(10)));
    // A recovered job continues its session.
    env.jobs.continue_job(&Env::vid("R1")).unwrap();
    fs::write(env.host.state.join("session.s1"), "Tech\nR1\n").unwrap();
    env.wait_state("R1", JobState::Completed);
    assert_eq!(env.calls()[0].0["sid"], "s1");
}

#[test]
fn refusals_and_launch_failures() {
    let env = Env::with_videos("complete", &["Video A", "Video B"], 3);
    // Empty channel prompt.
    env.host
        .store
        .update_settings(|s| {
            s.channels[0].long.prompts[0].text = "  ".into();
            Ok(())
        })
        .unwrap();
    let err = env
        .jobs
        .start_edit(&Env::vid("Video A"), VideoInputs::default())
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert!(env.jobs.job(&Env::vid("Video A")).is_none());
    // An empty prompt slot is named in the error; a slot that does not exist is refused.
    let err = env
        .jobs
        .start_edit(
            &Env::vid("Video A"),
            VideoInputs {
                prompt_slot: 1,
                ..VideoInputs::default()
            },
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert!(
        err.message.contains("Long prompt \"Prompt 2\""),
        "{}",
        err.message
    );
    let err = env
        .jobs
        .start_edit(
            &Env::vid("Video A"),
            VideoInputs {
                style_slot: 5,
                ..VideoInputs::default()
            },
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    env.host
        .store
        .update_settings(|s| {
            s.channels[0].long.prompts[0].text = "Edit.".into();
            Ok(())
        })
        .unwrap();
    // Unknown video.
    let err = env
        .jobs
        .start_edit(&Env::vid("Nope"), VideoInputs::default())
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    // Re-edit needs an edited video, continue and pause need the right state.
    let err = env.jobs.re_edit(&Env::vid("Video A"), "x").unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert_eq!(
        env.jobs
            .re_edit(&Env::vid("Video A"), " ")
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    assert_eq!(
        env.jobs
            .continue_job(&Env::vid("Video A"))
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );

    // Claude logged out when the job starts.
    *env.host.not_ready.lock().unwrap() = Some(AppError::claude_not_logged_in());
    env.start("Video A");
    let failed = env.wait_state("Video A", JobState::Failed);
    assert!(
        failed
            .error
            .unwrap()
            .starts_with("Claude Code is logged out.")
    );
    assert!(failed.session_id.is_none());
    *env.host.not_ready.lock().unwrap() = None;

    // One active job per video.
    env.scenario("hold");
    env.start("Video B");
    let err = env
        .jobs
        .start_edit(&Env::vid("Video B"), VideoInputs::default())
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(
        env.jobs
            .continue_job(&Env::vid("Video B"))
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    env.release("Video B");
    env.wait_state("Video B", JobState::Completed);
    assert_eq!(
        env.jobs.pause_job(&Env::vid("Video B")).unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(
        env.jobs.stop_job(&Env::vid("Video B")).unwrap_err().code,
        ErrorCode::Conflict
    );

    // The video folder disappears before the job starts.
    env.scenario("complete");
    fs::remove_dir_all(env.video_dir("Video A")).unwrap();
    env.jobs.continue_job(&Env::vid("Video A")).unwrap();
    let failed = env.wait_state("Video A", JobState::Failed);
    assert!(
        failed
            .error
            .unwrap()
            .starts_with("The video folder is missing")
    );
}

#[test]
fn quit_pauses_running_jobs() {
    let env = Env::with_videos("slow", &["Q1", "Q2"], 1);
    env.start("Q1");
    env.start("Q2");
    env.wait_log("Q1", "Bash: Long step");
    assert_eq!(env.jobs.busy_count(), 2);
    assert!(env.jobs.pause_all_for_quit(WAIT));
    assert!(env.jobs.is_quitting());
    assert_eq!(env.job("Q1").state, JobState::Paused);
    // Queued jobs stay queued (startup recovery handles them) and nothing new starts.
    assert_eq!(env.job("Q2").state, JobState::Queued);
    env.jobs.shutdown();
    let registry = env.host.store.data_dir().join("running-processes.tsv");
    assert_eq!(fs::read_to_string(registry).unwrap_or_default(), "");
    assert_eq!(env.calls().len(), 1);
}

// ----- start delay (SPEC section 6, "Start delay") -----

fn parse_time(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(s)
        .unwrap()
        .with_timezone(&chrono::Utc)
}

/// The engine's ISO 8601 format.
fn iso_at(t: chrono::DateTime<chrono::Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// When the job of `name` started running, plus `offset`.
fn launched(env: &Env, name: &str, offset: Duration) -> String {
    let started = env.job(name).started_at.expect("the job started");
    iso_at(parse_time(&started) + chrono::Duration::from_std(offset).unwrap())
}

impl Env {
    /// Waits until the manager has finished reacting to the latest event (it holds its lock while
    /// it does).
    fn settled(&self) {
        let _ = self.jobs.queued_videos();
    }

    fn set_delay(&self, minutes: u32) {
        self.host
            .store
            .update_settings(|s| {
                s.start_delay_minutes = minutes;
                Ok(())
            })
            .unwrap();
        self.jobs.settings_changed();
    }

    /// Every job-updated event of a video's job, in order.
    fn announced(&self, name: &str) -> Vec<JobView> {
        let id = Self::vid(name);
        self.notices()
            .into_iter()
            .filter_map(|n| match n {
                Notice::JobUpdated(j) if j.video_id == id => Some(*j),
                _ => None,
            })
            .collect()
    }

    /// The `startsAt` values a video's job was announced with, in order, without repeats.
    fn announced_starts(&self, name: &str) -> Vec<Option<String>> {
        let id = Self::vid(name);
        self.notices()
            .iter()
            .filter_map(|n| match n {
                Notice::JobUpdated(j) if j.video_id == id => Some(j.starts_at.clone()),
                _ => None,
            })
            .fold(Vec::new(), |mut acc, s| {
                if acc.last() != Some(&s) {
                    acc.push(s);
                }
                acc
            })
    }
}

#[test]
fn the_next_launch_waits_for_the_start_delay_and_then_starts_by_itself() {
    // One "minute" is 2 s and the delay 3 minutes. What the queued jobs showed is read from their
    // job-updated events, and when they started from their start times, so a slow machine (a
    // test thread that is late to look) cannot change the outcome; only the three starts must
    // happen within one delay.
    let minute = Duration::from_secs(2);
    let delay = minute * 3;
    let names = ["D1", "D2", "D3"];
    let env = Env::with_delay("hold", &names, 3, 3, minute);
    for n in names {
        env.start(n);
    }
    // Nothing held a slot: the first one started at once; the others were queued behind the
    // delay, one more delay for each job ahead.
    assert_eq!(env.announced_starts("D1"), [None]);
    assert!(env.job("D1").started_at.is_some());
    let d2 = env
        .announced("D2")
        .into_iter()
        .find(|j| j.starts_at.is_some())
        .expect("D2 was announced with a start time");
    assert_eq!(d2.state, JobState::Queued);
    assert_eq!(
        d2.last_activity.as_deref(),
        Some("Waiting for the start delay")
    );
    assert_eq!(
        env.announced_starts("D2")[..2],
        [None, Some(launched(&env, "D1", delay))]
    );
    assert_eq!(
        env.announced_starts("D3")[..2],
        [None, Some(launched(&env, "D1", delay * 2))]
    );

    // The delay passes: D2 starts by itself, and the clock restarts for D3.
    env.wait_file(&env.host.state.join("started.D2"));
    env.settled();
    let d2 = env.job("D2");
    assert_eq!(d2.state, JobState::Running);
    assert_eq!(d2.starts_at, None);
    assert!(
        parse_time(d2.started_at.as_deref().unwrap()) >= parse_time(&launched(&env, "D1", delay)),
        "D2 started before the delay passed"
    );
    assert_eq!(
        env.announced_starts("D2"),
        vec![None, Some(launched(&env, "D1", delay)), None],
        "job-updated events carry startsAt"
    );
    assert!(
        env.announced_starts("D3")
            .contains(&Some(launched(&env, "D2", delay)))
    );
    env.wait_file(&env.host.state.join("started.D3"));
    env.settled();
    let d3 = env.job("D3");
    assert_eq!(d3.starts_at, None);
    assert!(
        parse_time(d3.started_at.as_deref().unwrap()) >= parse_time(&launched(&env, "D2", delay)),
        "D3 started before the delay after D2 passed"
    );

    for n in names {
        env.release(n);
        env.wait_state(n, JobState::Completed);
    }
    assert!(env.jobs.wait_until_idle(WAIT));
    assert_eq!(env.calls().len(), 3);
}

#[test]
fn start_now_skips_the_delay_and_needs_a_free_slot() {
    let minute = Duration::from_secs(60);
    let names = ["S1", "S2", "S3"];
    let env = Env::with_delay("hold", &names, 2, 1, minute);
    for n in names {
        env.start(n);
    }
    assert_eq!(env.job("S2").starts_at, Some(launched(&env, "S1", minute)));
    assert_eq!(
        env.job("S3").starts_at,
        Some(launched(&env, "S1", minute * 2))
    );

    // Start now jumps the queue and restarts the clock for the jobs that keep waiting.
    let s3 = env.jobs.start_now(&Env::vid("S3")).unwrap();
    assert_eq!(s3.state, JobState::Running);
    assert_eq!(s3.starts_at, None);
    env.wait_file(&env.host.state.join("started.S3"));
    assert_eq!(env.job("S2").starts_at, Some(launched(&env, "S3", minute)));

    // Both slots are in use now.
    let err = env.jobs.start_now(&Env::vid("S2")).unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(err.message, "All 2 edit slots are in use.");
    assert_eq!(env.job("S2").state, JobState::Queued);
    // A job that is not queued comes back unchanged; a video without a job is not found.
    let s1 = env.job("S1");
    assert_eq!(env.jobs.start_now(&Env::vid("S1")).unwrap(), s1);
    assert_eq!(
        env.jobs.start_now(&Env::vid("Nope")).unwrap_err().code,
        ErrorCode::NotFound
    );

    // S1 ends, but S3 still holds a slot and started less than the delay ago: S2 keeps waiting.
    env.release("S1");
    env.wait_state("S1", JobState::Completed);
    env.settled();
    assert_eq!(env.job("S2").state, JobState::Queued);
    assert_eq!(env.job("S2").starts_at, Some(launched(&env, "S3", minute)));
    let s2 = env.jobs.start_now(&Env::vid("S2")).unwrap();
    assert_eq!(s2.state, JobState::Running);
    for n in ["S2", "S3"] {
        env.release(n);
        env.wait_state(n, JobState::Completed);
    }
}

#[test]
fn the_only_slot_in_use_is_named_as_such() {
    let env = Env::with_delay("hold", &["O1", "O2"], 1, 1, Duration::from_secs(60));
    env.start("O1");
    env.start("O2");
    // O1 just started, so the delay holds O2 as well as the busy slot: it shows when the delay
    // ends, but it cannot start now.
    assert_eq!(
        env.job("O2").starts_at,
        Some(launched(&env, "O1", Duration::from_secs(60)))
    );
    let err = env.jobs.start_now(&Env::vid("O2")).unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(err.message, "The only edit slot is in use.");
    env.release("O1");
    env.release("O2");
    env.wait_state("O2", JobState::Completed);
}

#[test]
fn a_finished_job_releases_the_next_one_at_once() {
    let env = Env::with_delay("hold", &["F1", "F2"], 3, 10, Duration::from_secs(60));
    env.start("F1");
    env.start("F2");
    assert!(env.job("F2").starts_at.is_some());
    env.release("F1");
    env.release("F2");
    // No job holds a slot any more: F2 starts without waiting the ten "minutes".
    let f2 = env.wait_state("F2", JobState::Completed);
    assert_eq!(f2.starts_at, None);
    assert!(env.announced_starts("F2").ends_with(&[None]));
}

#[test]
fn waiting_only_for_a_slot_has_no_starts_at() {
    // The last launch was longer ago than the delay: a full queue is not the delay's doing.
    let minute = Duration::from_millis(100);
    let env = Env::with_delay("hold", &["W1", "W2"], 1, 1, minute);
    env.start("W1");
    env.start("W2");
    // The delay holds W2 for 100 ms; afterwards only the slot does.
    let deadline = Instant::now() + WAIT;
    while env.job("W2").starts_at.is_some() {
        assert!(Instant::now() < deadline, "startsAt was never cleared");
        std::thread::sleep(Duration::from_millis(10));
    }
    let w2 = env.job("W2");
    assert_eq!(w2.state, JobState::Queued);
    assert_eq!(w2.last_activity.as_deref(), Some("Waiting for a free slot"));
    env.release("W1");
    env.release("W2");
    env.wait_state("W2", JobState::Completed);
}

#[test]
fn a_changed_delay_applies_at_once() {
    let minute = Duration::from_secs(60);
    let env = Env::with_delay("hold", &["G1", "G2"], 3, 2, minute);
    env.start("G1");
    env.start("G2");
    assert_eq!(
        env.job("G2").starts_at,
        Some(launched(&env, "G1", minute * 2))
    );
    env.set_delay(5);
    assert_eq!(
        env.job("G2").starts_at,
        Some(launched(&env, "G1", minute * 5))
    );
    assert!(
        env.announced_starts("G2")
            .contains(&Some(launched(&env, "G1", minute * 5)))
    );
    // No delay: G2 starts right away, without any job event.
    env.set_delay(0);
    env.wait_file(&env.host.state.join("started.G2"));
    assert_eq!(env.job("G2").starts_at, None);
    for n in ["G1", "G2"] {
        env.release(n);
        env.wait_state(n, JobState::Completed);
    }
}

#[test]
fn continue_is_not_held_by_the_delay_and_keeps_the_clock() {
    let minute = Duration::from_secs(60);
    let env = Env::with_delay("", &["P", "N1", "N2"], 3, 1, minute);
    fs::write(env.host.state.join("scenario.P"), "live").unwrap();
    fs::write(env.host.state.join("scenario.N1"), "hold").unwrap();
    fs::write(env.host.state.join("scenario.N2"), "hold").unwrap();
    env.start("P");
    env.wait_file(&env.host.state.join("started.P"));
    fs::remove_file(env.host.state.join("started.P")).unwrap();
    env.jobs.pause_job(&Env::vid("P")).unwrap();
    env.wait_state("P", JobState::Paused);
    env.settled();
    // Nothing holds a slot: N1 starts at once although P started less than the delay ago.
    env.start("N1");
    assert_eq!(env.job("N1").state, JobState::Running);
    // Continue does not wait for the delay...
    env.jobs.continue_job(&Env::vid("P")).unwrap();
    assert_eq!(env.job("P").state, JobState::Running);
    assert_eq!(env.job("P").starts_at, None);
    env.wait_file(&env.host.state.join("started.P"));
    // ...and does not restart the clock: N2 waits for one delay after N1.
    env.start("N2");
    assert_eq!(env.job("N2").starts_at, Some(launched(&env, "N1", minute)));
    // A queued job that is stopped leaves the queue at once.
    let stopped = env.jobs.stop_job(&Env::vid("N2")).unwrap();
    assert_eq!(
        (stopped.state, stopped.starts_at),
        (JobState::Stopped, None)
    );
    assert!(env.jobs.queued_videos().is_empty());
    for n in ["P", "N1"] {
        env.release(n);
        env.wait_state(n, JobState::Completed);
    }
}

#[test]
fn the_delay_clock_survives_a_restart() {
    let minute = Duration::from_secs(60);
    let env = Env::with_delay("", &["R1", "R2"], 3, 1, minute);
    fs::write(env.host.state.join("scenario.R1"), "live").unwrap();
    fs::write(env.host.state.join("scenario.R2"), "hold").unwrap();
    env.start("R1");
    env.wait_file(&env.host.state.join("started.R1"));
    fs::remove_file(env.host.state.join("started.R1")).unwrap();
    let first_launch = env.job("R1").started_at.unwrap();
    let saved = fs::read_to_string(env.host.store.data_dir().join("start-delay.json")).unwrap();
    assert!(saved.contains(&first_launch), "{saved}");

    // Quit (R1 is paused) and start again with a new manager on the same data.
    assert!(env.jobs.pause_all_for_quit(WAIT));
    assert_eq!(env.job("R1").state, JobState::Paused);
    let jobs = JobManager::new(
        env.host.clone(),
        Timings {
            start_delay_minute: minute,
            ..timings()
        },
    );
    jobs.recover();
    // Continue runs at once; a new edit then waits for the delay after the launch made before
    // the restart.
    jobs.continue_job(&Env::vid("R1")).unwrap();
    env.wait_file(&env.host.state.join("started.R1"));
    let r2 = jobs
        .start_edit(&Env::vid("R2"), VideoInputs::default())
        .unwrap();
    assert_eq!(r2.state, JobState::Queued);
    assert_eq!(
        r2.starts_at,
        Some(iso_at(
            parse_time(&first_launch) + chrono::Duration::from_std(minute).unwrap()
        ))
    );
    jobs.stop_job(&Env::vid("R2")).unwrap();
    env.release("R1");
    let deadline = Instant::now() + WAIT;
    while jobs.job(&Env::vid("R1")).unwrap().state != JobState::Completed {
        assert!(Instant::now() < deadline, "R1 did not complete");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(jobs.wait_until_idle(WAIT));
}

#[test]
fn a_queued_job_from_before_a_restart_waits_for_nothing() {
    let env = Env::with_delay("slow", &["Q1", "Q2"], 3, 1, Duration::from_secs(60));
    env.start("Q1");
    env.start("Q2");
    assert!(env.job("Q2").starts_at.is_some());
    env.wait_log("Q1", "Bash: Long step");
    assert!(env.jobs.pause_all_for_quit(WAIT));
    let jobs = JobManager::new(env.host.clone(), timings());
    jobs.recover();
    // Q2 never got a session: it is dropped. Q1 is paused and waits for nothing.
    assert!(jobs.job(&Env::vid("Q2")).is_none());
    let q1 = jobs.job(&Env::vid("Q1")).unwrap();
    assert_eq!((q1.state, q1.starts_at), (JobState::Paused, None));
}

// ----- one session per video (SPEC section 6, "One session per video") -----

/// Claude Code's `--continue` (`-c`) picks the latest conversation of the working directory,
/// which every video shares: it must never be used. Every process names exactly one session.
fn assert_never_continue(env: &Env) {
    for (call, _) in env.calls() {
        let args: Vec<&str> = call["args"].split(' ').collect();
        assert!(
            !args.contains(&"--continue") && !args.contains(&"-c"),
            "{}",
            call["args"]
        );
        let sessions = args
            .iter()
            .filter(|a| **a == "--session-id" || **a == "--resume")
            .count();
        assert_eq!(sessions, 1, "exactly one session flag: {}", call["args"]);
    }
}

/// The video folder a fake call worked on: its first message names it, or the session it
/// resumed was started for it.
fn video_of_call(env: &Env, call: &HashMap<String, String>, stdin: &str) -> String {
    let message = Env::message_of(stdin);
    if let Some(rest) = message.strip_prefix("MAIN_FOLDER = ") {
        return rest.lines().next().unwrap().to_owned();
    }
    let known = fs::read_to_string(env.host.state.join(format!("session.{}", call["sid"])))
        .expect("a resumed session the fake has seen");
    known.lines().nth(1).unwrap().to_owned()
}

#[test]
fn every_video_has_its_own_session_and_process() {
    let names = ["V1", "V2", "V3"];
    let env = Env::with_videos("slow", &names, 3);
    for n in names {
        env.start(n);
    }
    for n in names {
        env.wait_log(n, "Bash: Long step");
    }
    let calls = env.calls();
    assert_eq!(calls.len(), 3, "one claude process per video");
    let mut sids: HashMap<String, String> = HashMap::new();
    for (call, stdin) in &calls {
        assert_eq!(call["mode"], "new");
        sids.insert(video_of_call(&env, call, stdin), call["sid"].clone());
    }
    let distinct: std::collections::HashSet<&String> = sids.values().collect();
    assert_eq!(distinct.len(), 3, "three different sessions: {sids:?}");
    for n in names {
        assert_eq!(env.job(n).session_id.as_ref(), Some(&sids[n]), "{n}");
    }

    // Pause and continue each: each resumes only its own session.
    for n in names {
        env.jobs.pause_job(&Env::vid(n)).unwrap();
    }
    for n in names {
        env.wait_state(n, JobState::Paused);
    }
    for n in names {
        env.jobs.continue_job(&Env::vid(n)).unwrap();
    }
    for n in names {
        let done = env.wait_state(n, JobState::Completed);
        assert_eq!(done.session_id.as_ref(), Some(&sids[n]));
    }
    // Re-edit each: again its own session, and the work lands in its own folder.
    for n in names {
        env.jobs.re_edit(&Env::vid(n), "Shorter.").unwrap();
    }
    for n in names {
        let done = env.wait_state(n, JobState::Completed);
        assert_eq!(done.kind, JobKind::ReEdit);
        assert_eq!(done.session_id.as_ref(), Some(&sids[n]));
        assert!(
            env.video_dir(n)
                .join("output")
                .join(format!("{n}_v2.{}", review_extension()))
                .exists()
        );
    }
    let calls = env.calls();
    assert_eq!(calls.len(), 9);
    for (call, stdin) in &calls[3..] {
        assert_eq!(call["mode"], "resume");
        let video = video_of_call(&env, call, stdin);
        assert_eq!(call["sid"], sids[&video], "{video} resumed another session");
    }
    assert_never_continue(&env);
}

/// A finished edit of `name` with `session` (its review project is an hour old).
fn seed_job(env: &Env, name: &str, session: &str) {
    let out = env.video_dir(name).join("output");
    fs::create_dir_all(&out).unwrap();
    let file = out.join(format!("{name}_v1.fcpxml"));
    fs::write(&file, "").unwrap();
    assert!(filetime_past(&file));
    let job = JobView {
        id: format!("old-{name}"),
        video_id: Env::vid(name),
        kind: JobKind::Edit,
        state: JobState::Completed,
        session_id: Some(session.into()),
        toolkit: ToolkitKind::Standard,
        model: None,
        effort: None,
        video_type: VideoType::Long,
        created_at: "2026-11-01T10:00:00.000Z".into(),
        started_at: Some("2026-11-01T10:00:00.000Z".into()),
        ended_at: Some("2026-11-01T11:00:00.000Z".into()),
        active_ms: 1000,
        running_since: None,
        last_activity: None,
        error: None,
        cost_usd: None,
        progress: None,
        starts_at: None,
        setup: Setup::ClaudeSubscription,
        harness: None,
    };
    env.host
        .store
        .update_video(&Env::vid(name), |v| {
            v.latest_job = Some(job);
            Ok(())
        })
        .unwrap();
}

const SHARED_LINE: &str = "This video's Claude session was also recorded for another video";
const NEW_SESSION_LINE: &str = "This video's Claude session also belongs to another video, so a new session gets the full instructions.";

#[test]
fn a_session_recorded_for_two_videos_is_resumed_by_neither_after_a_restart() {
    let env = Env::with_videos("complete", &["A", "B", "C"], 3);
    seed_job(&env, "A", "dup");
    seed_job(&env, "B", "dup");
    seed_job(&env, "C", "own");
    env.jobs.recover();
    for n in ["A", "B"] {
        assert_eq!(env.job(n).session_id, None, "{n}");
        assert!(
            env.log_texts(n).iter().any(|t| t.starts_with(SHARED_LINE)),
            "{n}"
        );
    }
    assert_eq!(env.job("C").session_id.as_deref(), Some("own"));
    assert!(env.log_texts("C").is_empty());

    // A re-edit of each: A and B start brand new sessions with the full instructions.
    fs::write(env.host.state.join("session.own"), "Tech\nC\n").unwrap();
    for n in ["A", "B", "C"] {
        env.jobs.re_edit(&Env::vid(n), "Brighter.").unwrap();
        env.wait_state(n, JobState::Completed);
    }
    let calls = env.calls();
    assert_eq!(calls.len(), 3);
    let mut new_sids = Vec::new();
    for (call, stdin) in &calls {
        let video = video_of_call(&env, call, stdin);
        if video == "C" {
            assert_eq!(
                (call["mode"].as_str(), call["sid"].as_str()),
                ("resume", "own")
            );
            continue;
        }
        assert_eq!(call["mode"], "new", "{video}");
        assert_ne!(call["sid"], "dup");
        assert_eq!(env.job(&video).session_id.as_ref(), Some(&call["sid"]));
        let message = Env::message_of(stdin);
        assert!(message.starts_with(&format!("MAIN_FOLDER = {video}\n")));
        assert!(message.contains("RE-EDIT REQUEST."));
        new_sids.push(call["sid"].clone());
    }
    assert_eq!(new_sids.len(), 2);
    assert_ne!(new_sids[0], new_sids[1]);
    assert_never_continue(&env);
}

#[test]
fn a_session_of_another_video_is_never_resumed() {
    let env = Env::with_videos("", &["A", "B", "C", "D"], 4);
    fs::write(env.host.state.join("scenario.A"), "hold").unwrap();
    env.start("A");
    env.wait_file(&env.host.state.join("started.A"));
    let running = env.job("A").session_id.unwrap();
    // B's state says it had the session A is running on right now (state.json copied or edited).
    seed_job(&env, "B", &running);
    env.jobs.re_edit(&Env::vid("B"), "Brighter.").unwrap();
    let b = env.wait_state("B", JobState::Completed);
    assert_ne!(b.session_id.as_ref(), Some(&running));
    assert!(env.log_texts("B").iter().any(|t| t == NEW_SESSION_LINE));
    // A keeps running on its own session.
    assert_eq!(env.job("A").state, JobState::Running);
    assert_eq!(env.job("A").session_id.as_ref(), Some(&running));
    assert!(
        !env.log_texts("A")
            .iter()
            .any(|t| t.starts_with(SHARED_LINE))
    );

    // Two finished videos with the same session: the one that runs first gets a new session,
    // and the other one forgets the shared session too.
    seed_job(&env, "C", "dup");
    seed_job(&env, "D", "dup");
    env.jobs.re_edit(&Env::vid("C"), "Brighter.").unwrap();
    let c = env.wait_state("C", JobState::Completed);
    assert_ne!(c.session_id.as_deref(), Some("dup"));
    assert!(env.log_texts("C").iter().any(|t| t == NEW_SESSION_LINE));
    assert_eq!(env.job("D").session_id, None);
    assert!(
        env.log_texts("D")
            .iter()
            .any(|t| t.starts_with(SHARED_LINE))
    );

    let calls = env.calls();
    let sids: Vec<&str> = calls.iter().map(|(c, _)| c["sid"].as_str()).collect();
    assert_eq!(
        calls.len(),
        3,
        "nothing was spawned on a shared session: {sids:?}"
    );
    assert_eq!(sids.iter().filter(|s| **s == running).count(), 1);
    assert!(!sids.contains(&"dup"));
    for (call, _) in &calls {
        assert_eq!(call["mode"], "new");
    }
    env.release("A");
    env.wait_state("A", JobState::Completed);
    assert_never_continue(&env);
}

#[test]
fn a_new_edit_never_reuses_a_session() {
    let env = Env::with_videos("complete", &["E1", "E2"], 3);
    let mut seen = std::collections::HashSet::new();
    for round in 0..3 {
        for n in ["E1", "E2"] {
            env.start(n);
        }
        for n in ["E1", "E2"] {
            let done = env.wait_state(n, JobState::Completed);
            assert!(
                seen.insert(done.session_id.clone().unwrap()),
                "round {round}: {n} reused a session"
            );
        }
    }
    assert!(env.calls().iter().all(|(c, _)| c["mode"] == "new"));
    assert_never_continue(&env);
}

#[test]
fn a_settings_change_always_asks_for_a_rescan() {
    // A changed limit can add or remove Start now for a job the start delay holds without
    // changing any job, so the library must be looked at again (the rescan announces
    // library-changed only when the result differs).
    let env = Env::new("complete");
    let before = env.notices().len();
    env.jobs.settings_changed();
    assert!(
        env.notices()[before..]
            .iter()
            .any(|n| matches!(n, Notice::LibraryChanged)),
        "settings_changed did not ask for a rescan"
    );
}

// ---------------------------------------------------------------------------------------------
// OpenCode (SPEC section 7a)
// ---------------------------------------------------------------------------------------------

fn assert_on_opencode(call: &HashMap<String, String>, model: &str) {
    assert_eq!(call["ANTHROPIC_BASE_URL"], OPENCODE_URL);
    assert_eq!(call["ANTHROPIC_API_KEY"], OPENCODE_KEY);
    assert_eq!(call["ANTHROPIC_AUTH_TOKEN"], "<unset>");
    for alias in &OPENCODE_VARS[2..] {
        assert_eq!(call[*alias], model, "{alias}");
    }
    let args = &call["args"];
    assert!(args.contains(&format!("--model {model}")), "{args}");
    assert!(!args.contains("--effort"), "{args}");
    assert!(!args.contains(OPENCODE_KEY), "the key is never an argument");
}

fn assert_on_claude(call: &HashMap<String, String>) {
    for var in OPENCODE_VARS {
        assert_eq!(call[var], "<unset>", "{var}");
    }
    assert!(
        call["args"].contains("--model opus --effort high"),
        "{}",
        call["args"]
    );
}

#[test]
fn a_job_on_opencode_gets_the_five_variables_and_the_model() {
    let env = Env::new("complete");
    env.use_anthropic_api("glm-5.3");
    let job = env.start("Video A");
    assert_eq!(job.setup, Setup::AnthropicApi);
    assert_eq!(job.model.as_deref(), Some("glm-5.3"));
    assert_eq!(job.effort, None);
    env.wait_state("Video A", JobState::Completed);
    let calls = env.calls();
    assert_on_opencode(&calls[0].0, "glm-5.3");
    assert!(
        env.log_texts("Video A").iter().any(|t| t
            == "Started a new Claude Code session on Anthropic Compatible API (model glm-5.3)")
    );
}

#[test]
fn an_effort_remembered_for_the_model_is_sent_to_claude_code_on_opencode() {
    let env = Env::new("complete");
    env.use_anthropic_api("glm-5.3");
    env.set_api_effort(ApiOption::AnthropicApi, "glm-5.3", "high");
    env.set_api_effort(ApiOption::AnthropicApi, "kimi-k3", "low");
    let job = env.start("Video A");
    assert_eq!(job.effort.as_deref(), Some("high"));
    env.wait_state("Video A", JobState::Completed);
    let args = &env.calls()[0].0["args"];
    assert!(args.contains("--model glm-5.3 --effort high"), "{args}");
}

#[test]
fn a_job_on_the_claude_subscription_gets_none_of_them() {
    let env = Env::new("complete");
    let job = env.start("Video A");
    assert_eq!(job.setup, Setup::ClaudeSubscription);
    env.wait_state("Video A", JobState::Completed);
    assert_on_claude(&env.calls()[0].0);
}

#[test]
fn a_job_on_opencode_needs_no_claude_login() {
    let env = Env::new("complete");
    env.use_anthropic_api("glm-5.3");
    *env.host.not_ready.lock().unwrap() = Some(AppError::new(
        ErrorCode::ClaudeNotLoggedIn,
        "Claude Code is not logged in.",
    ));
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    assert!(!env.notices().iter().any(|n| matches!(n, Notice::LoginLost)));
}

#[test]
fn the_key_reaches_a_job_on_opencode_and_never_a_log_or_the_state() {
    let env = Env::new("echo_key");
    env.use_anthropic_api("kimi-k3");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let (call, stdin) = &env.calls()[0];
    assert_on_opencode(call, "kimi-k3");
    assert!(!stdin.contains(OPENCODE_KEY));

    let log = serde_json::to_string(&env.jobs.job_log(&Env::vid("Video A")).unwrap()).unwrap();
    assert!(!log.contains(OPENCODE_KEY), "{log}");
    assert!(log.contains("token [api key]"), "{log}");
    let raw = fs::read_to_string(env.host.store.log_path(&env.job("Video A").id).unwrap()).unwrap();
    assert!(!raw.contains(OPENCODE_KEY));
    let state = fs::read_to_string(env.host.store.data_dir().join("state.json")).unwrap();
    assert!(!state.contains(OPENCODE_KEY), "{state}");
    let settings = fs::read_to_string(env.host.store.data_dir().join("settings.json")).unwrap();
    assert!(!settings.contains(OPENCODE_KEY));
    for notice in env.notices() {
        let text = format!("{notice:?}");
        assert!(!text.contains(OPENCODE_KEY), "{text}");
    }
}

#[test]
fn a_re_edit_stays_on_the_provider_and_model_of_its_session() {
    let env = Env::new("complete");
    env.use_anthropic_api("glm-5.3");
    env.start("Video A");
    let edit = env.wait_state("Video A", JobState::Completed);
    // The user switches back to the Claude subscription and picks another OpenCode model.
    env.select(Setup::ClaudeSubscription);
    env.host
        .store
        .update_settings(|s| {
            s.api_options.anthropic_api.model = Some("kimi-k3".into());
            Ok(())
        })
        .unwrap();
    let re_edit = env
        .jobs
        .re_edit(&Env::vid("Video A"), "Shorter intro.")
        .unwrap();
    assert_eq!(re_edit.setup, Setup::AnthropicApi);
    assert_eq!(re_edit.model.as_deref(), Some("glm-5.3"));
    let done = env.wait_state("Video A", JobState::Completed);
    assert_eq!(done.session_id, edit.session_id);
    let calls = env.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1].0["mode"], "resume");
    assert_on_opencode(&calls[1].0, "glm-5.3");

    // A new edit follows the current selection.
    let other = Env::new("complete");
    other.use_anthropic_api("glm-5.3");
    other.select(Setup::ClaudeSubscription);
    assert_eq!(other.start("Video A").setup, Setup::ClaudeSubscription);
    other.wait_state("Video A", JobState::Completed);
}

#[test]
fn a_session_on_opencode_go_without_its_key_goes_on_in_a_new_session_on_the_claude_subscription() {
    let env = Env::new("complete");
    env.use_opencode2_program("glm-5.3");
    env.start("Video A");
    let edit = env.wait_state("Video A", JobState::Completed);
    env.select(Setup::ClaudeSubscription);
    env.remove_api_key(ApiOption::OpencodeGo);
    env.jobs
        .re_edit(&Env::vid("Video A"), "Shorter intro.")
        .unwrap();
    let done = env.wait_state("Video A", JobState::Completed);
    assert_eq!(done.setup, Setup::ClaudeSubscription);
    assert_eq!(done.model.as_deref(), Some("opus"));
    assert_eq!(done.effort.as_deref(), Some("high"));
    assert_ne!(done.session_id, edit.session_id);
    let calls = env.calls();
    assert_eq!(calls[0].0["mode"], "new");
    assert_on_claude(&calls[0].0);
    let message = Env::message_of(&calls[0].1);
    assert!(message.starts_with("MAIN_FOLDER = Video A\n"), "{message}");
    assert!(message.contains("Shorter intro."));
    assert!(env.log_texts("Video A").iter().any(|t| t
        == "This video's session ran on OpenCode Go (glm-5.3) in the OpenCode 2 program, which cannot continue it now (No API key is saved for OpenCode Go). A new session on the Claude subscription gets the full instructions."));
}

/// The key of option 3 is optional, so removing it does not end its sessions.
#[test]
fn a_session_on_the_anthropic_api_goes_on_after_its_key_is_removed() {
    let env = Env::new("complete");
    env.use_anthropic_api("glm-5.3");
    env.start("Video A");
    let edit = env.wait_state("Video A", JobState::Completed);
    env.remove_api_key(ApiOption::AnthropicApi);
    env.jobs
        .re_edit(&Env::vid("Video A"), "Shorter intro.")
        .unwrap();
    let done = env.wait_state("Video A", JobState::Completed);
    assert_eq!(done.setup, Setup::AnthropicApi);
    assert_eq!(done.session_id, edit.session_id);
    let calls = env.calls();
    assert_eq!(calls[1].0["ANTHROPIC_AUTH_TOKEN"], "no-key");
    assert_eq!(calls[1].0["ANTHROPIC_API_KEY"], "<unset>");
}

#[test]
fn a_new_edit_on_opencode_go_without_its_key_fails_with_the_reason() {
    let env = Env::new("complete");
    env.use_opencode2_program("glm-5.3");
    env.remove_api_key(ApiOption::OpencodeGo);
    env.start("Video A");
    let failed = env.wait_state("Video A", JobState::Failed);
    assert_eq!(
        failed.error.as_deref(),
        Some(
            "No API key is saved for OpenCode Go. Fix it in Settings, Harness + API Keys, then press Continue Editing."
        )
    );
    assert!(env.calls().is_empty());
    assert!(env.opencode2_calls().is_empty());
}

/// SPEC section 7a, "The key is optional": option 3 without a key still sends its requests to the
/// base URL, on a placeholder token, and never on the user's own login, key or token.
#[test]
fn a_job_on_the_anthropic_api_without_a_key_runs_on_a_placeholder_token() {
    let env = Env::new("complete");
    env.use_anthropic_api_without_key("local-model");
    env.set_env("ANTHROPIC_API_KEY", "the-users-own-key");
    env.set_env("ANTHROPIC_AUTH_TOKEN", "the-users-own-token");
    let job = env.start("Video A");
    assert_eq!(job.setup, Setup::AnthropicApi);
    env.wait_state("Video A", JobState::Completed);
    let calls = env.calls();
    let call = &calls[0].0;
    assert_eq!(call["ANTHROPIC_BASE_URL"], OPENCODE_URL);
    assert_eq!(call["ANTHROPIC_API_KEY"], "<unset>");
    assert_eq!(call["ANTHROPIC_AUTH_TOKEN"], "no-key");
    for alias in &OPENCODE_VARS[2..] {
        assert_eq!(call[*alias], "local-model", "{alias}");
    }
    assert!(
        call["args"].contains("--model local-model"),
        "{}",
        call["args"]
    );
    assert!(env.log_texts("Video A").iter().any(|t| t
        == "Started a new Claude Code session on Anthropic Compatible API (model local-model)"));
}

// ---------------------------------------------------------------------------------------------
// Keeping a job going (SPEC section 6): turns that end before the work is done, as some models on
// OpenCode do, are followed by a message of VidAI's own in the same live session.
// ---------------------------------------------------------------------------------------------

use vidai_lib::jobs::keepgoing::Nudge;
use vidai_lib::jobs::prompt::{KEEP_WORKING, continuation_body};

/// Settle time of the tests that keep jobs going: a turn that ended counts after this long.
const KEEP_SETTLE: Duration = Duration::from_secs(1);

impl Env {
    /// Where the fake ends its turns early (`premature` scenario): after these steps.
    fn stops(&self, steps: &str) {
        fs::write(self.host.state.join("stops"), steps).unwrap();
    }

    /// The `n`-th turn that the fake ended early (from 1).
    fn wait_ended(&self, name: &str, n: u32) {
        self.wait_file(&self.host.state.join(format!("ended.{name}.{n}")));
    }

    /// The states the job went through, without repeats.
    fn states(&self) -> Vec<JobState> {
        self.notices()
            .iter()
            .filter_map(|n| match n {
                Notice::JobUpdated(j) => Some(j.state),
                _ => None,
            })
            .fold(Vec::new(), |mut acc, s| {
                if acc.last() != Some(&s) {
                    acc.push(s);
                }
                acc
            })
    }

    /// Every percent the job published, in order.
    fn percents(&self) -> Vec<u32> {
        self.notices()
            .iter()
            .filter_map(|n| match n {
                Notice::JobUpdated(j) => j.progress.as_ref().map(|p| p.percent),
                _ => None,
            })
            .collect()
    }
}

/// The texts of every user message a call received, in order.
fn user_messages(stdin: &str) -> Vec<String> {
    stdin
        .lines()
        .filter(|l| l.contains("\"type\":\"user\""))
        .map(|l| {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            v["message"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

fn assert_never_failed(env: &Env) {
    let states = env.states();
    assert!(
        !states.contains(&JobState::Failed),
        "the job was failed on the way: {states:?}"
    );
}

fn assert_progress_never_went_back(env: &Env) {
    let percents = env.percents();
    assert!(
        percents.windows(2).all(|w| w[1] >= w[0]),
        "progress went backwards: {percents:?}"
    );
    assert_eq!(percents.last(), Some(&100));
}

fn asked_lines(env: &Env, name: &str) -> Vec<String> {
    env.log_texts(name)
        .into_iter()
        .filter(|t| t.starts_with("Asked to"))
        .collect()
}

#[test]
fn an_edit_that_ends_turns_early_keeps_going_until_it_is_done() {
    let env = Env::keeping_going("premature", KEEP_SETTLE);
    // At the start (a turn without any tool call), in the middle, and after the last step (the
    // review project, thumbnails and meta.txt are there, the marker is not).
    env.stops("0 3 6 9");
    env.start("Video A");
    let done = env.wait_state("Video A", JobState::Completed);
    assert!(env.jobs.wait_until_idle(WAIT));
    assert!(done.error.is_none());
    assert_eq!(
        env.states(),
        vec![JobState::Queued, JobState::Running, JobState::Completed]
    );
    assert_progress_never_went_back(&env);

    // One process, one session: every continuation went to the live process.
    let calls = env.calls();
    assert_eq!(calls.len(), 1);
    let messages = user_messages(&calls[0].1);
    let keep = continuation_body(JobKind::Edit, &Nudge::KeepWorking);
    let finish = continuation_body(
        JobKind::Edit,
        &Nudge::Finish {
            file: format!("Video A_v1.{}", review_extension()),
            extras_missing: false,
        },
    );
    assert_eq!(messages.len(), 5, "{messages:#?}");
    assert!(messages[0].starts_with("MAIN_FOLDER = Video A\n"));
    assert_eq!(&messages[1..], &[keep.clone(), keep.clone(), keep, finish]);
    // A job on the Claude subscription keeps its exact first message.
    assert!(!messages[0].contains(KEEP_WORKING));

    assert_eq!(
        asked_lines(&env, "Video A"),
        vec![
            "Asked to keep going (1): the turn ended before the edit was finished",
            "Asked to keep going (2): the turn ended before the edit was finished",
            "Asked to keep going (3): the turn ended before the edit was finished",
            "Asked to finish the last steps (4): the review project is saved, [OUTPUT COMPLETED] is not written yet",
        ]
    );
    let texts = env.log_texts("Video A");
    assert!(
        !texts.iter().any(|t| t.contains("Claude is finished")),
        "{texts:#?}"
    );
    let log = env.jobs.job_log(&Env::vid("Video A")).unwrap();
    assert!(log.iter().all(|e| e.kind != LogKind::Error), "{log:#?}");
    // The continuation's message is the detail of its status line.
    let first = log
        .iter()
        .find(|e| e.text.starts_with("Asked to keep going (1)"))
        .unwrap();
    assert_eq!(first.kind, LogKind::Status);
    assert!(
        first
            .detail
            .as_deref()
            .unwrap()
            .starts_with("The edit is not finished yet")
    );
}

#[test]
fn a_re_edit_and_a_render_keep_going_too() {
    let env = Env::keeping_going("premature", KEEP_SETTLE);
    seed_edited_video(&env, Some("existing"));
    fs::write(env.host.state.join("session.existing"), "Tech\nVideo A\n").unwrap();
    env.stops("0 1");
    env.jobs.re_edit(&Env::vid("Video A"), "Brighter.").unwrap();
    let done = env.wait_state("Video A", JobState::Completed);
    assert!(env.jobs.wait_until_idle(WAIT));
    assert_eq!(done.kind, JobKind::ReEdit);
    assert_never_failed(&env);
    assert_progress_never_went_back(&env);
    let calls = env.calls();
    assert_eq!(calls.len(), 1);
    let keep = continuation_body(JobKind::ReEdit, &Nudge::KeepWorking);
    assert_eq!(&user_messages(&calls[0].1)[1..], &[keep.clone(), keep]);

    // A render, with a stop right after its first step.
    for f in fs::read_dir(&env.host.state).unwrap().flatten() {
        if f.file_name().to_string_lossy().starts_with("stopped.") {
            fs::remove_file(f.path()).unwrap();
        }
    }
    env.host.notices.lock().unwrap().clear();
    env.stops("1");
    env.jobs
        .render_final(&Env::vid("Video A"), RenderFinalRequest::default())
        .unwrap();
    let done = env.wait_state("Video A", JobState::Completed);
    assert!(env.jobs.wait_until_idle(WAIT));
    assert_eq!(done.kind, JobKind::Render);
    assert_never_failed(&env);
    assert_progress_never_went_back(&env);
    let calls = env.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        &user_messages(&calls[1].1)[1..],
        &[continuation_body(JobKind::Render, &Nudge::KeepWorking)]
    );
    assert_eq!(
        asked_lines(&env, "Video A"),
        vec!["Asked to keep going (1): the turn ended before the final render was finished"]
    );
}

#[test]
fn where_jobs_do_not_keep_going_an_early_end_fails_as_before() {
    let env = Env::new("premature");
    env.stops("3");
    env.start("Video A");
    let failed = env.wait_state("Video A", JobState::Failed);
    assert_eq!(
        failed.error.as_deref(),
        Some("Claude finished without creating a review project.")
    );
    assert_eq!(user_messages(&env.calls()[0].1).len(), 1);
    assert!(
        env.log_texts("Video A")
            .iter()
            .any(|t| t == "Claude is finished, checking the output")
    );
}

#[test]
fn a_model_that_only_talks_is_stuck_after_three_turns() {
    let env = Env::keeping_going("no_output", KEEP_SETTLE);
    env.start("Video A");
    let failed = env.wait_state("Video A", JobState::Failed);
    assert_eq!(
        failed.error.as_deref(),
        Some(
            "The model stopped working on the edit: it ended 3 turns in a row without doing anything. Press Continue Editing to try again."
        )
    );
    let calls = env.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(user_messages(&calls[0].1).len(), 3, "two continuations");
}

#[test]
fn a_busy_model_without_progress_is_stuck_and_continue_starts_counting_again() {
    let env = Env::keeping_going("spin", KEEP_SETTLE);
    env.start("Video A");
    let failed = env.wait_state("Video A", JobState::Failed);
    assert_eq!(
        failed.error.as_deref(),
        Some(
            "The model made no progress on the edit after being asked 8 times to keep going. Press Continue Editing to try again."
        )
    );
    assert!(env.jobs.wait_until_idle(WAIT));
    assert_eq!(user_messages(&env.calls()[0].1).len(), 9);
    // The owner's Continue starts a new run with fresh counters: eight more continuations.
    env.jobs.continue_job(&Env::vid("Video A")).unwrap();
    env.wait_state("Video A", JobState::Running);
    let failed = env.wait_state("Video A", JobState::Failed);
    assert!(
        failed
            .error
            .unwrap()
            .starts_with("The model made no progress")
    );
    let calls = env.calls();
    assert_eq!(calls.len(), 2);
    let messages = user_messages(&calls[1].1);
    assert_eq!(messages.len(), 9);
    assert!(messages[0].starts_with("Continue the video edit from where it was paused."));
}

#[test]
fn an_api_error_stops_at_once_without_a_continuation() {
    for quiet in [false, true] {
        let env = Env::keeping_going("api_error", KEEP_SETTLE);
        env.use_anthropic_api("glm-5.3");
        if quiet {
            fs::write(env.host.state.join("api_error_quiet"), "").unwrap();
        }
        env.start("Video A");
        let failed = env.wait_state("Video A", JobState::Failed);
        let error = failed.error.unwrap();
        assert!(
            error.starts_with("The weekly limit of your OpenCode Go plan"),
            "{error}"
        );
        assert!(env.jobs.wait_until_idle(WAIT));
        let calls = env.calls();
        assert_eq!(calls.len(), 1);
        let messages = user_messages(&calls[0].1);
        assert_eq!(messages.len(), 1, "no continuation after an API error");
        // A job on OpenCode is asked to keep working in its first message.
        assert!(messages[0].contains(KEEP_WORKING));
        assert!(!env.host.state.join("continued_after_error").exists());
        assert!(asked_lines(&env, "Video A").is_empty());
    }
}

#[test]
fn pause_and_stop_right_after_an_early_end_send_no_continuation() {
    for stop in [false, true] {
        // A long settle time: the request comes while VidAI still waits to decide.
        let env = Env::keeping_going("premature", Duration::from_secs(5));
        env.stops("2");
        env.start("Video A");
        env.wait_ended("Video A", 1);
        if stop {
            env.jobs.stop_job(&Env::vid("Video A")).unwrap();
            env.wait_state("Video A", JobState::Stopped);
        } else {
            env.jobs.pause_job(&Env::vid("Video A")).unwrap();
            env.wait_state("Video A", JobState::Paused);
        }
        assert!(env.jobs.wait_until_idle(WAIT));
        std::thread::sleep(Duration::from_secs(1));
        let calls = env.calls();
        assert_eq!(user_messages(&calls[0].1).len(), 1, "no continuation");
        assert!(asked_lines(&env, "Video A").is_empty());
        if !stop {
            // Continue resumes the session and goes on from the next step.
            env.jobs.continue_job(&Env::vid("Video A")).unwrap();
            env.wait_state("Video A", JobState::Completed);
            assert!(env.jobs.wait_until_idle(WAIT));
            assert_never_failed(&env);
            assert_progress_never_went_back(&env);
            assert_eq!(env.calls()[1].0["mode"], "resume");
        }
    }
}

#[test]
fn pause_and_stop_during_a_continued_turn() {
    for stop in [false, true] {
        let env = Env::keeping_going("premature", KEEP_SETTLE);
        env.stops("2");
        fs::write(env.host.state.join("gate.Video A"), "").unwrap();
        env.start("Video A");
        env.wait_file(&env.host.state.join("continued.Video A.1"));
        if stop {
            env.jobs.stop_job(&Env::vid("Video A")).unwrap();
            env.wait_state("Video A", JobState::Stopped);
        } else {
            env.jobs.pause_job(&Env::vid("Video A")).unwrap();
            let paused = env.wait_state("Video A", JobState::Paused);
            assert!(paused.error.is_none());
        }
        assert!(env.jobs.wait_until_idle(WAIT));
        assert_never_failed(&env);
        let calls = env.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(user_messages(&calls[0].1).len(), 2);
        assert!(calls[0].1.contains("\"subtype\":\"interrupt\""));
        // The interrupted turn is not an error.
        let log = env.jobs.job_log(&Env::vid("Video A")).unwrap();
        assert!(log.iter().all(|e| e.kind != LogKind::Error), "{log:#?}");
    }
}

#[test]
fn a_job_recovered_as_paused_never_goes_on_by_itself() {
    let env = Env::keeping_going("premature", KEEP_SETTLE);
    env.stops("2");
    fs::write(env.host.state.join("gate.Video A"), "").unwrap();
    env.start("Video A");
    env.wait_file(&env.host.state.join("continued.Video A.1"));
    // VidAI quits while the continued turn runs.
    assert!(env.jobs.pause_all_for_quit(WAIT));
    env.jobs.shutdown();
    assert_eq!(env.job("Video A").state, JobState::Paused);
    // As if VidAI had crashed instead: state.json says running, the next start recovers it.
    env.host
        .store
        .update_video(&Env::vid("Video A"), |v| {
            v.latest_job.as_mut().unwrap().state = JobState::Running;
            Ok(())
        })
        .unwrap();
    let restarted = JobManager::new(
        env.host.clone(),
        Timings {
            settle: KEEP_SETTLE,
            ..timings()
        },
    );
    restarted.recover();
    assert_eq!(env.job("Video A").state, JobState::Paused);
    std::thread::sleep(KEEP_SETTLE * 4);
    assert_eq!(env.job("Video A").state, JobState::Paused);
    assert_eq!(env.calls().len(), 1, "nothing started by itself");
    // Continue picks it up and finishes it without a failure.
    fs::remove_file(env.host.state.join("gate.Video A")).unwrap();
    env.host.notices.lock().unwrap().clear();
    restarted.continue_job(&Env::vid("Video A")).unwrap();
    env.wait_state("Video A", JobState::Completed);
    assert!(restarted.wait_until_idle(WAIT));
    assert_never_failed(&env);
    assert_progress_never_went_back(&env);
}

//! End-to-end tests of the job engine with the OpenCode 2 program as the program that edits (SPEC
//! section 7a, "The OpenCode 2 program"): the real `JobManager`, driver threads, OpenCode 2
//! servers (`opencode::harness::server2`), process tree handling and log delivery, against the
//! fake OpenCode 2 (tests/support/fake-opencode2.py, which speaks the recorded shapes of the real
//! 2.2.6) and a temporary Editing Folder and data directory. The engine and its helpers are the
//! ones of tests/jobs_engine.rs (tests/support/engine.rs). Nothing here touches the real
//! OpenCode, the network, the keychain or the developer's files.

use std::fs;
use std::time::{Duration, Instant};

mod support;
use support::engine::*;
use vidai_lib::jobs::keepgoing::Nudge;
use vidai_lib::jobs::prompt;
use vidai_lib::model::{ApiOption, Harness, JobKind, JobState, LogKind, RenderFinalRequest, Setup};
use vidai_lib::opencode::harness::events2::QUESTION_CANCELLED;

const MODEL: &str = "glm-5.3";
const GO_ADDRESS: &str = "https://opencode.ai/inference/go/anthropic";

/// An Env whose new edits run on OpenCode in the OpenCode 2 program.
fn program_env(scenario: &str) -> Env {
    let env = Env::new(scenario);
    env.use_opencode2_program(MODEL);
    env
}

/// Like [`program_env`], with jobs that keep themselves going, as on an Apple Silicon Mac.
fn keeping_env(scenario: &str) -> Env {
    let env = Env::keeping_going(scenario, Duration::from_millis(600));
    env.use_opencode2_program(MODEL);
    env
}

fn session_of(env: &Env, name: &str) -> String {
    env.job(name).session_id.expect("a session")
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The messages the fake received for `session`: the session's model, the text and the folder
/// the request named.
fn prompts(env: &Env, session: &str) -> Vec<(serde_json::Value, String, String)> {
    let Ok(text) = fs::read_to_string(env.host.state.join(format!("prompts.{session}"))) else {
        return Vec::new();
    };
    text.lines()
        .map(|l| {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            (
                v["model"].clone(),
                v["text"].as_str().unwrap_or_default().to_owned(),
                v["directory"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect()
}

fn server_pid(env: &Env, n: usize) -> u32 {
    fs::read_to_string(env.host.state.join("opencode2.calls"))
        .unwrap()
        .lines()
        .nth(n)
        .unwrap()
        .parse()
        .unwrap()
}

fn state_files(env: &Env, prefix: &str) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = fs::read_dir(&env.host.state)
        .unwrap()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.strip_prefix(prefix)
                .map(|rest| (rest.to_owned(), fs::read_to_string(e.path()).unwrap()))
        })
        .collect();
    found.sort();
    found
}

#[test]
fn an_edit_runs_to_completion_in_the_opencode2_program() {
    let env = program_env("complete");
    let job = env.start("Video A");
    assert_eq!(job.harness, Some(Harness::Opencode2));
    assert_eq!(job.setup, Setup::OpencodeGo);
    let job = env.wait_state("Video A", JobState::Completed);
    assert_eq!(job.progress.as_ref().map(|p| p.percent), Some(100));
    assert!(job.cost_usd.unwrap_or_default() > 0.0, "{job:?}");
    let session = job.session_id.clone().unwrap();
    assert!(
        session.starts_with("ses_"),
        "OpenCode chose the id: {session}"
    );

    // One server, started as SPEC section 7a says, and no Claude Code.
    assert!(env.calls().is_empty(), "Claude Code was started");
    let calls = env.opencode2_calls();
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    assert_eq!(call["args"], "serve --stdio --hostname 127.0.0.1 --port 0");
    assert_eq!(call["cwd"], env.host.editing.to_string_lossy());
    assert_eq!(call["OPENCODE_API_KEY"], OPENCODE_KEY);
    assert_eq!(call["OPENCODE_SERVER_PASSWORD"], "<set>");
    assert_eq!(call["OPENCODE_PASSWORD"], "<unset>");
    assert_eq!(call["OPENCODE_DISABLE_AUTOUPDATE"], "1");
    for var in OPENCODE_VARS {
        assert_eq!(call[var], "<unset>", "{var} is for Claude Code only");
    }
    let config: serde_json::Value = serde_json::from_str(&call["OPENCODE_CONFIG_CONTENT"]).unwrap();
    assert_eq!(config["snapshots"], false);
    assert_eq!(
        config["instructions"][0],
        env.host
            .editing
            .join("CLAUDE.md")
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(
        config["providers"]["vidai"]["settings"],
        serde_json::json!({ "baseURL": format!("{OPENCODE_URL}/v1"), "apiKey": "{env:OPENCODE_API_KEY}" })
    );
    assert!(!call["OPENCODE_CONFIG_CONTENT"].contains(OPENCODE_KEY));

    // The full instructions, with the OpenCode 2 program's block, to the model of Settings, in
    // the Editing Folder.
    let sent = prompts(&env, &session);
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].0,
        serde_json::json!({ "providerID": "vidai", "id": MODEL })
    );
    assert!(sent[0].1.starts_with("MAIN_FOLDER = Video A\n"));
    assert!(
        sent[0]
            .1
            .contains(&format!("\n\n{}\n\n", prompt::OPENCODE2_PROGRAM))
    );
    assert!(sent[0].1.contains(prompt::KEEP_WORKING));
    assert_eq!(sent[0].2, env.host.editing.to_string_lossy());

    // The log reads like a Claude Code job's, naming OpenCode 2, with the sub-agent nested and
    // waited for in the background.
    let texts = env.log_texts("Video A");
    for line in [
        "Started a new OpenCode 2 session (model glm-5.3)",
        "Sent the edit instructions to OpenCode 2",
        "OpenCode 2 is running (model vidai/glm-5.3)",
        "Bash: ffprobe -v error -show_streams A-roll.mov",
        "Read: MEMORY.md",
        "Agent: Build graphics group A",
        "Sub-agent started in the background: Build graphics group A",
        "Waiting for a background task: Build graphics group A",
        "Sub-agent completed: Build graphics group A",
        "Transcription done",
    ] {
        assert!(
            texts.iter().any(|t| t == line),
            "{line:?} not in {texts:#?}"
        );
    }
    let log = env.jobs.job_log(&Env::vid("Video A")).unwrap();
    assert!(log.iter().any(|e| e.nested
        && e.kind == LogKind::Tool
        && e.text.starts_with("Bash: npx hyperframes render")));
    assert!(log.iter().all(|e| {
        !e.text.contains(OPENCODE_KEY)
            && !e
                .detail
                .as_deref()
                .unwrap_or_default()
                .contains(OPENCODE_KEY)
    }));
    // The server is gone.
    let server = server_pid(&env, 0);
    wait_until("the server to end", || !alive_native(server));
}

#[test]
fn the_go_address_runs_on_opencodes_own_provider_only_with_vidais_key() {
    let env = program_env("complete");
    env.edit_api(ApiOption::OpencodeGo, |api| {
        api.base_url = GO_ADDRESS.into()
    });
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let session = session_of(&env, "Video A");
    assert_eq!(
        prompts(&env, &session)[0].0,
        serde_json::json!({ "providerID": "opencode-go", "id": MODEL })
    );
    assert!(
        env.log_texts("Video A")
            .iter()
            .any(|t| t == "OpenCode 2 is running (model opencode-go/glm-5.3)")
    );

    // Once OpenCode has a login of its own, its provider would not use VidAI's key: the resumed
    // session moves to VidAI's own provider.
    env.set_env("FAKE_OPENCODE2_LOGIN", "stored");
    env.jobs
        .re_edit(&Env::vid("Video A"), "Cut the intro.")
        .unwrap();
    env.wait_state("Video A", JobState::Completed);
    let switched: Vec<(String, serde_json::Value)> = state_files(&env, "model.")
        .into_iter()
        .map(|(s, m)| (s, serde_json::from_str(&m).unwrap()))
        .collect();
    assert_eq!(
        switched,
        vec![(
            session.clone(),
            serde_json::json!({ "providerID": "vidai", "id": MODEL })
        )]
    );
    assert_eq!(
        prompts(&env, &session)[1].0,
        serde_json::json!({ "providerID": "vidai", "id": MODEL })
    );
}

/// SPEC section 7a, `openaiApi`: always VidAI's own provider with the OpenAI compatible package,
/// at the address as given, the key in `VIDAI_API_KEY` and nowhere else.
#[test]
fn an_openai_edit_runs_on_vidais_provider_with_its_own_key_variable() {
    for address in [
        "http://127.0.0.1:9/v1",
        // The Go address of OpenCode's own provider is not used either.
        "https://opencode.ai/inference/go/v1",
    ] {
        let env = Env::new("complete");
        env.use_opencode2_openai(MODEL);
        env.edit_api(ApiOption::OpenaiApi, |api| api.base_url = address.into());
        // A login stored in OpenCode and keys of the user's own change nothing.
        env.set_env("FAKE_OPENCODE2_LOGIN", "stored");
        env.set_env("VIDAI_API_KEY", "the-users-own-key");
        env.set_env("OPENCODE_API_KEY", "the-users-own-opencode-key");
        env.start("Video A");
        let job = env.wait_state("Video A", JobState::Completed);
        assert_eq!(job.setup, Setup::OpenaiApi);
        assert_eq!(job.harness(), Harness::Opencode2);
        let session = session_of(&env, "Video A");
        assert_eq!(
            prompts(&env, &session)[0].0,
            serde_json::json!({ "providerID": "vidai", "id": MODEL }),
            "{address}"
        );
        let call = &env.opencode2_calls()[0];
        assert_eq!(call["VIDAI_API_KEY"], OPENCODE_KEY);
        assert_eq!(call["OPENCODE_API_KEY"], "<unset>");
        assert_eq!(call["ANTHROPIC_BASE_URL"], "<unset>");
        let config: serde_json::Value =
            serde_json::from_str(&call["OPENCODE_CONFIG_CONTENT"]).unwrap();
        assert_eq!(
            config["providers"],
            serde_json::json!({
                "vidai": {
                    "name": "OpenAI Compatible API (VidAI)",
                    "package": "@ai-sdk/openai-compatible",
                    "settings": { "baseURL": address, "apiKey": "{env:VIDAI_API_KEY}" },
                    "models": { MODEL: { "name": MODEL } },
                }
            })
        );
        // The key itself is in the environment only: not in the arguments, the configuration or
        // any file the run left in the state folder.
        for (name, text) in [
            ("args", &call["args"]),
            ("config", &call["OPENCODE_CONFIG_CONTENT"]),
        ] {
            assert!(!text.contains(OPENCODE_KEY), "{name}: {text}");
        }
        let log = env.log_texts("Video A");
        assert!(log.iter().any(|t| t.contains("vidai/glm-5.3")), "{log:#?}");
    }
}

/// SPEC section 7a, "The key is optional": option 4 without a key starts its server with no key
/// anywhere (not in `VIDAI_API_KEY`, not as `apiKey` in the configuration) and none of the
/// user's own.
#[test]
fn an_openai_edit_without_a_key_starts_with_no_key_at_all() {
    let env = Env::new("complete");
    env.use_opencode2_openai_without_key(MODEL);
    env.edit_api(ApiOption::OpenaiApi, |api| {
        api.base_url = "http://127.0.0.1:9/v1".into();
    });
    env.set_env("VIDAI_API_KEY", "the-users-own-key");
    env.set_env("OPENCODE_API_KEY", "the-users-own-opencode-key");
    env.start("Video A");
    let job = env.wait_state("Video A", JobState::Completed);
    assert_eq!(job.setup, Setup::OpenaiApi);
    let session = session_of(&env, "Video A");
    assert_eq!(
        prompts(&env, &session)[0].0,
        serde_json::json!({ "providerID": "vidai", "id": MODEL })
    );
    let call = &env.opencode2_calls()[0];
    assert_eq!(call["VIDAI_API_KEY"], "<unset>");
    assert_eq!(call["OPENCODE_API_KEY"], "<unset>");
    let config: serde_json::Value = serde_json::from_str(&call["OPENCODE_CONFIG_CONTENT"]).unwrap();
    assert_eq!(
        config["providers"]["vidai"]["settings"],
        serde_json::json!({ "baseURL": "http://127.0.0.1:9/v1" })
    );
}

#[test]
fn the_openai_key_never_reaches_the_log() {
    let env = Env::new("echo_key");
    env.use_opencode2_openai(MODEL);
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let log = env.jobs.job_log(&Env::vid("Video A")).unwrap();
    let all: String = log
        .iter()
        .map(|e| format!("{}\n{}", e.text, e.detail.clone().unwrap_or_default()))
        .collect();
    assert!(all.contains("[api key]"), "{all}");
    assert!(!all.contains(OPENCODE_KEY), "{all}");
}

#[test]
fn a_model_opencodes_catalog_does_not_list_runs_on_vidais_provider() {
    let env = program_env("complete");
    env.edit_api(ApiOption::OpencodeGo, |api| {
        api.base_url = GO_ADDRESS.into()
    });
    env.set_env("FAKE_OPENCODE_MODELS", "kimi-k3");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let session = session_of(&env, "Video A");
    assert_eq!(
        prompts(&env, &session)[0].0,
        serde_json::json!({ "providerID": "vidai", "id": MODEL })
    );
}

#[test]
fn an_effort_the_model_offers_reaches_every_message_as_its_variant() {
    let env = program_env("complete");
    env.set_api_effort(ApiOption::OpencodeGo, MODEL, "high");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let session = session_of(&env, "Video A");
    let variants = env.opencode_variants(&session);
    assert!(!variants.is_empty());
    assert!(
        variants.iter().all(|v| v.as_deref() == Some("high")),
        "{variants:?}"
    );
    let log = env.log_texts("Video A").join("\n");
    assert!(!log.contains("does not offer"), "{log}");
}

#[test]
fn an_effort_the_model_does_not_offer_is_left_out_and_said_in_the_log() {
    let env = program_env("complete");
    env.set_api_effort(ApiOption::OpencodeGo, MODEL, "xhigh");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let session = session_of(&env, "Video A");
    assert!(env.opencode_variants(&session).iter().all(Option::is_none));
    let log = env.log_texts("Video A").join("\n");
    assert!(
        log.contains("does not offer the reasoning effort xhigh"),
        "{log}"
    );
}

#[test]
fn no_effort_sends_no_variant() {
    let env = program_env("complete");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let session = session_of(&env, "Video A");
    assert!(env.opencode_variants(&session).iter().all(Option::is_none));
}

#[test]
fn a_turn_that_ends_early_is_continued_in_the_same_session() {
    let env = keeping_env("early_end");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let session = session_of(&env, "Video A");
    let sent = prompts(&env, &session);
    assert_eq!(sent.len(), 2, "{sent:#?}");
    assert_eq!(
        sent[1].1,
        prompt::continuation_body_on(JobKind::Edit, &Nudge::KeepWorking, Setup::OpencodeGo)
    );
    assert_eq!(env.opencode2_calls().len(), 1, "the same live server");
    assert!(env.calls().is_empty());
}

#[test]
fn background_work_is_waited_for_and_never_taken_for_an_early_end() {
    // The edit's first busy period ends while its sub-agent builds the graphics: a job that keeps
    // itself going waits for the sub-agent's report instead of asking the model to keep going.
    let env = keeping_env("complete");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let session = session_of(&env, "Video A");
    assert_eq!(
        prompts(&env, &session).len(),
        1,
        "no continuation was needed"
    );
    assert!(
        env.log_texts("Video A")
            .iter()
            .all(|t| !t.starts_with("Asked to keep going"))
    );
}

#[test]
fn pause_interrupts_at_once_and_continue_resumes_the_same_session() {
    let env = keeping_env("hold");
    env.start("Video A");
    env.wait_file(&env.host.state.join("started.Video A"));
    let server = server_pid(&env, 0);
    let asked = Instant::now();
    env.jobs.pause_job(&Env::vid("Video A")).unwrap();
    let paused = env.wait_state("Video A", JobState::Paused);
    assert!(
        asked.elapsed() < Duration::from_secs(20),
        "the interrupt is prompt"
    );
    let session = paused.session_id.clone().unwrap();
    wait_until("the server to end", || !alive_native(server));
    assert!(
        env.log_texts("Video A")
            .iter()
            .all(|t| !t.contains("reported an error")),
        "the interrupted turn is no error"
    );
    assert!(env.host.state.join(format!("interrupt.{session}")).exists());
    assert!(
        env.log_texts("Video A")
            .iter()
            .any(|t| t == "Pausing: asking OpenCode 2 to stop the current step")
    );

    env.jobs.continue_job(&Env::vid("Video A")).unwrap();
    env.wait_file(&env.host.state.join("started.Video A"));
    env.release("Video A");
    let done = env.wait_state("Video A", JobState::Completed);
    assert_eq!(done.session_id.as_deref(), Some(session.as_str()));
    assert_eq!(
        env.opencode2_calls().len(),
        2,
        "a new server for the same session"
    );
    let sent = prompts(&env, &session);
    assert!(
        sent[1]
            .1
            .starts_with(&prompt::continue_body_in(None, Harness::Opencode2)),
        "{}",
        sent[1].1
    );
    assert!(
        env.log_texts("Video A")
            .iter()
            .any(|t| t == "Resumed the OpenCode 2 session (model glm-5.3)")
    );
}

// The fake starts POSIX `sleep` and `sh` commands for its process tree; on Windows the tree of a
// job is covered by the Git Bash fake (tests/jobs_engine.rs).
#[cfg(unix)]
#[test]
fn pause_stops_background_commands_and_sub_agents() {
    let env = keeping_env("background_hold");
    env.start("Video A");
    env.wait_file(&env.host.state.join("started.Video A"));
    let pids: Vec<u32> = fs::read_to_string(env.host.state.join("tree.pids"))
        .unwrap()
        .lines()
        .map(|l| l.parse().unwrap())
        .collect();
    assert_eq!(pids.len(), 1);
    // The job waits for its background work, it is not idle.
    env.wait_log("Video A", "Waiting for 2 background tasks");
    assert_eq!(env.job("Video A").state, JobState::Running);

    env.jobs.pause_job(&Env::vid("Video A")).unwrap();
    let paused = env.wait_state("Video A", JobState::Paused);
    let session = paused.session_id.clone().unwrap();
    for pid in pids {
        wait_until(&format!("process {pid} to end"), || !alive(pid));
    }
    // The command was ended through OpenCode, in the Editing Folder, and the sub-agent
    // interrupted along with the main session.
    let deleted = state_files(&env, "deleted.");
    assert_eq!(deleted.len(), 1, "{deleted:?}");
    assert_eq!(deleted[0].1.trim(), env.host.editing.to_string_lossy());
    let interrupted = state_files(&env, "interrupt.");
    assert!(interrupted.len() >= 2, "{interrupted:?}");
    assert!(interrupted.iter().any(|(s, _)| *s == session));
    assert!(
        env.log_texts("Video A")
            .iter()
            .all(|t| !t.contains("reported an error")),
        "{:#?}",
        env.log_texts("Video A")
    );

    env.jobs.continue_job(&Env::vid("Video A")).unwrap();
    let done = env.wait_state("Video A", JobState::Completed);
    assert_eq!(done.session_id.as_deref(), Some(session.as_str()));
}

#[cfg(unix)]
#[test]
fn stop_ends_the_whole_process_tree() {
    let env = program_env("tree");
    env.start("Video A");
    env.wait_file(&env.host.state.join("tree.ready"));
    let pids: Vec<u32> = fs::read_to_string(env.host.state.join("tree.pids"))
        .unwrap()
        .lines()
        .map(|l| l.parse().unwrap())
        .collect();
    assert_eq!(pids.len(), 3);
    env.jobs.stop_job(&Env::vid("Video A")).unwrap();
    env.wait_state("Video A", JobState::Stopped);
    for pid in pids {
        wait_until(&format!("process {pid} to end"), || !alive(pid));
    }
}

#[test]
fn re_edit_and_render_final_resume_the_session_in_the_same_program() {
    let env = program_env("complete");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let session = session_of(&env, "Video A");
    // The selected setup changing later does not move the session.
    env.select(Setup::ClaudeSubscription);

    let job = env
        .jobs
        .re_edit(&Env::vid("Video A"), "Cut the intro.")
        .unwrap();
    assert_eq!(job.harness, Some(Harness::Opencode2));
    let job = env.wait_state("Video A", JobState::Completed);
    assert_eq!(job.session_id.as_deref(), Some(session.as_str()));
    env.jobs
        .render_final(
            &Env::vid("Video A"),
            RenderFinalRequest {
                timeline_export_path: None,
                notes: String::new(),
            },
        )
        .unwrap();
    let job = env.wait_state("Video A", JobState::Completed);
    assert_eq!(job.session_id.as_deref(), Some(session.as_str()));
    let sent = prompts(&env, &session);
    assert_eq!(sent.len(), 3);
    assert!(sent[1].1.starts_with("RE-EDIT REQUEST."));
    assert!(sent[2].1.contains("Create the final output render"));
    assert!(env.calls().is_empty(), "Claude Code was never started");
    assert!(
        state_files(&env, "model.").is_empty(),
        "the model did not change"
    );
}

#[test]
fn a_session_the_program_no_longer_has_starts_again_with_the_full_instructions() {
    let env = program_env("complete");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    // OpenCode's store lost the session.
    fs::remove_dir_all(env.host.state.join("opencode2-sessions")).unwrap();
    env.jobs
        .re_edit(&Env::vid("Video A"), "Cut the intro.")
        .unwrap();
    let job = env.wait_state("Video A", JobState::Completed);
    env.wait_log(
        "Video A",
        "OpenCode 2 no longer has the earlier session, so a new session gets the full instructions.",
    );
    let sent = prompts(&env, job.session_id.as_deref().unwrap());
    assert!(sent[0].1.starts_with("MAIN_FOLDER = Video A\n"));
    assert!(sent[0].1.contains("RE-EDIT REQUEST."));
}

#[test]
fn without_the_program_a_resumed_session_moves_to_the_current_selection() {
    let env = program_env("complete");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    env.remove_opencode2_program();
    env.select(Setup::ClaudeSubscription);
    let job = env
        .jobs
        .re_edit(&Env::vid("Video A"), "Cut the intro.")
        .unwrap();
    assert_eq!(
        job.harness,
        Some(Harness::Opencode2),
        "recorded with its session"
    );
    let job = env.wait_state("Video A", JobState::Completed);
    assert_eq!(job.harness, Some(Harness::ClaudeCode));
    env.wait_log(
        "Video A",
        "This video's session ran on OpenCode Go (glm-5.3) in the OpenCode 2 program, which cannot continue it now (OpenCode 2 is not installed on this Mac). A new session on the Claude subscription gets the full instructions.",
    );
    assert_eq!(env.calls().len(), 1);

    // Not resuming and nothing to fall back to: the job fails with the reason.
    env.select(Setup::OpencodeGo);
    let job = env.start("Video A");
    let job_id = job.id.clone();
    let failed = env.wait_state("Video A", JobState::Failed);
    assert_eq!(failed.id, job_id);
    assert_eq!(
        failed.error.as_deref(),
        Some(
            "OpenCode 2 is not installed on this Mac. Fix it in Settings, Harness + API Keys, then press Continue Editing."
        )
    );
}

#[test]
fn two_videos_never_share_a_session() {
    let env = Env::with_videos("complete", &["Video A", "Video B"], 3);
    env.use_opencode2_program(MODEL);
    env.start("Video A");
    env.start("Video B");
    env.wait_state("Video A", JobState::Completed);
    env.wait_state("Video B", JobState::Completed);
    assert_ne!(session_of(&env, "Video A"), session_of(&env, "Video B"));
    assert_eq!(env.opencode2_calls().len(), 2, "one server per video");

    // A session recorded for two videos (state copied) is resumed by neither.
    let shared = session_of(&env, "Video A");
    env.host
        .store
        .update_video(&Env::vid("Video B"), |v| {
            v.latest_job.as_mut().unwrap().session_id = Some(shared.clone());
            Ok(())
        })
        .unwrap();
    env.jobs
        .re_edit(&Env::vid("Video B"), "Cut the intro.")
        .unwrap();
    let job = env.wait_state("Video B", JobState::Completed);
    assert_ne!(job.session_id.as_deref(), Some(shared.as_str()));
}

#[test]
fn one_slot_queues_the_second_edit() {
    let env = Env::with_videos("hold", &["Video A", "Video B"], 1);
    env.use_opencode2_program(MODEL);
    env.start("Video A");
    env.start("Video B");
    env.wait_file(&env.host.state.join("started.Video A"));
    assert_eq!(env.job("Video B").state, JobState::Queued);
    env.release("Video A");
    env.wait_state("Video A", JobState::Completed);
    env.wait_file(&env.host.state.join("started.Video B"));
    env.release("Video B");
    env.wait_state("Video B", JobState::Completed);
}

#[test]
fn a_restart_keeps_the_session_and_continue_resumes_it() {
    let env = program_env("complete");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let session = session_of(&env, "Video A");
    // VidAI ended while the job ran.
    env.host
        .store
        .update_video(&Env::vid("Video A"), |v| {
            let job = v.latest_job.as_mut().unwrap();
            job.state = JobState::Running;
            job.running_since = Some("2026-11-01T10:00:00.000Z".into());
            Ok(())
        })
        .unwrap();
    env.jobs.recover();
    assert_eq!(env.job("Video A").state, JobState::Paused);
    env.jobs.continue_job(&Env::vid("Video A")).unwrap();
    let job = env.wait_state("Video A", JobState::Completed);
    assert_eq!(job.session_id.as_deref(), Some(session.as_str()));
    assert_eq!(job.harness, Some(Harness::Opencode2));
    assert_eq!(prompts(&env, &session).len(), 2);
}

#[test]
fn a_refused_key_fails_in_opencodes_words() {
    let env = keeping_env("api_error");
    env.edit_api(ApiOption::OpencodeGo, |api| {
        api.base_url = GO_ADDRESS.into()
    });
    env.start("Video A");
    let job = env.wait_state("Video A", JobState::Failed);
    let error = job.error.unwrap();
    assert!(
        error.starts_with("OpenCode did not accept the API key"),
        "{error}"
    );
    assert!(!error.contains(OPENCODE_KEY));
    assert_eq!(
        prompts(&env, &job.session_id.unwrap()).len(),
        1,
        "no continuation"
    );
}

/// An address that is not OpenCode's names no OpenCode in what the service answered (SPEC section
/// 7a, "Test and errors"), on either option of the OpenCode 2 program.
#[test]
fn a_refused_key_of_another_service_fails_in_generic_words() {
    for option in [ApiOption::OpencodeGo, ApiOption::OpenaiApi] {
        let env = Env::keeping_going("api_error", Duration::from_millis(600));
        match option {
            ApiOption::OpenaiApi => env.use_opencode2_openai(MODEL),
            _ => env.use_opencode2_program(MODEL),
        }
        env.start("Video A");
        let error = env.wait_state("Video A", JobState::Failed).error.unwrap();
        assert!(
            error.starts_with("The service did not accept the API key"),
            "{option:?}: {error}"
        );
        assert!(!error.contains("OpenCode"), "{option:?}: {error}");
        assert!(!error.contains(OPENCODE_KEY));
    }
}

#[test]
fn a_go_limit_ends_the_job_with_the_limit() {
    for scenario in ["usage_limit", "usage_limit_retry"] {
        let env = keeping_env(scenario);
        env.start("Video A");
        let job = env.wait_state("Video A", JobState::Failed);
        let error = job.error.unwrap();
        assert!(
            error.starts_with("The weekly limit of your OpenCode Go plan"),
            "{scenario}: {error}"
        );
        let server = server_pid(&env, 0);
        wait_until("the server to end", || !alive_native(server));
    }
}

#[test]
fn a_permission_request_is_answered_without_a_person() {
    let env = program_env("permission");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let answers: Vec<String> = state_files(&env, "permission.per_")
        .into_iter()
        .map(|(_, answer)| answer)
        .collect();
    assert_eq!(answers, ["once"]);
}

#[test]
fn a_question_is_cancelled_and_the_model_goes_on() {
    let env = program_env("question");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let forms = state_files(&env, "form.frm_");
    assert_eq!(forms.len(), 1);
    assert_eq!(forms[0].1, QUESTION_CANCELLED);
    assert!(
        env.log_texts("Video A")
            .iter()
            .any(|t| t.starts_with("Error: VidAI runs this edit"))
    );
}

#[test]
fn the_key_never_reaches_the_log() {
    let env = program_env("echo_key");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let log = env.jobs.job_log(&Env::vid("Video A")).unwrap();
    let all: String = log
        .iter()
        .map(|e| format!("{}\n{}", e.text, e.detail.clone().unwrap_or_default()))
        .collect();
    assert!(all.contains("[api key]"), "{all}");
    assert!(!all.contains(OPENCODE_KEY), "{all}");
}

#[test]
fn a_crash_reports_the_last_line_of_the_program() {
    let env = program_env("crash");
    env.start("Video A");
    let job = env.wait_state("Video A", JobState::Failed);
    let error = job.error.unwrap();
    assert!(error.contains("boom"), "{error}");
}

#[test]
fn an_edit_without_output_fails_after_the_continuations() {
    let env = keeping_env("no_output");
    env.start("Video A");
    let job = env.wait_state("Video A", JobState::Failed);
    assert!(job.error.is_some());
    assert!(prompts(&env, &job.session_id.unwrap()).len() > 1);
}

/// The real OpenCode 2 program with its free model, through the real job engine (never part of a
/// normal run): `VIDAI_REAL_OPENCODE2=<path of opencode2> VIDAI_E2E_OPENCODE_LOGIN=public cargo
/// test --test opencode2_engine real -- --ignored`. The servers run without VidAI's key on
/// OpenCode's public free tier, with every OpenCode folder (data, configuration, cache, state)
/// and the home folder inside the test's temporary folder, so nothing of the user's own OpenCode
/// is read or changed and the sessions it makes go away with that folder. A trivial edit starts a
/// command in the background, is paused in the middle of a foreground command, continues in the
/// same session and completes with a review project.
#[cfg(unix)]
#[test]
#[ignore = "runs the real OpenCode 2 program; see the doc comment"]
fn real_opencode2_smoke() {
    let Ok(program) = std::env::var("VIDAI_REAL_OPENCODE2") else {
        eprintln!("VIDAI_REAL_OPENCODE2 is not set; nothing to run");
        return;
    };
    assert_eq!(
        std::env::var("VIDAI_E2E_OPENCODE_LOGIN").as_deref(),
        Ok("public"),
        "the real smoke runs on the public free tier only"
    );
    const PROMPT: &str = "This is an automated test of the VidAI app, not a real video edit. Do exactly these steps and nothing else: 1. Write a short message whose only content is the line [VIDAI_PROGRESS inspected]. 2. Start the shell command `sleep 5 && echo bg-done` with the shell tool with its background option set to true, and do not wait for it. 3. Run the shell command `sleep 20` with the shell tool and a timeout of 60000 milliseconds. 4. Create the folder \"output\" inside MAIN_FOLDER (inside CHANNEL_FOLDER) if it is missing. 5. Write a minimal valid FCPXML 1.11 document (an empty project, no media) to output/<MAIN_FOLDER>_review_v1.fcpxml, unless that file already exists. 6. Write [OUTPUT COMPLETED] in your last message. Do not read MEMORY.md, do not transcribe, do not run ffmpeg, do not start sub-agents.";
    let env = Env::keeping_going("complete", Duration::from_secs(3));
    env.use_opencode2_program("big-pickle");
    *env.host.opencode2_program.lock().unwrap() = Some(program.into());
    env.edit_api(ApiOption::OpencodeGo, |api| {
        api.base_url = "https://opencode.ai/inference/anthropic".into()
    });
    let root = env.host.editing.parent().unwrap().to_path_buf();
    for (var, dir) in [
        ("HOME", "home"),
        ("XDG_DATA_HOME", "xdg/data"),
        ("XDG_CONFIG_HOME", "xdg/config"),
        ("XDG_CACHE_HOME", "xdg/cache"),
        ("XDG_STATE_HOME", "xdg/state"),
    ] {
        let path = root.join(dir);
        fs::create_dir_all(&path).unwrap();
        env.set_env(var, &path.to_string_lossy());
    }
    env.host
        .store
        .update_settings(|s| {
            s.channels[0].long.prompts[0].text = PROMPT.into();
            Ok(())
        })
        .unwrap();
    let long = |what: &str, minutes: u64, done: &mut dyn FnMut() -> bool| {
        let deadline = Instant::now() + Duration::from_secs(minutes * 60);
        while !done() {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}: {:#?}",
                env.log_texts("Video A")
            );
            std::thread::sleep(Duration::from_millis(250));
        }
    };

    env.start("Video A");
    long("the model to run sleep 20", 8, &mut || {
        assert_eq!(
            env.job("Video A").state,
            JobState::Running,
            "{:#?}",
            env.log_texts("Video A")
        );
        let log = env.jobs.job_log(&Env::vid("Video A")).unwrap();
        log.iter().any(|e| {
            e.kind == LogKind::Tool && e.detail.as_deref().unwrap_or_default().trim() == "sleep 20"
        })
    });
    let server = server_pid_of_real();
    env.jobs.pause_job(&Env::vid("Video A")).unwrap();
    long("the pause", 2, &mut || {
        env.job("Video A").state == JobState::Paused
    });
    let session = session_of(&env, "Video A");
    if let Some(server) = server {
        wait_until("the server to end", || !alive_native(server));
    }

    env.jobs.continue_job(&Env::vid("Video A")).unwrap();
    long("the edit to complete", 10, &mut || {
        let state = env.job("Video A").state;
        assert!(
            matches!(state, JobState::Running | JobState::Completed),
            "{state:?}: {:#?}",
            env.log_texts("Video A")
        );
        state == JobState::Completed
    });
    let job = env.job("Video A");
    assert_eq!(job.session_id.as_deref(), Some(session.as_str()));
    assert_eq!(job.harness, Some(Harness::Opencode2));
    let texts = env.log_texts("Video A");
    eprintln!("real OpenCode 2 log:\n{}", texts.join("\n"));
    for want in [
        "Started a new OpenCode 2 session (model big-pickle)",
        "Resumed the OpenCode 2 session (model big-pickle)",
        "OpenCode 2 is running (model opencode/big-pickle)",
        "Footage inspected",
    ] {
        assert!(
            texts.iter().any(|t| t == want),
            "{want:?} not in {texts:#?}"
        );
    }
    let files: Vec<String> = fs::read_dir(env.video_dir("Video A").join("output"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(files.iter().any(|f| f.ends_with(".fcpxml")), "{files:?}");
}

/// The process id of the real server this test process started, when it can be found.
#[cfg(unix)]
fn server_pid_of_real() -> Option<u32> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()
        .ok()?;
    let me = std::process::id().to_string();
    String::from_utf8_lossy(&out.stdout).lines().find_map(|l| {
        let mut fields = l.split_whitespace();
        let pid = fields.next()?.parse().ok()?;
        (fields.next()? == me && l.contains("serve --stdio --hostname 127.0.0.1 --port 0"))
            .then_some(pid)
    })
}

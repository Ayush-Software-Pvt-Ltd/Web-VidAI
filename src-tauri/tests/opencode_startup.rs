//! How a job's OpenCode 2 server starts (SPEC section 7a, "Starting the
//! server"): a slow start is waited for and said so in the log, a server that never gets ready,
//! one that ends at once and one that only shows a progress display fail with what they printed,
//! and the user's own OpenCode configuration stays out of the server. The engine and its helpers
//! are the ones of tests/jobs_engine.rs (tests/support/engine.rs), the server the fake
//! (tests/support/fake-opencode2.py), steered by `FAKE_OPENCODE_START`.

use std::time::Duration;

mod support;
use support::engine::*;
use vidai_lib::jobs::Timings;
use vidai_lib::model::JobState;
use vidai_lib::opencode::harness::child::{STARTUP_TIMEOUT, StartLimits};

const MODEL: &str = "glm-5.3";

/// An Env whose edits run in OpenCode 2, whose fake server starts as `start` says
/// (`FAKE_OPENCODE_START`), with the given limits for a server start.
fn env(start: &str, limits: StartLimits) -> Env {
    let env = Env::build(
        "complete",
        &["Video A"],
        3,
        0,
        Timings {
            server_start: limits,
            ..timings()
        },
    );
    env.use_opencode2_program(MODEL);
    env.host
        .extra_env
        .lock()
        .unwrap()
        .push(("FAKE_OPENCODE_START".into(), start.into()));
    env
}

fn limits(timeout_ms: u64) -> StartLimits {
    StartLimits {
        timeout: Duration::from_millis(timeout_ms),
        first_notice: Duration::from_millis(600),
        notice_every: Duration::from_millis(600),
    }
}

/// The error of the job that failed to start.
fn start_error(env: &Env) -> String {
    env.start("Video A");
    env.wait_state("Video A", JobState::Failed)
        .error
        .expect("an error")
}

#[test]
fn the_default_limit_is_far_beyond_the_old_thirty_seconds() {
    // 30 seconds were not enough on an Intel Mac; a failing start says why long before the limit.
    assert!(
        STARTUP_TIMEOUT >= Duration::from_secs(120),
        "{STARTUP_TIMEOUT:?}"
    );
}

#[test]
fn a_slow_start_is_waited_for_and_the_log_says_so() {
    let env = env("delay:2.5", limits(20_000));
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let texts = env.log_texts("Video A");
    let waiting: Vec<&String> = texts
        .iter()
        .filter(|t| t.starts_with(&format!("Still waiting for {} to start (", "OpenCode 2")))
        .collect();
    assert!(!waiting.is_empty(), "{}: {texts:#?}", "OpenCode 2");
    assert!(
        texts.iter().any(|t| t.starts_with("Started a new")),
        "{texts:#?}"
    );
}

#[test]
fn a_server_that_never_gets_ready_fails_actionably_and_is_ended() {
    let env = env("never", limits(1_800));
    let error = start_error(&env);
    let name = "OpenCode 2";
    assert!(
        error.starts_with(&format!("The {name} program could not be started: ")),
        "{error}"
    );
    assert!(
        error.contains("did not become ready within 1 seconds")
            || error.contains("did not become ready within 2 seconds"),
        "{error}"
    );
    assert!(error.contains("it printed nothing"), "{error}");
    let terminal = if cfg!(windows) {
        "PowerShell"
    } else {
        "Terminal"
    };
    assert!(error.contains(&format!("serve\" in {terminal}")), "{error}");
    // Nothing of it keeps running.
    assert!(env.opencode2_calls().is_empty());
}

#[test]
fn a_server_that_ends_at_once_fails_with_what_it_printed() {
    let env = env("exit:Error: cannot open the database", limits(20_000));
    let error = start_error(&env);
    assert!(error.contains("ended before it was ready"), "{error}");
    assert!(
        error.contains("(Error: cannot open the database)"),
        "{error}"
    );
}

#[test]
fn a_progress_display_without_line_ends_is_not_lost() {
    // Carriage returns only, and the last piece has no line end at all.
    let env = env("migrate:30", limits(1_500));
    let error = start_error(&env);
    assert!(error.contains("did not become ready"), "{error}");
    assert!(error.contains("Migrating database"), "{error}");
    assert!(!error.contains("it printed nothing"), "{error}");
}

#[test]
fn a_migration_that_ends_just_after_the_first_notice_still_starts_the_job() {
    let env = env("migrate:2", limits(20_000));
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
}

/// The user's own OpenCode configuration (MCP servers, plugins, agents) stays out of a job's
/// server: OpenCode 2 gets a private config folder in place of the user's.
#[test]
fn the_users_own_opencode_configuration_stays_out_of_the_server() {
    let env = env("", limits(20_000));
    env.host
        .extra_env
        .lock()
        .unwrap()
        .retain(|(k, _)| k != "FAKE_OPENCODE_START");
    env.start("Video A");
    env.wait_state("Video A", JobState::Completed);
    let call = &env.opencode2_calls()[0];
    let dir = &call["OPENCODE_CONFIG_DIR"];
    assert!(
        dir.starts_with(env.host.store.data_dir().to_str().unwrap())
            && dir.ends_with("opencode2-config"),
        "{dir}"
    );
    assert_eq!(call["OPENCODE_CONFIG_PROJECT_DISABLE"], "1");
    assert_eq!(call["OPENCODE_CONFIG"], "<unset>");
}

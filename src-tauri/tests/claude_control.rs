//! The Claude Code environment against a fake `claude` (`tests/fixtures/claude-control/fake-claude.sh`,
//! POSIX `sh`): the control-request helper, locating through `VIDAI_CLAUDE_BIN`, the login check
//! and the version. Never runs the real Claude Code.
//!
//! The tests that need `VIDAI_CLAUDE_BIN` run this test binary again as a child process with the
//! variable set (the crate forbids unsafe code, so the environment of the running test process
//! cannot be changed). The child's `SHELL` is `/bin/sh`, so the login-shell capture is quick and
//! does not depend on the developer's own shell.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use tempfile::TempDir;

mod support;
use vidai_lib::claude::control::ControlClient;
use vidai_lib::claude::{auth, env, info, locate, usage};
use vidai_lib::error::ErrorCode;

const CHILD_VAR: &str = "VIDAI_TEST_CHILD";
/// Limit for requests the fake answers: it only catches a hang, so it does not assume a fast or
/// idle machine.
const ANSWER: Duration = Duration::from_secs(60);

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-control")
}

/// The fake claude (one executable shared by every test) with an environment for it that logs
/// into `dir`.
fn fake_claude(dir: &Path) -> (PathBuf, HashMap<String, String>) {
    let bin = support::installed(&fixtures().join("fake-claude.sh"));
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert(
        "FAKE_CLAUDE_FIXTURES".into(),
        fixtures().to_string_lossy().into_owned(),
    );
    env.insert(
        "FAKE_CLAUDE_LOG".into(),
        dir.join("log").to_string_lossy().into_owned(),
    );
    (bin, env)
}

fn log(dir: &Path) -> String {
    fs::read_to_string(dir.join("log")).unwrap_or_default()
}

#[test]
fn helper_answers_info_and_usage() {
    let tmp = TempDir::new().unwrap();
    let (bin, env) = fake_claude(tmp.path());
    let mut client = ControlClient::spawn(&bin, &env, &tmp.path().join("cwd")).unwrap();

    let info = info::fetch(&mut client, "2026-11-14T06:00:00.000Z".into()).unwrap();
    assert_eq!(info.models.len(), 7);
    assert_eq!(info.models[0].value, "opus");
    assert_eq!(info.default_model.as_deref(), Some("fable"));
    assert_eq!(info.default_effort.as_deref(), Some("high"));
    assert_eq!(info.subscription_type.as_deref(), Some("Claude Team"));
    assert_eq!(info.version.as_deref(), Some("2.1.319"));

    let answer = client.request("get_usage", ANSWER).unwrap();
    let (available, limits) = usage::parse_usage(&answer);
    assert!(available);
    let keys: Vec<&str> = limits.iter().map(|l| l.key.as_str()).collect();
    assert_eq!(keys, ["fiveHour", "weekly", "weeklyFable"]);

    let err = client.request("not_a_request", ANSWER).unwrap_err();
    assert!(
        err.message.contains("Unsupported control request subtype"),
        "{}",
        err.message
    );
    // An error answer leaves the helper usable.
    assert!(client.is_alive());
    client.request("get_settings", ANSWER).unwrap();
    client.close();

    let log = log(tmp.path());
    assert_eq!(log.matches("start ").count(), 1);
    assert!(log.contains("-p --input-format stream-json --output-format stream-json --verbose"));
    assert!(!log.contains("mcp_status"));
}

#[test]
fn helper_timeout_and_exit_are_errors() {
    let tmp = TempDir::new().unwrap();
    let (bin, mut env) = fake_claude(tmp.path());
    env.insert("FAKE_CLAUDE_SILENT".into(), "get_usage".into());
    let mut client = ControlClient::spawn(&bin, &env, tmp.path()).unwrap();
    let err = client
        .request("get_usage", Duration::from_millis(300))
        .unwrap_err();
    assert!(err.message.contains("did not answer"), "{}", err.message);
    // After a timeout the client refuses further requests instead of mixing up answers.
    assert!(!client.is_alive());
    drop(client);

    env.remove("FAKE_CLAUDE_SILENT");
    env.insert("FAKE_CLAUDE_EXIT_ON".into(), "initialize".into());
    let mut client = ControlClient::spawn(&bin, &env, tmp.path()).unwrap();
    let err = client.request("initialize", ANSWER).unwrap_err();
    assert!(
        err.message
            .contains("stopped unexpectedly: Error: fake claude stopped on initialize"),
        "{}",
        err.message
    );
}

/// Runs the test `name` of this binary in a child process with `vars` set.
fn run_child(name: &str, vars: &[(&str, &str)]) {
    let output = Command::new(std::env::current_exe().unwrap())
        .args([name, "--exact", "--nocapture", "--test-threads=1"])
        .envs(vars.iter().copied())
        .env("SHELL", "/bin/sh")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains(&format!("child ran: {name}")),
        "child test {name} failed:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn finds_and_checks_claude_through_vidai_claude_bin() {
    let tmp = TempDir::new().unwrap();
    let (bin, _) = fake_claude(tmp.path());
    let fixtures = fixtures();
    let base = [
        (locate::OVERRIDE_VAR, bin.to_str().unwrap()),
        ("FAKE_CLAUDE_FIXTURES", fixtures.to_str().unwrap()),
    ];
    run_child(
        "child_logged_in",
        &[base[0], base[1], (CHILD_VAR, "logged-in")],
    );
    run_child(
        "child_logged_out",
        &[
            base[0],
            base[1],
            (CHILD_VAR, "logged-out"),
            ("FAKE_CLAUDE_LOGGED_OUT", "1"),
        ],
    );
    let missing = tmp.path().join("not-installed");
    run_child(
        "child_not_installed",
        &[
            (locate::OVERRIDE_VAR, missing.to_str().unwrap()),
            (CHILD_VAR, "not-installed"),
        ],
    );
}

/// Whether this process is the child started for `role`; says so on stdout for the parent.
fn is_child(role: &str, name: &str) -> bool {
    let me = std::env::var(CHILD_VAR).is_ok_and(|v| v == role);
    if me {
        println!("child ran: {name}");
    }
    me
}

#[test]
fn child_logged_in() {
    if !is_child("logged-in", "child_logged_in") {
        return;
    }
    let expected = PathBuf::from(std::env::var(locate::OVERRIDE_VAR).unwrap());
    assert_eq!(locate::find(), Some(expected.clone()));

    // The variables of the app reach children through the captured login-shell environment.
    let env = env::child_env();
    assert!(env.contains_key("FAKE_CLAUDE_FIXTURES"));
    #[cfg(unix)]
    assert!(env["PATH"].contains("/usr/bin"));
    #[cfg(windows)]
    assert!(env["PATH"].to_lowercase().contains(r"\system32"));
    assert!(!env.contains_key("VIDAI_RESOLVING_ENVIRONMENT"));

    let ready = tauri::async_runtime::block_on(auth::ensure_ready()).unwrap();
    assert_eq!(ready, expected);
    // A second check within the cache time does not run `claude auth status` again (the fake
    // would still say yes, so this only shows the call is fast and consistent).
    assert_eq!(auth::ensure_ready_blocking().unwrap(), expected);
    assert_eq!(locate::version(&ready, &env).as_deref(), Some("2.1.319"));

    let cwd = TempDir::new().unwrap();
    let mut client = ControlClient::spawn(&ready, &env, cwd.path()).unwrap();
    let info = info::fetch(&mut client, "2026-11-14T06:00:00.000Z".into()).unwrap();
    assert_eq!(info.models.len(), 7);
    client.close();
}

#[test]
fn child_logged_out() {
    if !is_child("logged-out", "child_logged_out") {
        return;
    }
    let bin = locate::find().unwrap();
    assert!(!auth::check_logged_in(&bin, &env::child_env()).unwrap());
    let err = tauri::async_runtime::block_on(auth::ensure_ready()).unwrap_err();
    assert_eq!(err.code, ErrorCode::ClaudeNotLoggedIn);
}

#[test]
fn child_not_installed() {
    if !is_child("not-installed", "child_not_installed") {
        return;
    }
    // A wrong VIDAI_CLAUDE_BIN never falls back to another claude on the machine.
    assert_eq!(locate::find(), None);
    let err = auth::ensure_ready_blocking().unwrap_err();
    assert_eq!(err.code, ErrorCode::ClaudeNotInstalled);
}

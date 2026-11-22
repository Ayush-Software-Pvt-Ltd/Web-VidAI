//! A Claude Code process in stream-json mode used only for control requests (`initialize`,
//! `get_settings`, `get_usage`). It never receives a user message, so it never makes a model call.
//!
//! The process runs without MCP servers, hooks or session persistence, in a working folder
//! inside VidAI's app data directory, so it leaves nothing behind for the user. Closing stdin
//! makes it exit with code 0; dropping a [`ControlClient`] ends it for sure.
//!
//! Never send `mcp_status`: its answer contains the user's MCP server credentials.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::error::{AppError, AppResult};
use crate::platform;

/// Arguments of the helper process. `--settings` turns off the user's hooks for this process
/// only (a hook must not run every minute for a usage refresh) and keeps it from registering a
/// Remote Control session.
pub const HELPER_ARGS: &[&str] = &[
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    r#"{"mcpServers":{}}"#,
    "--settings",
    r#"{"disableAllHooks":true,"remoteControlAtStartup":false}"#,
];

/// How long a closed helper may take to exit before it is killed.
const EXIT_GRACE: Duration = Duration::from_secs(3);

/// Keeps the last line of stderr (shortened) for error messages.
const STDERR_TAIL_CHARS: usize = 300;

/// One answer read from stdout: the `response` object of a `control_response` line.
type Answer = Value;

/// A running helper process.
pub struct ControlClient {
    child: Child,
    /// Ends what is left of the helper's process tree when the client is dropped (Windows).
    _group: platform::process::ChildGroup,
    stdin: Option<ChildStdin>,
    answers: mpsc::Receiver<Answer>,
    stderr_tail: Arc<Mutex<String>>,
    next_id: u64,
    started: Instant,
}

impl ControlClient {
    /// Starts `bin` with [`HELPER_ARGS`] in `cwd` with exactly the environment `env`.
    pub fn spawn(bin: &Path, env: &HashMap<String, String>, cwd: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(cwd).map_err(|e| AppError::io_at("Could not create", cwd, e))?;
        let mut cmd = platform::launch::command(bin, env, HELPER_ARGS)
            .map_err(|e| AppError::internal(format!("Could not start Claude Code: {e}")))?;
        cmd.env_clear()
            .envs(env)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (mut child, group) = platform::process::spawn_in_new_group(&mut cmd)
            .map_err(|e| AppError::internal(format!("Could not start Claude Code: {e}")))?;
        let stdin = child.stdin.take();
        let (tx, answers) = mpsc::channel();
        if let Some(stdout) = child.stdout.take() {
            thread::spawn(move || read_answers(stdout, tx));
        }
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = Arc::clone(&stderr_tail);
            thread::spawn(move || read_stderr_tail(stderr, tail));
        }
        Ok(Self {
            child,
            _group: group,
            stdin,
            answers,
            stderr_tail,
            next_id: 0,
            started: Instant::now(),
        })
    }

    /// When the process was started.
    pub fn started(&self) -> Instant {
        self.started
    }

    /// Whether the process is still running.
    pub fn is_alive(&mut self) -> bool {
        self.stdin.is_some() && matches!(self.child.try_wait(), Ok(None))
    }

    /// Sends one control request and waits up to `timeout` for its answer. Returns the inner
    /// `response` object of a `success` answer; an `error` answer, an exit or a timeout is an
    /// error. After a timeout or an exit the client is unusable and should be dropped.
    pub fn request(&mut self, subtype: &str, timeout: Duration) -> AppResult<Value> {
        debug_assert_ne!(subtype, "mcp_status", "mcp_status returns credentials");
        self.next_id += 1;
        let id = format!("vidai-{}", self.next_id);
        let line = request_line(&id, subtype);
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| AppError::internal("The Claude Code helper was closed."))?;
        if let Err(err) = stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.flush())
        {
            self.stdin = None;
            return Err(self.exited_error(&format!("could not be reached ({err})")));
        }
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.answers.recv_timeout(left) {
                Ok(answer) if answer.get("request_id").and_then(Value::as_str) == Some(&id) => {
                    return parse_answer(subtype, &answer);
                }
                Ok(_) => continue, // an answer to an earlier request that timed out
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.stdin = None;
                    return Err(AppError::internal(format!(
                        "Claude Code did not answer within {} seconds.",
                        timeout.as_secs()
                    )));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.stdin = None;
                    return Err(self.exited_error("stopped unexpectedly"));
                }
            }
        }
    }

    /// Closes stdin, which makes Claude Code exit, and waits briefly; kills it if it lingers.
    pub fn close(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stdin = None;
        let deadline = Instant::now() + EXIT_GRACE;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => thread::sleep(Duration::from_millis(20)),
            }
        }
        platform::process::kill_now(&mut self.child);
    }

    fn exited_error(&mut self, what: &str) -> AppError {
        // Give the stderr reader a moment to catch the last words.
        thread::sleep(Duration::from_millis(100));
        let tail = self
            .stderr_tail
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if tail.is_empty() {
            AppError::internal(format!("Claude Code {what}."))
        } else {
            AppError::internal(format!("Claude Code {what}: {tail}"))
        }
    }
}

impl Drop for ControlClient {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            self.shutdown();
        }
    }
}

/// The stdin line of a control request.
pub fn request_line(id: &str, subtype: &str) -> String {
    let mut line = json!({
        "type": "control_request",
        "request_id": id,
        "request": { "subtype": subtype },
    })
    .to_string();
    line.push('\n');
    line
}

/// The `response` object of a stdout line when it is a `control_response`, else `None`.
/// Every other line (system messages, noise, unknown types) is ignored.
pub fn parse_line(line: &str) -> Option<Answer> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type")?.as_str()? != "control_response" {
        return None;
    }
    let response = value.get("response")?;
    response.get("request_id")?.as_str()?;
    Some(response.clone())
}

/// The inner `response` of a `success` answer, or a readable error.
pub fn parse_answer(subtype: &str, answer: &Value) -> AppResult<Value> {
    match answer.get("subtype").and_then(Value::as_str) {
        Some("success") => Ok(answer.get("response").cloned().unwrap_or(Value::Null)),
        _ => {
            let reason = answer
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            Err(AppError::internal(format!(
                "Claude Code could not answer {subtype}: {}",
                shorten(reason, STDERR_TAIL_CHARS)
            )))
        }
    }
}

fn read_answers(stdout: impl Read, tx: mpsc::Sender<Answer>) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if let Some(answer) = parse_line(&line)
            && tx.send(answer).is_err()
        {
            break;
        }
    }
}

fn read_stderr_tail(stderr: impl Read, tail: Arc<Mutex<String>>) {
    for line in BufReader::new(stderr).lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if !line.is_empty() {
            *tail.lock().unwrap_or_else(PoisonError::into_inner) = shorten(line, STDERR_TAIL_CHARS);
        }
    }
}

fn shorten(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_owned()
    } else {
        let mut short: String = text.chars().take(max).collect();
        short.push_str("...");
        short
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_lines_are_single_json_lines() {
        let line = request_line("vidai-1", "get_usage");
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            value,
            json!({"type":"control_request","request_id":"vidai-1","request":{"subtype":"get_usage"}})
        );
    }

    #[test]
    fn parses_success_and_error_answers() {
        let ok = parse_line(
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"a","response":{"x":1}}}"#,
        )
        .unwrap();
        assert_eq!(ok["request_id"], "a");
        assert_eq!(parse_answer("initialize", &ok).unwrap(), json!({"x":1}));

        let err = parse_line(
            r#"{"type":"control_response","response":{"subtype":"error","request_id":"b","error":"Unsupported control request subtype: nope"}}"#,
        )
        .unwrap();
        let err = parse_answer("nope", &err).unwrap_err();
        assert_eq!(
            err.message,
            "Claude Code could not answer nope: Unsupported control request subtype: nope"
        );
    }

    #[test]
    fn ignores_other_lines() {
        for line in [
            "",
            "not json",
            r#"{"type":"system","subtype":"init"}"#,
            r#"{"type":"control_request","request_id":"x","request":{"subtype":"can_use_tool"}}"#,
            r#"{"type":"control_response","response":{"subtype":"success"}}"#,
        ] {
            assert!(parse_line(line).is_none(), "{line}");
        }
    }
}

//! One running Claude Code process, and the tracking that tells when Claude is really finished.
//!
//! [`Session::spawn`] starts `claude` with the flags of SPEC section 6 ([`SessionConfig::args`]),
//! the Editing Folder as working directory and the given environment, in its own process group
//! (`platform::process`; on Windows a job object), started through `platform::launch` (which
//! knows how to start npm shims and scripts on Windows). Three threads serve it, none of which ever holds a lock of the caller:
//!
//! - the stdout reader parses each line ([`protocol::parse_line`]) and hands it to the caller's
//!   callback; lines are read with a hard size cap, so a runaway line cannot exhaust memory;
//! - the stderr reader keeps only the last few lines (for "Claude crashed" messages);
//! - the waiter reaps the process, gives the stdout reader a moment to drain, and reports
//!   [`SessionEvent::Exited`] last.
//!
//! Writing to stdin ([`Session::send_user`], [`Session::interrupt`], [`Session::close_stdin`])
//! happens on the caller's thread. Ending the process tree is done by the caller through
//! `platform::process::ProcessTree` with [`Session::pid`].
//!
//! [`TurnTracker`] is the pure completion logic: a `result` ends one turn, not the job; Claude is
//! finished only when every message sent has been answered, no turn is in progress, no background
//! task is active, and nothing has happened for a settle time.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crate::claude::protocol::{self, Block, StreamEvent, SystemEvent, TurnResult};
use crate::platform::{launch, process};

/// Longest stdout line kept; the rest of a longer line is discarded (the line is then skipped).
pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
/// How many stderr lines are kept.
const STDERR_TAIL_LINES: usize = 20;
/// Longest stderr line kept, in bytes.
const STDERR_LINE_BYTES: usize = 2_000;
/// How long the waiter lets the stdout reader drain after the process exited.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// New session (`--session-id`) or an existing one (`--resume`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionMode {
    New(String),
    Resume(String),
}

impl SessionMode {
    pub fn session_id(&self) -> &str {
        match self {
            Self::New(id) | Self::Resume(id) => id,
        }
    }

    pub fn is_resume(&self) -> bool {
        matches!(self, Self::Resume(_))
    }
}

/// Everything needed to start one Claude Code process.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub program: PathBuf,
    /// The Editing Folder.
    pub cwd: PathBuf,
    /// The complete environment of the child (nothing else is inherited).
    pub env: HashMap<String, String>,
    pub mode: SessionMode,
    pub model: Option<String>,
    pub effort: Option<String>,
}

impl SessionConfig {
    /// The command-line arguments of SPEC section 6, "Driving Claude Code".
    pub fn args(&self) -> Vec<String> {
        let mut args: Vec<String> = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "bypassPermissions",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        if let Some(model) = self.model.as_deref().filter(|m| !m.trim().is_empty()) {
            args.extend(["--model".into(), model.trim().to_owned()]);
        }
        if let Some(effort) = self.effort.as_deref().filter(|e| !e.trim().is_empty()) {
            args.extend(["--effort".into(), effort.trim().to_owned()]);
        }
        match &self.mode {
            SessionMode::New(id) => args.extend(["--session-id".into(), id.clone()]),
            SessionMode::Resume(id) => args.extend(["--resume".into(), id.clone()]),
        }
        args
    }
}

/// How the process ended.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ExitInfo {
    /// `None` when it was ended by a signal.
    pub code: Option<i32>,
    pub signal: Option<i32>,
    /// The last lines of stderr, oldest first.
    pub stderr_tail: Vec<String>,
}

impl ExitInfo {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    /// The last non-empty stderr line.
    pub fn last_stderr_line(&self) -> Option<&str> {
        self.stderr_tail
            .iter()
            .rev()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
    }
}

/// What a session reports to its owner, in order: zero or more lines, then `Exited` once.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvent {
    Line(StreamEvent),
    Exited(ExitInfo),
}

/// A running Claude Code process.
pub struct Session {
    pid: u32,
    /// Ends what is left of the process tree when the session is dropped (Windows).
    _group: process::ChildGroup,
    stdin: Mutex<Option<ChildStdin>>,
    next_request: Mutex<u64>,
}

impl Session {
    /// Spawns the process and its reader threads. `on_event` is called from those threads and must
    /// not block for long (typically it sends into a channel).
    pub fn spawn(
        config: &SessionConfig,
        on_event: impl Fn(SessionEvent) + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let mut cmd = launch::command(&config.program, &config.env, config.args())?;
        cmd.current_dir(&config.cwd)
            .env_clear()
            .envs(&config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (mut child, group) = process::spawn_in_new_group(&mut cmd)?;
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let on_event = Arc::new(on_event);

        let (stdout_done_tx, stdout_done_rx) = mpsc::channel::<()>();
        let reader_events = Arc::clone(&on_event);
        thread::Builder::new()
            .name(format!("claude-{pid}-stdout"))
            .spawn(move || {
                let mut reader = BufReader::with_capacity(64 * 1024, stdout);
                let mut buf = Vec::new();
                while let Ok(Some(complete)) =
                    read_line_capped(&mut reader, &mut buf, MAX_LINE_BYTES)
                {
                    if !complete {
                        continue;
                    }
                    let line = String::from_utf8_lossy(&buf);
                    if let Some(event) = protocol::parse_line(&line) {
                        reader_events(SessionEvent::Line(event));
                    }
                }
                let _ = stdout_done_tx.send(());
            })?;

        let tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
        let (stderr_done_tx, stderr_done_rx) = mpsc::channel::<()>();
        let stderr_tail = Arc::clone(&tail);
        thread::Builder::new()
            .name(format!("claude-{pid}-stderr"))
            .spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut buf = Vec::new();
                while let Ok(Some(_)) = read_line_capped(&mut reader, &mut buf, STDERR_LINE_BYTES) {
                    let line = String::from_utf8_lossy(&buf).trim_end().to_owned();
                    let mut tail = stderr_tail.lock().unwrap_or_else(PoisonError::into_inner);
                    if tail.len() == STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
                let _ = stderr_done_tx.send(());
            })?;

        thread::Builder::new()
            .name(format!("claude-{pid}-wait"))
            .spawn(move || {
                let status = child.wait();
                // A grandchild may keep the pipes open; never wait for them for long.
                let _ = stdout_done_rx.recv_timeout(DRAIN_TIMEOUT);
                let _ = stderr_done_rx.recv_timeout(Duration::from_millis(200));
                let stderr_tail = tail
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .iter()
                    .cloned()
                    .collect();
                let (code, signal) = match status {
                    Ok(status) => (status.code(), exit_signal(&status)),
                    Err(_) => (None, None),
                };
                on_event(SessionEvent::Exited(ExitInfo {
                    code,
                    signal,
                    stderr_tail,
                }));
            })?;

        Ok(Self {
            pid,
            _group: group,
            stdin: Mutex::new(stdin),
            next_request: Mutex::new(0),
        })
    }

    /// Process id (and on Unix the process group id) of the Claude process.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Sends one user message.
    pub fn send_user(&self, text: &str) -> io::Result<()> {
        self.write_line(&protocol::user_message_line(text))
    }

    /// Sends an interrupt and returns its request id (the `control_response` carries it).
    pub fn interrupt(&self) -> io::Result<String> {
        let id = {
            let mut next = self
                .next_request
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            *next += 1;
            format!("vidai-interrupt-{}", *next)
        };
        self.write_line(&protocol::interrupt_line(&id))?;
        Ok(id)
    }

    /// Closes stdin. While Claude is idle this makes it exit cleanly; it also ends Claude's own
    /// background tasks. Idempotent.
    pub fn close_stdin(&self) {
        self.stdin
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }

    fn write_line(&self, line: &str) -> io::Result<()> {
        let mut stdin = self.stdin.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(pipe) = stdin.as_mut() else {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "stdin is closed"));
        };
        pipe.write_all(line.as_bytes())?;
        pipe.write_all(b"\n")?;
        pipe.flush()
    }
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

/// Reads one line into `buf` (without the newline), keeping at most `max` bytes. Returns
/// `Ok(None)` at end of input, `Ok(Some(true))` for a complete line and `Ok(Some(false))` for a
/// line that was longer than `max` (its content is then incomplete and should be skipped).
pub fn read_line_capped(
    reader: &mut impl BufRead,
    buf: &mut Vec<u8>,
    max: usize,
) -> io::Result<Option<bool>> {
    buf.clear();
    let mut complete = true;
    let mut read_any = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            return Ok(read_any.then_some(complete));
        }
        read_any = true;
        let (chunk, found, used) = match available.iter().position(|b| *b == b'\n') {
            Some(i) => (&available[..i], true, i + 1),
            None => (available, false, available.len()),
        };
        let room = max.saturating_sub(buf.len());
        if chunk.len() > room {
            complete = false;
        }
        buf.extend_from_slice(&chunk[..chunk.len().min(room)]);
        reader.consume(used);
        if found {
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(Some(complete));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Completion tracking
// ---------------------------------------------------------------------------------------------

/// What one observed line meant for the job.
#[derive(Debug, Clone, PartialEq)]
pub enum Observed {
    Nothing,
    /// A `result` that answered a message (or ended a turn Claude started by itself).
    TurnEnded(TurnResult),
    /// The empty `result` after `--resume` or a stale task notification; not an answer.
    EmptyResult,
    /// A `result` reporting an error.
    Error(TurnResult),
}

/// Where Claude stands, as far as the stream tells.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Activity {
    /// A message is unanswered or a turn is in progress.
    Working,
    /// The turn ended but background tasks still run; Claude will start a new turn by itself.
    WaitingForBackground(usize),
    /// Nothing is pending; finished once this has lasted for the settle time.
    Idle,
}

/// The pure completion logic of SPEC section 6 ("A `result` ends one turn, not the job").
#[derive(Debug, Clone)]
pub struct TurnTracker {
    /// Messages sent and not yet answered by a counted result.
    unanswered: u32,
    /// A top-level turn is in progress (assistant or user output, an init, or a task
    /// notification that will start a new turn).
    in_turn: bool,
    /// Active background tasks by id, with their description.
    background: BTreeMap<String, Option<String>>,
    /// Every background task id seen in this process, active or not.
    seen_background: BTreeSet<String>,
    last_line: Instant,
    answered_once: bool,
    /// Tool calls that were started with a time limit of their own and have no result yet, by
    /// tool use id: a command the model allowed an hour is silent for up to an hour.
    limited_tools: BTreeMap<String, Duration>,
}

/// How long past its own time limit a tool call may stay silent before the job is stalled.
const TOOL_GRACE: Duration = Duration::from_secs(120);

const TERMINAL_TASK_STATES: [&str; 5] = ["completed", "failed", "killed", "stopped", "cancelled"];

impl TurnTracker {
    pub fn new(now: Instant) -> Self {
        Self {
            unanswered: 0,
            in_turn: false,
            background: BTreeMap::new(),
            seen_background: BTreeSet::new(),
            last_line: now,
            answered_once: false,
            limited_tools: BTreeMap::new(),
        }
    }

    /// How long the process may stay silent before it counts as stalled: `base`, or, while a tool
    /// call runs that was given a longer time limit (the `timeout` of a `Bash` call, in
    /// milliseconds), that limit and a short grace. The tool ends by its own limit, so a command
    /// that is silent for half an hour (a transcription on a slow computer) is not a hang.
    pub fn stall_limit(&self, base: Duration) -> Duration {
        self.limited_tools
            .values()
            .max()
            .map_or(base, |limit| base.max(*limit + TOOL_GRACE))
    }

    /// A user message was written to stdin.
    pub fn message_sent(&mut self, now: Instant) {
        self.unanswered += 1;
        self.last_line = now;
    }

    /// Feeds one stdout line.
    pub fn observe(&mut self, event: &StreamEvent, now: Instant) -> Observed {
        self.last_line = now;
        match event {
            StreamEvent::Assistant(m) | StreamEvent::User(m) => {
                if !m.is_nested() {
                    self.in_turn = true;
                }
                for block in &m.content {
                    match block {
                        Block::ToolUse { id, input, .. } => {
                            if let Some(ms) = input.get("timeout").and_then(|t| t.as_u64()) {
                                self.limited_tools
                                    .insert(id.clone(), Duration::from_millis(ms));
                            }
                        }
                        Block::ToolResult { tool_use_id, .. } => {
                            self.limited_tools.remove(tool_use_id);
                        }
                        _ => {}
                    }
                }
            }
            StreamEvent::System(system) => match system {
                SystemEvent::Init { .. } => self.in_turn = true,
                SystemEvent::TaskStarted {
                    task_id,
                    description,
                    backgrounded: true,
                    ..
                } => {
                    self.seen_background.insert(task_id.clone());
                    self.background.insert(task_id.clone(), description.clone());
                }
                SystemEvent::TaskUpdated {
                    task_id,
                    status: Some(status),
                } if TERMINAL_TASK_STATES.contains(&status.as_str()) => {
                    self.background.remove(task_id);
                }
                SystemEvent::TaskNotification { task_id, .. } => {
                    // A finished background task makes Claude start a new turn by itself. (The
                    // task is often already gone through `task_updated` at this point.)
                    self.background.remove(task_id);
                    if self.seen_background.contains(task_id) {
                        self.in_turn = true;
                    }
                }
                SystemEvent::BackgroundTasksChanged { tasks } => {
                    self.seen_background
                        .extend(tasks.iter().map(|t| t.task_id.clone()));
                    self.background = tasks
                        .iter()
                        .map(|t| (t.task_id.clone(), t.description.clone()))
                        .collect();
                }
                _ => {}
            },
            StreamEvent::Result(result) => {
                self.in_turn = false;
                if result.is_empty() {
                    return Observed::EmptyResult;
                }
                self.unanswered = self.unanswered.saturating_sub(1);
                self.answered_once = true;
                if result.is_error {
                    return Observed::Error(result.clone());
                }
                return Observed::TurnEnded(result.clone());
            }
            _ => {}
        }
        Observed::Nothing
    }

    pub fn activity(&self) -> Activity {
        if self.unanswered > 0 || self.in_turn {
            Activity::Working
        } else if !self.background.is_empty() {
            Activity::WaitingForBackground(self.background.len())
        } else {
            Activity::Idle
        }
    }

    /// Descriptions of the active background tasks.
    pub fn background_tasks(&self) -> Vec<String> {
        self.background
            .iter()
            .map(|(id, d)| d.clone().unwrap_or_else(|| id.clone()))
            .collect()
    }

    /// At least one counted result arrived since this process started.
    pub fn answered_once(&self) -> bool {
        self.answered_once
    }

    /// Claude is finished: idle for at least `settle` since the last line.
    pub fn is_finished(&self, now: Instant, settle: Duration) -> bool {
        self.activity() == Activity::Idle && now.duration_since(self.last_line) >= settle
    }

    /// Time since the last line.
    pub fn quiet_for(&self, now: Instant) -> Duration {
        now.duration_since(self.last_line)
    }

    /// When the finished check should run again (`None`: only a new line can change anything).
    pub fn settle_deadline(&self, settle: Duration) -> Option<Instant> {
        (self.activity() == Activity::Idle).then(|| self.last_line + settle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::protocol::parse_line;
    use std::io::Cursor;

    fn config(mode: SessionMode, model: Option<&str>, effort: Option<&str>) -> SessionConfig {
        SessionConfig {
            program: "/bin/claude".into(),
            cwd: "/tmp".into(),
            env: HashMap::new(),
            mode,
            model: model.map(Into::into),
            effort: effort.map(Into::into),
        }
    }

    #[test]
    fn args_match_spec() {
        let base = "-p --input-format stream-json --output-format stream-json --verbose --permission-mode bypassPermissions";
        assert_eq!(
            config(SessionMode::New("s1".into()), None, None)
                .args()
                .join(" "),
            format!("{base} --session-id s1")
        );
        assert_eq!(
            config(SessionMode::Resume("s2".into()), Some("opus"), Some("high"))
                .args()
                .join(" "),
            format!("{base} --model opus --effort high --resume s2")
        );
        assert_eq!(
            config(SessionMode::Resume("s3".into()), Some(" "), None)
                .args()
                .join(" "),
            format!("{base} --resume s3")
        );
    }

    #[test]
    fn capped_line_reader() {
        let mut reader = Cursor::new(b"short\r\nthis line is long\nlast".to_vec());
        let mut buf = Vec::new();
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 8).unwrap(),
            Some(true)
        );
        assert_eq!(buf, b"short");
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 8).unwrap(),
            Some(false)
        );
        assert_eq!(buf, b"this lin");
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 8).unwrap(),
            Some(true)
        );
        assert_eq!(buf, b"last");
        assert_eq!(read_line_capped(&mut reader, &mut buf, 8).unwrap(), None);
        // A tiny internal buffer splits lines across reads.
        let mut reader = BufReader::with_capacity(2, Cursor::new(b"abcdef\nxy\n".to_vec()));
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 100).unwrap(),
            Some(true)
        );
        assert_eq!(buf, b"abcdef");
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 100).unwrap(),
            Some(true)
        );
        assert_eq!(buf, b"xy");
    }

    fn feed(tracker: &mut TurnTracker, file: &str, now: Instant) -> Vec<Observed> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/claude-stream")
            .join(file);
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter_map(parse_line)
            .map(|e| tracker.observe(&e, now))
            .filter(|o| *o != Observed::Nothing)
            .collect()
    }

    fn lines(text: &str) -> Vec<StreamEvent> {
        text.lines().filter_map(parse_line).collect()
    }

    #[test]
    fn a_tool_call_with_a_longer_time_limit_is_silent_that_long() {
        let t0 = Instant::now();
        let mut t = TurnTracker::new(t0);
        let base = Duration::from_secs(20 * 60);
        assert_eq!(t.stall_limit(base), base);
        let call = |id: &str, timeout: u64| {
            parse_line(
                &serde_json::json!({"type": "assistant", "message": {"content": [
                    {"type": "tool_use", "id": id, "name": "Bash",
                     "input": {"command": "x", "timeout": timeout}}]}})
                .to_string(),
            )
            .unwrap()
        };
        // An hour-long command: silent up to that hour and two minutes of grace.
        t.observe(&call("a", 3_600_000), t0);
        assert_eq!(t.stall_limit(base), Duration::from_secs(62 * 60));
        // A short limit never lowers the base; the longest running limit counts.
        t.observe(&call("b", 120_000), t0);
        assert_eq!(t.stall_limit(base), Duration::from_secs(62 * 60));
        let result = |id: &str| {
            parse_line(
                &serde_json::json!({"type": "user", "message": {"content": [
                    {"type": "tool_result", "tool_use_id": id, "content": "ok"}]}})
                .to_string(),
            )
            .unwrap()
        };
        t.observe(&result("a"), t0);
        assert_eq!(t.stall_limit(base), base);
        t.observe(&result("b"), t0);
        assert_eq!(t.stall_limit(base), base);
    }

    #[test]
    fn background_task_keeps_the_job_open_after_the_first_result() {
        let t0 = Instant::now();
        let mut t = TurnTracker::new(t0);
        t.message_sent(t0);
        // Replay the recording line by line and check the state after the first result.
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/claude-stream/01_background_task.jsonl");
        let text = std::fs::read_to_string(path).unwrap();
        let mut results = 0;
        for event in lines(&text) {
            if let Observed::TurnEnded(_) = t.observe(&event, t0) {
                results += 1;
                if results == 1 {
                    assert_eq!(t.activity(), Activity::WaitingForBackground(1));
                    assert_eq!(
                        t.background_tasks(),
                        vec!["Sleep 10 seconds then echo slept"]
                    );
                    assert!(!t.is_finished(t0 + Duration::from_secs(3600), Duration::ZERO));
                }
            }
        }
        assert_eq!(results, 2);
        assert_eq!(t.activity(), Activity::Idle);
        let settle = Duration::from_secs(2);
        assert!(!t.is_finished(t0 + Duration::from_secs(1), settle));
        assert!(t.is_finished(t0 + settle, settle));
        assert_eq!(t.settle_deadline(settle), Some(t0 + settle));
    }

    #[test]
    fn notification_between_turns_counts_as_work() {
        let t0 = Instant::now();
        let mut t = TurnTracker::new(t0);
        t.message_sent(t0);
        for e in lines(concat!(
            r#"{"type":"system","subtype":"task_started","task_id":"b1","is_backgrounded":true,"description":"render"}"#,
            "\n",
            r#"{"type":"result","subtype":"success","num_turns":2,"is_error":false}"#,
            "\n",
            r#"{"type":"system","subtype":"task_notification","task_id":"b1","status":"completed"}"#,
        )) {
            t.observe(&e, t0);
        }
        // The background task is gone, but its notification starts a new turn.
        assert_eq!(t.activity(), Activity::Working);
        for e in lines(r#"{"type":"result","subtype":"success","num_turns":1,"is_error":false}"#) {
            t.observe(&e, t0);
        }
        assert_eq!(t.activity(), Activity::Idle);
    }

    #[test]
    fn empty_result_after_resume_is_not_the_answer() {
        let t0 = Instant::now();
        let mut t = TurnTracker::new(t0);
        t.message_sent(t0);
        let observed = feed(&mut t, "06_resume_empty_result.jsonl", t0);
        assert_eq!(observed[0], Observed::EmptyResult);
        assert!(matches!(&observed[1], Observed::TurnEnded(r) if r.text.as_deref() == Some("HI")));
        assert_eq!(t.activity(), Activity::Idle);

        // Stopping right after the empty result: still working on the message.
        let mut t = TurnTracker::new(t0);
        t.message_sent(t0);
        let text = std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/claude-stream/06_resume_empty_result.jsonl"),
        )
        .unwrap();
        for e in lines(&text) {
            let o = t.observe(&e, t0);
            if o == Observed::EmptyResult {
                break;
            }
        }
        assert_eq!(t.activity(), Activity::Working);
        assert!(!t.answered_once());
    }

    #[test]
    fn missing_session_is_an_error_result() {
        let t0 = Instant::now();
        let mut t = TurnTracker::new(t0);
        t.message_sent(t0);
        let observed = feed(&mut t, "04_resume_missing_session.jsonl", t0);
        assert!(matches!(&observed[0], Observed::Error(r) if r.is_resume_not_found()));
    }

    #[test]
    fn sub_agent_output_does_not_open_a_main_turn() {
        let t0 = Instant::now();
        let mut t = TurnTracker::new(t0);
        for e in lines(concat!(
            r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a1","description":"Research"}]}"#,
            "\n",
            r#"{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"content":[{"type":"text","text":"working"}]}}"#,
        )) {
            t.observe(&e, t0);
        }
        assert_eq!(t.activity(), Activity::WaitingForBackground(1));
        for e in lines(r#"{"type":"system","subtype":"background_tasks_changed","tasks":[]}"#) {
            t.observe(&e, t0);
        }
        assert_eq!(t.activity(), Activity::Idle);
    }

    #[test]
    fn interrupt_recording_ends_the_turn_with_an_aborted_error() {
        let t0 = Instant::now();
        let mut t = TurnTracker::new(t0);
        t.message_sent(t0);
        let observed = feed(&mut t, "02_subagent_interrupt.jsonl", t0);
        assert_eq!(observed.len(), 1);
        assert!(matches!(&observed[0], Observed::Error(r) if r.is_interrupted()));
        assert_eq!(t.activity(), Activity::Idle);
    }

    /// A minimal environment on Unix. Windows processes need the system variables, and there the
    /// script runs with Git Bash.
    fn test_env() -> HashMap<String, String> {
        if cfg!(windows) {
            std::env::vars().collect()
        } else {
            HashMap::from([("PATH".into(), "/usr/bin:/bin".into())])
        }
    }

    #[test]
    fn spawns_a_process_and_reports_lines_then_exit() {
        let script = r#"read -r line; printf '%s\n' '{"type":"system","subtype":"init","session_id":"s"}'; printf 'oops\n' >&2; printf '%s\n' "$line" | grep -q '"text":"hi"' && exit 3; exit 4"#;
        let dir = tempfile::TempDir::new().unwrap();
        let program = dir.path().join("fake");
        std::fs::write(&program, format!("#!/bin/sh\n{script}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let config = SessionConfig {
            program,
            cwd: dir.path().into(),
            env: test_env(),
            mode: SessionMode::New("s".into()),
            model: None,
            effort: None,
        };
        let session = Session::spawn(&config, move |e| {
            let _ = tx.lock().unwrap().send(e);
        })
        .unwrap();
        assert!(session.pid() > 0);
        session.send_user("hi").unwrap();
        let first = rx.recv_timeout(Duration::from_secs(60)).unwrap();
        assert!(matches!(
            first,
            SessionEvent::Line(StreamEvent::System(SystemEvent::Init { .. }))
        ));
        let exit = rx.recv_timeout(Duration::from_secs(60)).unwrap();
        let SessionEvent::Exited(info) = exit else {
            panic!("{exit:?}")
        };
        assert_eq!(info.code, Some(3));
        assert_eq!(info.last_stderr_line(), Some("oops"));
        session.close_stdin();
        assert!(session.send_user("again").is_err());
    }
}

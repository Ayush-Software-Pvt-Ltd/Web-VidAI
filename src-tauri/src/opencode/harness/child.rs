//! What the OpenCode 2 server of a job is built on (`server2`): the server process itself (started
//! in a process group of its own, its listening line, the tail of its stderr, its exit reported
//! once as `SessionEvent::Exited`, signals to its group), the HTTP clients that reach it on this
//! computer, and the reader of its event stream.

use std::collections::VecDeque;
use std::io::{self, Read};
use std::path::Path;
use std::process::{ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::claude::session::{ExitInfo, SessionEvent};
use crate::platform::{launch as platform_launch, process};

/// How long a server may take to say it is ready. Generous on purpose: a first start on a Mac
/// that never ran OpenCode can migrate its database, unpack itself and let the system check the
/// new program, and a failing start says why long before this (it exits, or prints). 30 seconds
/// were not enough on an Intel Mac.
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(180);
/// When the first "still waiting" notice is given, and how often the next ones follow.
pub const STARTUP_NOTICE_FIRST: Duration = Duration::from_secs(8);
pub const STARTUP_NOTICE_EVERY: Duration = Duration::from_secs(15);
/// How often the readiness probe asks a server that has not announced itself yet.
const PROBE_EVERY: Duration = Duration::from_millis(500);
/// How long the event stream may take to connect.
const SUBSCRIBE_TIMEOUT: Duration = Duration::from_secs(10);
/// Every request but the event stream.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the waiter lets the event stream drain after the server exited.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const TAIL_LINES: usize = 20;

const LINE_BYTES: usize = 2_000;
/// How many of the last lines a failed start puts into its error.
const FAILURE_LINES: usize = 4;
/// How long a failed request waits to see whether the server died (then its exit says why).
pub const EXIT_NOTICE: Duration = Duration::from_secs(2);

/// What a job's server needs to reach its model: the API option, its key, the normalized address
/// (`None`: the default) and the model id.
#[derive(Clone, Copy)]
pub struct Gateway<'a> {
    pub option: crate::model::ApiOption,
    /// `None` when the option's key is optional and not saved.
    pub key: Option<&'a str>,
    pub base_url: Option<&'a str>,
    pub model_id: &'a str,
    /// The model's reasoning effort (`None`: the model's default).
    pub effort: Option<&'a str>,
}

/// Where the events of a server go (`SessionEvent::Line`, then `Exited` once).
pub type Callback = Arc<dyn Fn(SessionEvent) + Send + Sync>;

/// How to start one server process.
pub struct Spawn<'a> {
    pub program: &'a Path,
    pub args: Vec<String>,
    pub cwd: &'a Path,
    pub env: &'a std::collections::HashMap<String, String>,
    /// Keep a pipe to the server's stdin (OpenCode 2's `--stdio` ends when it closes).
    pub stdin: bool,
    /// The server's address from one line of its stdout, once it listens.
    pub listening: fn(&str) -> Option<String>,
}

/// How a server start is waited for: the limit, the notices while it takes long, and (for a
/// server whose port is known beforehand) a probe that asks whether it answers, so a server
/// that does not print the expected listening line is still found.
pub struct StartWait<'a> {
    pub timeout: Duration,
    pub first_notice: Duration,
    pub notice_every: Duration,
    /// Called every half second until the server is ready; `Some(url)` says it is.
    pub probe: Option<&'a dyn Fn() -> Option<String>>,
    /// Told "still waiting" notices (one line each) for the log.
    pub on_status: &'a dyn Fn(&str),
}

/// The limits of a server start (`Timings` of the job engine), for tests to shorten.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartLimits {
    pub timeout: Duration,
    pub first_notice: Duration,
    pub notice_every: Duration,
}

impl Default for StartLimits {
    fn default() -> Self {
        Self {
            timeout: STARTUP_TIMEOUT,
            first_notice: STARTUP_NOTICE_FIRST,
            notice_every: STARTUP_NOTICE_EVERY,
        }
    }
}

impl StartLimits {
    pub fn wait<'a>(
        &self,
        probe: Option<&'a dyn Fn() -> Option<String>>,
        on_status: &'a dyn Fn(&str),
    ) -> StartWait<'a> {
        StartWait {
            timeout: self.timeout,
            first_notice: self.first_notice,
            notice_every: self.notice_every,
            probe,
            on_status,
        }
    }
}

/// The output of a server that is starting: the last lines it printed (stdout lines that were
/// not its listening line, and stderr) and the half line each stream has at the moment (a
/// progress display ends its lines with a carriage return or not at all).
#[derive(Default)]
struct Output {
    lines: VecDeque<String>,
    partial_out: String,
    partial_err: String,
}

impl Output {
    fn push_line(&mut self, line: String) {
        let line = line.trim().to_owned();
        if line.is_empty() {
            return;
        }
        if self.lines.len() == TAIL_LINES {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }

    /// The last `n` lines, oldest first, and the half line of each stream last.
    fn last(&self, n: usize) -> Vec<String> {
        let mut all: Vec<String> = self.lines.iter().cloned().collect();
        for partial in [&self.partial_out, &self.partial_err] {
            let partial = partial.trim();
            if !partial.is_empty() {
                all.push(partial.to_owned());
            }
        }
        let skip = all.len().saturating_sub(n);
        all.split_off(skip)
    }
}

/// Splits what a pipe delivers into lines at `\n` and `\r`, keeping the half line.
#[derive(Default)]
struct Lines {
    half: Vec<u8>,
}

impl Lines {
    /// The lines `chunk` completes. A line longer than the cap is cut.
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut done = Vec::new();
        for &byte in chunk {
            if byte == b'\n' || byte == b'\r' {
                if !self.half.is_empty() {
                    done.push(String::from_utf8_lossy(&self.half).into_owned());
                    self.half.clear();
                }
            } else if self.half.len() < LINE_BYTES {
                self.half.push(byte);
            }
        }
        done
    }

    fn half(&self) -> String {
        String::from_utf8_lossy(&self.half).into_owned()
    }

    /// The end of the stream turns the half line into a line.
    fn finish(&mut self) -> Option<String> {
        (!self.half.is_empty()).then(|| {
            let line = String::from_utf8_lossy(&self.half).into_owned();
            self.half.clear();
            line
        })
    }
}

/// A running server process. Nothing of it is reported until [`ServerChild::arm`].
pub struct ServerChild {
    pub pid: u32,
    /// The process has ended (its process group id may be reused, so it is not signalled any
    /// more).
    pub exited: Arc<AtomicBool>,
    armed: Arc<AtomicBool>,
    program: String,
    output: Arc<Mutex<Output>>,
    stderr_closed: Arc<AtomicBool>,
    stdin: Mutex<Option<ChildStdin>>,
    /// The listening line and the exit, while the server starts.
    startup: Mutex<(mpsc::Receiver<String>, mpsc::Receiver<()>)>,
    /// Ends what is left of the process tree when the server is dropped (Windows).
    _group: process::ChildGroup,
}

impl ServerChild {
    /// Starts the server. `stream_done` is signalled when its event stream ends, so the exit is
    /// reported only after the last events (or after a short wait).
    pub fn spawn(
        spawn: &Spawn,
        on_event: Callback,
        stream_done: mpsc::Receiver<()>,
    ) -> io::Result<Self> {
        let mut cmd = platform_launch::command(spawn.program, spawn.env, spawn.args.clone())?;
        cmd.current_dir(spawn.cwd)
            .env_clear()
            .envs(spawn.env)
            .stdin(if spawn.stdin {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (mut child, group) = process::spawn_in_new_group(&mut cmd)?;
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");

        let output = Arc::new(Mutex::new(Output::default()));

        // stdout: the listening line, then drained so the pipe never fills. Every other line is
        // kept for the error of a start that fails.
        let (url_tx, url) = mpsc::channel::<String>();
        let listening = spawn.listening;
        let stdout_output = Arc::clone(&output);
        thread::Builder::new()
            .name(format!("opencode-{pid}-stdout"))
            .spawn(move || {
                let mut reader = stdout;
                let mut lines = Lines::default();
                let mut chunk = [0u8; 4096];
                let mut sent = false;
                let mut handle = |line: String| {
                    if sent {
                        return;
                    }
                    if let Some(found) = listening(line.trim()) {
                        sent = true;
                        let _ = url_tx.send(found);
                    } else {
                        stdout_output
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .push_line(line);
                    }
                };
                loop {
                    match reader.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            for line in lines.push(&chunk[..n]) {
                                handle(line);
                            }
                            stdout_output
                                .lock()
                                .unwrap_or_else(PoisonError::into_inner)
                                .partial_out = lines.half();
                        }
                    }
                }
                if let Some(line) = lines.finish() {
                    handle(line);
                }
                stdout_output
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .partial_out
                    .clear();
            })?;

        let (stderr_done_tx, stderr_done_rx) = mpsc::channel::<()>();
        let stderr_closed = Arc::new(AtomicBool::new(false));
        let stderr_closed_by_reader = Arc::clone(&stderr_closed);
        let stderr_output = Arc::clone(&output);
        thread::Builder::new()
            .name(format!("opencode-{pid}-stderr"))
            .spawn(move || {
                let mut reader = stderr;
                let mut lines = Lines::default();
                let mut chunk = [0u8; 4096];
                loop {
                    match reader.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let done = lines.push(&chunk[..n]);
                            let mut out =
                                stderr_output.lock().unwrap_or_else(PoisonError::into_inner);
                            for line in done {
                                out.push_line(line);
                            }
                            out.partial_err = lines.half();
                        }
                    }
                }
                {
                    let mut out = stderr_output.lock().unwrap_or_else(PoisonError::into_inner);
                    if let Some(line) = lines.finish() {
                        out.push_line(line);
                    }
                    out.partial_err.clear();
                }
                stderr_closed_by_reader.store(true, Ordering::SeqCst);
                let _ = stderr_done_tx.send(());
            })?;

        let (exited_tx, exited_rx) = mpsc::channel::<()>();
        let exited = Arc::new(AtomicBool::new(false));
        let armed = Arc::new(AtomicBool::new(false));
        let waiter_exited = Arc::clone(&exited);
        let waiter_armed = Arc::clone(&armed);
        let waiter_output = Arc::clone(&output);
        thread::Builder::new()
            .name(format!("opencode-{pid}-wait"))
            .spawn(move || {
                let status = child.wait();
                waiter_exited.store(true, Ordering::SeqCst);
                let _ = exited_tx.send(());
                let _ = stream_done.recv_timeout(DRAIN_TIMEOUT);
                let _ = stderr_done_rx.recv_timeout(Duration::from_millis(200));
                let stderr_tail = waiter_output
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .last(TAIL_LINES);
                let (code, signal) = match status {
                    Ok(status) => (status.code(), exit_signal(&status)),
                    Err(_) => (None, None),
                };
                if waiter_armed.load(Ordering::SeqCst) {
                    on_event(SessionEvent::Exited(ExitInfo {
                        code,
                        signal,
                        stderr_tail,
                    }));
                }
            })?;

        Ok(Self {
            pid,
            exited,
            armed,
            program: spawn.program.to_string_lossy().into_owned(),
            output,
            stderr_closed,
            stdin: Mutex::new(stdin),
            startup: Mutex::new((url, exited_rx)),
            _group: group,
        })
    }

    /// From now on events and the exit are reported.
    pub fn arm(&self) {
        self.armed.store(true, Ordering::SeqCst);
    }

    /// Whether events are reported (shared with the reader of the event stream).
    pub fn armed(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.armed)
    }

    /// Waits until the server says where it listens (its stdout line, or the probe), it exits, or
    /// the limit is over; says "still waiting" through `wait.on_status` while it takes long.
    pub fn wait_for_url(&self, wait: &StartWait) -> Result<String, String> {
        let begun = Instant::now();
        let startup = self.startup.lock().unwrap_or_else(PoisonError::into_inner);
        let (url, exited) = &*startup;
        let mut next_notice = wait.first_notice;
        let mut next_probe = Instant::now();
        loop {
            match url.recv_timeout(Duration::from_millis(50)) {
                Ok(url) => return Ok(url),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // The reader of stdout ended: the process is gone or closed its stdout.
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if exited.try_recv().is_ok() || self.exited.load(Ordering::SeqCst) {
                // A listening line printed just before the exit still counts as an answer.
                if let Ok(url) = url.try_recv() {
                    return Ok(url);
                }
                return Err("OpenCode ended before it was ready".into());
            }
            if let Some(probe) = wait.probe
                && Instant::now() >= next_probe
            {
                if let Some(url) = probe() {
                    return Ok(url);
                }
                next_probe = Instant::now() + PROBE_EVERY;
            }
            let elapsed = begun.elapsed();
            if elapsed >= wait.timeout {
                return Err(format!(
                    "OpenCode did not become ready within {} seconds{}",
                    wait.timeout.as_secs(),
                    self.silence_note()
                ));
            }
            if elapsed >= next_notice {
                (wait.on_status)(&format!(
                    "Still waiting for OpenCode to start ({} s)",
                    elapsed.as_secs()
                ));
                next_notice = elapsed + wait.notice_every;
            }
        }
    }

    /// What to tell about a server that is alive but has said nothing: it prints nothing, and how
    /// to see what it is doing.
    fn silence_note(&self) -> String {
        let said_something = !self
            .output
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .last(1)
            .is_empty();
        if said_something {
            String::new()
        } else {
            format!(
                ", and it printed nothing. To see what it is waiting for, run \"{} serve\" in {}; if that hangs too, reinstall OpenCode",
                self.program,
                if cfg!(windows) {
                    "PowerShell"
                } else {
                    "Terminal"
                }
            )
        }
    }

    /// Ends a server that failed to start and says why, with the last lines it printed.
    pub fn failure(&self, message: String) -> io::Error {
        self.signal("KILL");
        // What the server printed says why; give the readers a moment to get it.
        let deadline = Instant::now() + Duration::from_millis(500);
        while !self.stderr_closed.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let last = self
            .output
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .last(FAILURE_LINES);
        if last.is_empty() {
            io::Error::other(message)
        } else {
            io::Error::other(format!("{message} ({})", last.join(" | ")))
        }
    }

    /// Whether the server process ends within `wait`.
    pub fn ended_within(&self, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        while !self.exited.load(Ordering::SeqCst) {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(20));
        }
        true
    }

    /// Closes the pipe to the server's stdin, if there is one. Idempotent.
    pub fn close_stdin(&self) {
        drop(
            self.stdin
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take(),
        );
    }

    /// Sends `signal` (`TERM`, `KILL`) to the server's process group, which it leads, unless the
    /// server has already ended. The tools it started run in groups of their own; the caller ends
    /// them with the process tree (`platform::process::ProcessTree`), as for Claude Code.
    ///
    /// Windows has no polite signal for a process without a window (SPEC section 11): `TERM`
    /// does nothing there (closing the server's stdin has already asked it to end), and `KILL`
    /// ends the whole tree at once by closing the server's job object.
    pub fn signal(&self, signal: &str) {
        if self.exited.load(Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-s", signal, "--", &format!("-{}", self.pid)])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        #[cfg(not(unix))]
        {
            if signal == "KILL" {
                process::ProcessTree::group(self.pid).terminate(Duration::ZERO);
            }
        }
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

// ---------------------------------------------------------------------------------------------
// HTTP on this computer
// ---------------------------------------------------------------------------------------------

/// The two clients of one server: `client` for requests (with a time limit), `stream` for the
/// event stream (without). Both go to 127.0.0.1 only, without a proxy, and follow no redirect.
pub struct Clients {
    pub client: reqwest::Client,
    pub stream: reqwest::Client,
}

impl Clients {
    pub fn new() -> Result<Self, String> {
        let builder = || {
            reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .user_agent(concat!("VidAI/", env!("CARGO_PKG_VERSION")))
        };
        Ok(Self {
            client: builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .map_err(|e| e.to_string())?,
            stream: builder().build().map_err(|e| e.to_string())?,
        })
    }
}

/// Sends one request and returns its status and body, or why there was none.
pub fn send(request: reqwest::RequestBuilder) -> Result<(u16, Vec<u8>), String> {
    tauri::async_runtime::block_on(async move {
        let response = request.send().await.map_err(|e| describe(&e))?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await.map_err(|e| describe(&e))?;
        Ok((status, bytes.to_vec()))
    })
}

/// Sends one request without waiting for it (answers to permission requests and the like).
pub fn send_detached(request: reqwest::RequestBuilder, what: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = request.send().await {
            eprintln!(
                "vidai: could not answer OpenCode ({what}): {}",
                describe(&err)
            );
        }
    });
}

pub fn with_json(request: reqwest::RequestBuilder, body: &Value) -> reqwest::RequestBuilder {
    request
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
}

pub fn describe(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "OpenCode did not answer in time".into()
    } else if err.is_connect() {
        format!(
            "Could not reach the OpenCode server on this {}",
            if cfg!(windows) { "PC" } else { "Mac" }
        )
    } else {
        format!("The request to OpenCode failed: {err}")
    }
}

/// Connects the event stream (`request`) and waits for its first event (`server.connected` in
/// both programs); then a task reads it and hands the `data` of every event to `on_data`, and
/// signals `done` when the stream ends.
pub fn subscribe(
    request: reqwest::RequestBuilder,
    mut on_data: impl FnMut(&str) + Send + 'static,
    done: mpsc::Sender<()>,
) -> Result<(), String> {
    let request = request.header("accept", "text/event-stream");
    let (connected_tx, connected_rx) = mpsc::channel::<Result<(), String>>();
    tauri::async_runtime::spawn(async move {
        let mut response = match request.send().await {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                let _ = connected_tx.send(Err(format!(
                    "OpenCode refused the event stream (HTTP {})",
                    response.status().as_u16()
                )));
                let _ = done.send(());
                return;
            }
            Err(err) => {
                let _ = connected_tx.send(Err(describe(&err)));
                let _ = done.send(());
                return;
            }
        };
        let mut decoder = SseDecoder::new();
        let mut connected = Some(connected_tx);
        while let Ok(Some(chunk)) = response.chunk().await {
            for data in decoder.push(&chunk) {
                if let Some(tx) = connected.take() {
                    let _ = tx.send(Ok(()));
                }
                on_data(&data);
            }
        }
        let _ = done.send(());
    });
    match connected_rx.recv_timeout(SUBSCRIBE_TIMEOUT) {
        Ok(result) => result,
        Err(_) => Err("OpenCode's event stream did not connect".into()),
    }
}

/// Longest event kept; a longer one is dropped whole.
const MAX_EVENT_BYTES: usize = 16 * 1024 * 1024;

/// Splits a server-sent event stream into the `data` of each event. Bytes may arrive in any
/// pieces; `\n` and `\r\n` line ends both work; comments, `event:` and `id:` lines are ignored.
#[derive(Debug, Default)]
pub struct SseDecoder {
    line: Vec<u8>,
    data: Vec<u8>,
    has_data: bool,
    /// The current line or event is too long and is being skipped.
    overflow: bool,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds bytes and returns the data of every event they complete.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &byte in bytes {
            if byte != b'\n' {
                if self.line.len() + self.data.len() < MAX_EVENT_BYTES {
                    self.line.push(byte);
                } else {
                    self.overflow = true;
                }
                continue;
            }
            if self.line.last() == Some(&b'\r') {
                self.line.pop();
            }
            let line = std::mem::take(&mut self.line);
            if line.is_empty() {
                if self.has_data && !self.overflow {
                    out.push(String::from_utf8_lossy(&self.data).into_owned());
                }
                self.data.clear();
                self.has_data = false;
                self.overflow = false;
                continue;
            }
            if let Some(value) = line.strip_prefix(b"data:") {
                let value = value.strip_prefix(b" ").unwrap_or(value);
                if self.has_data {
                    self.data.push(b'\n');
                }
                self.data.extend_from_slice(value);
                self.has_data = true;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_frames_in_any_pieces() {
        let stream = b"data: {\"a\":1}\n\n: comment\r\nevent: message\r\nid: 7\r\ndata: {\"b\":\r\ndata: 2}\r\n\r\ndata:x\n\n";
        let mut whole = SseDecoder::new();
        let all = whole.push(stream);
        assert_eq!(all, vec!["{\"a\":1}", "{\"b\":\n2}", "x"]);
        let mut pieces = SseDecoder::new();
        let mut got = Vec::new();
        for chunk in stream.chunks(3) {
            got.extend(pieces.push(chunk));
        }
        assert_eq!(got, all);
        // An event without data and an unfinished one give nothing.
        assert!(SseDecoder::new().push(b"event: x\n\ndata: half").is_empty());
    }
}

//! Job logs: human-readable entries from the Claude stream, and their delivery.
//!
//! - [`Describer`] turns stream events into [`Draft`] entries and a short "last activity" line:
//!   tool calls become one line ("Bash: Render graphics at 1080", using the tool's description
//!   when there is one) with the full input in `detail`, sub-agent output is marked `nested`, and
//!   thinking is never logged. Absolute paths in tool lines and tool results are shown relative
//!   to the video folder or the Editing Folder ([`Paths`]); `detail` keeps the original. Progress
//!   marker lines (`[VIDAI_PROGRESS transcribed]`, see `jobs::progress`) become compact status
//!   entries such as "Transcription done" instead of assistant text.
//! - [`LogSink`] assigns increasing `seq` numbers, scrubs every known secret (the OpenCode key), truncates
//!   text and `detail` to `model::MAX_LOG_DETAIL_CHARS`, appends the entries with
//!   `Store::append_log` and emits them as `events::JobLog`, batched at most every 150 ms by one
//!   background thread. Producers never wait for disk I/O.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::claude::protocol::{Block, Message, StreamEvent, SystemEvent};
use crate::events::JobLog;
use crate::jobs::host::{JobHost, Notice};
use crate::jobs::progress;
use crate::model::{LogEntry, LogKind, MAX_LOG_DETAIL_CHARS};

/// Longest one-line summary (tool lines, last activity).
const LINE_CHARS: usize = 160;

/// A log entry before it gets its `seq` and timestamp.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    pub kind: LogKind,
    pub text: String,
    pub detail: Option<String>,
    pub nested: bool,
}

impl Draft {
    pub fn new(kind: LogKind, text: impl Into<String>) -> Self {
        Self {
            kind,
            text: text.into(),
            detail: None,
            nested: false,
        }
    }

    pub fn status(text: impl Into<String>) -> Self {
        Self::new(LogKind::Status, text)
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self::new(LogKind::Error, text)
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        self.detail = (!detail.trim().is_empty()).then_some(detail);
        self
    }

    pub fn nested(mut self, nested: bool) -> Self {
        self.nested = nested;
        self
    }
}

/// Cuts `text` to at most `max` characters, ending with "..." when it was cut.
pub fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let keep = max.saturating_sub(3);
    let mut out: String = text.chars().take(keep).collect();
    out.push_str("...");
    out
}

/// The first non-empty line, shortened to one readable line.
pub fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    truncate_chars(line, LINE_CHARS)
}

/// Shortens absolute paths for one-line summaries: a path inside the video folder is shown
/// relative to it (`CLAUDE_VE/timeline.py`), any other path inside the Editing Folder relative to
/// that (`Channel/Other Video/CLAUDE_VE/notes.md`, `CLAUDE_VE_ALL/tools/cut.py`). Only whole path
/// prefixes are replaced, so `/a/Editing Folder 2/x` stays as it is for `/a/Editing Folder`.
#[derive(Debug, Clone, Default)]
pub struct Paths {
    /// Folder prefixes ending with `/`, most specific first.
    prefixes: Vec<String>,
    /// Windows: prefixes are lowercase with `/` separators and match ignoring letter case and
    /// with `\` or `/` as separator (see [`Paths::new_windows`]).
    folded: bool,
}

impl Paths {
    /// No shortening (tests, lines without a known folder).
    pub fn none() -> Self {
        Self::default()
    }

    /// The folder prefixes of this platform (macOS: [`Paths::new_unix`]; Windows:
    /// [`Paths::new_windows`]).
    pub fn new(editing_folder: &Path, video_dir: &Path) -> Self {
        if cfg!(windows) {
            Self::new_windows(editing_folder, video_dir)
        } else {
            Self::new_unix(editing_folder, video_dir)
        }
    }

    /// Absolute `/` paths, matched exactly.
    pub fn new_unix(editing_folder: &Path, video_dir: &Path) -> Self {
        let prefixes = [video_dir, editing_folder]
            .iter()
            .filter_map(|dir| {
                let dir = dir.to_str()?.trim_end_matches('/');
                // The root or a relative path would match far too much.
                (dir.starts_with('/') && dir.len() > 1).then(|| format!("{dir}/"))
            })
            .collect();
        Self {
            prefixes,
            folded: false,
        }
    }

    /// The Windows form of [`Paths::new`]: Claude Code and its tools write a folder as
    /// `C:\Users\...`, `C:/Users/...` or, in Git Bash, `/c/Users/...`, in any letter case. Each
    /// folder is matched in all of these forms.
    pub fn new_windows(editing_folder: &Path, video_dir: &Path) -> Self {
        let mut prefixes = Vec::new();
        for dir in [video_dir, editing_folder] {
            let Some(dir) = dir.to_str() else { continue };
            let dir = dir
                .trim_start_matches(r"\\?\")
                .replace('\\', "/")
                .trim_end_matches('/')
                .to_ascii_lowercase();
            let mut chars = dir.chars();
            let (Some(drive), Some(':'), Some('/')) = (chars.next(), chars.next(), chars.next())
            else {
                continue; // not a drive path
            };
            if !drive.is_ascii_alphabetic() || dir.len() <= 3 {
                continue; // the drive root would match far too much
            }
            prefixes.push(format!("{dir}/"));
            prefixes.push(format!("/{drive}{}/", &dir[2..]));
        }
        Self {
            prefixes,
            folded: true,
        }
    }

    /// `text` with every known folder prefix of an absolute path removed.
    pub fn shorten(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for prefix in &self.prefixes {
            if self.folded {
                out = strip_folded_prefix_everywhere(&out, prefix);
            } else if out.contains(prefix.as_str()) {
                out = strip_prefix_everywhere(&out, prefix);
            }
        }
        out
    }
}

/// A character as Windows compares paths: ASCII letters without case, `\` as `/`.
fn fold(c: char) -> char {
    if c == '\\' {
        '/'
    } else {
        c.to_ascii_lowercase()
    }
}

/// [`strip_prefix_everywhere`] for a folded `prefix` (lowercase, `/` separators), matching
/// ignoring letter case and with either separator.
fn strip_folded_prefix_everywhere(text: &str, prefix: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let wanted: Vec<char> = prefix.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut prev: Option<char> = None;
    while i < chars.len() {
        let matches = chars.len() - i >= wanted.len()
            && wanted.iter().zip(&chars[i..]).all(|(w, c)| *w == fold(*c));
        if matches {
            let after = chars.get(i + wanted.len()).copied();
            let starts_path = prev.is_none_or(|c| !is_path_char(c));
            let names_something =
                after.is_some_and(|c| !c.is_whitespace() && !matches!(c, '"' | '\'' | '`' | ')'));
            if starts_path && names_something {
                i += wanted.len();
                prev = Some('/');
                continue;
            }
        }
        out.push(chars[i]);
        prev = Some(chars[i]);
        i += 1;
    }
    out
}

/// Characters that may be part of a path right before a folder prefix: when one precedes the
/// prefix, the match is the middle of another path (for example `/private/Users/...`).
fn is_path_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '~' | '\\')
}

/// Removes `prefix` (ending with `/`) where it starts a path and something follows it.
fn strip_prefix_everywhere(text: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut prev: Option<char> = None;
    while let Some(i) = rest.find(prefix) {
        let (before, tail) = rest.split_at(i);
        let after = &tail[prefix.len()..];
        let starts_path = before
            .chars()
            .next_back()
            .or(prev)
            .is_none_or(|c| !is_path_char(c));
        let names_something = after
            .chars()
            .next()
            .is_some_and(|c| !c.is_whitespace() && !matches!(c, '"' | '\'' | '`' | ')'));
        out.push_str(before);
        if !(starts_path && names_something) {
            out.push_str(prefix);
        }
        prev = Some('/');
        rest = after;
    }
    out.push_str(rest);
    out
}

/// One line for a tool call: `<Tool>: <what it does>`, with paths shortened by `paths`.
pub fn tool_line(name: &str, input: &Value, paths: &Paths) -> String {
    let get = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let line = |text: &str| first_line(&paths.shorten(text));
    let what = get("description").map(line).or_else(|| match name {
        "Bash" => get("command").map(line),
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
            get("file_path").or(get("notebook_path")).map(line)
        }
        "Glob" | "Grep" => get("pattern").map(line),
        "LS" => get("path").map(line),
        "WebFetch" => get("url").map(first_line),
        "WebSearch" => get("query").map(first_line),
        "TodoWrite" => Some("Update the task list".to_owned()),
        "Skill" => get("skill").map(first_line),
        "Agent" | "Task" => get("subagent_type").map(first_line),
        _ => None,
    });
    let name = if name.is_empty() { "Tool" } else { name };
    match what {
        Some(what) => truncate_chars(&format!("{name}: {what}"), LINE_CHARS),
        None => name.to_owned(),
    }
}

/// The full input of a tool call for `detail`: the command for Bash, pretty JSON otherwise.
fn tool_detail(name: &str, input: &Value) -> String {
    if name == "Bash"
        && let Some(command) = input.get("command").and_then(Value::as_str)
    {
        return command.to_owned();
    }
    match input {
        Value::Null => String::new(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

/// What one stream event means for the log.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Described {
    pub entries: Vec<Draft>,
    /// A new "last activity" line, when the event says what Claude is doing now.
    pub activity: Option<String>,
}

/// Turns the stream of one Claude process into log entries. Keeps a little state (whether the
/// first `init` was seen, what each task is) so repeated lines stay quiet.
#[derive(Debug, Default)]
pub struct Describer {
    paths: Paths,
    /// The program whose stream this is, as the log names it ("Claude Code" when empty).
    program: &'static str,
    init_seen: bool,
    /// Background tasks and sub-agents by task id: description and whether it is a sub-agent.
    tasks: HashMap<String, (String, bool)>,
}

impl Describer {
    /// A describer that shows paths as they are.
    pub fn new() -> Self {
        Self::default()
    }

    /// A describer that shortens paths inside the video folder and the Editing Folder.
    pub fn with_paths(paths: Paths) -> Self {
        Self {
            paths,
            ..Self::default()
        }
    }

    /// The same for the stream of the OpenCode 2 program (`opencode::harness::events2`).
    pub fn for_opencode2(mut self) -> Self {
        self.program = "OpenCode 2";
        self
    }

    fn program(&self) -> &'static str {
        if self.program.is_empty() {
            "Claude Code"
        } else {
            self.program
        }
    }

    pub fn describe(&mut self, event: &StreamEvent) -> Described {
        let mut out = Described::default();
        match event {
            StreamEvent::Assistant(m) => self.assistant(m, &mut out),
            StreamEvent::User(m) => self.user(m, &mut out),
            StreamEvent::System(s) => self.system(s, &mut out),
            StreamEvent::Result(r) => {
                if r.is_error && !r.is_interrupted() {
                    out.entries.push(
                        Draft::error(format!(
                            "{} reported an error: {}",
                            self.program(),
                            first_line(&r.error_text())
                        ))
                        .with_detail(r.error_text()),
                    );
                }
            }
            StreamEvent::RateLimit(info) if info.is_rejected() => {
                out.entries.push(Draft::error(if self.program.is_empty() {
                    "Claude reports that a usage limit is reached.".to_owned()
                } else {
                    format!("{} reports that a usage limit is reached.", self.program)
                }));
            }
            _ => {}
        }
        out
    }

    fn assistant(&mut self, m: &Message, out: &mut Described) {
        for block in &m.content {
            match block {
                Block::Text(text) if !text.trim().is_empty() => {
                    // Progress marker lines become compact status entries (sub-agents' are
                    // dropped: only the main session's markers count).
                    let (text, markers) = progress::split_markers(text);
                    if !text.is_empty() {
                        out.entries.push(
                            Draft::new(LogKind::Assistant, text.trim()).nested(m.is_nested()),
                        );
                        if !m.is_nested() {
                            out.activity = Some(first_line(&text));
                        }
                    }
                    if !m.is_nested() {
                        for name in markers {
                            let line = progress::marker_log_line(&name);
                            out.entries.push(Draft::status(line.clone()));
                            out.activity = Some(line);
                        }
                    }
                }
                Block::ToolUse { name, input, .. } => {
                    let line = tool_line(name, input, &self.paths);
                    out.entries.push(
                        Draft::new(LogKind::Tool, line.clone())
                            .with_detail(tool_detail(name, input))
                            .nested(m.is_nested()),
                    );
                    out.activity = Some(line);
                }
                _ => {}
            }
        }
    }

    fn user(&mut self, m: &Message, out: &mut Described) {
        for block in &m.content {
            match block {
                Block::ToolResult { text, is_error, .. } => {
                    let shortened = self.paths.shorten(text);
                    let line = first_line(&shortened);
                    let line = match (is_error, line.is_empty()) {
                        (true, true) => "Error".to_owned(),
                        (true, false) => format!("Error: {line}"),
                        (false, true) => "(no output)".to_owned(),
                        (false, false) => line,
                    };
                    // The full text goes to `detail` whenever the line does not show all of it.
                    let detail = if text.trim().lines().count() > 1
                        || text.trim().chars().count() > LINE_CHARS
                        || shortened != *text
                    {
                        text.clone()
                    } else {
                        String::new()
                    };
                    out.entries.push(
                        Draft::new(LogKind::ToolResult, line)
                            .with_detail(detail)
                            .nested(m.is_nested()),
                    );
                }
                Block::Text(text) if !text.trim().is_empty() => {
                    let line = first_line(text);
                    let detail = if text.trim() == line {
                        String::new()
                    } else {
                        text.clone()
                    };
                    out.entries.push(
                        Draft::new(LogKind::User, line)
                            .with_detail(detail)
                            .nested(m.is_nested()),
                    );
                }
                _ => {}
            }
        }
    }

    fn system(&mut self, s: &SystemEvent, out: &mut Described) {
        match s {
            SystemEvent::Init { model, .. } if !self.init_seen => {
                self.init_seen = true;
                let text = match model {
                    Some(model) => format!("{} is running (model {model})", self.program()),
                    None => format!("{} is running", self.program()),
                };
                out.entries.push(Draft::status(text));
            }
            SystemEvent::TaskStarted {
                task_id,
                description,
                task_type,
                backgrounded,
            } => {
                let agent = task_type.as_deref() == Some("local_agent");
                if !*backgrounded && !agent {
                    return;
                }
                let desc = description.clone().unwrap_or_else(|| task_id.clone());
                self.tasks.insert(task_id.clone(), (desc.clone(), agent));
                let text = match (agent, *backgrounded) {
                    (true, true) => format!("Sub-agent started in the background: {desc}"),
                    (true, false) => format!("Sub-agent started: {desc}"),
                    _ => format!("Background task started: {desc}"),
                };
                out.entries.push(Draft::status(first_line(&text)));
                out.activity = Some(first_line(&text));
            }
            SystemEvent::TaskProgress {
                description: Some(desc),
                ..
            } => {
                out.activity = Some(first_line(desc));
            }
            SystemEvent::TaskNotification {
                task_id,
                status,
                summary,
            } => {
                let status = status.as_deref().unwrap_or("finished");
                let summary = summary.clone().unwrap_or_default();
                let text = match self.tasks.remove(task_id) {
                    Some((desc, true)) => format!("Sub-agent {status}: {desc}"),
                    Some((desc, false)) => format!("Background task {status}: {desc}"),
                    // Foreground tasks are covered by their tool call already.
                    None if summary.is_empty() => return,
                    None => format!("Task {status}: {}", first_line(&summary)),
                };
                let detail = if summary.trim().lines().count() > 1 {
                    summary
                } else {
                    String::new()
                };
                out.entries
                    .push(Draft::status(first_line(&text)).with_detail(detail));
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------------------------

struct Pending {
    video_id: String,
    entries: Vec<LogEntry>,
}

#[derive(Default)]
struct SinkState {
    pending: BTreeMap<String, Pending>,
    next_seq: HashMap<String, u64>,
    /// Each secret with the text that replaces it.
    secrets: Vec<(String, &'static str)>,
    shutdown: bool,
}

struct Shared {
    host: Arc<dyn JobHost>,
    interval: Duration,
    state: Mutex<SinkState>,
    wake: Condvar,
    /// Held while taking a batch and writing it, so batches reach the file in order.
    write: Mutex<()>,
}

impl Shared {
    fn state(&self) -> MutexGuard<'_, SinkState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes everything pending and writes it. Returns whether anything was written.
    fn flush(&self) -> bool {
        let _write = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let batch = std::mem::take(&mut self.state().pending);
        let wrote = !batch.is_empty();
        for (job_id, pending) in batch {
            if let Err(err) = self.host.store().append_log(&job_id, &pending.entries) {
                eprintln!("vidai: could not write the log of job {job_id}: {err}");
            }
            self.host.notify(Notice::JobLog(JobLog {
                video_id: pending.video_id,
                job_id,
                entries: pending.entries,
            }));
        }
        wrote
    }
}

/// Batches job log entries into the store and `job-log` events (see the module docs).
pub struct LogSink {
    shared: Arc<Shared>,
}

impl LogSink {
    /// Starts the writer thread. Entries are written at most every `interval`.
    pub fn start(host: Arc<dyn JobHost>, interval: Duration) -> Self {
        let shared = Arc::new(Shared {
            host,
            interval,
            state: Mutex::new(SinkState::default()),
            wake: Condvar::new(),
            write: Mutex::new(()),
        });
        let worker = Arc::clone(&shared);
        thread::Builder::new()
            .name("vidai-job-log".into())
            .spawn(move || run_writer(&worker))
            .expect("start the job log writer");
        Self { shared }
    }

    /// Adds a secret given to a job, to scrub from every later entry as `label` (for example
    /// the OpenCode key as `[opencode key]`).
    pub fn add_secret_as(&self, secret: &str, label: &'static str) {
        let secret = secret.trim();
        if secret.is_empty() {
            return;
        }
        let mut state = self.shared.state();
        if !state.secrets.iter().any(|(s, _)| s == secret) {
            state.secrets.push((secret.to_owned(), label));
        }
    }

    /// `text` with every known secret replaced by its label (for example `[opencode key]`).
    pub fn scrub(&self, text: &str) -> String {
        scrub_all(text, &self.shared.state().secrets)
    }

    /// Queues entries for a job. They get the next `seq` numbers and the timestamp `ts`.
    pub fn push(&self, video_id: &str, job_id: &str, drafts: Vec<Draft>, ts: &str) {
        if drafts.is_empty() {
            return;
        }
        let mut state = self.shared.state();
        let mut seq = match state.next_seq.get(job_id) {
            Some(seq) => *seq,
            None => self.last_seq_on_disk(job_id) + 1,
        };
        let secrets = state.secrets.clone();
        let entries: Vec<LogEntry> = drafts
            .into_iter()
            .map(|d| {
                let entry = LogEntry {
                    seq,
                    ts: ts.to_owned(),
                    kind: d.kind,
                    text: truncate_chars(&scrub_all(&d.text, &secrets), MAX_LOG_DETAIL_CHARS),
                    detail: d
                        .detail
                        .map(|t| truncate_chars(&scrub_all(&t, &secrets), MAX_LOG_DETAIL_CHARS)),
                    nested: d.nested,
                };
                seq += 1;
                entry
            })
            .collect();
        state.next_seq.insert(job_id.to_owned(), seq);
        state
            .pending
            .entry(job_id.to_owned())
            .or_insert_with(|| Pending {
                video_id: video_id.to_owned(),
                entries: Vec::new(),
            })
            .entries
            .extend(entries);
        drop(state);
        self.shared.wake.notify_all();
    }

    fn last_seq_on_disk(&self, job_id: &str) -> u64 {
        self.shared
            .host
            .store()
            .read_log(job_id, 1)
            .ok()
            .and_then(|entries| entries.last().map(|e| e.seq))
            .unwrap_or(0)
    }

    /// Writes everything pending now (for example before reading a log, or before exit).
    pub fn flush(&self) {
        self.shared.flush();
    }

    /// Forgets a job whose log was deleted (its video got a newer job).
    pub fn forget(&self, job_id: &str) {
        let mut state = self.shared.state();
        state.pending.remove(job_id);
        state.next_seq.remove(job_id);
    }
}

impl Drop for LogSink {
    fn drop(&mut self) {
        self.shared.state().shutdown = true;
        self.shared.wake.notify_all();
        self.shared.flush();
    }
}

fn scrub_all(text: &str, secrets: &[(String, &'static str)]) -> String {
    secrets.iter().fold(text.to_owned(), |t, (secret, label)| {
        t.replace(secret.as_str(), label)
    })
}

fn run_writer(shared: &Shared) {
    loop {
        {
            let state = shared.state();
            let state = shared
                .wake
                .wait_while(state, |s| s.pending.is_empty() && !s.shutdown)
                .unwrap_or_else(PoisonError::into_inner);
            if state.shutdown {
                return;
            }
        }
        shared.flush();
        // At most one batch per interval; wake early only to shut down.
        let state = shared.state();
        let (state, _) = shared
            .wake
            .wait_timeout_while(state, shared.interval, |s| !s.shutdown)
            .unwrap_or_else(PoisonError::into_inner);
        if state.shutdown {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::protocol::parse_line;
    use serde_json::json;
    use std::path::PathBuf;

    fn none() -> Paths {
        Paths::none()
    }

    #[test]
    fn tool_lines() {
        assert_eq!(
            tool_line(
                "Bash",
                &json!({"command": "ffmpeg -i a.mp4", "description": "Render graphics at 1080"}),
                &none()
            ),
            "Bash: Render graphics at 1080"
        );
        assert_eq!(
            tool_line("Bash", &json!({"command": "ls -la\npwd"}), &none()),
            "Bash: ls -la"
        );
        assert_eq!(
            tool_line("Read", &json!({"file_path": "/x/info.txt"}), &none()),
            "Read: /x/info.txt"
        );
        assert_eq!(
            tool_line("TodoWrite", &json!({}), &none()),
            "TodoWrite: Update the task list"
        );
        assert_eq!(tool_line("Mystery", &json!({"x": 1}), &none()), "Mystery");
        assert_eq!(tool_detail("Bash", &json!({"command": "ls"})), "ls");
        assert_eq!(
            tool_detail("Read", &json!({"file_path": "a"})),
            "{\n  \"file_path\": \"a\"\n}"
        );
    }

    const EDITING: &str = "/Users/name/Movies/Editing Folder";
    const VIDEO: &str = "/Users/name/Movies/Editing Folder/Glow Naturals/018 Hair Oil";

    fn paths() -> Paths {
        Paths::new_unix(Path::new(EDITING), Path::new(VIDEO))
    }

    #[test]
    fn windows_paths_are_shortened_in_every_form() {
        let p = Paths::new_windows(
            Path::new(r"C:\Users\Ana\Editing Folder"),
            Path::new(r"C:\Users\Ana\Editing Folder\Glow\018 Oil"),
        );
        assert_eq!(
            p.shorten(r"python C:\Users\Ana\Editing Folder\Glow\018 Oil\CLAUDE_VE\t.py"),
            r"python CLAUDE_VE\t.py"
        );
        assert_eq!(
            p.shorten("Read: c:/users/ana/editing folder/Glow/017 Serum/notes.md"),
            "Read: Glow/017 Serum/notes.md"
        );
        assert_eq!(
            p.shorten("ls '/c/Users/Ana/Editing Folder/CLAUDE_VE_ALL/cut.py'"),
            "ls 'CLAUDE_VE_ALL/cut.py'"
        );
        assert_eq!(
            p.shorten(r"C:\Users\Ana\Editing Folder\Glow\018 Oil"),
            r"Glow\018 Oil"
        );
        // Only whole prefixes that start a path, and only when something follows.
        let sibling = r"C:\Users\Ana\Editing Folder 2\x.mp4";
        assert_eq!(p.shorten(sibling), sibling);
        let nested = r"D:\backup\C:\Users\Ana\Editing Folder\x.mp4";
        assert_eq!(p.shorten(nested), nested);
        assert_eq!(
            p.shorten(r"cd C:\Users\Ana\Editing Folder\ "),
            r"cd C:\Users\Ana\Editing Folder\ "
        );
        assert_eq!(p.shorten("हिंदी C:/x"), "हिंदी C:/x");
        // Verbatim paths are understood; a drive root or a relative path is never a prefix.
        let verbatim = Paths::new_windows(Path::new(r"\\?\D:\Edit"), Path::new("relative"));
        assert_eq!(verbatim.shorten(r"D:\Edit\a.mp4"), "a.mp4");
        let root = Paths::new_windows(Path::new(r"C:\"), Path::new("relative"));
        assert_eq!(root.shorten(r"C:\a.txt"), r"C:\a.txt");
    }

    #[test]
    fn paths_are_shown_relative_to_the_video_or_the_editing_folder() {
        let p = paths();
        assert_eq!(
            p.shorten(&format!("{VIDEO}/CLAUDE_VE/timeline.py")),
            "CLAUDE_VE/timeline.py"
        );
        assert_eq!(
            p.shorten(&format!(
                "{EDITING}/Glow Naturals/017 Serum/CLAUDE_VE/notes.md"
            )),
            "Glow Naturals/017 Serum/CLAUDE_VE/notes.md"
        );
        assert_eq!(
            p.shorten(&format!("{EDITING}/CLAUDE_VE_ALL/tools/cut.py")),
            "CLAUDE_VE_ALL/tools/cut.py"
        );
        // The video folder itself, every occurrence, and quoted paths.
        assert_eq!(p.shorten(VIDEO), "Glow Naturals/018 Hair Oil");
        assert_eq!(
            p.shorten(&format!(
                "python3 '{EDITING}/CLAUDE_VE_ALL/timeline.py' --out \"{VIDEO}/output\""
            )),
            "python3 'CLAUDE_VE_ALL/timeline.py' --out \"output\""
        );
        // A folder alone stays recognizable instead of vanishing.
        assert_eq!(
            p.shorten(&format!("ls {VIDEO}/")),
            "ls Glow Naturals/018 Hair Oil/"
        );
        assert_eq!(
            p.shorten(&format!("ls {EDITING}/")),
            format!("ls {EDITING}/")
        );
        // Only whole prefixes: other folders and paths that merely contain the prefix stay.
        let sibling = "/Users/name/Movies/Editing Folder 2/x.mp4";
        assert_eq!(p.shorten(sibling), sibling);
        let nested = format!("/private{EDITING}/x.mp4");
        assert_eq!(p.shorten(&nested), nested);
        assert_eq!(
            p.shorten("/tmp/a.txt and relative/b.txt"),
            "/tmp/a.txt and relative/b.txt"
        );
        // Without folders, nothing changes; the root is never treated as a folder.
        assert_eq!(Paths::none().shorten(VIDEO), VIDEO);
        let root = Paths::new_unix(Path::new("/"), Path::new("relative"));
        assert_eq!(root.shorten("/Users/a"), "/Users/a");
    }

    #[test]
    fn tool_lines_shorten_paths_and_keep_the_original_in_detail() {
        let p = paths();
        let input = json!({"file_path": format!("{VIDEO}/CLAUDE_VE/timeline.py")});
        assert_eq!(tool_line("Read", &input, &p), "Read: CLAUDE_VE/timeline.py");
        assert!(tool_detail("Read", &input).contains(VIDEO));
        let bash = json!({"command": format!("python3 {EDITING}/CLAUDE_VE_ALL/thumbs.py")});
        assert_eq!(
            tool_line("Bash", &bash, &p),
            "Bash: python3 CLAUDE_VE_ALL/thumbs.py"
        );
        let glob = json!({"pattern": format!("{VIDEO}/Broll/**/*.mp4")});
        assert_eq!(tool_line("Glob", &glob, &p), "Glob: Broll/**/*.mp4");
        // A long path that fits once shortened is not cut.
        let deep = format!("{VIDEO}/{}/file.txt", "sub/".repeat(30));
        let line = tool_line("Write", &json!({"file_path": deep}), &p);
        assert!(line.starts_with("Write: sub/sub/") && !line.contains("Editing"));

        let mut d = Describer::with_paths(p);
        let event = |json: Value| parse_line(&json.to_string()).unwrap();
        let out = d.describe(&event(json!({
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": input}]}
        })));
        assert_eq!(out.entries[0].text, "Read: CLAUDE_VE/timeline.py");
        assert_eq!(out.activity.as_deref(), Some("Read: CLAUDE_VE/timeline.py"));
        let written = format!("Wrote {VIDEO}/output/review_v1.fcpxml");
        let out = d.describe(&event(json!({
            "type": "user",
            "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": written}]}
        })));
        assert_eq!(out.entries[0].text, "Wrote output/review_v1.fcpxml");
        assert_eq!(out.entries[0].detail.as_deref(), Some(written.as_str()));
    }

    #[test]
    fn truncation_keeps_the_limit() {
        assert_eq!(truncate_chars("abc", 3), "abc");
        assert_eq!(truncate_chars("abcdef", 5), "ab...");
        let long = "\u{0915}".repeat(5_000);
        assert_eq!(
            truncate_chars(&long, MAX_LOG_DETAIL_CHARS).chars().count(),
            4_000
        );
    }

    fn describe_fixture(name: &str) -> (Vec<Draft>, Vec<String>) {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/claude-stream")
            .join(name);
        let mut d = Describer::new();
        let mut entries = Vec::new();
        let mut activity = Vec::new();
        for line in std::fs::read_to_string(path).unwrap().lines() {
            let out = d.describe(&parse_line(line).unwrap());
            entries.extend(out.entries);
            activity.extend(out.activity);
        }
        (entries, activity)
    }

    #[test]
    fn background_recording_reads_well() {
        let (entries, activity) = describe_fixture("01_background_task.jsonl");
        let texts: Vec<(LogKind, &str)> =
            entries.iter().map(|e| (e.kind, e.text.as_str())).collect();
        assert_eq!(
            texts,
            vec![
                (
                    LogKind::Status,
                    "Claude Code is running (model claude-haiku-5-5)"
                ),
                (LogKind::Tool, "Bash: Sleep 10 seconds then echo slept"),
                (
                    LogKind::Status,
                    "Background task started: Sleep 10 seconds then echo slept"
                ),
                (
                    LogKind::ToolResult,
                    "Command running in background with ID: byxi50wjd. Output is being written to: /private/tmp/claude-501/-Users-editor-Editing/5de5259b-60f1-4173-9520-d86db7b24..."
                ),
                (
                    LogKind::Assistant,
                    "The background command (`sleep 10 && echo slept`) is running as task `byxi50wjd`. I'll wait for its completion notification before writing `out.txt`, without polling."
                ),
                (
                    LogKind::Status,
                    "Background task completed: Sleep 10 seconds then echo slept"
                ),
                (
                    LogKind::Tool,
                    "Bash: Write DONE to out.txt in the working directory and verify"
                ),
                (LogKind::ToolResult, "DONE"),
                (LogKind::Assistant, "[OUTPUT COMPLETED]"),
            ]
        );
        assert_eq!(entries[1].detail.as_deref(), Some("sleep 10 && echo slept"));
        assert!(entries.iter().all(|e| !e.nested));
        assert_eq!(
            activity.last().map(String::as_str),
            Some("[OUTPUT COMPLETED]")
        );
    }

    #[test]
    fn sub_agent_output_is_nested_and_thinking_is_dropped() {
        let (entries, activity) = describe_fixture("02_subagent_interrupt.jsonl");
        assert!(entries.iter().any(|e| e.nested && e.kind == LogKind::Tool));
        assert!(entries.iter().any(|e| e.nested && e.kind == LogKind::User));
        assert!(
            entries
                .iter()
                .any(|e| e.text == "Sub-agent started: Run sleep, date, and ls")
        );
        assert!(
            entries
                .iter()
                .any(|e| e.text == "Sub-agent completed: Run sleep, date, and ls")
        );
        assert!(
            entries
                .iter()
                .any(|e| e.text == "[Request interrupted by user]" && !e.nested)
        );
        // The interrupted turn's error result is not an error for the user.
        assert!(entries.iter().all(|e| e.kind != LogKind::Error));
        assert!(
            activity
                .iter()
                .any(|a| a == "Running Sleep 5 seconds then print date")
        );
        let (entries, _) = describe_fixture("04_resume_missing_session.jsonl");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, LogKind::Error);
        assert!(entries[0].text.contains("No conversation found"));
    }

    #[test]
    fn progress_markers_become_compact_status_entries() {
        let mut d = Describer::new();
        let say = |d: &mut Describer, text: &str, nested: bool| {
            let mut line = json!({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}});
            if nested {
                line["parent_tool_use_id"] = json!("agent1");
            }
            d.describe(&parse_line(&line.to_string()).unwrap())
        };
        let texts = |out: &Described| -> Vec<(LogKind, String)> {
            out.entries
                .iter()
                .map(|e| (e.kind, e.text.clone()))
                .collect()
        };
        // A marker on its own: one status line, which is also the last activity.
        let out = say(&mut d, "[VIDAI_PROGRESS transcribed]", false);
        assert_eq!(
            texts(&out),
            vec![(LogKind::Status, "Transcription done".to_owned())]
        );
        assert_eq!(out.activity.as_deref(), Some("Transcription done"));
        // Text around marker lines stays assistant text, without the markers.
        let out = say(
            &mut d,
            "The plan is written.\n\n`[VIDAI_PROGRESS planned]`\n[VIDAI_PROGRESS mystery]",
            false,
        );
        assert_eq!(
            texts(&out),
            vec![
                (LogKind::Assistant, "The plan is written.".to_owned()),
                (LogKind::Status, "Edit plan written".to_owned()),
                (LogKind::Status, "Progress: mystery".to_owned()),
            ]
        );
        // A marker inside a sentence is prose.
        let prose = "I will write [VIDAI_PROGRESS planned] after the plan.";
        let out = say(&mut d, prose, false);
        assert_eq!(texts(&out), vec![(LogKind::Assistant, prose.to_owned())]);
        // Sub-agents' markers do not count, so they are dropped.
        let out = say(&mut d, "[VIDAI_PROGRESS graphics_built]", true);
        assert!(out.entries.is_empty() && out.activity.is_none());
        let out = say(
            &mut d,
            "Built 6 cards.\n[VIDAI_PROGRESS graphics_built]",
            true,
        );
        assert_eq!(
            texts(&out),
            vec![(LogKind::Assistant, "Built 6 cards.".to_owned())]
        );
    }
}

//! The stream-json protocol of `claude -p --input-format stream-json --output-format stream-json`.
//!
//! - Build stdin lines: user messages ([`user_message_line`]) and control requests
//!   ([`interrupt_line`], [`control_request_line`] for `initialize`, `get_settings`, `get_usage`).
//! - Parse stdout lines into typed events ([`parse_line`]): `system` (`init`, `task_started`,
//!   `task_progress`, `task_updated`, `task_notification`, `background_tasks_changed`, ...),
//!   `assistant` (`text`, `thinking`, `tool_use`), `user` (tool results), `result`,
//!   `rate_limit_event`, `control_response`.
//!   Unknown types, subtypes and fields are ignored, never treated as errors: a line that is not
//!   JSON yields `None`, an unknown `type` yields [`StreamEvent::Other`].
//!
//! Parsing is lenient on purpose (every field is optional on the wire), because Claude Code adds
//! fields and subtypes between releases. Turning events into log lines lives in `jobs::log`.
//! Unit tests run against lines recorded from Claude Code 2.1.319
//! (`tests/fixtures/claude-stream/`).

use serde_json::{Value, json};

// ---------------------------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------------------------

/// One user message as a stdin line (without the trailing newline).
pub fn user_message_line(text: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
        "parent_tool_use_id": null,
        "session_id": "",
    })
    .to_string()
}

/// A control request such as `interrupt`, `initialize`, `get_settings` or `get_usage`
/// (without the trailing newline). Claude answers with a `control_response` carrying the same
/// `request_id`.
pub fn control_request_line(request_id: &str, subtype: &str) -> String {
    json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": subtype },
    })
    .to_string()
}

/// Interrupts the current turn. Claude answers with a `control_response`.
pub fn interrupt_line(request_id: &str) -> String {
    control_request_line(request_id, "interrupt")
}

// ---------------------------------------------------------------------------------------------
// stdout
// ---------------------------------------------------------------------------------------------

/// One parsed stdout line.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    System(SystemEvent),
    Assistant(Message),
    /// Tool results, sub-agent prompts and notes such as "[Request interrupted by user]".
    User(Message),
    Result(TurnResult),
    /// The `rate_limit_info` object of a `rate_limit_event` (passed on to the usage display).
    RateLimit(RateLimitInfo),
    ControlResponse(ControlResponse),
    /// A line with an unknown `type`.
    Other {
        kind: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum SystemEvent {
    /// Emitted when the process starts and again at the start of later turns.
    Init {
        session_id: Option<String>,
        model: Option<String>,
    },
    TaskStarted {
        task_id: String,
        description: Option<String>,
        /// `local_bash`, `local_agent`, ...
        task_type: Option<String>,
        backgrounded: bool,
    },
    TaskProgress {
        task_id: String,
        description: Option<String>,
    },
    TaskUpdated {
        task_id: String,
        status: Option<String>,
    },
    TaskNotification {
        task_id: String,
        status: Option<String>,
        summary: Option<String>,
    },
    /// The full list of background tasks that are active right now.
    BackgroundTasksChanged { tasks: Vec<BackgroundTask> },
    /// Any other subtype (`hook_started`, `thinking_tokens`, `commands_changed`, ...).
    Other { subtype: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackgroundTask {
    pub task_id: String,
    pub description: Option<String>,
    pub task_type: Option<String>,
}

/// An `assistant` or `user` message.
#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    /// Set when the message belongs to a sub-agent (the `Agent` tool call it runs under).
    pub parent_tool_use_id: Option<String>,
    pub content: Vec<Block>,
}

impl Message {
    /// Produced by a sub-agent rather than the main conversation.
    pub fn is_nested(&self) -> bool {
        self.parent_tool_use_id.is_some()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Text(String),
    /// Thinking is never logged; its content is dropped while parsing.
    Thinking,
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        /// The text parts of the result joined by newlines (images and other parts dropped).
        text: String,
        is_error: bool,
    },
    Other,
}

/// A `result` line: the end of one turn (not of the job).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TurnResult {
    /// `success`, `error_during_execution`, `error_max_turns`, ...
    pub subtype: String,
    pub is_error: bool,
    pub num_turns: u64,
    /// The final text of the turn, when there is one.
    pub text: Option<String>,
    /// The `errors` list of error results (for example "No conversation found with ...").
    pub errors: Vec<String>,
    /// Cumulative cost of the session so far, as Claude Code reports it.
    pub total_cost_usd: Option<f64>,
    pub session_id: Option<String>,
    pub api_error_status: Option<i64>,
    /// For example `completed`, or `aborted_streaming` after an interrupt.
    pub terminal_reason: Option<String>,
}

/// The phrase Claude Code prints when `--resume` names a session it does not have.
pub const NO_CONVERSATION_FOUND: &str = "No conversation found";

impl TurnResult {
    /// The empty result Claude Code can emit right after `--resume` (or after a stale task
    /// notification) before it handles the new message: no turns, no error. It never answers a
    /// message.
    pub fn is_empty(&self) -> bool {
        !self.is_error && self.num_turns == 0
    }

    /// The error result that ends a turn cut short by an interrupt.
    pub fn is_interrupted(&self) -> bool {
        self.terminal_reason
            .as_deref()
            .is_some_and(|r| r.starts_with("aborted"))
    }

    /// The error of a `--resume` whose session does not exist.
    pub fn is_resume_not_found(&self) -> bool {
        self.is_error
            && self
                .errors
                .iter()
                .chain(self.text.iter())
                .any(|e| e.contains(NO_CONVERSATION_FOUND))
    }

    /// Everything Claude said about the error, for classification and the log.
    pub fn error_text(&self) -> String {
        let mut parts: Vec<&str> = Vec::new();
        if let Some(text) = self.text.as_deref().filter(|t| !t.trim().is_empty()) {
            parts.push(text.trim());
        }
        parts.extend(
            self.errors
                .iter()
                .map(|e| e.trim())
                .filter(|e| !e.is_empty()),
        );
        if parts.is_empty() {
            return self.subtype.clone();
        }
        parts.join("\n")
    }
}

/// The parts of `rate_limit_info` the job engine reads; `raw` is the whole object.
#[derive(Debug, Clone, PartialEq)]
pub struct RateLimitInfo {
    /// `allowed`, `allowed_warning`, `rejected`, ...
    pub status: Option<String>,
    /// When the limit that applies resets, in epoch seconds.
    pub resets_at: Option<i64>,
    pub raw: Value,
}

impl RateLimitInfo {
    /// Claude Code refused to make more requests because a usage limit is reached.
    pub fn is_rejected(&self) -> bool {
        self.status.as_deref() == Some("rejected")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlResponse {
    pub request_id: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Parses one stdout line. Returns `None` for blank lines and lines that are not a JSON object.
pub fn parse_line(line: &str) -> Option<StreamEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    parse_value(&value)
}

/// Parses one already decoded stdout object (see [`parse_line`]).
pub fn parse_value(v: &Value) -> Option<StreamEvent> {
    let obj = v.as_object()?;
    let kind = str_of(v, "type").unwrap_or_default();
    Some(match kind.as_str() {
        "system" => StreamEvent::System(parse_system(v)),
        "assistant" => StreamEvent::Assistant(parse_message(v)),
        "user" => StreamEvent::User(parse_message(v)),
        "result" => StreamEvent::Result(parse_result(v)),
        "rate_limit_event" => {
            let info = obj.get("rate_limit_info").cloned().unwrap_or(Value::Null);
            StreamEvent::RateLimit(RateLimitInfo {
                status: str_of(&info, "status"),
                resets_at: info.get("resetsAt").and_then(Value::as_i64),
                raw: info,
            })
        }
        "control_response" => {
            let response = v.get("response").cloned().unwrap_or(Value::Null);
            StreamEvent::ControlResponse(ControlResponse {
                request_id: str_of(&response, "request_id").unwrap_or_default(),
                success: str_of(&response, "subtype").as_deref() == Some("success"),
                error: str_of(&response, "error"),
            })
        }
        _ => StreamEvent::Other { kind },
    })
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn parse_system(v: &Value) -> SystemEvent {
    let subtype = str_of(v, "subtype").unwrap_or_default();
    let task_id = || str_of(v, "task_id").unwrap_or_default();
    match subtype.as_str() {
        "init" => SystemEvent::Init {
            session_id: str_of(v, "session_id"),
            model: str_of(v, "model"),
        },
        "task_started" => SystemEvent::TaskStarted {
            task_id: task_id(),
            description: str_of(v, "description"),
            task_type: str_of(v, "task_type"),
            backgrounded: v
                .get("is_backgrounded")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        "task_progress" => SystemEvent::TaskProgress {
            task_id: task_id(),
            description: str_of(v, "description"),
        },
        "task_updated" => SystemEvent::TaskUpdated {
            task_id: task_id(),
            status: v.get("patch").and_then(|p| str_of(p, "status")),
        },
        "task_notification" => SystemEvent::TaskNotification {
            task_id: task_id(),
            status: str_of(v, "status"),
            summary: str_of(v, "summary"),
        },
        "background_tasks_changed" => SystemEvent::BackgroundTasksChanged {
            tasks: v
                .get("tasks")
                .and_then(Value::as_array)
                .map(|tasks| {
                    tasks
                        .iter()
                        .filter_map(|t| {
                            Some(BackgroundTask {
                                task_id: str_of(t, "task_id")?,
                                description: str_of(t, "description"),
                                task_type: str_of(t, "task_type"),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        _ => SystemEvent::Other { subtype },
    }
}

fn parse_message(v: &Value) -> Message {
    let content = v.get("message").and_then(|m| m.get("content"));
    let content = match content {
        Some(Value::String(text)) => vec![Block::Text(text.clone())],
        Some(Value::Array(blocks)) => blocks.iter().map(parse_block).collect(),
        _ => Vec::new(),
    };
    Message {
        parent_tool_use_id: str_of(v, "parent_tool_use_id"),
        content,
    }
}

fn parse_block(b: &Value) -> Block {
    match str_of(b, "type").as_deref() {
        Some("text") => Block::Text(str_of(b, "text").unwrap_or_default()),
        Some("thinking") | Some("redacted_thinking") => Block::Thinking,
        Some("tool_use") => Block::ToolUse {
            id: str_of(b, "id").unwrap_or_default(),
            name: str_of(b, "name").unwrap_or_default(),
            input: b.get("input").cloned().unwrap_or(Value::Null),
        },
        Some("tool_result") => Block::ToolResult {
            tool_use_id: str_of(b, "tool_use_id").unwrap_or_default(),
            text: tool_result_text(b.get("content")),
            is_error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
        },
        _ => Block::Other,
    }
}

fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| match str_of(p, "type").as_deref() {
                Some("text") => str_of(p, "text"),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn parse_result(v: &Value) -> TurnResult {
    TurnResult {
        subtype: str_of(v, "subtype").unwrap_or_default(),
        is_error: v.get("is_error").and_then(Value::as_bool).unwrap_or(false),
        num_turns: v.get("num_turns").and_then(Value::as_u64).unwrap_or(0),
        text: str_of(v, "result"),
        errors: v
            .get("errors")
            .and_then(Value::as_array)
            .map(|errors| {
                errors
                    .iter()
                    .map(|e| match e {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        total_cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
        session_id: str_of(v, "session_id"),
        api_error_status: v.get("api_error_status").and_then(Value::as_i64),
        terminal_reason: str_of(v, "terminal_reason"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> Vec<StreamEvent> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/claude-stream")
            .join(name);
        let text = std::fs::read_to_string(&path).unwrap();
        text.lines()
            .map(|line| parse_line(line).unwrap_or_else(|| panic!("unparsed line: {line}")))
            .collect()
    }

    fn results(events: &[StreamEvent]) -> Vec<&TurnResult> {
        events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Result(r) => Some(r),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn builds_stdin_lines() {
        let line = user_message_line("Hello \"there\"\nsecond line");
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            v,
            json!({
                "type": "user",
                "message": { "role": "user", "content": [{ "type": "text", "text": "Hello \"there\"\nsecond line" }] },
                "parent_tool_use_id": null,
                "session_id": "",
            })
        );
        assert!(!line.contains('\n'), "one line on the wire");
        let v: Value = serde_json::from_str(&interrupt_line("int-1")).unwrap();
        assert_eq!(
            v,
            json!({ "type": "control_request", "request_id": "int-1", "request": { "subtype": "interrupt" } })
        );
        let v: Value = serde_json::from_str(&control_request_line("u1", "get_usage")).unwrap();
        assert_eq!(v["request"]["subtype"], "get_usage");
    }

    #[test]
    fn unknown_and_broken_lines_are_ignored() {
        assert_eq!(parse_line(""), None);
        assert_eq!(parse_line("   "), None);
        assert_eq!(parse_line("not json"), None);
        assert_eq!(parse_line("[1,2]"), None);
        assert_eq!(
            parse_line(r#"{"type":"stream_event","event":{}}"#),
            Some(StreamEvent::Other {
                kind: "stream_event".into()
            })
        );
        assert_eq!(
            parse_line(r#"{"type":"system","subtype":"something_new","x":1}"#),
            Some(StreamEvent::System(SystemEvent::Other {
                subtype: "something_new".into()
            }))
        );
        // Missing fields never fail.
        assert!(matches!(
            parse_line(r#"{"type":"result"}"#),
            Some(StreamEvent::Result(TurnResult {
                num_turns: 0,
                is_error: false,
                ..
            }))
        ));
        assert!(matches!(
            parse_line(r#"{"type":"assistant"}"#),
            Some(StreamEvent::Assistant(Message { ref content, .. })) if content.is_empty()
        ));
    }

    #[test]
    fn background_task_recording() {
        let events = fixture("01_background_task.jsonl");
        // Two turns: the second one starts by itself when the background task reports back.
        let results = results(&events);
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| !r.is_error && r.num_turns == 2));
        assert_eq!(results[1].text.as_deref(), Some("[OUTPUT COMPLETED]"));
        assert_eq!(results[1].total_cost_usd, Some(0.00707391));

        let changes: Vec<usize> = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::System(SystemEvent::BackgroundTasksChanged { tasks }) => {
                    Some(tasks.len())
                }
                _ => None,
            })
            .collect();
        assert_eq!(changes, vec![1, 0]);
        assert!(events.iter().any(|e| matches!(
            e,
            StreamEvent::System(SystemEvent::TaskStarted { backgrounded: true, task_type: Some(t), .. }) if t == "local_bash"
        )));
        assert!(events.iter().any(|e| matches!(
            e,
            StreamEvent::System(SystemEvent::TaskNotification { status: Some(s), .. }) if s == "completed"
        )));
        let inits = events
            .iter()
            .filter(|e| matches!(e, StreamEvent::System(SystemEvent::Init { .. })))
            .count();
        assert_eq!(inits, 2, "init is repeated at the start of the second turn");

        // The tool call carries a description, and thinking content is dropped.
        let tool = events.iter().find_map(|e| match e {
            StreamEvent::Assistant(m) => m.content.iter().find_map(|b| match b {
                Block::ToolUse { name, input, .. } => Some((name.clone(), input.clone())),
                _ => None,
            }),
            _ => None,
        });
        let (name, input) = tool.unwrap();
        assert_eq!(name, "Bash");
        assert_eq!(input["description"], "Sleep 10 seconds then echo slept");
        assert!(events.iter().any(|e| matches!(
            e,
            StreamEvent::Assistant(m) if m.content == vec![Block::Thinking]
        )));
        let rate = events.iter().find_map(|e| match e {
            StreamEvent::RateLimit(info) => Some(info.clone()),
            _ => None,
        });
        let rate = rate.unwrap();
        assert_eq!(rate.status.as_deref(), Some("allowed"));
        assert!(!rate.is_rejected());
        assert_eq!(rate.resets_at, Some(1794637200));
        assert_eq!(rate.raw["unifiedWindows"]["five_hour"]["utilization"], 0.19);
    }

    #[test]
    fn subagent_and_interrupt_recording() {
        let events = fixture("02_subagent_interrupt.jsonl");
        // Sub-agent messages carry the parent tool use id.
        assert!(
            events
                .iter()
                .any(|e| matches!(e, StreamEvent::User(m) if m.is_nested()))
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, StreamEvent::Assistant(m) if m.is_nested()))
        );
        assert!(events.iter().any(|e| matches!(
            e,
            StreamEvent::System(SystemEvent::TaskStarted { backgrounded: false, task_type: Some(t), .. }) if t == "local_agent"
        )));
        assert!(events.iter().any(|e| matches!(
            e,
            StreamEvent::System(SystemEvent::TaskProgress {
                description: Some(_),
                ..
            })
        )));
        // The interrupt is answered by a control_response, and the cut turn ends with an error
        // result marked as aborted.
        let response = events.iter().find_map(|e| match e {
            StreamEvent::ControlResponse(r) => Some(r.clone()),
            _ => None,
        });
        assert_eq!(
            response,
            Some(ControlResponse {
                request_id: "req_int_1".into(),
                success: true,
                error: None
            })
        );
        let found = results(&events);
        assert_eq!(found.len(), 1);
        assert!(found[0].is_error && found[0].is_interrupted());
        assert_eq!(found[0].num_turns, 3);
        assert!(events.iter().any(|e| matches!(
            e,
            StreamEvent::User(m) if m.content == vec![Block::Text("[Request interrupted by user]".into())]
        )));
        // Tool results arrive as text, with array content joined.
        assert!(events.iter().any(|e| matches!(
            e,
            StreamEvent::User(m) if m.content.iter().any(|b| matches!(b, Block::ToolResult { text, .. } if text.contains("date output")))
        )));
    }

    #[test]
    fn resume_recordings() {
        let events = fixture("03_resume_after_interrupt.jsonl");
        let found = results(&events);
        assert_eq!(found.len(), 1);
        assert!(!found[0].is_empty());

        // A pending task notification makes the resumed process emit an empty result first.
        let events = fixture("06_resume_empty_result.jsonl");
        let found = results(&events);
        assert_eq!(found.len(), 2);
        assert!(found[0].is_empty());
        assert!(!found[1].is_empty());
        assert_eq!(found[1].text.as_deref(), Some("HI"));
    }

    #[test]
    fn resume_missing_session_recording() {
        let events = fixture("04_resume_missing_session.jsonl");
        let results = results(&events);
        assert_eq!(results.len(), 1);
        let r = results[0];
        assert!(r.is_error && r.num_turns == 0 && !r.is_empty() && !r.is_interrupted());
        assert_eq!(r.subtype, "error_during_execution");
        assert!(r.is_resume_not_found());
        assert!(
            r.error_text()
                .starts_with("No conversation found with session ID")
        );
    }

    #[test]
    fn interrupt_while_idle_recording() {
        let events = fixture("05_interrupt_idle_with_background_task.jsonl");
        let updates: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::System(SystemEvent::TaskUpdated { status, .. }) => status.clone(),
                _ => None,
            })
            .collect();
        assert_eq!(updates, vec!["killed".to_string()]);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, StreamEvent::ControlResponse(r) if r.request_id == "int1"))
        );
    }

    #[test]
    fn error_text_prefers_result_then_errors() {
        let r = TurnResult {
            subtype: "error_during_execution".into(),
            is_error: true,
            ..TurnResult::default()
        };
        assert_eq!(r.error_text(), "error_during_execution");
        let r = TurnResult {
            text: Some("API Error: 500".into()),
            errors: vec!["boom".into()],
            is_error: true,
            ..TurnResult::default()
        };
        assert_eq!(r.error_text(), "API Error: 500\nboom");
        assert!(!r.is_resume_not_found());
    }
}

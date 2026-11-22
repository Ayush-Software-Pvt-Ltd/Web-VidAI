//! The event stream of an OpenCode 2 server (`GET /api/event`, server-sent events), translated
//! into the vocabulary the job engine already reads for Claude Code (`claude::protocol::
//! StreamEvent`).
//!
//! What OpenCode 2 sends (recorded from 2.2.6, `tests/fixtures/opencode2-stream/`): one JSON
//! object per event, `{"id","created","type","location","data","durable"}`, for every session of
//! the server. A message to a session is `session.inbox.enqueued` (item `user`), then the busy
//! period: `session.execution.started`, `session.inbox.delivered` when the message joins it, per
//! model step `session.step.started` ... `session.step.ended` (finish, tokens, cost) with text
//! (`session.text.ended` carries the whole text), reasoning and tool calls
//! (`session.tool.input.started` names the tool, `session.tool.called` carries its input,
//! `session.tool.progress`, then `session.tool.success` or `session.tool.failed`), and exactly one
//! terminal event: `session.execution.succeeded`, `.failed` (with the error) or `.interrupted`
//! (with the reason). A message sent while a busy period runs joins it (one terminal for both).
//!
//! Background work: the `shell` tool moves a command that outlives its timeout (2 minutes by
//! default) to the background, or starts it there (`background: true`); the `subagent` tool always
//! runs its child session (`session.created` with `parentID`) in the background. Both answer at
//! once with `metadata.status` `running`. When a command ends or a child goes idle, its report is
//! queued for the session that started it (`session.inbox.enqueued`, item `synthetic` with
//! `metadata.source` `shell` or `subagent`), which wakes that session for a new busy period.
//!
//! The translation ([`Translator`]):
//!
//! | OpenCode 2 | StreamEvent |
//! |---|---|
//! | main session busy (`session.execution.started`) | `System(Init)` with the session id and model |
//! | `session.text.ended` | `Assistant` text; nested in a sub-agent's session |
//! | a sub-agent's prompt (`session.inbox.enqueued`, item `user`, in its session) | nested `User` text |
//! | `session.tool.called` | `Assistant` `ToolUse`, named and shaped as Claude Code's tools |
//! | `session.tool.success` / `session.tool.failed` | `User` `ToolResult` (failed: `is_error`) |
//! | `session.tool.progress` of a running tool | `System(TaskProgress)` (activity, nothing logged) |
//! | a command or sub-agent that runs on in the background (`metadata.status` `running`) | also `System(TaskStarted)` (`local_bash` / `local_agent`, backgrounded) |
//! | its report queued for the main session | `System(TaskNotification)` (the main session then works again) |
//! | its report queued for a sub-agent's session | `System(TaskUpdated)` completed |
//! | main session's terminal event | one `Result` per message that joined the busy period (success, error, or interrupted after an interrupt) |
//! | retry for a usage limit (`session.retry.scheduled`) | an error `Result` at once (the job ends with the limit) |
//! | any other retry | `System(Other { subtype: "api_retry" })` |
//! | `permission.asked`, `form.created` | no event; an [`Action`] that answers it |
//!
//! Reasoning, deltas, steps, usage, shells, instructions and catalog events are dropped; unknown
//! events and fields are ignored, never errors. Costs are the sum of the steps' `cost`.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};

use crate::claude::protocol::{
    Block, Message, RateLimitInfo, StreamEvent, SystemEvent, TurnResult,
};

/// What a question is answered with when the session's rules did not remove the question tool
/// (a plugin or the user's own agent can bring it back): the model goes on without an answer.
pub const QUESTION_CANCELLED: &str = "VidAI runs this edit and nobody can answer questions, so the question was cancelled. Continue without an answer: make the best choice yourself and say which one you made.";

/// Something the server must be told, found in the stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// `POST /api/session/<session>/permission/<id>/reply` with `once`: the session's rules allow
    /// everything, so a request that still comes (a plugin's) is allowed at once.
    ReplyPermission { session: String, id: String },
    /// `DELETE /api/session/<session>/form/<id>?message=...`: nobody can fill in a form during an
    /// edit (`session` is `global` for a form of an MCP server of the Editing Folder).
    CancelForm { session: String, id: String },
    /// `POST /api/session/<session>/interrupt`: a session of the job started working again after
    /// a pause or stop was asked for.
    Interrupt { session: String },
}

/// What one OpenCode 2 event means.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Translated {
    pub events: Vec<StreamEvent>,
    pub actions: Vec<Action>,
}

/// Error types of a usage limit that waiting would not solve soon (`session-error` types of
/// OpenCode 2: a Go window, the free tier, a quota or budget).
const LIMIT_TYPES: &[&str] = &[
    "provider.go-limit",
    "provider.free-limit",
    "provider.quota",
    "provider.budget-limit",
    "provider.model-budget-limit",
];

/// One busy period of the main session.
#[derive(Debug, Default)]
struct Execution {
    steps: u64,
    last_text: Option<String>,
    error: Option<TurnError>,
    /// VidAI's messages that joined this busy period.
    delivered: u32,
    /// Its results were already reported (a usage limit ends the turn before OpenCode does).
    reported: bool,
}

#[derive(Debug, Default)]
struct ToolCall {
    name: String,
    input: Value,
    started: bool,
    finished: bool,
}

/// Translates the events of one server for one main session (see the module docs).
#[derive(Debug)]
pub struct Translator {
    main: String,
    model: String,
    /// The Editing Folder, whose global forms (an MCP server's) belong to this job.
    directory: Option<String>,
    /// Sub-agent sessions, with the `subagent` tool call that runs each (once known).
    children: HashMap<String, Option<String>>,
    tools: HashMap<String, ToolCall>,
    /// VidAI's messages that OpenCode queued and did not deliver yet.
    queued: HashSet<String>,
    /// VidAI's messages sent and not queued yet.
    unseen: u32,
    execution: Option<Execution>,
    /// A pause or stop was asked for: every busy period of the job is interrupted from now on.
    halting: bool,
    /// Background commands and sub-agents by task id (shell id or child session id), with the
    /// session that started them and how often the server's job list did not have them.
    background: HashMap<String, (String, u32)>,
    /// Cost of every step this server ran (main session and sub-agents), in dollars.
    cost: f64,
}

impl Translator {
    /// `main` is the job's session; `model` names the model in the `Init` events
    /// (`provider/model`); `directory` is the Editing Folder.
    pub fn new(main: &str, model: &str, directory: Option<&str>) -> Self {
        Self {
            main: main.to_owned(),
            model: model.to_owned(),
            directory: directory.map(str::to_owned),
            children: HashMap::new(),
            tools: HashMap::new(),
            queued: HashSet::new(),
            unseen: 0,
            execution: None,
            halting: false,
            background: HashMap::new(),
            cost: 0.0,
        }
    }

    pub fn session_id(&self) -> &str {
        &self.main
    }

    /// A message is being sent to the main session.
    pub fn prompt_sent(&mut self) {
        self.unseen += 1;
    }

    /// The message just sent was refused: its turn ends at once with `message` as the error.
    pub fn prompt_refused(&mut self, message: &str) -> Vec<StreamEvent> {
        self.unseen = self.unseen.saturating_sub(1);
        let error = TurnError {
            name: "UnknownError".into(),
            message: message.to_owned(),
            status: None,
            body: None,
        };
        vec![StreamEvent::Result(self.error_result(0, &error))]
    }

    /// A pause or stop was asked for: the busy period that ends next ends as interrupted, and
    /// any later one of the job's sessions is interrupted as soon as it starts.
    pub fn abort_requested(&mut self) {
        self.halting = true;
    }

    /// A turn is open (a message is unanswered or OpenCode is working).
    pub fn in_turn(&self) -> bool {
        self.execution.is_some() || self.unseen > 0 || !self.queued.is_empty()
    }

    /// Nothing runs in the main session, but background work does.
    pub fn waiting_for_background(&self) -> bool {
        !self.in_turn() && !self.background.is_empty()
    }

    /// The background work of the job, as the server's job list must show it while it runs.
    pub fn background_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.background.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Reconciles the background work with the server's list of running jobs (`running`, job
    /// ids). A task that the list did not have twice in a row ended without a report reaching
    /// VidAI: it is dropped (`TaskUpdated` completed), so the job does not wait for it forever.
    pub fn reconcile(&mut self, running: &[String]) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        let mut gone = Vec::new();
        for (id, (_, missing)) in &mut self.background {
            if running.contains(id) {
                *missing = 0;
            } else {
                *missing += 1;
                if *missing >= 2 {
                    gone.push(id.clone());
                }
            }
        }
        gone.sort();
        for id in gone {
            self.background.remove(&id);
            out.push(StreamEvent::System(SystemEvent::TaskUpdated {
                task_id: id,
                status: Some("completed".into()),
            }));
        }
        out
    }

    /// Translates one event's `data` (a JSON object). Anything else translates to nothing.
    pub fn observe_data(&mut self, data: &str) -> Translated {
        match serde_json::from_str::<Value>(data) {
            Ok(value) => self.observe(&value),
            Err(_) => Translated::default(),
        }
    }

    /// Translates one event.
    pub fn observe(&mut self, event: &Value) -> Translated {
        let mut out = Translated::default();
        let data = event.get("data").unwrap_or(&Value::Null);
        let kind = str_of(event, "type").unwrap_or_default();
        if kind == "form.created" {
            self.form(event, data, &mut out);
            return out;
        }
        let Some(session) = str_of(data, "sessionID") else {
            return out;
        };
        if kind == "session.created" {
            if let Some(parent) = str_of(data, "parentID")
                && self.in_tree(&parent)
            {
                self.children.entry(session).or_insert(None);
            }
            return out;
        }
        let Some(parent) = self.scope(&session) else {
            return out;
        };
        let main = parent.is_none();
        match kind.as_str() {
            "session.execution.started" => {
                if self.halting {
                    out.actions.push(Action::Interrupt {
                        session: session.clone(),
                    });
                }
                if main {
                    self.execution = Some(Execution::default());
                    out.events.push(StreamEvent::System(SystemEvent::Init {
                        session_id: Some(self.main.clone()),
                        model: Some(self.model.clone()),
                    }));
                }
            }
            "session.execution.succeeded" if main => self.terminal(None, None, &mut out),
            "session.execution.failed" if main => {
                let error = turn_error(data.get("error").unwrap_or(&Value::Null));
                self.terminal(Some(error), None, &mut out);
            }
            "session.execution.interrupted" if main => {
                let reason = str_of(data, "reason").unwrap_or_else(|| "user".into());
                self.terminal(None, Some(reason), &mut out);
            }
            "session.inbox.enqueued" => self.enqueued(&session, parent, data, &mut out),
            "session.inbox.delivered" if main => {
                if let Some(id) = str_of(data, "inboxID")
                    && self.queued.remove(&id)
                {
                    self.execution
                        .get_or_insert_with(Execution::default)
                        .delivered += 1;
                }
            }
            "session.step.ended" | "session.step.failed" => {
                if let Some(cost) = data.get("cost").and_then(Value::as_f64) {
                    self.cost += cost;
                }
                if main
                    && kind == "session.step.ended"
                    && let Some(execution) = self.execution.as_mut()
                {
                    execution.steps += 1;
                }
            }
            "session.text.ended" => {
                let text = str_of(data, "text").unwrap_or_default();
                if !text.trim().is_empty() {
                    if main && let Some(execution) = self.execution.as_mut() {
                        execution.last_text = Some(text.clone());
                    }
                    out.events.push(StreamEvent::Assistant(Message {
                        parent_tool_use_id: parent,
                        content: vec![Block::Text(text)],
                    }));
                }
            }
            "session.tool.input.started" => {
                if let Some(id) = str_of(data, "id") {
                    self.tools.entry(id).or_default().name =
                        str_of(data, "name").unwrap_or_default();
                }
            }
            "session.tool.called" => {
                if let Some(id) = str_of(data, "id") {
                    let tool = self.tools.entry(id.clone()).or_default();
                    tool.input = data.get("input").cloned().unwrap_or(Value::Null);
                    self.tool_started(&id, parent, &mut out);
                }
            }
            "session.tool.progress" => self.tool_progress(data, &mut out),
            "session.tool.success" | "session.tool.failed" => {
                self.tool_ended(
                    &session,
                    parent,
                    data,
                    kind == "session.tool.failed",
                    &mut out,
                );
            }
            "session.retry.scheduled" => {
                let error = data.get("error").unwrap_or(&Value::Null);
                let limit =
                    str_of(error, "type").is_some_and(|t| LIMIT_TYPES.contains(&t.as_str()));
                if main && limit {
                    self.limit_reached(turn_error(error), &mut out);
                } else if main {
                    out.events.push(StreamEvent::System(SystemEvent::Other {
                        subtype: "api_retry".into(),
                    }));
                }
            }
            "permission.asked" => {
                if let Some(id) = str_of(data, "id") {
                    out.actions.push(Action::ReplyPermission { session, id });
                }
            }
            _ => {}
        }
        out
    }

    fn in_tree(&self, session: &str) -> bool {
        session == self.main || self.children.contains_key(session)
    }

    /// `None`: not this job's session; `Some(None)`: the main session; `Some(Some(call))`: a
    /// sub-agent session run by the tool call `call` (or named after itself until that is
    /// known).
    fn scope(&self, session: &str) -> Option<Option<String>> {
        if session == self.main {
            return Some(None);
        }
        self.children
            .get(session)
            .map(|call| Some(call.clone().unwrap_or_else(|| session.to_owned())))
    }

    fn form(&self, event: &Value, data: &Value, out: &mut Translated) {
        let form = data.get("form").unwrap_or(&Value::Null);
        let (Some(id), Some(session)) = (str_of(form, "id"), str_of(form, "sessionID")) else {
            return;
        };
        let ours = if session == "global" {
            // An MCP server's form belongs to the folder it runs for; this server is the job's own.
            event.pointer("/location/directory").and_then(Value::as_str)
                == self.directory.as_deref()
        } else {
            self.in_tree(&session)
        };
        if ours {
            out.actions.push(Action::CancelForm { session, id });
        }
    }

    fn enqueued(
        &mut self,
        session: &str,
        parent: Option<String>,
        data: &Value,
        out: &mut Translated,
    ) {
        let item = data.get("item").unwrap_or(&Value::Null);
        let payload = item.get("payload").unwrap_or(&Value::Null);
        match str_of(item, "type").as_deref() {
            Some("user") if parent.is_none() => {
                // Only VidAI sends messages to the main session.
                if let Some(id) = str_of(data, "inboxID") {
                    self.queued.insert(id);
                    self.unseen = self.unseen.saturating_sub(1);
                }
            }
            Some("user") => {
                // A sub-agent's prompt is shown under its tool call.
                let text = str_of(payload, "text").unwrap_or_default();
                if !text.trim().is_empty() {
                    out.events.push(StreamEvent::User(Message {
                        parent_tool_use_id: parent,
                        content: vec![Block::Text(text)],
                    }));
                }
            }
            Some("synthetic") => {
                let metadata = payload.get("metadata").unwrap_or(&Value::Null);
                let task = match str_of(metadata, "source").as_deref() {
                    Some("shell") => {
                        str_of(metadata, "shellID").or_else(|| str_of(metadata, "jobID"))
                    }
                    Some("subagent") => str_of(metadata, "childID"),
                    _ => None,
                };
                let Some(task) = task else {
                    return;
                };
                if self.background.remove(&task).is_none() {
                    return;
                }
                if session == self.main {
                    out.events
                        .push(StreamEvent::System(SystemEvent::TaskNotification {
                            task_id: task,
                            status: str_of(metadata, "state"),
                            summary: Some(report_body(
                                &str_of(payload, "text").unwrap_or_default(),
                            )),
                        }));
                } else {
                    // A sub-agent's own background work: the sub-agent goes on, the main
                    // session waits for the sub-agent.
                    out.events
                        .push(StreamEvent::System(SystemEvent::TaskUpdated {
                            task_id: task,
                            status: Some("completed".into()),
                        }));
                }
            }
            _ => {}
        }
    }

    fn tool_started(&mut self, id: &str, parent: Option<String>, out: &mut Translated) {
        let Some(tool) = self.tools.get_mut(id) else {
            return;
        };
        if tool.started {
            return;
        }
        tool.started = true;
        let (name, input) = claude_tool(&tool.name, &tool.input);
        out.events.push(StreamEvent::Assistant(Message {
            parent_tool_use_id: parent,
            content: vec![Block::ToolUse {
                id: id.to_owned(),
                name,
                input,
            }],
        }));
    }

    fn tool_progress(&mut self, data: &Value, out: &mut Translated) {
        let Some(id) = str_of(data, "id") else {
            return;
        };
        let Some(tool) = self.tools.get(&id) else {
            return;
        };
        if tool.name == "subagent"
            && let Some(child) = data.pointer("/metadata/sessionID").and_then(Value::as_str)
        {
            self.children.insert(child.to_owned(), Some(id.clone()));
        }
        if tool.started && !tool.finished {
            // A running tool that reports something: not silence, though nothing to log.
            out.events
                .push(StreamEvent::System(SystemEvent::TaskProgress {
                    task_id: id,
                    description: None,
                }));
        }
    }

    fn tool_ended(
        &mut self,
        session: &str,
        parent: Option<String>,
        data: &Value,
        failed: bool,
        out: &mut Translated,
    ) {
        let Some(id) = str_of(data, "id") else {
            return;
        };
        self.tool_started(&id, parent.clone(), out);
        let Some(tool) = self.tools.get_mut(&id) else {
            return;
        };
        if tool.finished {
            return;
        }
        tool.finished = true;
        let content = content_text(data.get("content").unwrap_or(&Value::Null));
        let text = if failed {
            let message = data
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("The tool failed");
            if content.trim().is_empty() {
                message.to_owned()
            } else {
                format!("{content}\n\n{message}")
            }
        } else {
            content
        };
        out.events.push(StreamEvent::User(Message {
            parent_tool_use_id: parent,
            content: vec![Block::ToolResult {
                tool_use_id: id.clone(),
                text,
                is_error: failed,
            }],
        }));
        let metadata = data.get("metadata").unwrap_or(&Value::Null);
        if failed || str_of(metadata, "status").as_deref() != Some("running") {
            return;
        }
        // It runs on in the background and reports when it ends.
        let (task, description, task_type) = match tool.name.as_str() {
            "shell" => (
                str_of(metadata, "shellID"),
                str_of(&tool.input, "command"),
                "local_bash",
            ),
            "subagent" => (
                str_of(metadata, "sessionID"),
                str_of(&tool.input, "description"),
                "local_agent",
            ),
            _ => (None, None, ""),
        };
        let Some(task) = task else {
            return;
        };
        if tool.name == "subagent" {
            self.children.insert(task.clone(), Some(id.clone()));
        }
        self.background
            .insert(task.clone(), (session.to_owned(), 0));
        out.events
            .push(StreamEvent::System(SystemEvent::TaskStarted {
                task_id: task,
                description,
                task_type: Some(task_type.into()),
                backgrounded: true,
            }));
    }

    /// OpenCode 2 would retry (or the gateway would refuse until a window resets): the job ends
    /// with the limit at once, in the gateway's words.
    fn limit_reached(&mut self, error: TurnError, out: &mut Translated) {
        let (steps, delivered, error) = {
            let execution = self.execution.get_or_insert_with(Execution::default);
            if execution.reported {
                return;
            }
            execution.reported = true;
            let error = execution.error.get_or_insert(error).clone();
            (execution.steps, execution.delivered, error)
        };
        let count = self.outstanding(delivered);
        for _ in 0..count {
            out.events
                .push(StreamEvent::Result(self.error_result(steps, &error)));
        }
    }

    /// Messages a failed or interrupted busy period answers: those that joined it and those still
    /// waiting (they will not run), at least one.
    fn outstanding(&mut self, delivered: u32) -> u32 {
        let count = delivered + self.unseen + self.queued.len() as u32;
        self.unseen = 0;
        self.queued.clear();
        count.max(1)
    }

    fn terminal(
        &mut self,
        error: Option<TurnError>,
        interrupted: Option<String>,
        out: &mut Translated,
    ) {
        let execution = self.execution.take().unwrap_or_default();
        if execution.reported {
            return;
        }
        let error = error.or(execution.error.clone());
        if let Some(reason) = interrupted {
            let count = self.outstanding(execution.delivered);
            let result = if self.halting {
                interrupted_result(&self.main, execution.steps, self.cost, &reason)
            } else {
                // Nobody asked for it (OpenCode is shutting down): the turn did not finish.
                self.error_result(
                    execution.steps,
                    &TurnError {
                        name: "Interrupted".into(),
                        message: format!("OpenCode 2 stopped the turn ({reason})."),
                        status: None,
                        body: None,
                    },
                )
            };
            for _ in 0..count {
                out.events.push(StreamEvent::Result(result.clone()));
            }
            return;
        }
        if let Some(error) = error {
            let count = self.outstanding(execution.delivered);
            for _ in 0..count {
                out.events.push(StreamEvent::Result(
                    self.error_result(execution.steps, &error),
                ));
            }
            return;
        }
        let success = TurnResult {
            subtype: "success".into(),
            is_error: false,
            num_turns: execution.steps.max(1),
            text: execution.last_text.clone(),
            errors: Vec::new(),
            total_cost_usd: Some(self.cost),
            session_id: Some(self.main.clone()),
            api_error_status: None,
            terminal_reason: Some("completed".into()),
        };
        if execution.delivered > 0 {
            for _ in 0..execution.delivered {
                out.events.push(StreamEvent::Result(success.clone()));
            }
        } else if self.unseen > 0 || !self.queued.is_empty() {
            // A busy period that did not take VidAI's message (it runs in the next one): it ends a
            // turn but answers nothing.
            out.events.push(StreamEvent::Result(TurnResult {
                num_turns: 0,
                ..success
            }));
        } else {
            // A busy period of its own, such as one woken by a background report.
            out.events.push(StreamEvent::Result(success));
        }
    }

    fn error_result(&self, steps: u64, error: &TurnError) -> TurnResult {
        TurnResult {
            subtype: "error_during_execution".into(),
            is_error: true,
            num_turns: steps,
            text: None,
            errors: vec![error.text()],
            total_cost_usd: Some(self.cost),
            session_id: Some(self.main.clone()),
            api_error_status: error.status.map(i64::from),
            terminal_reason: Some("error".into()),
        }
    }
}

fn interrupted_result(session: &str, steps: u64, cost: f64, reason: &str) -> TurnResult {
    TurnResult {
        subtype: "error_during_execution".into(),
        is_error: true,
        num_turns: steps,
        text: None,
        errors: vec![format!("Session interrupted: {reason}")],
        total_cost_usd: Some(cost),
        session_id: Some(session.to_owned()),
        api_error_status: None,
        terminal_reason: Some("aborted".into()),
    }
}

/// The error that ended a turn.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnError {
    pub name: String,
    pub message: String,
    pub status: Option<u16>,
    pub body: Option<String>,
}

impl TurnError {
    /// The error as Claude Code words a refused request ("API Error: 401 {...}"), so the readable
    /// texts of `opencode::http::failure_text` find the gateway's answer in it.
    pub fn text(&self) -> String {
        match (self.status, self.body.as_deref()) {
            (Some(status), Some(body)) => format!("API Error: {status} {}", body.trim()),
            (Some(status), None) => format!("API Error: {status} {}", self.message),
            _ if self.message.is_empty() => self.name.clone(),
            _ => self.message.clone(),
        }
    }
}

/// The first step of [`claude_tool`]: a tool of OpenCode 1.x's names (`bash`, `read`, `task`) as
/// Claude Code names it, with the input keys in snake_case (`filePath` is `file_path`).
fn shaped_tool(tool: &str, input: &Value) -> (String, Value) {
    let name = match tool {
        "bash" => "Bash",
        "read" => "Read",
        "write" => "Write",
        "edit" => "Edit",
        "multiedit" => "MultiEdit",
        "apply_patch" | "patch" => "Patch",
        "glob" => "Glob",
        "grep" => "Grep",
        "list" => "LS",
        "webfetch" => "WebFetch",
        "websearch" => "WebSearch",
        "todowrite" => "TodoWrite",
        "todoread" => "TodoRead",
        "task" => "Agent",
        "skill" => "Skill",
        other => other,
    };
    let mut shaped = Map::new();
    if let Value::Object(fields) = input {
        for (key, value) in fields {
            shaped.insert(snake_case(key), value.clone());
        }
    }
    if name == "Skill"
        && let Some(skill) = shaped.remove("name")
    {
        shaped.insert("skill".into(), skill);
    }
    let shaped = if input.is_object() {
        Value::Object(shaped)
    } else {
        input.clone()
    };
    (name.to_owned(), shaped)
}

fn snake_case(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            if !out.is_empty() {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// The `Result` of a resume whose session OpenCode does not have, in Claude Code's words, so
/// `TurnResult::is_resume_not_found` recognizes it.
pub fn resume_not_found(session_id: &str) -> TurnResult {
    TurnResult {
        subtype: "error_during_execution".into(),
        is_error: true,
        num_turns: 0,
        text: None,
        errors: vec![format!(
            "{} with session ID: {session_id}",
            crate::claude::protocol::NO_CONVERSATION_FOUND
        )],
        total_cost_usd: None,
        session_id: Some(session_id.to_owned()),
        api_error_status: None,
        terminal_reason: Some("error".into()),
    }
}

/// The error a usage limit ends a job with. OpenCode itself would wait for the limit to reset
/// (its retry of a `GoUsageLimitError` or `FreeUsageLimitError` waits until then, possibly days),
/// so the job ends instead, with the gateway's error in the shape `opencode::http::failure_text`
/// reads ("API Error: 429 {...}" with the limit's name).
pub fn limit_result(info: &RateLimitInfo, session_id: &str) -> TurnResult {
    let message = info
        .raw
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Usage limit reached");
    let free =
        info.raw.pointer("/action/reason").and_then(Value::as_str) == Some("free_tier_limit");
    let body = if free {
        json!({ "type": "error", "error": { "type": "FreeUsageLimitError", "message": message } })
    } else {
        let limit_name = message
            .split_once(" usage limit")
            .map(|(name, _)| name.trim())
            .filter(|name| !name.is_empty() && !name.eq_ignore_ascii_case("usage"));
        json!({
            "type": "error",
            "error": { "type": "GoUsageLimitError", "message": message },
            "metadata": { "limitName": limit_name },
        })
    };
    TurnResult {
        subtype: "error_during_execution".into(),
        is_error: true,
        num_turns: 1,
        text: None,
        errors: vec![format!("API Error: 429 {body}")],
        total_cost_usd: None,
        session_id: Some(session_id.to_owned()),
        api_error_status: Some(429),
        terminal_reason: Some("error".into()),
    }
}

/// An error as OpenCode 2 sends it (`{"type","message","status","response":{"body"}}`), so it is
/// worded like Claude Code's ("API Error: 401 {...}").
pub fn turn_error(value: &Value) -> TurnError {
    TurnError {
        name: str_of(value, "type").unwrap_or_else(|| "unknown".into()),
        message: str_of(value, "message").unwrap_or_default(),
        status: value
            .get("status")
            .and_then(Value::as_u64)
            .and_then(|s| u16::try_from(s).ok()),
        body: value
            .pointer("/response/body")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|b| !b.trim().is_empty()),
    }
}

/// The text of a tool's `content` (texts, and files by their address).
fn content_text(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| match str_of(item, "type").as_deref() {
            Some("text") => str_of(item, "text"),
            Some("file") => str_of(item, "uri"),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The body of a report (`<shell ...>\n<output>\n</shell>`, `<subagent ...>\n<text>\n</subagent>`).
fn report_body(text: &str) -> String {
    let inner = text
        .split_once('\n')
        .map(|(_, rest)| rest)
        .and_then(|rest| rest.rsplit_once("\n</").map(|(inner, _)| inner))
        .unwrap_or(text);
    inner.trim().to_owned()
}

/// OpenCode 2's tool name and input as Claude Code names and shapes them, so the log lines and the
/// progress evidence read the same: `shell` is `Bash`, `read` is `Read` with `file_path`,
/// `subagent` is `Agent` with `subagent_type`, and so on. Input keys become snake_case. Tools
/// Claude Code does not have keep their name.
pub fn claude_tool(tool: &str, input: &Value) -> (String, Value) {
    let (name, mut shaped) = match tool {
        "shell" => shaped_tool("bash", input),
        "subagent" => shaped_tool("task", input),
        "patch" => shaped_tool("apply_patch", input),
        other => shaped_tool(other, input),
    };
    if let Value::Object(fields) = &mut shaped {
        let rename = |fields: &mut Map<String, Value>, from: &str, to: &str| {
            if let Some(value) = fields.remove(from) {
                fields.insert(to.into(), value);
            }
        };
        match name.as_str() {
            "Read" | "Write" | "Edit" => rename(fields, "path", "file_path"),
            "Bash" => rename(fields, "background", "run_in_background"),
            "Agent" => {
                rename(fields, "agent", "subagent_type");
                rename(fields, "session_i_d", "session_id");
            }
            "Skill" => rename(fields, "id", "skill"),
            _ => {}
        }
    }
    (name, shaped)
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// The body of `POST /api/session` for a new session of a job.
pub fn session_body(title: &str, model: &Value, permissions: &Value, directory: &str) -> Value {
    json!({
        "title": title,
        "model": model,
        "permissions": permissions,
        "location": { "directory": directory },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const DIR: &str = "/Users/editor/Editing/work1";

    fn fixture(name: &str) -> Vec<Value> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/opencode2-stream")
            .join(name);
        std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// The main session of a recording: the first session created without a parent, or the
    /// first session named at all.
    fn main_session(events: &[Value]) -> String {
        events
            .iter()
            .find_map(|e| {
                (e["type"] == "session.created" && e["data"]["parentID"].is_null())
                    .then(|| e["data"]["sessionID"].as_str().unwrap().to_owned())
            })
            .or_else(|| {
                events
                    .iter()
                    .find_map(|e| e["data"]["sessionID"].as_str().map(str::to_owned))
            })
            .unwrap()
    }

    /// Replays a recording, sending a prompt where the recording shows VidAI's message queued for
    /// the main session.
    fn replay_with(
        t: &mut Translator,
        events: &[Value],
        mut before: impl FnMut(&mut Translator, &Value),
    ) -> (Vec<StreamEvent>, Vec<Action>) {
        let main = t.session_id().to_owned();
        let mut out = Vec::new();
        let mut actions = Vec::new();
        for event in events {
            if event["type"] == "session.inbox.enqueued"
                && event["data"]["sessionID"] == main.as_str()
                && event["data"]["item"]["type"] == "user"
            {
                t.prompt_sent();
            }
            before(t, event);
            let translated = t.observe(event);
            out.extend(translated.events);
            actions.extend(translated.actions);
        }
        (out, actions)
    }

    fn replay(name: &str) -> (Vec<StreamEvent>, Vec<Action>) {
        let events = fixture(name);
        let mut t = Translator::new(&main_session(&events), "opencode/big-pickle", Some(DIR));
        replay_with(&mut t, &events, |_, _| {})
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

    fn tools(events: &[StreamEvent]) -> Vec<(String, Value, bool)> {
        events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Assistant(m) => m.content.iter().find_map(|b| match b {
                    Block::ToolUse { name, input, .. } => {
                        Some((name.clone(), input.clone(), m.is_nested()))
                    }
                    _ => None,
                }),
                _ => None,
            })
            .collect()
    }

    fn texts(events: &[StreamEvent]) -> Vec<(String, bool)> {
        events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Assistant(m) => m.content.iter().find_map(|b| match b {
                    Block::Text(t) => Some((t.clone(), m.is_nested())),
                    _ => None,
                }),
                _ => None,
            })
            .collect()
    }

    fn tool_results(events: &[StreamEvent]) -> Vec<(String, bool)> {
        events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::User(m) => m.content.iter().find_map(|b| match b {
                    Block::ToolResult { text, is_error, .. } => Some((text.clone(), *is_error)),
                    _ => None,
                }),
                _ => None,
            })
            .collect()
    }

    fn systems(events: &[StreamEvent]) -> Vec<&SystemEvent> {
        events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::System(s) => Some(s),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn two_turns_with_files_and_commands() {
        let (events, actions) = replay("01_turns_with_tools.jsonl");
        assert!(actions.is_empty());
        let inits: Vec<_> = systems(&events)
            .into_iter()
            .filter_map(|s| match s {
                SystemEvent::Init { session_id, model } => {
                    Some((session_id.clone(), model.clone()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(inits.len(), 2);
        assert_eq!(
            inits[0],
            (
                Some("ses_e204bd724ffenrgalf5N7ln7ys".into()),
                Some("opencode/big-pickle".into())
            )
        );
        // The tools as Claude Code names them, each once, with Claude Code's input keys.
        let used = tools(&events);
        let names: Vec<&str> = used.iter().map(|(n, _, _)| n.as_str()).collect();
        assert_eq!(names, ["Write", "Bash", "Read", "Edit", "Bash"]);
        assert_eq!(
            used[0].1,
            json!({"file_path": "a.txt", "content": "hello\n"})
        );
        assert_eq!(used[1].1, json!({"command": "ls -la"}));
        assert_eq!(
            used[3].1,
            json!({"file_path": "a.txt", "old_string": "hello", "new_string": "hello world"})
        );
        assert!(used.iter().all(|(_, _, nested)| !nested));
        // Each tool has exactly one result.
        let done = tool_results(&events);
        assert_eq!(done.len(), 5);
        assert_eq!(done[4], ("hello world\n".into(), false));
        // The project file's rule reached the model through the configured instructions.
        let said = texts(&events);
        assert_eq!(said.len(), 3);
        assert!(said[1].0.ends_with("PINEAPPLE"));
        // Each turn ends with one successful result carrying its last text and the cost.
        let found = results(&events);
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|r| !r.is_error && !r.is_empty()));
        assert_eq!(found[0].num_turns, 5);
        assert!(found[1].text.as_deref().unwrap().contains("hello world"));
        assert_eq!(found[1].total_cost_usd, Some(0.0));
    }

    #[test]
    fn an_interrupt_ends_the_turn_as_interrupted() {
        let events = fixture("02_interrupt_during_shell.jsonl");
        let mut t = Translator::new(&main_session(&events), "m", Some(DIR));
        let (out, actions) = replay_with(&mut t, &events, |t, e| {
            if e["type"] == "session.tool.failed" {
                // The interrupt was asked for just before.
                t.abort_requested();
            }
        });
        assert!(actions.is_empty());
        let found = results(&out);
        assert_eq!(found.len(), 1);
        assert!(found[0].is_error && found[0].is_interrupted(), "{found:?}");
        // The cut command still reports its end.
        assert_eq!(
            tool_results(&out),
            vec![("Tool execution interrupted".to_owned(), true)]
        );
        // From now on a busy period of the job is interrupted as soon as it starts.
        let started =
            json!({"type":"session.execution.started","data":{"sessionID": t.session_id()}});
        assert_eq!(
            t.observe(&started).actions,
            vec![Action::Interrupt {
                session: t.session_id().to_owned()
            }]
        );
    }

    #[test]
    fn an_interrupt_nobody_asked_for_is_an_error() {
        let mut t = Translator::new("ses_1", "m", None);
        t.prompt_sent();
        let started = json!({"type":"session.execution.started","data":{"sessionID":"ses_1"}});
        t.observe(&started);
        let ended = json!({"type":"session.execution.interrupted","data":{"sessionID":"ses_1","reason":"shutdown"}});
        let out = t.observe(&ended).events;
        let found = results(&out);
        assert_eq!(found.len(), 1);
        assert!(found[0].is_error && !found[0].is_interrupted());
        assert_eq!(
            found[0].error_text(),
            "OpenCode 2 stopped the turn (shutdown)."
        );
    }

    #[test]
    fn errors_are_worded_like_claude_codes() {
        let (events, _) = replay("03_unknown_model.jsonl");
        let found = results(&events);
        assert_eq!(found.len(), 1);
        assert!(found[0].is_error && !found[0].is_interrupted() && !found[0].is_resume_not_found());
        assert_eq!(
            found[0].error_text(),
            "Model unavailable: opencode/no-such-model-xyz"
        );

        let (events, _) = replay("04_refused_key.jsonl");
        let found = results(&events);
        assert_eq!(found.len(), 1, "one message, one result");
        assert_eq!(found[0].api_error_status, Some(401));
        assert_eq!(
            found[0].error_text(),
            r#"API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid credential"}}"#
        );
        assert_eq!(
            crate::jobs::errors::for_opencode2_program_result(
                found[0],
                Some("big-pickle"),
                crate::opencode::http::Service::OpenCode,
            ),
            crate::opencode::http::failure_text(
                Some(401),
                &found[0].error_text(),
                Some("big-pickle")
            )
        );
    }

    #[test]
    fn a_resumed_session_answers_in_a_new_server() {
        let (events, _) = replay("05_resume_in_new_server.jsonl");
        let found = results(&events);
        assert_eq!(found.len(), 1);
        assert!(!found[0].is_error);
        assert!(found[0].text.as_deref().unwrap().contains("hello world"));
    }

    #[test]
    fn background_commands_and_sub_agents_keep_the_job_waiting() {
        let (events, _) = replay("06_background_shell_and_subagent.jsonl");
        let used = tools(&events);
        let summary: Vec<(&str, bool)> = used
            .iter()
            .map(|(n, _, nested)| (n.as_str(), *nested))
            .collect();
        assert_eq!(summary, [("Bash", false), ("Agent", false), ("Bash", true)]);
        assert_eq!(used[0].1["run_in_background"], true);
        assert_eq!(used[1].1["subagent_type"], "general");
        assert_eq!(used[1].1["description"], "Count files");
        let agent_call = "call_54bbeda0022a494fb6b46fcc";
        let child = "ses_e204b0562ffe0n9cr1L82NhFD8";
        let shell = "sh_1dfb4fa9e001pjrFR6z1ICD1EY";
        // The sub-agent's prompt, tool calls and answer are nested under its tool call.
        assert!(events.iter().any(|e| matches!(e, StreamEvent::User(m)
            if m.parent_tool_use_id.as_deref() == Some(agent_call)
            && matches!(m.content.first(), Some(Block::Text(t)) if t.starts_with("You are a subagent")))));
        assert!(events.iter().any(|e| matches!(e, StreamEvent::Assistant(m)
            if m.parent_tool_use_id.as_deref() == Some(agent_call)
            && m.content == vec![Block::Text("2\n\nPINEAPPLE".into())])));
        // Both run in the background, and their reports are notifications.
        let tasks: Vec<String> = systems(&events)
            .into_iter()
            .filter_map(|s| match s {
                SystemEvent::TaskStarted {
                    task_id,
                    task_type: Some(kind),
                    backgrounded: true,
                    ..
                } => Some(format!("started {kind} {task_id}")),
                SystemEvent::TaskNotification {
                    task_id,
                    status: Some(status),
                    summary: Some(summary),
                } => Some(format!("{status} {task_id}: {summary}")),
                _ => None,
            })
            .collect();
        assert_eq!(
            tasks,
            [
                format!("started local_bash {shell}"),
                format!("started local_agent {child}"),
                format!("completed {child}: 2\n\nPINEAPPLE"),
                format!("completed {shell}: bg-done"),
            ]
        );
        // Three busy periods of the main session: the message, and one per report; the
        // sub-agent's own busy period ends nothing of the main session.
        let found = results(&events);
        assert_eq!(found.len(), 3);
        assert!(found.iter().all(|r| !r.is_error && !r.is_empty()));
        assert!(found[2].text.as_deref().unwrap().contains("bg-done"));
    }

    #[test]
    fn the_job_follows_background_work_like_claude_codes() {
        // The engine's own turn tracking over the recording: busy, then waiting for the two
        // background tasks, then idle only after the last report's turn.
        use crate::claude::session::{Activity, TurnTracker};
        let (events, _) = replay("06_background_shell_and_subagent.jsonl");
        let now = std::time::Instant::now();
        let mut tracker = TurnTracker::new(now);
        tracker.message_sent(now);
        let mut seen = Vec::new();
        for event in &events {
            tracker.observe(event, now);
            if let StreamEvent::Result(_) = event {
                seen.push(tracker.activity());
            }
        }
        assert_eq!(
            seen,
            [
                Activity::WaitingForBackground(2),
                Activity::WaitingForBackground(1),
                Activity::Idle
            ]
        );
    }

    #[test]
    fn permission_requests_and_questions_are_answered() {
        let (events, actions) = replay("07_permission_asked.jsonl");
        assert_eq!(
            actions,
            vec![Action::ReplyPermission {
                session: "ses_e204abf15ffeWnPwILo3GypQD2".into(),
                id: "per_1dfb551ab001CBrWEBkddKKeFH".into()
            }]
        );
        assert_eq!(results(&events).len(), 1);

        let (events, actions) = replay("08_question_form.jsonl");
        assert_eq!(
            actions,
            vec![Action::CancelForm {
                session: "ses_e204aa064ffegxrmHJ8zYn3OCE".into(),
                id: "frm_1dfb56973001ikKX1Mhe9wCH0g".into()
            }]
        );
        let found = results(&events);
        assert_eq!(found.len(), 1);
        assert!(!found[0].is_error, "the model went on without an answer");

        // Another job's requests are left alone; a global form of this folder is cancelled.
        let mut t = Translator::new("ses_1", "m", Some(DIR));
        let ask = json!({"type":"permission.asked","data":{"id":"per_1","sessionID":"ses_other","action":"read"}});
        assert!(t.observe(&ask).actions.is_empty());
        let global = |dir: &str| {
            json!({"type":"form.created","location":{"directory":dir},
            "data":{"form":{"id":"frm_1","sessionID":"global","title":"MCP"}}})
        };
        assert_eq!(
            t.observe(&global(DIR)).actions,
            vec![Action::CancelForm {
                session: "global".into(),
                id: "frm_1".into()
            }]
        );
        assert!(t.observe(&global("/elsewhere")).actions.is_empty());
    }

    #[test]
    fn a_usage_limit_ends_the_turn_at_once() {
        let mut t = Translator::new("ses_1", "opencode-go/glm-5.3", None);
        t.prompt_sent();
        let body = r#"{"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"},"metadata":{"limitName":"weekly"}}"#;
        for event in [
            json!({"type":"session.inbox.enqueued","data":{"sessionID":"ses_1","inboxID":"msg_1","item":{"type":"user","payload":{"text":"x"}}}}),
            json!({"type":"session.execution.started","data":{"sessionID":"ses_1"}}),
            json!({"type":"session.inbox.delivered","data":{"sessionID":"ses_1","inboxID":"msg_1"}}),
        ] {
            t.observe(&event);
        }
        let retry = |kind: &str| {
            json!({"type":"session.retry.scheduled","data":{"sessionID":"ses_1","assistantMessageID":"msg_2","attempt":1,"at":1,
            "error":{"type":kind,"message":"OpenCode Go weekly usage limit reached.","status":429,"response":{"body":body}}}})
        };
        let out = t.observe(&retry("provider.go-limit")).events;
        let found = results(&out);
        assert_eq!(found.len(), 1);
        assert!(
            crate::jobs::errors::for_opencode2_program_result(
                found[0],
                Some("glm-5.3"),
                crate::opencode::http::Service::OpenCode,
            )
            .starts_with("The weekly limit of your OpenCode Go plan"),
            "{}",
            crate::jobs::errors::for_opencode2_program_result(
                found[0],
                Some("glm-5.3"),
                crate::opencode::http::Service::OpenCode,
            )
        );
        // Reported once; the busy period's own end adds nothing.
        assert!(t.observe(&retry("provider.go-limit")).events.is_empty());
        let failed = json!({"type":"session.execution.failed","data":{"sessionID":"ses_1","error":{"type":"aborted","message":"x"}}});
        assert!(t.observe(&failed).events.is_empty());
        // Any other retry is only activity.
        t.observe(&json!({"type":"session.execution.started","data":{"sessionID":"ses_1"}}));
        assert_eq!(
            t.observe(&retry("provider.rate-limit")).events,
            vec![StreamEvent::System(SystemEvent::Other {
                subtype: "api_retry".into()
            })]
        );
    }

    #[test]
    fn messages_are_answered_by_the_busy_period_they_joined() {
        let mut t = Translator::new("ses_1", "m", None);
        let ev = |kind: &str, extra: Value| {
            let mut data = json!({"sessionID":"ses_1"});
            data.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            json!({"type":kind,"data":data})
        };
        let user = |id: &str| {
            ev(
                "session.inbox.enqueued",
                json!({"inboxID":id,"item":{"type":"user","payload":{"text":"x"}}}),
            )
        };
        // Two messages that joined one busy period get two results.
        t.prompt_sent();
        t.observe(&user("msg_1"));
        t.observe(&ev("session.execution.started", json!({})));
        t.observe(&ev("session.inbox.delivered", json!({"inboxID":"msg_1"})));
        t.prompt_sent();
        t.observe(&user("msg_2"));
        t.observe(&ev("session.inbox.delivered", json!({"inboxID":"msg_2"})));
        let out = t
            .observe(&ev("session.execution.succeeded", json!({})))
            .events;
        assert_eq!(results(&out).len(), 2);
        assert!(!t.in_turn());
        // A busy period that ends before a message joined it answers nothing yet.
        t.observe(&ev("session.execution.started", json!({})));
        t.prompt_sent();
        t.observe(&user("msg_3"));
        let out = t
            .observe(&ev("session.execution.succeeded", json!({})))
            .events;
        assert!(matches!(&results(&out)[..], [r] if r.is_empty()));
        assert!(t.in_turn());
        // A refused message ends its turn with the reason.
        let mut t = Translator::new("ses_1", "m", None);
        t.prompt_sent();
        let out = t.prompt_refused("OpenCode refused the message (HTTP 400): bad");
        assert!(
            matches!(&results(&out)[..], [r] if r.is_error && r.error_text().contains("HTTP 400"))
        );
        assert!(!t.in_turn());
    }

    #[test]
    fn background_work_that_vanished_is_dropped_after_two_checks() {
        let (_, _) = replay("06_background_shell_and_subagent.jsonl");
        let mut t = Translator::new("ses_1", "m", None);
        t.background.insert("sh_1".into(), ("ses_1".into(), 0));
        t.background.insert("ses_c".into(), ("ses_1".into(), 0));
        assert!(t.waiting_for_background());
        assert!(t.reconcile(&["sh_1".into()]).is_empty());
        assert_eq!(
            t.reconcile(&["sh_1".into()]),
            vec![StreamEvent::System(SystemEvent::TaskUpdated {
                task_id: "ses_c".into(),
                status: Some("completed".into())
            })]
        );
        assert_eq!(t.background_ids(), ["sh_1"]);
    }

    #[test]
    fn tools_take_claude_codes_names_and_shapes() {
        assert_eq!(
            claude_tool(
                "shell",
                &json!({"command":"ls","workdir":"/v","timeout":600000,"background":true})
            ),
            (
                "Bash".into(),
                json!({"command":"ls","workdir":"/v","timeout":600000,"run_in_background":true})
            )
        );
        assert_eq!(
            claude_tool(
                "subagent",
                &json!({"agent":"general","description":"d","prompt":"p","sessionID":"ses_x"})
            ),
            (
                "Agent".into(),
                json!({"subagent_type":"general","description":"d","prompt":"p","session_id":"ses_x"})
            )
        );
        assert_eq!(
            claude_tool("read", &json!({"path":"a"})).1,
            json!({"file_path":"a"})
        );
        assert_eq!(
            claude_tool("skill", &json!({"id":"x"})),
            ("Skill".into(), json!({"skill":"x"}))
        );
        assert_eq!(
            claude_tool("patch", &json!({"patchText":"p"})),
            ("Patch".into(), json!({"patch_text":"p"}))
        );
        assert_eq!(
            claude_tool("execute", &Value::Null),
            ("execute".into(), Value::Null)
        );
        assert_eq!(report_body("<shell id=\"s\">\nout\n\n</shell>"), "out");
        assert_eq!(report_body("plain"), "plain");
        assert_eq!(
            content_text(&json!([{"type":"text","text":"a"},{"type":"file","uri":"file:///x"}])),
            "a\n\nfile:///x"
        );
        assert_eq!(
            session_body("T", &json!({"providerID":"p","id":"m"}), &json!([]), "/E").to_string(),
            r#"{"location":{"directory":"/E"},"model":{"id":"m","providerID":"p"},"permissions":[],"title":"T"}"#
        );
    }
}

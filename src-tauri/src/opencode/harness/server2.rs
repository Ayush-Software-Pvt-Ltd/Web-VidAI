//! One running OpenCode 2 server and the session of its job, with the same small surface as a
//! Claude Code process: start, send a message, interrupt, close, and events through one
//! callback, in order: lines, then `Exited` once.
//!
//! OpenCode 2 serves a new HTTP API (`/api/...`); [`Server2::start`]:
//!
//! 1. starts `opencode2 serve --stdio --hostname 127.0.0.1 --port 0` (`launch2`) in a process
//!    group of its own, with the Editing Folder as working directory and the complete environment
//!    of `launch2::server_env` (key, password, per-run configuration), and keeps a pipe to its
//!    stdin: the server ends when that pipe closes, also when VidAI itself ends;
//! 2. reads its address from the first line it prints (`{"url":"http://127.0.0.1:<port>"}`);
//! 3. subscribes to `GET /api/event` and waits for `server.connected`, so nothing of the session
//!    is missed;
//! 4. decides the model: the built-in provider of the address (`opencode-go`, `opencode`) only
//!    when it lists the model (`GET /api/model`) and would use VidAI's key
//!    (`GET /api/integration/<provider>`: its first connection is `OPENCODE_API_KEY`, not a
//!    login stored in OpenCode), VidAI's own provider otherwise;
//! 5. creates the session (`POST /api/session` with a title, the model, the permissions of
//!    `launch2::session_permissions` and the Editing Folder as location), or checks that the
//!    session to resume exists (`GET /api/session/<id>`; a 404 is reported as Claude Code
//!    reports a session it does not have, then the server is closed) and moves it to the model
//!    (`POST /api/session/<id>/model`) when it ran on another one.
//!
//! Then [`Server2::send_user`] is `POST /api/session/<id>/prompt` (answered at once; the turn
//! runs on), [`Server2::interrupt`] interrupts the session (`POST /api/session/<id>/interrupt`)
//! and stops its background work (`GET /api/experimental/job`: each command is ended with
//! `DELETE /api/shell/<id>`, each sub-agent interrupted), reported as a `ControlResponse`, and
//! [`Server2::close`] closes the stdin pipe and ends the server (SIGTERM; on Windows its job object ends the tree). Sessions live in
//! OpenCode's own store, so a later server resumes a session by its id, also after VidAI
//! restarted.
//!
//! While the main session only waits for background work, the server's job list is checked
//! every [`RECONCILE_EVERY`], so work whose report never arrives does not hold the job forever
//! (`events2::Translator::reconcile`).
//!
//! Every request carries the per-run password (HTTP basic auth) and the Editing Folder as
//! `x-opencode-directory`, and goes to 127.0.0.1 without a proxy.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use super::child::{self, Callback, Clients, Gateway, ServerChild, Spawn, StartLimits};
use super::events2::{self, Action, Translator};
use super::launch2::{self, ModelRef, ServerCommand};
use crate::claude::protocol::{ControlResponse, StreamEvent};
use crate::claude::session::SessionEvent;

/// A new session (with its title) or an existing one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionStart {
    New { title: String },
    Resume(String),
}

/// How often the background work of a waiting session is checked against the server's job list.
pub const RECONCILE_EVERY: Duration = Duration::from_secs(30);

/// Everything one server and its session need.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub command: ServerCommand,
    /// The per-run password (also in `command.env`).
    pub password: String,
    /// The folder the session works in (the Editing Folder).
    pub directory: PathBuf,
    pub session: SessionStart,
    /// The model to ask for (`launch2::route`).
    pub model: ModelRef,
    /// The reasoning effort to ask for (`None`: the model's default); set as the `variant` of the
    /// session's model when the model offers it.
    pub effort: Option<String>,
    /// The servers run without VidAI's key (`launch2::TEST_LOGIN_VAR`): a built-in provider is
    /// used on whatever login the program has.
    pub test_login: bool,
    /// How long the start may take (shortened by tests).
    pub limits: StartLimits,
}

impl ServerConfig {
    /// The server of one job: `base_env` is the login-shell environment of the job,
    /// `base_url` the normalized OpenCode address (`None`: the default).
    pub fn for_job(
        program: PathBuf,
        editing_folder: PathBuf,
        base_env: &HashMap<String, String>,
        gateway: Gateway,
        session: SessionStart,
        private_dir: &Path,
    ) -> Self {
        let Gateway {
            option,
            key,
            base_url,
            model_id,
            effort,
        } = gateway;
        let password = launch2::new_password();
        let home = base_env.get("HOME").map(Path::new);
        let mut config = launch2::run_config(option, base_url, model_id, &editing_folder, home);
        let test_login = launch2::test_login(option);
        if test_login || key.is_none() {
            launch2::without_key(&mut config);
        }
        let mut env = launch2::server_env(option, base_env, key, &password, &config);
        launch2::isolate_user_config(&mut env, private_dir);
        if test_login {
            launch2::apply_test_login(&mut env);
        }
        Self {
            command: ServerCommand {
                program,
                cwd: editing_folder.clone(),
                env,
            },
            password,
            directory: editing_folder,
            session,
            model: launch2::route(option, base_url).model(model_id),
            effort: effort.map(str::to_owned),
            test_login,
            limits: StartLimits::default(),
        }
    }
}

/// A running OpenCode 2 server and its session.
pub struct Server2 {
    child: Arc<ServerChild>,
    http: Arc<Http>,
    session_id: String,
    model: ModelRef,
    translator: Arc<Mutex<Option<Translator>>>,
    on_event: Callback,
    next_request: Mutex<u64>,
    closed: Arc<AtomicBool>,
}

impl Server2 {
    /// Starts the server and its session (see the module docs). `on_event` is called from the
    /// server's reader threads and tasks and must not block for long; nothing is reported unless
    /// this returns `Ok`.
    pub fn start(
        config: &ServerConfig,
        on_event: impl Fn(SessionEvent) + Send + Sync + 'static,
        on_status: &dyn Fn(&str),
    ) -> io::Result<Self> {
        let on_event: Callback = Arc::new(on_event);
        let command = &config.command;
        let (stream_done_tx, stream_done_rx) = mpsc::channel::<()>();
        let child = ServerChild::spawn(
            &Spawn {
                program: &command.program,
                args: command.args(),
                cwd: &command.cwd,
                env: &command.env,
                stdin: true,
                listening: listening_url,
            },
            Arc::clone(&on_event),
            stream_done_rx,
        )?;
        let base = child
            .wait_for_url(&config.limits.wait(None, on_status))
            .map_err(|m| child.failure(m))?;
        let http = Arc::new(
            Http::new(base, &config.password, &config.directory).map_err(|m| child.failure(m))?,
        );
        let translator: Arc<Mutex<Option<Translator>>> = Arc::new(Mutex::new(None));
        if let Err(message) = Http::subscribe(
            &http,
            Arc::clone(&translator),
            Arc::clone(&on_event),
            child.armed(),
            stream_done_tx,
        ) {
            return Err(child.failure(message));
        }

        let model = http.choose_model(&config.model, config.test_login);
        let variant = config.effort.as_deref().and_then(|effort| {
            let offered = http.variants(&model);
            launch2::variant_for_effort(&model, effort, offered.as_deref())
                .map_err(|note| on_status(&note))
                .ok()
        });
        let variant = variant.as_deref();
        let (session_id, missing) = match &config.session {
            SessionStart::New { title } => match http.create_session(title, &model, variant) {
                Ok(id) => (id, false),
                Err(message) => return Err(child.failure(message)),
            },
            SessionStart::Resume(id) => match http.resume_session(id, &model, variant) {
                Ok(exists) => (id.clone(), !exists),
                Err(message) => return Err(child.failure(message)),
            },
        };
        *translator.lock().unwrap_or_else(PoisonError::into_inner) = Some(Translator::new(
            &session_id,
            &model.to_string(),
            Some(&http.directory),
        ));
        child.arm();
        let server = Self {
            child: Arc::new(child),
            http,
            session_id: session_id.clone(),
            model,
            translator,
            on_event,
            next_request: Mutex::new(0),
            closed: Arc::new(AtomicBool::new(false)),
        };
        if missing {
            (server.on_event)(SessionEvent::Line(StreamEvent::Result(
                events2::resume_not_found(&session_id),
            )));
            server.close();
        } else {
            server.watch_background()?;
        }
        Ok(server)
    }

    /// Process id (and process group id) of the server.
    pub fn pid(&self) -> u32 {
        self.child.pid
    }

    /// The session's id (OpenCode chooses it for a new session).
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The model the session runs.
    pub fn model(&self) -> &ModelRef {
        &self.model
    }

    fn with_translator<T>(&self, f: impl FnOnce(&mut Translator) -> T) -> Option<T> {
        with(&self.translator, f)
    }

    /// Sends one message. When OpenCode refuses it, the turn ends at once with an error
    /// `Result` that says why, and the error is returned.
    pub fn send_user(&self, text: &str) -> io::Result<()> {
        self.with_translator(Translator::prompt_sent);
        let path = format!("/api/session/{}/prompt", self.session_id);
        match self
            .http
            .call(reqwest::Method::POST, &path, Some(json!({ "text": text })))
        {
            Ok((status, _)) if (200..300).contains(&status) => Ok(()),
            outcome => {
                let message = match outcome {
                    Ok((status, body)) => format!(
                        "OpenCode refused the message (HTTP {status}): {}",
                        String::from_utf8_lossy(&body).trim()
                    ),
                    Err(message) => {
                        // A server that died meanwhile reports its own end (with its last words)
                        // next, like a Claude Code process whose stdin is gone.
                        if self.child.ended_within(child::EXIT_NOTICE) {
                            return Err(io::Error::new(io::ErrorKind::BrokenPipe, message));
                        }
                        message
                    }
                };
                let ended = self.with_translator(|t| t.prompt_refused(&message));
                for event in ended.unwrap_or_default() {
                    (self.on_event)(SessionEvent::Line(event));
                }
                Err(io::Error::other(message))
            }
        }
    }

    /// Interrupts the running turn and stops the session's background work, and returns the id
    /// of the `ControlResponse` that reports it done. The turn's own end follows as an
    /// interrupted `Result` when one was running. The job engine interrupts only to pause or stop
    /// a job, so every later busy period of the job is interrupted too (`Translator`).
    pub fn interrupt(&self) -> io::Result<String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "the server is closed",
            ));
        }
        let id = {
            let mut next = self
                .next_request
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            *next += 1;
            format!("vidai-interrupt-{}", *next)
        };
        self.with_translator(Translator::abort_requested);
        let path = format!("/api/session/{}/interrupt", self.session_id);
        let (status, body) = self
            .http
            .call(reqwest::Method::POST, &path, None)
            .map_err(io::Error::other)?;
        let success = (200..300).contains(&status);
        if success {
            self.http.stop_background(&self.session_id);
        }
        (self.on_event)(SessionEvent::Line(StreamEvent::ControlResponse(
            ControlResponse {
                request_id: id.clone(),
                success,
                error: (!success).then(|| String::from_utf8_lossy(&body).into_owned()),
            },
        )));
        Ok(id)
    }

    /// Ends the server: its stdin closes (it shuts down) and it gets SIGTERM (Windows: nothing
    /// more, see `ServerChild::signal`); the caller ends whatever is left of its tree. Its
    /// `Exited` follows. Idempotent.
    pub fn close(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            self.child.close_stdin();
            self.child.signal("TERM");
        }
    }

    /// Checks, while the main session only waits for background work, that the server still
    /// runs that work (see the module docs).
    fn watch_background(&self) -> io::Result<()> {
        let translator = Arc::clone(&self.translator);
        let http = Arc::clone(&self.http);
        let closed = Arc::clone(&self.closed);
        let child = Arc::clone(&self.child);
        let on_event = Arc::clone(&self.on_event);
        let session = self.session_id.clone();
        thread::Builder::new()
            .name(format!("opencode2-{}-jobs", self.child.pid))
            .spawn(move || {
                let step = Duration::from_millis(200);
                let mut waited = Duration::ZERO;
                loop {
                    thread::sleep(step);
                    if closed.load(Ordering::SeqCst) || child.exited.load(Ordering::SeqCst) {
                        return;
                    }
                    waited += step;
                    if waited < RECONCILE_EVERY {
                        continue;
                    }
                    waited = Duration::ZERO;
                    if !with(&translator, |t| t.waiting_for_background()).unwrap_or(false) {
                        continue;
                    }
                    let Some(running) = http.running_jobs(&session) else {
                        continue;
                    };
                    let gone = with(&translator, |t| {
                        // Only while nothing started meanwhile.
                        if t.waiting_for_background() {
                            t.reconcile(&running)
                        } else {
                            Vec::new()
                        }
                    });
                    for event in gone.unwrap_or_default() {
                        on_event(SessionEvent::Line(event));
                    }
                }
            })?;
        Ok(())
    }
}

impl Drop for Server2 {
    /// A server is never left running by accident.
    fn drop(&mut self) {
        self.close();
    }
}

fn with<T>(
    translator: &Mutex<Option<Translator>>,
    f: impl FnOnce(&mut Translator) -> T,
) -> Option<T> {
    translator
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_mut()
        .map(f)
}

/// The address in the first line the server prints with `--stdio` (`{"url":"..."}`); the line of
/// a server without `--stdio` (`server listening on http://...`) is understood too.
fn listening_url(line: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<Value>(line)
        && let Some(url) = value.get("url").and_then(Value::as_str)
        && url.starts_with("http://")
    {
        return Some(url.trim_end_matches('/').to_owned());
    }
    let rest = line.split("server listening on http://").nth(1)?.trim();
    let host_port = rest.split_whitespace().next().unwrap_or(rest);
    Some(format!("http://{host_port}"))
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

/// The server's API, with the password and the directory of every request.
struct Http {
    clients: Clients,
    base: String,
    password: String,
    directory: String,
}

impl Http {
    fn new(base: String, password: &str, directory: &Path) -> Result<Self, String> {
        Ok(Self {
            clients: Clients::new()?,
            base,
            password: password.to_owned(),
            directory: directory.to_string_lossy().into_owned(),
        })
    }

    fn request(
        &self,
        client: &reqwest::Client,
        method: reqwest::Method,
        path: &str,
    ) -> reqwest::RequestBuilder {
        client
            .request(method, format!("{}{path}", self.base))
            .basic_auth(launch2::USERNAME, Some(&self.password))
            .header("x-opencode-directory", encode(&self.directory))
    }

    /// One request and its answer: the status and the body, or why there was none.
    fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Vec<u8>), String> {
        let mut request = self.request(&self.clients.client, method, path);
        if let Some(body) = body {
            request = child::with_json(request, &body);
        }
        child::send(request)
    }

    fn json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        match self.call(method, path, body)? {
            (status, body) if (200..300).contains(&status) => serde_json::from_slice(&body)
                .map_err(|e| format!("OpenCode answered {path} with something unexpected: {e}")),
            (status, body) => Err(format!(
                "OpenCode answered {path} with HTTP {status}: {}",
                String::from_utf8_lossy(&body).trim()
            )),
        }
    }

    fn create_session(
        &self,
        title: &str,
        model: &ModelRef,
        variant: Option<&str>,
    ) -> Result<String, String> {
        let body = events2::session_body(
            title,
            &launch2::model_json(model, variant),
            &launch2::session_permissions(),
            &self.directory,
        );
        let session = self.json(reqwest::Method::POST, "/api/session", Some(body))?;
        session
            .pointer("/data/id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "OpenCode did not say which session it created".to_owned())
    }

    /// Whether the session exists; one that ran on another model (or reasoning effort) is moved
    /// to `model` with `variant`.
    fn resume_session(
        &self,
        id: &str,
        model: &ModelRef,
        variant: Option<&str>,
    ) -> Result<bool, String> {
        let session = match self.call(reqwest::Method::GET, &format!("/api/session/{id}"), None)? {
            (status, body) if (200..300).contains(&status) => {
                serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null)
            }
            (404, _) => return Ok(false),
            (status, body) => {
                return Err(format!(
                    "OpenCode could not look up the session (HTTP {status}): {}",
                    String::from_utf8_lossy(&body).trim()
                ));
            }
        };
        let current = session.pointer("/data/model").unwrap_or(&Value::Null);
        let same = current.get("providerID").and_then(Value::as_str)
            == Some(model.provider_id.as_str())
            && current.get("id").and_then(Value::as_str) == Some(model.model_id.as_str())
            && current.get("variant").and_then(Value::as_str) == variant;
        if !same {
            let body = json!({ "model": launch2::model_json(model, variant) });
            match self.call(
                reqwest::Method::POST,
                &format!("/api/session/{id}/model"),
                Some(body),
            )? {
                (status, _) if (200..300).contains(&status) => {}
                (status, body) => {
                    return Err(format!(
                        "OpenCode could not switch the session to the model (HTTP {status}): {}",
                        String::from_utf8_lossy(&body).trim()
                    ));
                }
            }
        }
        Ok(true)
    }

    /// The variant names of `model` in the server's catalog (`GET /api/model`: `variants` is a
    /// list of `{id}`); `None` when the catalog cannot be read or lacks the model.
    fn variants(&self, model: &ModelRef) -> Option<Vec<String>> {
        let list = self.json(reqwest::Method::GET, "/api/model", None).ok()?;
        let found = list.get("data")?.as_array()?.iter().find(|m| {
            m.get("providerID").and_then(Value::as_str) == Some(model.provider_id.as_str())
                && (m.get("id").and_then(Value::as_str) == Some(model.model_id.as_str())
                    || m.get("modelID").and_then(Value::as_str) == Some(model.model_id.as_str()))
        })?;
        Some(
            found
                .get("variants")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect(),
        )
    }

    /// `wanted` when its built-in provider lists the model and would use VidAI's key (or, for a
    /// test login, whatever login it has), else the model through VidAI's own provider, which
    /// always uses VidAI's key. When the server cannot say, VidAI's own provider.
    fn choose_model(&self, wanted: &ModelRef, test_login: bool) -> ModelRef {
        if wanted.provider_id == launch2::VIDAI_PROVIDER {
            return wanted.clone();
        }
        let listed = self
            .json(reqwest::Method::GET, "/api/model", None)
            .ok()
            .is_some_and(|list| {
                list.get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .any(|m| {
                        m.get("providerID").and_then(Value::as_str)
                            == Some(wanted.provider_id.as_str())
                            && (m.get("id").and_then(Value::as_str)
                                == Some(wanted.model_id.as_str())
                                || m.get("modelID").and_then(Value::as_str)
                                    == Some(wanted.model_id.as_str()))
                    })
            });
        let own_key = test_login
            || self
                .json(
                    reqwest::Method::GET,
                    &format!("/api/integration/{}", wanted.provider_id),
                    None,
                )
                .ok()
                .is_some_and(|integration| uses_key_variable(&integration));
        if listed && own_key {
            wanted.clone()
        } else {
            ModelRef::custom(&wanted.model_id)
        }
    }

    /// The ids of the session tree's background work that runs now, or `None` when the server
    /// cannot say.
    fn running_jobs(&self, session: &str) -> Option<Vec<String>> {
        let list = self
            .json(
                reqwest::Method::GET,
                &format!(
                    "/api/experimental/job?sessionID={session}&descendants=true&status=running"
                ),
                None,
            )
            .ok()?;
        Some(
            list.get("data")?
                .as_array()?
                .iter()
                .filter(|job| job.get("status").and_then(Value::as_str) == Some("running"))
                .filter_map(|job| job.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect(),
        )
    }

    /// Ends the commands of the session tree that run in the background and interrupts its
    /// sub-agents (an interrupt of the session alone leaves them running, and their reports would
    /// wake it again).
    fn stop_background(&self, session: &str) {
        let Ok(list) = self.json(
            reqwest::Method::GET,
            &format!("/api/experimental/job?sessionID={session}&descendants=true&status=running"),
            None,
        ) else {
            return;
        };
        for job in list
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let field = |key: &str| job.get(key).and_then(Value::as_str);
            let request = match (field("kind"), field("shellID"), field("childSessionID")) {
                (Some("shell"), Some(shell), _) => {
                    (reqwest::Method::DELETE, format!("/api/shell/{shell}"))
                }
                (Some("subagent"), _, Some(child)) => (
                    reqwest::Method::POST,
                    format!("/api/session/{child}/interrupt"),
                ),
                _ => continue,
            };
            let (method, path) = request;
            if let Err(message) = self.call(method, &path, None) {
                eprintln!("vidai: could not stop OpenCode's background work ({path}): {message}");
            }
        }
    }

    /// Connects the event stream and waits for `server.connected`; then a task reads it,
    /// translates it and answers permission requests and forms, and signals `done` when the
    /// stream ends.
    fn subscribe(
        http: &Arc<Self>,
        translator: Arc<Mutex<Option<Translator>>>,
        on_event: Callback,
        armed: Arc<AtomicBool>,
        done: mpsc::Sender<()>,
    ) -> Result<(), String> {
        let request = http.request(&http.clients.stream, reqwest::Method::GET, "/api/event");
        let answers = Arc::clone(http);
        child::subscribe(
            request,
            move |data| {
                let translated = with(&translator, |t| t.observe_data(data));
                let Some(translated) = translated else {
                    return;
                };
                for action in translated.actions {
                    answers.answer(action);
                }
                if armed.load(Ordering::SeqCst) {
                    for event in translated.events {
                        on_event(SessionEvent::Line(event));
                    }
                }
            },
            done,
        )
    }

    /// Answers a permission request or a form, or interrupts a session, without waiting.
    fn answer(&self, action: Action) {
        let (method, path, body) = match action {
            Action::ReplyPermission { session, id } => (
                reqwest::Method::POST,
                format!("/api/session/{session}/permission/{id}/reply"),
                Some(json!({ "decision": "once" })),
            ),
            Action::CancelForm { session, id } => {
                let mut url = format!("/api/session/{session}/form/{id}");
                url.push_str("?message=");
                url.push_str(&encode(events2::QUESTION_CANCELLED));
                (reqwest::Method::DELETE, url, None)
            }
            Action::Interrupt { session } => (
                reqwest::Method::POST,
                format!("/api/session/{session}/interrupt"),
                None,
            ),
        };
        let mut request = self.request(&self.clients.client, method, &path);
        if let Some(body) = body {
            request = child::with_json(request, &body);
        }
        child::send_detached(request, path);
    }
}

/// Whether a built-in provider would use `OPENCODE_API_KEY` (`GET /api/integration/<id>`: its
/// first connection, the one it uses, comes from that variable rather than a stored login).
fn uses_key_variable(integration: &Value) -> bool {
    integration.pointer("/data/connections/0").is_some_and(|c| {
        c.get("type").and_then(Value::as_str) == Some("env")
            && c.get("name").and_then(Value::as_str) == Some(launch2::KEY_VAR)
    })
}

/// Percent-encodes a header value or query value (an Editing Folder may have spaces or Devanagari
/// in its path; OpenCode decodes the header with `decodeURIComponent`).
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_listening_line() {
        assert_eq!(
            listening_url(r#"{"url":"http://127.0.0.1:59642"}"#).as_deref(),
            Some("http://127.0.0.1:59642")
        );
        assert_eq!(
            listening_url("server listening on http://127.0.0.1:47123").as_deref(),
            Some("http://127.0.0.1:47123")
        );
        assert_eq!(listening_url("Warning: something"), None);
        assert_eq!(listening_url(r#"{"url":"https://elsewhere"}"#), None);
    }

    #[test]
    fn a_built_in_provider_runs_only_on_vidais_key() {
        let env = json!({"data":{"id":"opencode","connections":[{"type":"env","name":"OPENCODE_API_KEY"}]}});
        let stored = json!({"data":{"id":"opencode","connections":[
            {"type":"credential","id":"crd_1","label":"OpenCode"},{"type":"env","name":"OPENCODE_API_KEY"}]}});
        let none = json!({"data":{"id":"opencode","connections":[]}});
        assert!(uses_key_variable(&env));
        assert!(!uses_key_variable(&stored));
        assert!(!uses_key_variable(&none));
    }

    #[test]
    fn folders_are_encoded_like_encode_uri_component() {
        assert_eq!(
            encode("/Users/editor/My Edits/वीडियो"),
            "%2FUsers%2Feditor%2FMy%20Edits%2F%E0%A4%B5%E0%A5%80%E0%A4%A1%E0%A4%BF%E0%A4%AF%E0%A5%8B"
        );
    }
}

//! Helpers shared by the integration tests: start the built `vidai-web` on a free port with a
//! throwaway data directory, talk HTTP to it the way a browser does, and read its event stream.
//! Requests carry the access cookie unless a test asks otherwise.

#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

pub const BIN: &str = env!("CARGO_BIN_EXE_vidai-web");
pub const PATIENCE: Duration = Duration::from_secs(60);

/// The line that says where the server is; the token is in its address.
const RUNNING: &str = "VidAI Web is running at http://127.0.0.1:";

/// A running `vidai-web`, ended when dropped.
pub struct Server {
    pub child: Child,
    pub port: u16,
    pub token: String,
    /// What the server prints on standard output, and on standard error.
    pub lines: mpsc::Receiver<String>,
    pub errors: mpsc::Receiver<String>,
    /// The data directory; owned here when the server made its own.
    data_path: PathBuf,
    _data: Option<tempfile::TempDir>,
}

/// The command to start the server in `data` on `port` (0: any), without a browser, with the
/// keys in memory and no real Claude Code.
pub fn command(data: &Path, port: u16) -> Command {
    let mut command = Command::new(BIN);
    command
        .args(["--port", &port.to_string(), "--no-open"])
        .env("VIDAI_DATA_DIR", data)
        .env("VIDAI_SECRETS", "memory")
        .env("VIDAI_CLAUDE_BIN", data.join("no-claude"))
        .env("VIDAI_WEB_NO_BROWSER", "1")
        .env_remove("VIDAI_WEB_PORT")
        .env_remove("VIDAI_WEB_DIST")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// Sends every line of `stream` to a channel (so reading never blocks a test).
pub fn forward_lines(stream: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (send, lines) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            if send.send(line).is_err() {
                break;
            }
        }
    });
    lines
}

/// The port and the token from the line that says the server is running.
pub fn parse_running(line: &str) -> Option<(u16, String)> {
    let address = line.strip_prefix(RUNNING)?;
    let (port, rest) = address.split_once("/?token=")?;
    Some((port.parse().ok()?, rest.trim().to_owned()))
}

impl Server {
    pub fn start() -> Self {
        Self::start_with(&[])
    }

    /// Starts with more environment variables (`VIDAI_WEB_DIST`, ...).
    pub fn start_with(env: &[(&str, &Path)]) -> Self {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().to_owned();
        Self::launch(path, Some(data), env)
    }

    /// Starts on an existing data directory (a restart keeps the token).
    pub fn start_in(data: &Path) -> Self {
        Self::launch(data.to_owned(), None, &[])
    }

    fn launch(path: PathBuf, owned: Option<tempfile::TempDir>, env: &[(&str, &Path)]) -> Self {
        let mut command = command(&path, 0);
        for (name, value) in env {
            command.env(name, value);
        }
        let mut child = command.spawn().unwrap();
        let lines = forward_lines(child.stdout.take().unwrap());
        let errors = forward_lines(child.stderr.take().unwrap());
        let started = Instant::now();
        let (port, token) = loop {
            let left = PATIENCE.saturating_sub(started.elapsed());
            let line = lines
                .recv_timeout(left)
                .expect("vidai-web did not say it is running");
            if let Some(found) = parse_running(&line) {
                break found;
            }
        };
        Self {
            child,
            port,
            token,
            lines,
            errors,
            data_path: path,
            _data: owned,
        }
    }

    pub fn data(&self) -> &Path {
        &self.data_path
    }

    /// Ends the process and waits for it (its lock on the data directory is let go).
    pub fn stop(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// The `Cookie` header value of a signed-in browser.
    pub fn cookie(&self) -> String {
        format!("vidai_web={}", self.token)
    }

    /// One request with the access cookie, a right `Host` and the extra `headers` (a header given
    /// here replaces the default of the same name).
    pub fn request(
        &self,
        method: &str,
        path: &str,
        body: &str,
        headers: &[(&str, &str)],
    ) -> Response {
        let cookie = self.cookie();
        let mut all = vec![("Cookie", cookie.as_str())];
        all.extend_from_slice(headers);
        request(self.port, method, path, body, &all)
    }

    /// The same without any cookie (a browser that never opened the tokenized address).
    pub fn anonymous(
        &self,
        method: &str,
        path: &str,
        body: &str,
        headers: &[(&str, &str)],
    ) -> Response {
        request(self.port, method, path, body, headers)
    }

    pub fn get(&self, path: &str) -> Response {
        self.request("GET", path, "", &[])
    }

    /// POSTs `args` to `/api/invoke/<command>`: the status and the JSON answer.
    pub fn invoke(&self, command: &str, args: &Value) -> (u16, Value) {
        let response = self.request(
            "POST",
            &format!("/api/invoke/{command}"),
            &args.to_string(),
            &[],
        );
        let value = serde_json::from_str(&response.body).expect("a JSON answer");
        (response.status, value)
    }

    /// Ends the process with SIGINT and returns its exit status (Unix).
    #[cfg(unix)]
    pub fn interrupt(&mut self) -> std::process::ExitStatus {
        let signalled = Command::new("kill")
            .args(["-INT", &self.child.id().to_string()])
            .status()
            .unwrap();
        assert!(signalled.success());
        wait_for_exit(&mut self.child)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(unix)]
pub fn wait_for_exit(child: &mut Child) -> std::process::ExitStatus {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(started.elapsed() < PATIENCE, "the process did not end");
        thread::sleep(Duration::from_millis(50));
    }
}

/// One answer.
pub struct Response {
    pub status: u16,
    pub head: String,
    pub body: String,
    pub bytes: Vec<u8>,
}

impl Response {
    /// The value of the header `name` (case does not matter); the first when there are several.
    pub fn header(&self, name: &str) -> Option<String> {
        self.headers(name).into_iter().next()
    }

    /// Every value of the header `name`.
    pub fn headers(&self, name: &str) -> Vec<String> {
        let prefix = format!("{}:", name.to_ascii_lowercase());
        self.head
            .lines()
            .skip(1)
            .filter(|line| line.to_ascii_lowercase().starts_with(&prefix))
            .map(|line| line[prefix.len()..].trim().to_owned())
            .collect()
    }
}

/// Opens a connection and sends one request. A `Host` of `127.0.0.1:<port>` is sent unless
/// `headers` has its own `Host`; a `Content-Type` of JSON the same way.
pub fn send(
    port: u16,
    method: &str,
    path: &str,
    body: &str,
    headers: &[(&str, &str)],
) -> TcpStream {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
    stream.set_read_timeout(Some(PATIENCE)).unwrap();
    let has = |name: &str| headers.iter().any(|(n, _)| n.eq_ignore_ascii_case(name));
    let mut head = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
    if !has("Host") {
        head.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    }
    if !has("Content-Type") {
        head.push_str("Content-Type: application/json\r\n");
    }
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    write!(stream, "{head}Content-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    stream
}

/// One request with `Connection: close`, read to the end.
pub fn request(
    port: u16,
    method: &str,
    path: &str,
    body: &str,
    headers: &[(&str, &str)],
) -> Response {
    let mut raw = Vec::new();
    send(port, method, path, body, headers)
        .read_to_end(&mut raw)
        .unwrap();
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("a complete response");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let bytes = raw[split + 4..].to_vec();
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    Response {
        status,
        head,
        body: String::from_utf8_lossy(&bytes).into_owned(),
        bytes,
    }
}

/// The open `/api/events` stream: the `data:` messages in order.
pub struct Events {
    lines: mpsc::Receiver<String>,
    _stream: TcpStream,
}

impl Events {
    /// Opens the stream as a signed-in browser.
    pub fn open(server: &Server) -> Self {
        let cookie = server.cookie();
        Self::open_with(server.port, &[("Cookie", cookie.as_str())])
    }

    pub fn open_with(port: u16, headers: &[(&str, &str)]) -> Self {
        let mut stream = send(port, "GET", "/api/events", "", headers);
        let reader = stream.try_clone().unwrap();
        let lines = forward_lines(reader);
        stream.flush().unwrap();
        Self {
            lines,
            _stream: stream,
        }
    }

    /// The next message, as `(event name, payload)`.
    pub fn next(&self) -> (String, Value) {
        let started = Instant::now();
        loop {
            let left = PATIENCE.saturating_sub(started.elapsed());
            let line = self.lines.recv_timeout(left).expect("no more events");
            if let Some(data) = line.strip_prefix("data:") {
                let message: Value = serde_json::from_str(data.trim()).unwrap();
                return (
                    message["event"].as_str().unwrap().to_owned(),
                    message["payload"].clone(),
                );
            }
        }
    }

    /// Reads until `name` comes, and returns its payload.
    pub fn wait_for(&self, name: &str) -> Value {
        loop {
            let (event, payload) = self.next();
            if event == name {
                return payload;
            }
        }
    }
}

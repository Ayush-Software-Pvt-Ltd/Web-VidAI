//! `POST /api/invoke/<command>`: one command of the core (or of a plugin), run by Tauri's own
//! handler (SPEC section 12, Server).
//!
//! The request becomes the `InvokeRequest` a webview would send, handed to `Webview::on_message`
//! of the hidden `main` webview, so Tauri does everything it does for a window: the invoke key,
//! the capability check (`capabilities/default.json`, the page counts as local), argument
//! decoding and the command itself. Its answer travels back through a oneshot channel.

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use tauri::http::HeaderMap;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse, InvokeResponseBody};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Manager, Url};
use tokio::sync::oneshot;
use vidai_lib::lifecycle::MAIN_WINDOW;

/// The most a request body may hold (a command's arguments).
pub const MAX_BODY: usize = 16 * 1024 * 1024;

/// The layer that applies [`MAX_BODY`] to the invoke route.
pub fn body_limit() -> DefaultBodyLimit {
    DefaultBodyLimit::max(MAX_BODY)
}

/// What a command answered.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The JSON text of the result.
    Json(String),
    /// A binary result (no command of VidAI has one).
    Bytes(Vec<u8>),
    /// The JSON text of a command's error, which is a 400.
    Failed(String),
    /// The server could not get an answer (not the command's error), which is a 500 or 503.
    Unavailable(StatusCode, String),
}

impl IntoResponse for Outcome {
    fn into_response(self) -> Response {
        let (status, content_type, body) = match self {
            Self::Json(text) => (StatusCode::OK, "application/json", text.into_bytes()),
            Self::Bytes(bytes) => (StatusCode::OK, "application/octet-stream", bytes),
            Self::Failed(text) => (
                StatusCode::BAD_REQUEST,
                "application/json",
                text.into_bytes(),
            ),
            Self::Unavailable(status, message) => (
                status,
                "application/json",
                json_string(&message).into_bytes(),
            ),
        };
        let mut response = (status, body).into_response();
        let headers = response.headers_mut();
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}

/// `text` as a JSON string.
fn json_string(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

/// The address Tauri treats as one of its own pages: the custom protocol origin of the app, which
/// the capability's `local` rule accepts without any `remote` entry.
fn local_url() -> Url {
    let origin = if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    Url::parse(origin).expect("a constant address")
}

/// The arguments of a request: an empty body means no arguments.
pub fn parse_args(body: &[u8]) -> Result<Value, String> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    serde_json::from_slice(body).map_err(|err| format!("The request body is not valid JSON: {err}"))
}

/// Runs `command` with `args` through the handler of the `main` webview.
pub async fn run_command(app: &AppHandle, command: String, args: Value) -> Outcome {
    let Some(webview) = app.get_webview_window(MAIN_WINDOW) else {
        return Outcome::Unavailable(
            StatusCode::SERVICE_UNAVAILABLE,
            "The VidAI core is not ready yet.".into(),
        );
    };
    let request = InvokeRequest {
        cmd: command,
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: local_url(),
        body: InvokeBody::Json(args),
        headers: HeaderMap::new(),
        invoke_key: app.invoke_key().to_owned(),
    };
    let (answer, answered) = oneshot::channel();
    // Off the async workers: a command Tauri runs synchronously may block.
    let handing_over = tauri::async_runtime::spawn_blocking(move || {
        webview.on_message(
            request,
            Box::new(move |_webview, _command, response, _callback, _error| {
                let _ = answer.send(response);
            }),
        );
    });
    if handing_over.await.is_err() {
        return Outcome::Unavailable(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The command could not be started.".into(),
        );
    }
    match answered.await {
        Ok(InvokeResponse::Ok(InvokeResponseBody::Json(text))) => Outcome::Json(text),
        Ok(InvokeResponse::Ok(InvokeResponseBody::Raw(bytes))) => Outcome::Bytes(bytes),
        Ok(InvokeResponse::Err(error)) => Outcome::Failed(error.0.to_string()),
        Err(_) => Outcome::Unavailable(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The command ended without an answer.".into(),
        ),
    }
}

/// `POST /api/invoke/<command>`.
pub async fn handler(
    State(app): State<AppHandle>,
    Path(command): Path<String>,
    body: Bytes,
) -> Response {
    match parse_args(&body) {
        Ok(args) => run_command(&app, command, args).await.into_response(),
        Err(message) => Outcome::Failed(json_string(&message)).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[test]
    fn an_empty_body_means_no_arguments() {
        assert_eq!(parse_args(b""), Ok(serde_json::json!({})));
        assert_eq!(parse_args(b" \n"), Ok(serde_json::json!({})));
        assert_eq!(
            parse_args(br#"{"videoId":"a/b"}"#),
            Ok(serde_json::json!({ "videoId": "a/b" }))
        );
        assert!(parse_args(b"{nope").unwrap_err().contains("not valid JSON"));
    }

    #[tokio::test]
    async fn outcomes_become_status_codes_and_json() {
        let ok = Outcome::Json("{\"a\":1}".into()).into_response();
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(ok.headers()[header::CACHE_CONTROL], "no-store");
        let failed = Outcome::Failed("{\"kind\":\"x\"}".into()).into_response();
        assert_eq!(failed.status(), StatusCode::BAD_REQUEST);
        let down = Outcome::Unavailable(StatusCode::SERVICE_UNAVAILABLE, "later".into());
        let down = down.into_response();
        assert_eq!(down.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            &to_bytes(down.into_body(), 100).await.unwrap()[..],
            b"\"later\""
        );
    }
}

//! VidAI's own requests to a service, and the readable texts for what it answers.
//!
//! Per API option (SPEC section 7a, "Options, addresses and protocols"):
//!
//! | Option | Model list | Test |
//! |---|---|---|
//! | `opencodeGo` | `GET <address>/v1/models`, bearer | `POST <address>/v1/messages`, bearer |
//! | `anthropicApi` | `GET <address>/v1/models`, `x-api-key` | `POST <address>/v1/messages`, `x-api-key` |
//! | `openaiApi` | `GET <address>/models`, bearer | `POST <address>/chat/completions`, bearer |
//!
//! The model list is fetched only when the user presses Fetch Models (or refreshes OpenCode Go);
//! it is a pick list, never authoritative for `anthropicApi` and `openaiApi`.
//!
//! The Anthropic list form is `{"data":[{"type":"model","id","display_name","created_at"}],
//! "has_more","last_id"}`, paged with `after_id` while `has_more` is set; the OpenAI form is
//! `{"data":[{"id"}]}` (extra fields, as Ollama and LM Studio add them, are ignored). The
//! Anthropic requests carry `anthropic-version: 2023-06-01`; every Test request has `max_tokens` 1. A fourth request, `GET <Go root>/v1/usage`, is the Go quota
//! (`opencode::usage`).
//!
//! Short timeouts, no redirects (the key must never follow one), plain `http` only for this
//! computer, a `VidAI/<version>` user agent, and the key never in a message. [`failure_text`]
//! turns an error answer into one user-readable sentence; the job errors of `jobs::errors` use it
//! too.

use std::time::Duration;

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::model::{ApiModel, ApiOption, ApiTest};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// The model list and the quota.
const LIST_TIMEOUT: Duration = Duration::from_secs(15);
/// The Test request runs the model once, which can take a while on a cold model.
const TEST_TIMEOUT: Duration = Duration::from_secs(60);
/// The most pages of models followed (a gateway that never ends its list stops here).
const MAX_PAGES: usize = 50;
/// The `anthropic-version` header of the Anthropic requests.
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Who answers: OpenCode (its own wording and console), or any other service, which the texts
/// call "the service" (SPEC section 7a, "Test and errors").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Service {
    OpenCode,
    Generic,
}

impl Service {
    /// The service of an address: OpenCode for `opencode.ai`, otherwise generic.
    pub fn for_base_url(base_url: &str) -> Self {
        let host = reqwest::Url::parse(base_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_ascii_lowercase));
        match host {
            Some(host) if host == "opencode.ai" || host.ends_with(".opencode.ai") => Self::OpenCode,
            _ => Self::Generic,
        }
    }

    /// For the start of a sentence.
    fn subject(self) -> &'static str {
        match self {
            Self::OpenCode => "OpenCode",
            Self::Generic => "The service",
        }
    }

    /// For the middle of a sentence.
    fn object(self) -> &'static str {
        match self {
            Self::OpenCode => "OpenCode",
            Self::Generic => "the service",
        }
    }
}

fn client(url: &reqwest::Url, timeout: Duration, service: Service) -> AppResult<reqwest::Client> {
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    let mut builder = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("VidAI/", env!("CARGO_PKG_VERSION")));
    if loopback {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|_| {
        AppError::internal(format!(
            "Could not prepare the request to {}.",
            service.object()
        ))
    })
}

fn parse_url(text: &str, service: Service) -> AppResult<reqwest::Url> {
    reqwest::Url::parse(text).map_err(|_| {
        AppError::invalid_input(format!("The address of {} is not valid.", service.object()))
    })
}

/// The answer to one request: the status and the body, or a readable transport failure.
pub struct Answer {
    pub status: u16,
    pub body: Vec<u8>,
}

async fn send(request: reqwest::RequestBuilder, service: Service) -> Result<Answer, String> {
    let response = request
        .send()
        .await
        .map_err(|err| transport_failure(&err, service))?;
    let status = response.status().as_u16();
    let body = response
        .bytes()
        .await
        .map_err(|err| transport_failure(&err, service))?
        .to_vec();
    Ok(Answer { status, body })
}

fn transport_failure(err: &reqwest::Error, service: Service) -> String {
    let (subject, object) = (service.subject(), service.object());
    if err.is_timeout() {
        format!("{subject} did not answer in time. Check your internet connection and try again.")
    } else if err.is_connect() {
        format!("Could not reach {object}. Check the address and your internet connection.")
    } else if err.is_redirect() {
        format!(
            "{subject} answered with a redirect, which VidAI does not follow. Check the address."
        )
    } else {
        format!("The connection to {object} failed. Check your internet connection and try again.")
    }
}

/// Adds the key the way the option's service wants it: a bearer token, or Anthropic's
/// `x-api-key` with its version header.
fn with_key(
    request: reqwest::RequestBuilder,
    option: ApiOption,
    key: Option<&str>,
) -> reqwest::RequestBuilder {
    match option {
        ApiOption::OpencodeGo | ApiOption::OpenaiApi => match key {
            Some(key) => request.bearer_auth(key),
            None => request,
        },
        ApiOption::AnthropicApi => match key {
            Some(key) => request.header("x-api-key", key),
            None => request,
        },
    }
}

/// The `anthropic-version` header, on the options that speak Anthropic's protocol.
fn with_protocol(request: reqwest::RequestBuilder, option: ApiOption) -> reqwest::RequestBuilder {
    match option {
        ApiOption::OpencodeGo | ApiOption::AnthropicApi => {
            request.header("anthropic-version", ANTHROPIC_VERSION)
        }
        ApiOption::OpenaiApi => request,
    }
}

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

/// One page of the Anthropic form of `GET /v1/models`: its models, and the id to continue after
/// when there is more.
pub fn parse_models_page(body: &[u8]) -> Option<(Vec<ApiModel>, Option<String>)> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let data = value.get("data")?.as_array()?;
    let models: Vec<ApiModel> = data
        .iter()
        .filter(|m| {
            m.get("type")
                .and_then(Value::as_str)
                .is_none_or(|t| t == "model")
        })
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.trim();
            if id.is_empty() {
                return None;
            }
            let name = m
                .get("display_name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .unwrap_or(id);
            Some(ApiModel {
                id: id.to_owned(),
                display_name: name.to_owned(),
            })
        })
        .collect();
    let has_more = value.get("has_more").and_then(Value::as_bool) == Some(true);
    let next = has_more
        .then(|| {
            value
                .get("last_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| models.last().map(|m| m.id.clone()))
        })
        .flatten();
    Some((models, next))
}

/// The OpenAI form of `GET /models`: `{"data":[{"id":...}]}`. The name of a model is its id.
pub fn parse_openai_models(body: &[u8]) -> Option<Vec<ApiModel>> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let data = value.get("data")?.as_array()?;
    Some(
        data.iter()
            .filter_map(|m| {
                let id = m.get("id")?.as_str()?.trim();
                (!id.is_empty()).then(|| ApiModel {
                    id: id.to_owned(),
                    display_name: id.to_owned(),
                })
            })
            .fold(Vec::new(), |mut models: Vec<ApiModel>, model| {
                if !models.iter().any(|m| m.id == model.id) {
                    models.push(model);
                }
                models
            }),
    )
}

/// Every model of `option` at `base_url`. With a key the request carries it (a key may see models
/// the public list does not); without one the public list is asked. The Anthropic form is
/// followed with `has_more`; the OpenAI form is one answer.
pub async fn fetch_models(
    option: ApiOption,
    base_url: &str,
    key: Option<&str>,
) -> AppResult<Vec<ApiModel>> {
    let service = Service::for_base_url(base_url);
    let path = match option {
        ApiOption::OpencodeGo | ApiOption::AnthropicApi => "v1/models",
        ApiOption::OpenaiApi => "models",
    };
    let url = parse_url(&format!("{base_url}/{path}"), service)?;
    let client = client(&url, LIST_TIMEOUT, service)?;
    let not_a_list = || {
        AppError::internal(format!(
            "{} answered, but not with a model list. Check the address.",
            service.subject()
        ))
    };
    let mut models: Vec<ApiModel> = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut page_url = url.clone();
        if option != ApiOption::OpenaiApi {
            let mut query = page_url.query_pairs_mut();
            query.append_pair("limit", "1000");
            if let Some(after) = &after {
                query.append_pair("after_id", after);
            }
        }
        let request = client
            .get(page_url)
            .header(reqwest::header::ACCEPT, "application/json");
        let request = with_key(with_protocol(request, option), option, key);
        let answer = send(request, service).await.map_err(AppError::internal)?;
        if answer.status != 200 {
            return Err(AppError::internal(failure_text_keyed(
                service,
                Some(answer.status),
                &String::from_utf8_lossy(&answer.body),
                None,
                key.is_some(),
            )));
        }
        if option == ApiOption::OpenaiApi {
            return parse_openai_models(&answer.body).ok_or_else(not_a_list);
        }
        let Some((page, next)) = parse_models_page(&answer.body) else {
            return Err(not_a_list());
        };
        for model in page {
            if !models.iter().any(|m| m.id == model.id) {
                models.push(model);
            }
        }
        match next {
            Some(next) if after.as_deref() != Some(next.as_str()) => after = Some(next),
            _ => return Ok(models),
        }
    }
    Ok(models)
}

// ---------------------------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------------------------

/// The Test action: one tiny request with `max_tokens` 1 (`POST <address>/v1/messages` for the
/// Anthropic protocol, `POST <address>/chat/completions` for OpenAI's). Never fails: every
/// problem is a readable [`ApiTest`] with `ok: false`.
pub async fn test(
    option: ApiOption,
    base_url: &str,
    key: Option<&str>,
    model: &str,
    model_name: &str,
) -> ApiTest {
    let service = Service::for_base_url(base_url);
    let outcome = async {
        let path = match option {
            ApiOption::OpencodeGo | ApiOption::AnthropicApi => "v1/messages",
            ApiOption::OpenaiApi => "chat/completions",
        };
        let url = parse_url(&format!("{base_url}/{path}"), service).map_err(|e| e.message)?;
        let client = client(&url, TEST_TIMEOUT, service).map_err(|e| e.message)?;
        let body = serde_json::json!({
            "model": model,
            "max_tokens": 1,
            "messages": [{ "role": "user", "content": "Hi" }],
        });
        let request = client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json")
            .body(body.to_string());
        let request = with_key(with_protocol(request, option), option, key);
        let answer = send(request, service).await?;
        let text = String::from_utf8_lossy(&answer.body).into_owned();
        if answer.status != 200 {
            return Err(failure_text_keyed(
                service,
                Some(answer.status),
                &text,
                Some(model),
                key.is_some(),
            ));
        }
        let message = serde_json::from_str::<Value>(&text).ok();
        let as_expected = match option {
            ApiOption::OpencodeGo | ApiOption::AnthropicApi => {
                message
                    .as_ref()
                    .and_then(|m| m.get("type"))
                    .and_then(Value::as_str)
                    == Some("message")
            }
            ApiOption::OpenaiApi => message
                .as_ref()
                .and_then(|m| m.get("choices"))
                .is_some_and(Value::is_array),
        };
        if !as_expected {
            return Err(format!(
                "{} answered, but not as expected. Check the address.",
                service.subject()
            ));
        }
        Ok(())
    }
    .await;
    match outcome {
        Ok(()) => ApiTest {
            ok: true,
            message: format!(
                "{} answered with {model_name}.",
                option.setup().service_name()
            ),
        },
        Err(message) => ApiTest {
            ok: false,
            message: crate::opencode::scrub(&message, key),
        },
    }
}

/// `GET <url>` with the key as a bearer token, for the quota.
pub async fn get_with_key(url: &str, key: &str) -> Result<Answer, String> {
    let service = Service::OpenCode;
    let url = parse_url(url, service).map_err(|e| e.message)?;
    let client = client(&url, LIST_TIMEOUT, service).map_err(|e| e.message)?;
    send(
        client
            .get(url)
            .bearer_auth(key)
            .header(reqwest::header::ACCEPT, "application/json"),
        service,
    )
    .await
}

// ---------------------------------------------------------------------------------------------
// What an error answer means
// ---------------------------------------------------------------------------------------------

/// The parts of an error answer: `{"type":"error","error":{"type","message"},"metadata":{...}}`
/// (or the same without the outer `type`).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct GatewayError {
    pub kind: Option<String>,
    pub message: Option<String>,
    /// `metadata.limitName` of a Go limit refusal: "5 hour", "weekly" or "monthly".
    pub limit_name: Option<String>,
}

/// Reads an error body; the JSON may follow other text (Claude Code's "API Error: 429 {...}").
/// An OpenAI style error (`{"error":{"message","type","code"}}`) is read the same way.
pub fn parse_error(text: &str) -> GatewayError {
    let json = text
        .find('{')
        .and_then(|start| serde_json::from_str::<Value>(text[start..].trim()).ok());
    let Some(value) = json else {
        return GatewayError::default();
    };
    let field = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    GatewayError {
        kind: field("/error/type"),
        message: field("/error/message"),
        limit_name: field("/metadata/limitName"),
    }
}

/// The Go window a `limitName` names, as the UI says it.
fn window_label(name: &str) -> Option<&'static str> {
    match name.trim().to_ascii_lowercase().as_str() {
        "5 hour" | "5-hour" | "rolling" => Some("5-hour"),
        "weekly" => Some("weekly"),
        "monthly" => Some("monthly"),
        _ => None,
    }
}

/// [`failure_text_for`], but a refusal of a request that carried no key (the key is optional on
/// options 3 and 4) asks for one instead of blaming a key that was never sent.
fn failure_text_keyed(
    service: Service,
    status: Option<u16>,
    text: &str,
    model: Option<&str>,
    has_key: bool,
) -> String {
    if !has_key && status == Some(401) {
        return "The service wants an API key. Enter one in Settings, Harness + API Keys."
            .to_owned();
    }
    failure_text_for(service, status, text, model)
}

/// One readable sentence for an error answer of OpenCode: [`failure_text_for`] with
/// [`Service::OpenCode`].
pub fn failure_text(status: Option<u16>, text: &str, model: Option<&str>) -> String {
    failure_text_for(Service::OpenCode, status, text, model)
}

/// One readable sentence for an error answer of `service` (`status` when known, the body or a
/// text that contains it). `model` is named when the model is the problem.
pub fn failure_text_for(
    service: Service,
    status: Option<u16>,
    text: &str,
    model: Option<&str>,
) -> String {
    let error = parse_error(text);
    let kind = error.kind.as_deref().unwrap_or_default();
    let lower = format!("{} {}", error.message.as_deref().unwrap_or_default(), text).to_lowercase();
    let the_model = match model {
        Some(model) => format!("the model {model}"),
        None => "this model".to_owned(),
    };
    let open = service == Service::OpenCode;
    let subject = service.subject();
    if kind == "GoUsageLimitError" || lower.contains("go usage limit") {
        return match error.limit_name.as_deref().and_then(window_label) {
            Some(window) => format!(
                "The {window} limit of your OpenCode Go plan is reached. It resets on its own; the OpenCode console shows when."
            ),
            None => "A limit of your OpenCode Go plan is reached. It resets on its own; the OpenCode console shows when.".to_owned(),
        };
    }
    if kind == "BudgetLimitError"
        || lower.contains("budget exceeded")
        || lower.contains("budget policy")
    {
        return if open {
            "An OpenCode budget limit is reached. Raise it in the OpenCode console, or wait until it resets.".to_owned()
        } else {
            "A budget limit of the service is reached. Raise it with the service, or wait until it resets.".to_owned()
        };
    }
    if kind == "FreeUsageLimitError" {
        return if open {
            "The free OpenCode limit is reached. Try again later, or choose a paid model."
                .to_owned()
        } else {
            "The free limit of the service is reached. Try again later, or choose a paid model."
                .to_owned()
        };
    }
    if status == Some(402)
        || kind == "CreditLimitExceeded"
        || lower.contains("insufficient account funds")
        || lower.contains("credit limit")
    {
        return if open {
            "Your OpenCode balance is used up. Add credit in the OpenCode console.".to_owned()
        } else {
            "Your balance with the service is used up. Add credit with the service.".to_owned()
        };
    }
    if lower.contains("invoice is overdue") {
        return if open {
            "Your OpenCode account has an overdue invoice. Settle it in the OpenCode console."
                .to_owned()
        } else {
            "Your account with the service has an overdue invoice. Settle it with the service."
                .to_owned()
        };
    }
    if status == Some(401)
        || matches!(kind, "authentication_error" | "AuthError")
        || lower.contains("invalid credential")
    {
        return if open {
            "OpenCode did not accept the API key. Check that you copied the whole key, or make a new one in the OpenCode console.".to_owned()
        } else {
            "The service did not accept the API key. Check that you copied the whole key, or make a new one with the service.".to_owned()
        };
    }
    if status == Some(404)
        || kind == "not_found_error"
        || kind == "ModelError"
        || lower.contains("model_not_found")
        || lower.contains("model not found")
        || lower.contains("not supported")
    {
        return format!(
            "{subject} does not offer {the_model} at this address. Choose another model in Settings, Harness + API Keys."
        );
    }
    if status == Some(403) || kind == "permission_error" {
        return if open {
            format!(
                "OpenCode does not allow {the_model} for this key: it is not in your plan, or it is a free model that only works in OpenCode's own apps. Choose another model in Settings, Harness + API Keys."
            )
        } else {
            format!(
                "The service does not allow {the_model} for this key: it is not in your plan. Choose another model in Settings, Harness + API Keys."
            )
        };
    }
    if status == Some(429) || kind == "rate_limit_error" || lower.contains("rate limit") {
        return format!("{subject} is limiting requests right now. Try again in a minute.");
    }
    match status {
        Some(code @ 500..=599) => {
            format!("{subject} is having problems right now (error {code}). Try again later.")
        }
        Some(code) => format!("{subject} answered with an unexpected error (HTTP {code})."),
        None => unknown_failure(service).to_owned(),
    }
}

/// What [`failure_text`] says when neither a status nor the text tells anything.
pub const UNKNOWN_FAILURE: &str = "OpenCode reported an error.";

/// [`UNKNOWN_FAILURE`] for `service`.
pub fn unknown_failure(service: Service) -> &'static str {
    match service {
        Service::OpenCode => UNKNOWN_FAILURE,
        Service::Generic => "The service reported an error.",
    }
}

/// A local stand-in for the OpenCode gateway, for the tests here and in `opencode::usage`.
#[cfg(test)]
pub(crate) mod stand_in {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    /// One request as the stand-in saw it.
    #[derive(Debug, Clone)]
    pub struct Seen {
        pub method: String,
        pub target: String,
        /// Lower-case header lines.
        pub headers: String,
        pub body: String,
    }

    /// Serves every request with `answer(&seen) -> (status, extra headers, body)` until the
    /// test ends; `base` is `http://127.0.0.1:<port>`.
    pub fn serve(
        answer: impl Fn(&Seen) -> (u16, String) + Send + Sync + 'static,
    ) -> (String, Arc<Mutex<Vec<Seen>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut data = Vec::new();
                let mut buf = [0u8; 4096];
                let head_end = loop {
                    if let Some(i) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break data.len(),
                        Ok(n) => data.extend_from_slice(&buf[..n]),
                    }
                };
                let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
                let length = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                    })
                    .unwrap_or(0);
                while data.len() < head_end + length {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => data.extend_from_slice(&buf[..n]),
                    }
                }
                let mut first = head.lines().next().unwrap_or_default().split(' ');
                let request = Seen {
                    method: first.next().unwrap_or_default().to_owned(),
                    target: first.next().unwrap_or_default().to_owned(),
                    headers: head.to_ascii_lowercase(),
                    body: String::from_utf8_lossy(&data[head_end.min(data.len())..]).into_owned(),
                };
                let (status, body) = answer(&request);
                log.lock().unwrap().push(request);
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (base, seen)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GO: ApiOption = ApiOption::OpencodeGo;

    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn the_model_list_is_paged_and_carries_the_key() {
        let (base, seen) = stand_in::serve(|req| {
            if req.target.contains("after_id=glm-5.3") {
                (200, r#"{"data":[{"type":"model","id":"kimi-k3","display_name":"Kimi K3"}],"has_more":false,"last_id":"kimi-k3"}"#.into())
            } else {
                (200, r#"{"data":[{"type":"model","id":"glm-5.3","display_name":"GLM-5.3"}],"has_more":true,"first_id":"glm-5.3","last_id":"glm-5.3"}"#.into())
            }
        });
        let base = format!("{base}/inference/go/anthropic");
        let models = run(fetch_models(GO, &base, Some("oc_sk_listkey"))).unwrap();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["glm-5.3", "kimi-k3"]
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(
            seen[0]
                .target
                .starts_with("/inference/go/anthropic/v1/models?limit=1000")
        );
        assert!(seen[1].target.ends_with("after_id=glm-5.3"));
        assert!(
            seen[0]
                .headers
                .contains("authorization: bearer oc_sk_listkey\r\n")
        );
        assert!(
            seen[0]
                .headers
                .contains(&format!("user-agent: vidai/{}", env!("CARGO_PKG_VERSION")))
        );
    }

    #[test]
    fn the_public_list_needs_no_key_and_errors_are_readable() {
        let (base, seen) = stand_in::serve(|req| {
            if req.headers.contains("authorization:") {
                (401, r#"{"type":"error","error":{"type":"authentication_error","message":"Invalid credential"}}"#.into())
            } else {
                (
                    200,
                    r#"{"data":[{"type":"model","id":"a"}],"has_more":false}"#.into(),
                )
            }
        });
        assert_eq!(run(fetch_models(GO, &base, None)).unwrap().len(), 1);
        assert!(!seen.lock().unwrap()[0].headers.contains("authorization:"));
        let err = run(fetch_models(GO, &base, Some("oc_sk_wrong_1234"))).unwrap_err();
        assert!(
            err.message
                .starts_with("The service did not accept the API key"),
            "{}",
            err.message
        );
        assert!(!err.message.contains("oc_sk_wrong"));
    }

    #[test]
    fn the_test_request_is_one_tiny_message() {
        let (base, seen) = stand_in::serve(|req| {
            let body: Value = serde_json::from_str(&req.body).unwrap();
            match body["model"].as_str().unwrap() {
                "ok-model" => (200, r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"H"}],"usage":{"input_tokens":3,"output_tokens":1,"opencode":{"billing_source":"go","allowance":0.0001}}}"#.into()),
                "forbidden" => (403, r#"{"type":"error","error":{"type":"permission_error","message":"Model not allowed"}}"#.into()),
                "limited" => (429, r#"{"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"},"metadata":{"workspace":"wrk_1","limitName":"5 hour"}}"#.into()),
                _ => (401, r#"{"type":"error","error":{"type":"authentication_error","message":"Invalid credential"}}"#.into()),
            }
        });
        let outcome = run(test(
            GO,
            &base,
            Some("oc_sk_testkey"),
            "ok-model",
            "OK Model",
        ));
        assert_eq!(
            outcome,
            ApiTest {
                ok: true,
                message: "OpenCode Go answered with OK Model.".into()
            }
        );
        {
            let seen = seen.lock().unwrap();
            assert_eq!(seen[0].method, "POST");
            assert_eq!(seen[0].target, "/v1/messages");
            assert!(
                seen[0]
                    .headers
                    .contains("authorization: bearer oc_sk_testkey\r\n")
            );
            assert!(
                seen[0]
                    .headers
                    .contains("anthropic-version: 2023-06-01\r\n")
            );
            let body: Value = serde_json::from_str(&seen[0].body).unwrap();
            assert_eq!(body["max_tokens"], 1);
        }
        let forbidden = run(test(GO, &base, Some("oc_sk_testkey"), "forbidden", "F"));
        assert!(
            !forbidden.ok
                && forbidden
                    .message
                    .contains("does not allow the model forbidden")
        );
        let limited = run(test(GO, &base, Some("oc_sk_testkey"), "limited", "L"));
        assert!(
            limited
                .message
                .starts_with("The 5-hour limit of your OpenCode Go plan")
        );
        let refused = run(test(GO, &base, Some("oc_sk_testkey"), "x", "X"));
        assert!(
            refused
                .message
                .starts_with("The service did not accept the API key")
        );
        assert!(!refused.message.contains("oc_sk_testkey"));
    }

    #[test]
    fn an_unreachable_gateway_is_named_plainly() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let outcome = run(test(
            GO,
            &format!("http://127.0.0.1:{port}"),
            Some("k"),
            "m",
            "M",
        ));
        assert!(
            outcome.message.starts_with("Could not reach the service"),
            "{outcome:?}"
        );
    }

    #[test]
    fn the_anthropic_api_uses_x_api_key_and_the_anthropic_paths() {
        let (base, seen) = stand_in::serve(|req| {
            if req.method == "GET" {
                (200, r#"{"data":[{"type":"model","id":"claude-x","display_name":"Claude X"}],"has_more":false}"#.into())
            } else {
                (200, r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"H"}]}"#.into())
            }
        });
        let models = run(fetch_models(
            ApiOption::AnthropicApi,
            &base,
            Some("sk-ant-key"),
        ))
        .unwrap();
        assert_eq!(models[0].display_name, "Claude X");
        let outcome = run(test(
            ApiOption::AnthropicApi,
            &base,
            Some("sk-ant-key"),
            "claude-x",
            "Claude X",
        ));
        assert_eq!(
            outcome,
            ApiTest {
                ok: true,
                message: "Anthropic Compatible API answered with Claude X.".into()
            }
        );
        let seen = seen.lock().unwrap();
        assert!(seen[0].target.starts_with("/v1/models?limit=1000"));
        assert!(seen[0].headers.contains("x-api-key: sk-ant-key\r\n"));
        assert!(
            seen[0]
                .headers
                .contains("anthropic-version: 2023-06-01\r\n")
        );
        assert!(!seen[0].headers.contains("authorization:"));
        assert_eq!(
            (seen[1].method.as_str(), seen[1].target.as_str()),
            ("POST", "/v1/messages")
        );
        assert!(seen[1].headers.contains("x-api-key: sk-ant-key\r\n"));
        assert!(!seen[1].headers.contains("authorization:"));
    }

    #[test]
    fn the_openai_api_uses_a_bearer_key_and_the_openai_paths() {
        let (base, seen) = stand_in::serve(|req| {
            if req.method == "GET" {
                (200, r#"{"object":"list","data":[{"id":"gpt-x","object":"model"},{"id":"gpt-x"},{"id":" "},{"id":"gpt-y"}]}"#.into())
            } else {
                (200, r#"{"id":"c1","choices":[{"index":0,"message":{"role":"assistant","content":"H"}}]}"#.into())
            }
        });
        let base = format!("{base}/v1");
        let models = run(fetch_models(ApiOption::OpenaiApi, &base, Some("sk-openai"))).unwrap();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["gpt-x", "gpt-y"]
        );
        let outcome = run(test(
            ApiOption::OpenaiApi,
            &base,
            Some("sk-openai"),
            "gpt-x",
            "gpt-x",
        ));
        assert_eq!(
            outcome,
            ApiTest {
                ok: true,
                message: "OpenAI Compatible API answered with gpt-x.".into()
            }
        );
        let seen = seen.lock().unwrap();
        // One request for the list: the OpenAI form has no paging.
        assert_eq!(seen[0].target, "/v1/models");
        assert!(
            seen[0]
                .headers
                .contains("authorization: bearer sk-openai\r\n")
        );
        assert!(!seen[0].headers.contains("anthropic-version"));
        assert!(!seen[0].headers.contains("x-api-key"));
        assert_eq!(
            (seen[1].method.as_str(), seen[1].target.as_str()),
            ("POST", "/v1/chat/completions")
        );
        let body: Value = serde_json::from_str(&seen[1].body).unwrap();
        assert_eq!(body["model"], "gpt-x");
        assert_eq!(body["max_tokens"], 1);
        assert_eq!(body["messages"][0]["role"], "user");
    }

    #[test]
    fn a_refusal_without_a_key_asks_for_one() {
        let (base, _) = stand_in::serve(|_| (401, r#"{"error":"unauthorized"}"#.into()));
        let err = run(fetch_models(ApiOption::OpenaiApi, &base, None)).unwrap_err();
        assert!(err.message.starts_with("The service wants an API key"));
        let outcome = run(test(ApiOption::AnthropicApi, &base, None, "m", "M"));
        assert!(!outcome.ok);
        assert!(outcome.message.starts_with("The service wants an API key"));
    }

    #[test]
    fn without_a_key_no_authorization_is_sent_on_either_protocol() {
        for option in [ApiOption::AnthropicApi, ApiOption::OpenaiApi] {
            let openai = option == ApiOption::OpenaiApi;
            let (base, seen) =
                stand_in::serve(move |request| match (request.method.as_str(), openai) {
                    ("GET", false) => (
                        200,
                        r#"{"data":[{"id":"m","display_name":"M"}],"has_more":false}"#.into(),
                    ),
                    ("GET", true) => (200, r#"{"data":[{"id":"m"}]}"#.into()),
                    (_, false) => (200, r#"{"type":"message","content":[]}"#.into()),
                    (_, true) => (200, r#"{"choices":[]}"#.into()),
                });
            let models = run(fetch_models(option, &base, None)).unwrap();
            assert_eq!(models[0].id, "m");
            let outcome = run(test(option, &base, None, "m", "M"));
            assert!(outcome.ok, "{outcome:?}");
            let seen = seen.lock().unwrap();
            assert_eq!(seen.len(), 2);
            for request in seen.iter() {
                assert!(!request.headers.contains("authorization:"), "{option:?}");
                assert!(!request.headers.contains("x-api-key"), "{option:?}");
            }
        }
    }

    #[test]
    fn an_answer_of_the_wrong_shape_is_named_without_blaming_a_vendor() {
        // An Anthropic style answer where the OpenAI protocol is expected, and the reverse.
        let (base, _) =
            stand_in::serve(|_| (200, r#"{"type":"message","content":[],"data":[]}"#.into()));
        let test_outcome = run(test(
            ApiOption::OpenaiApi,
            &base,
            Some("key-12345"),
            "m",
            "M",
        ));
        assert_eq!(
            test_outcome.message,
            "The service answered, but not as expected. Check the address."
        );
        let (base, _) = stand_in::serve(|_| (200, r#"{"choices":[]}"#.into()));
        assert_eq!(
            run(test(
                ApiOption::AnthropicApi,
                &base,
                Some("key-12345"),
                "m",
                "M"
            ))
            .message,
            "The service answered, but not as expected. Check the address."
        );
        let err = run(fetch_models(ApiOption::OpenaiApi, &base, None)).unwrap_err();
        assert_eq!(
            err.message,
            "The service answered, but not with a model list. Check the address."
        );
    }

    #[test]
    fn lists_of_local_servers_in_their_usual_shapes_are_read() {
        // Ollama and LM Studio add fields to the OpenAI form.
        let ollama = br#"{"object":"list","data":[
            {"id":"llama3.2:latest","object":"model","created":1,"owned_by":"library"},
            {"id":"qwen3:8b","object":"model","created":2,"owned_by":"library"}]}"#;
        let models = parse_openai_models(ollama).unwrap();
        assert_eq!(models[1].id, "qwen3:8b");
        // A server that answers the Anthropic path with the OpenAI form has no `type`.
        let (models, next) = parse_models_page(ollama).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(next, None);
        assert!(parse_openai_models(br#"{"models":[]}"#).is_none());
    }

    #[test]
    fn a_refused_local_server_is_named_plainly() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        for option in [ApiOption::AnthropicApi, ApiOption::OpenaiApi] {
            let err = run(fetch_models(
                option,
                &format!("http://localhost:{port}"),
                None,
            ))
            .unwrap_err();
            assert!(
                err.message.starts_with("Could not reach the service"),
                "{}",
                err.message
            );
        }
    }

    #[test]
    fn only_opencode_addresses_are_named_opencode() {
        for (url, service) in [
            (
                "https://opencode.ai/inference/go/anthropic",
                Service::OpenCode,
            ),
            ("https://api.opencode.ai/v1", Service::OpenCode),
            ("https://notopencode.ai/v1", Service::Generic),
            ("https://api.openai.com/v1", Service::Generic),
            ("http://127.0.0.1:9", Service::Generic),
            ("not a url", Service::Generic),
        ] {
            assert_eq!(Service::for_base_url(url), service, "{url}");
        }
        let auth = r#"{"type":"error","error":{"type":"authentication_error","message":"x"}}"#;
        assert!(
            failure_text_for(Service::Generic, Some(401), auth, None)
                .starts_with("The service did not accept the API key")
        );
        assert!(
            failure_text_for(Service::Generic, Some(404), "{}", Some("m"))
                .starts_with("The service does not offer the model m")
        );
        assert!(!failure_text_for(Service::Generic, Some(500), "", None).contains("OpenCode"));
        assert_eq!(
            failure_text_for(Service::Generic, None, "", None),
            "The service reported an error."
        );
    }

    #[test]
    fn reads_a_models_page() {
        let body = br#"{"data":[
            {"type":"model","id":"glm-5.3","display_name":"GLM-5.3","created_at":"2026-01-01T00:00:00Z"},
            {"type":"model","id":"no-name","display_name":"  "},
            {"type":"other","id":"skip"},
            {"type":"model","id":"  "}
        ],"has_more":false,"first_id":"glm-5.3","last_id":"no-name"}"#;
        let (models, next) = parse_models_page(body).unwrap();
        assert_eq!(
            models,
            vec![
                ApiModel {
                    id: "glm-5.3".into(),
                    display_name: "GLM-5.3".into()
                },
                ApiModel {
                    id: "no-name".into(),
                    display_name: "no-name".into()
                },
            ]
        );
        assert_eq!(next, None);
        let (_, next) =
            parse_models_page(br#"{"data":[{"id":"a"}],"has_more":true,"last_id":"a"}"#).unwrap();
        assert_eq!(next.as_deref(), Some("a"));
        // Without last_id the last model continues the list.
        let (_, next) = parse_models_page(br#"{"data":[{"id":"b"}],"has_more":true}"#).unwrap();
        assert_eq!(next.as_deref(), Some("b"));
        assert!(parse_models_page(b"<html>").is_none());
        assert!(parse_models_page(br#"{"models":[]}"#).is_none());
    }

    #[test]
    fn readable_failures() {
        let go = r#"{"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"},"metadata":{"workspace":"wrk_1","limitName":"5 hour"}}"#;
        assert!(
            failure_text(Some(429), go, None)
                .starts_with("The 5-hour limit of your OpenCode Go plan")
        );
        let weekly = go.replace("5 hour", "weekly");
        assert!(failure_text(Some(429), &weekly, None).starts_with("The weekly limit"));
        let budget = r#"{"type":"error","error":{"type":"BudgetLimitError","message":"A budget policy for this model has been reached."},"metadata":{"coverage":"models","resetsAt":"2026-11-01T00:00:00.000Z"}}"#;
        assert!(failure_text(Some(429), budget, None).starts_with("An OpenCode budget limit"));
        assert!(
            failure_text(
                None,
                "Upstream request failed: Policy budget exceeded",
                None
            )
            .starts_with("An OpenCode budget limit")
        );
        let auth = r#"{"type":"error","error":{"type":"authentication_error","message":"Invalid credential"}}"#;
        assert!(
            failure_text(Some(401), auth, None).starts_with("OpenCode did not accept the API key")
        );
        assert!(
            failure_text(Some(403), "{}", Some("big-pickle"))
                .contains("does not allow the model big-pickle")
        );
        assert!(
            failure_text(Some(404), "{}", Some("gone-1"))
                .contains("does not offer the model gone-1")
        );
        let credit = r#"{"type":"error","error":{"type":"CreditLimitExceeded","message":"Credit limit exceeded."}}"#;
        assert!(failure_text(Some(402), credit, None).contains("balance is used up"));
        let free = r#"{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}"#;
        assert!(failure_text(Some(429), free, None).contains("free OpenCode limit"));
        assert!(failure_text(Some(429), "{}", None).contains("limiting requests"));
        assert!(failure_text(Some(503), "", None).contains("error 503"));
        assert!(failure_text(Some(418), "", None).contains("HTTP 418"));
    }

    #[test]
    fn errors_inside_claude_code_text_are_read() {
        let text = r#"API Error: 429 {"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"},"metadata":{"limitName":"monthly"}}"#;
        let error = parse_error(text);
        assert_eq!(error.kind.as_deref(), Some("GoUsageLimitError"));
        assert_eq!(error.limit_name.as_deref(), Some("monthly"));
        assert!(failure_text(None, text, None).starts_with("The monthly limit"));
        assert_eq!(parse_error("no json"), GatewayError::default());
    }
}

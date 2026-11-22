//! Who may talk to the server (SPEC section 12, Server): `Host` and `Origin` checks against DNS
//! rebinding and cross-site requests, then the access token (cookie `vidai_web`).

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{self, HeaderMap, HeaderValue};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::token::{self, Access};

/// The cookie that carries the token.
pub const COOKIE: &str = "vidai_web";

/// How long the cookie lasts: one year.
const COOKIE_SECONDS: u32 = 365 * 24 * 60 * 60;

/// The page for a request without access.
const UNAUTHORIZED_PAGE: &str = include_str!("unauthorized.html");

/// The message of a request without access.
const UNAUTHORIZED_TEXT: &str = "Open the address that vidai-web printed when it started.";

/// Shared by the two layers.
pub type Shared = State<Arc<Access>>;

/// An answer for a request that is not let through: JSON under `/api/`, else a short text.
fn refuse(path: &str, status: StatusCode, kind: &str, message: &str) -> Response {
    let mut response = if path.starts_with("/api/") {
        let body = serde_json::json!({ "kind": kind, "message": message });
        (
            status,
            [(header::CONTENT_TYPE, "application/json")],
            body.to_string(),
        )
            .into_response()
    } else if status == StatusCode::UNAUTHORIZED {
        (
            status,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            UNAUTHORIZED_PAGE,
        )
            .into_response()
    } else {
        (
            status,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            message.to_owned(),
        )
            .into_response()
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Whether `host` is the server's own address: `127.0.0.1:<port>` or `localhost:<port>`.
pub fn host_allowed(host: &str, port: u16) -> bool {
    let host = host.to_ascii_lowercase();
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

/// Whether `origin` is a page of the server itself.
pub fn origin_allowed(origin: &str, port: u16) -> bool {
    origin
        .strip_prefix("http://")
        .is_some_and(|host| host_allowed(host, port))
}

/// Layer: every request needs one allowed `Host`, and an allowed `Origin` when it has one.
pub async fn check_host_and_origin(
    State(access): Shared,
    request: Request,
    next: Next,
) -> Response {
    let port = access.port;
    let headers = request.headers();
    let mut hosts = headers.get_all(header::HOST).iter();
    let host_ok = match (hosts.next(), hosts.next()) {
        (Some(host), None) => host.to_str().is_ok_and(|host| host_allowed(host, port)),
        _ => false,
    };
    // A request line in absolute form names a host too; it must agree.
    let target_ok = request
        .uri()
        .authority()
        .is_none_or(|authority| host_allowed(authority.as_str(), port));
    let origin_ok = headers.get_all(header::ORIGIN).iter().all(|origin| {
        origin
            .to_str()
            .is_ok_and(|origin| origin_allowed(origin, port))
    });
    if host_ok && target_ok && origin_ok {
        return next.run(request).await;
    }
    refuse(
        request.uri().path(),
        StatusCode::FORBIDDEN,
        "forbidden",
        "VidAI Web only answers requests for its own address on this computer.",
    )
}

/// The value of the query parameter `token`, as sent.
fn token_param(query: &str) -> Option<&str> {
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix("token="))
}

/// The value of the cookie `name`.
fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|line| line.split(';'))
        .find_map(|pair| pair.trim().strip_prefix(name)?.strip_prefix('='))
}

/// The redirect that turns the token of the address into the cookie.
fn start_session(token: &str) -> Response {
    let cookie =
        format!("{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={COOKIE_SECONDS}");
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SEE_OTHER;
    let headers = response.headers_mut();
    headers.insert(header::LOCATION, HeaderValue::from_static("/"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    // The token is hex, so this is a valid header value.
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        headers.insert(header::SET_COOKIE, value);
    }
    response
}

/// Layer: `GET /?token=...` with the right token sets the cookie and redirects to `/` (a wrong
/// one is 401); every other request needs the cookie.
pub async fn require_token(State(access): Shared, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let unauthorized = |path: &str| {
        refuse(
            path,
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            UNAUTHORIZED_TEXT,
        )
    };
    if request.method() == Method::GET
        && path == "/"
        && let Some(given) = request.uri().query().and_then(token_param)
    {
        return if token::matches(&access.token, given) {
            start_session(&access.token)
        } else {
            unauthorized(path)
        };
    }
    match cookie(request.headers(), COOKIE) {
        Some(given) if token::matches(&access.token, given) => next.run(request).await,
        _ => unauthorized(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_servers_own_names_are_allowed() {
        assert!(host_allowed("127.0.0.1:14200", 14200));
        assert!(host_allowed("localhost:14200", 14200));
        assert!(host_allowed("LocalHost:14200", 14200));
        for host in [
            "127.0.0.1",
            "localhost",
            "127.0.0.1:1",
            "evil.example:14200",
            "127.0.0.1:14200.evil.example",
            "localhost.evil.example:14200",
            "[::1]:14200",
            "",
        ] {
            assert!(!host_allowed(host, 14200), "{host}");
        }
    }

    #[test]
    fn an_origin_is_a_page_of_the_server() {
        assert!(origin_allowed("http://127.0.0.1:14200", 14200));
        assert!(origin_allowed("http://localhost:14200", 14200));
        for origin in [
            "null",
            "https://127.0.0.1:14200",
            "http://127.0.0.1:14201",
            "http://evil.example",
            "http://127.0.0.1:14200/",
        ] {
            assert!(!origin_allowed(origin, 14200), "{origin}");
        }
    }

    #[test]
    fn the_token_and_the_cookie_are_found() {
        assert_eq!(token_param("token=abc"), Some("abc"));
        assert_eq!(token_param("a=1&token=abc&b=2"), Some("abc"));
        assert_eq!(token_param("a=1"), None);
        assert_eq!(token_param("mytoken=abc"), None);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; vidai_web=xyz; b=2"),
        );
        assert_eq!(cookie(&headers, COOKIE), Some("xyz"));
        assert_eq!(cookie(&headers, "vidai"), None);
    }

    #[test]
    fn the_unauthorized_page_is_plain_and_has_no_em_dash() {
        assert!(UNAUTHORIZED_PAGE.contains("prefers-color-scheme: dark"));
        assert!(UNAUTHORIZED_PAGE.contains("vidai-web"));
        assert!(!UNAUTHORIZED_PAGE.contains('\u{2014}'));
    }
}

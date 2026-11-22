//! Response headers for the browser (SPEC section 12, Server).

use axum::extract::Request;
use axum::http::HeaderValue;
use axum::http::header::{
    self, CACHE_CONTROL, CONTENT_SECURITY_POLICY, REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS,
};
use axum::middleware::Next;
use axum::response::Response;

/// The Content-Security-Policy of `src-tauri/tauri.conf.json` without the Tauri schemes (`ipc:`,
/// `asset:`, `*.localhost`): the page loads its own files, talks to its own server (`fetch` and
/// the event stream), and shows its own images (`/api/asset`), `data:` and `blob:` images, inline
/// styles and its own fonts. A test compares it with the desktop one.
pub const POLICY: &str = "default-src 'self'; connect-src 'self'; \
     img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:";

/// Layer: the security headers on every answer, and `no-store` on API answers that do not say
/// otherwise. A Content-Security-Policy that a handler set itself stays (`/api/asset` answers
/// with a sandbox policy, so a file of the Editing Folder cannot run script as a page).
pub async fn add(request: Request, next: Next) -> Response {
    let api = request.uri().path().starts_with("/api/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    if !headers.contains_key(CONTENT_SECURITY_POLICY) {
        headers.insert(CONTENT_SECURITY_POLICY, HeaderValue::from_static(POLICY));
    }
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    if api && !headers.contains_key(header::CACHE_CONTROL) {
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The directives of a policy, as a sorted list of `directive sources` (the order of a JSON
    /// object does not matter to a browser).
    fn directives(policy: &str) -> Vec<String> {
        let mut all: Vec<String> = policy.split("; ").map(str::to_owned).collect();
        all.sort();
        all
    }

    /// The desktop policy with the Tauri schemes taken out.
    fn desktop_without_tauri_schemes() -> String {
        let text = include_str!("../../src-tauri/tauri.conf.json");
        let config: Value = serde_json::from_str(text).unwrap();
        let csp = config.pointer("/app/security/csp").unwrap();
        csp.as_object()
            .unwrap()
            .iter()
            .map(|(directive, value)| {
                let sources: Vec<&str> = value
                    .as_str()
                    .unwrap()
                    .split_whitespace()
                    .filter(|source| {
                        !matches!(
                            *source,
                            "ipc:" | "asset:" | "http://ipc.localhost" | "http://asset.localhost"
                        )
                    })
                    .collect();
                format!("{directive} {}", sources.join(" "))
            })
            .collect::<Vec<_>>()
            .join("; ")
    }

    #[test]
    fn the_policy_is_the_desktop_one_without_the_tauri_schemes() {
        assert_eq!(
            directives(POLICY),
            directives(&desktop_without_tauri_schemes())
        );
    }
}

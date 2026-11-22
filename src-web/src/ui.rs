//! The user interface: the regular `dist/` build of `src/` (SPEC section 12, Server).
//!
//! Release builds carry the files in the binary (`rust-embed`); debug builds read `../dist` from
//! disk on every request, and there `VIDAI_WEB_DIST` names another folder (the tests use it).
//! `index.html` gets `<script src="/vidai-env.js"></script>` before its first script, so the page
//! knows its platform and that it runs in the web version before its own code starts.

use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use axum::http::header::{
    CACHE_CONTROL, CONTENT_TYPE, ETAG, HeaderMap, HeaderValue, IF_NONE_MATCH,
};
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;
use vidai_lib::model::Platform;

/// The script tag that defines the page's environment.
pub const ENV_TAG: &str = r#"<script src="/vidai-env.js"></script>"#;

/// What to do about a build without UI files.
const BUILD_HINT: &str = "run `npm run build` in the VidAI folder, then start vidai-web again";

#[derive(RustEmbed)]
#[folder = "../dist"]
#[allow_missing = true]
struct Dist;

/// One file of the UI.
struct Asset {
    data: Cow<'static, [u8]>,
}

/// The file at `path` (no leading slash), if the UI has it.
fn load(path: &str) -> Option<Asset> {
    #[cfg(debug_assertions)]
    if let Some(folder) = std::env::var_os("VIDAI_WEB_DIST") {
        let file = std::path::Path::new(&folder).join(path);
        return std::fs::read(file)
            .ok()
            .map(|data| Asset { data: data.into() });
    }
    Dist::get(path).map(|file| Asset { data: file.data })
}

/// A sentence that says what is wrong when the build has no UI files, else `None`.
pub fn problem() -> Option<String> {
    load("index.html")
        .is_none()
        .then(|| format!("this VidAI Web build has no user interface files: {BUILD_HINT}"))
}

/// The content type for a file name.
pub fn content_type(path: &str) -> &'static str {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// `html` with [`ENV_TAG`] before its first script (else before `</head>`, else at the start).
pub fn inject_env(html: &str) -> String {
    let at = html
        .find("<script")
        .or_else(|| html.find("</head>"))
        .unwrap_or(0);
    let (before, after) = html.split_at(at);
    format!("{before}{ENV_TAG}\n    {after}")
}

/// The body of `/vidai-env.js`.
pub fn env_script() -> String {
    let version = serde_json::Value::from(env!("CARGO_PKG_VERSION"));
    format!(
        "{}\nObject.defineProperty(window, \"__VIDAI_WEB__\", {{ value: {{ version: {version} }} }});\n",
        vidai_lib::platform_init_script(Platform::current(), false),
    )
}

/// `GET /vidai-env.js`.
pub async fn env_js() -> Response {
    (
        [
            (CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (CACHE_CONTROL, "no-store"),
        ],
        env_script(),
    )
        .into_response()
}

/// Everything else: the files of the UI, `index.html` for pages of the app, 404 for the rest.
pub async fn files(method: Method, uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path();
    if path.starts_with("/api/") {
        return not_found();
    }
    if method != Method::GET && method != Method::HEAD {
        let mut response = StatusCode::METHOD_NOT_ALLOWED.into_response();
        response
            .headers_mut()
            .insert("allow", HeaderValue::from_static("GET, HEAD"));
        return response;
    }
    let relative = path.trim_start_matches('/');
    if relative.is_empty()
        || relative == "index.html"
        || (!has_extension(relative) && safe(relative))
    {
        return index();
    }
    match safe(relative).then(|| load(relative)).flatten() {
        Some(asset) => file(relative, asset, &headers),
        None => not_found(),
    }
}

/// Whether the last part of `path` has an extension.
fn has_extension(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .is_some_and(|name| name.contains('.'))
}

/// Whether `path` stays inside the UI folder: no `.` or `..` parts, no backslash, drive or NUL.
fn safe(path: &str) -> bool {
    !path.contains(['\\', ':', '\0']) && path.split('/').all(|part| part != ".." && part != ".")
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(CONTENT_TYPE, "text/plain; charset=utf-8")],
        "Not found",
    )
        .into_response()
}

/// `index.html` with the environment script, or the page that says the build has no UI.
fn index() -> Response {
    let Some(asset) = load("index.html") else {
        let page = format!(
            "<!doctype html><meta charset=\"utf-8\"><meta name=\"color-scheme\" content=\"light dark\">\
             <title>VidAI Web</title><body style=\"font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem\">\
             <h1>VidAI Web has no user interface yet</h1>\
             <p>This build of vidai-web was made without the user interface files.</p>\
             <p>To fix it, {BUILD_HINT}.</p>"
        );
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [
                (CONTENT_TYPE, "text/html; charset=utf-8"),
                (CACHE_CONTROL, "no-store"),
            ],
            page,
        )
            .into_response();
    };
    let html = String::from_utf8_lossy(&asset.data);
    (
        [
            (CONTENT_TYPE, "text/html; charset=utf-8"),
            (CACHE_CONTROL, "no-store"),
        ],
        inject_env(&html),
    )
        .into_response()
}

/// One file with its type and caching: hashed files under `assets/` never change, the rest is
/// checked again with an `ETag`.
fn file(path: &str, asset: Asset, request: &HeaderMap) -> Response {
    let mut hasher = DefaultHasher::new();
    asset.data.hash(&mut hasher);
    let etag = format!("\"{:016x}\"", hasher.finish());
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let same = request
        .get(IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|given| given == etag);
    let status = if same {
        StatusCode::NOT_MODIFIED
    } else {
        StatusCode::OK
    };
    let body = if same {
        Vec::new()
    } else {
        asset.data.into_owned()
    };
    let mut response = (status, body).into_response();
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type(path)));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static(cache));
    if let Ok(value) = HeaderValue::from_str(&etag) {
        headers.insert(ETAG, value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_env_tag_goes_before_the_first_script() {
        let html = "<html><head><meta charset=\"utf-8\"><script type=\"module\" src=\"/a.js\"></script></head></html>";
        let out = inject_env(html);
        let tag = out.find(ENV_TAG).unwrap();
        assert!(tag < out.find("<script type=\"module\"").unwrap());
        assert!(out.find("<meta").unwrap() < tag);
        assert_eq!(out.matches("<script").count(), 2);
    }

    #[test]
    fn without_a_script_the_tag_goes_to_the_end_of_the_head() {
        let out = inject_env("<head><title>t</title></head><body></body>");
        assert!(out.find("</title>").unwrap() < out.find(ENV_TAG).unwrap());
        assert!(out.find(ENV_TAG).unwrap() < out.find("</head>").unwrap());
        assert!(inject_env("plain").starts_with(ENV_TAG));
    }

    #[test]
    fn the_script_defines_platform_and_version() {
        let script = env_script();
        assert!(script.contains("\"__VIDAI_PLATFORM__\""), "{script}");
        assert!(script.contains(Platform::current().as_str()), "{script}");
        assert!(script.contains("\"__VIDAI_WEB__\""), "{script}");
        assert!(script.contains(env!("CARGO_PKG_VERSION")), "{script}");
        assert!(!script.contains('\u{2014}'));
    }

    #[test]
    fn types_follow_the_extension() {
        assert_eq!(
            content_type("assets/a-1.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type("assets/a.CSS"), "text/css; charset=utf-8");
        assert_eq!(content_type("logo.svg"), "image/svg+xml");
        assert_eq!(content_type("f.woff2"), "font/woff2");
        assert_eq!(content_type("noextension"), "application/octet-stream");
    }

    #[test]
    fn paths_cannot_leave_the_folder() {
        assert!(safe("assets/a.js"));
        assert!(!safe("../secret"));
        assert!(!safe("a/../../b"));
        assert!(!safe("a\\b"));
        assert!(!safe("C:/x"));
        assert!(has_extension("a/b.js"));
        assert!(!has_extension("a.b/c"));
    }
}

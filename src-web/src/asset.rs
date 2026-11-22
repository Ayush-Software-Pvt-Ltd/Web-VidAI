//! `GET /api/asset?path=<absolute path>`: a file of the Editing Folder for the page (SPEC
//! section 12, Server). It replaces Tauri's asset protocol (`assets.rs` of the core) with the same
//! scope: a file is served only when it lies inside the current Editing Folder.
//!
//! Safety is the point of this module:
//! - The folder is read from the core's settings on every request, so a changed Editing Folder
//!   takes effect at once and no folder means 403.
//! - The folder and the file are compared after `canonicalize` (symlinks resolved, `..` gone), so
//!   a link inside the folder that points outside is refused and a link to somewhere inside works.
//! - A path that does not exist cannot be resolved, so it is judged by its lexical form: outside
//!   the folder is 403 (the same answer whether it exists or not, so nothing can be probed),
//!   inside is 404.
//! - The file is opened by its resolved path and served from that very handle.
//!
//! Files are streamed (a video is never read into memory) with single `Range` support. A
//! response is cheap but never stale: `Last-Modified` with `If-Modified-Since` (304) and
//! `Cache-Control: private, max-age=0, must-revalidate`.

use std::io::SeekFrom;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;
use vidai_lib::error::AppError;
use vidai_lib::store::Store;

use crate::fs::clean;

/// What the browser may keep: it always asks again, and a 304 costs no body.
const CACHE_CONTROL: &str = "private, max-age=0, must-revalidate";

/// A file served from this address cannot run anything when it is opened as a page (an SVG or an
/// HTML file in the Editing Folder), while images and videos shown in the app are unaffected.
const SANDBOX: &str = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

/// How much one read of the stream takes.
const CHUNK: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
pub struct AssetQuery {
    path: Option<String>,
}

/// `GET /api/asset`.
pub async fn handler(
    State(app): State<AppHandle>,
    Query(query): Query<AssetQuery>,
    headers: HeaderMap,
) -> Response {
    let folder = app.state::<Store>().settings().editing_folder;
    respond(folder.as_deref(), query.path.as_deref(), &headers).await
}

/// The answer to one request. `folder` is the Editing Folder of the settings, `requested` the
/// `path` of the query.
pub async fn respond(
    folder: Option<&str>,
    requested: Option<&str>,
    headers: &HeaderMap,
) -> Response {
    let Some(folder) = folder.filter(|f| !f.is_empty()) else {
        return failure(StatusCode::FORBIDDEN, AppError::no_editing_folder());
    };
    let Some(requested) = requested.filter(|p| !p.is_empty()) else {
        return failure(
            StatusCode::BAD_REQUEST,
            AppError::invalid_input("The path is missing."),
        );
    };
    let requested = Path::new(requested);
    if !requested.is_absolute() {
        return outside();
    }
    let folder = Path::new(folder);
    let resolved = tokio::fs::canonicalize(requested).await;
    let canonical_folder = tokio::fs::canonicalize(folder).await.ok();
    let target = match resolved {
        Ok(target) => {
            let Some(canonical_folder) = canonical_folder else {
                return outside();
            };
            if !target.starts_with(&canonical_folder) {
                return outside();
            }
            target
        }
        Err(_) => {
            let typed = clean(requested);
            let inside = typed.starts_with(clean(folder))
                || canonical_folder.is_some_and(|c| typed.starts_with(c));
            return if inside { missing() } else { outside() };
        }
    };
    serve(&target, headers).await
}

/// The answer for a file that is inside the folder.
async fn serve(target: &Path, headers: &HeaderMap) -> Response {
    let Ok(mut file) = tokio::fs::File::open(target).await else {
        return missing();
    };
    let Ok(meta) = file.metadata().await else {
        return missing();
    };
    if !meta.is_file() {
        return missing();
    }
    let len = meta.len();
    let modified = meta.modified().ok();

    let mut base = HeaderMap::new();
    base.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(CACHE_CONTROL),
    );
    base.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    base.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    base.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(SANDBOX),
    );
    if let Some(modified) = modified {
        let stamp = httpdate::fmt_http_date(modified);
        if let Ok(value) = HeaderValue::from_str(&stamp) {
            base.insert(header::LAST_MODIFIED, value);
        }
    }

    if let Some(modified) = modified
        && not_modified_since(header_text(headers, header::IF_MODIFIED_SINCE), modified)
    {
        return with_headers(StatusCode::NOT_MODIFIED, base, Body::empty());
    }

    let content_type = mime_guess::from_path(target).first_or_octet_stream();
    if let Ok(value) = HeaderValue::from_str(content_type.essence_str()) {
        base.insert(header::CONTENT_TYPE, value);
    }

    let range = match header_text(headers, header::RANGE) {
        Some(text) if range_applies(header_text(headers, header::IF_RANGE), modified) => {
            parse_range(text, len)
        }
        _ => Requested::Whole,
    };
    let (status, start, count) = match range {
        Requested::Whole => (StatusCode::OK, 0, len),
        Requested::Part { start, end } => {
            let value = format!("bytes {start}-{end}/{len}");
            if let Ok(value) = HeaderValue::from_str(&value) {
                base.insert(header::CONTENT_RANGE, value);
            }
            (StatusCode::PARTIAL_CONTENT, start, end - start + 1)
        }
        Requested::Unsatisfiable => {
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{len}")) {
                base.insert(header::CONTENT_RANGE, value);
            }
            return with_headers(StatusCode::RANGE_NOT_SATISFIABLE, base, Body::empty());
        }
    };
    base.insert(header::CONTENT_LENGTH, HeaderValue::from(count));
    if start > 0 && file.seek(SeekFrom::Start(start)).await.is_err() {
        return missing();
    }
    let body = Body::from_stream(ReaderStream::with_capacity(file.take(count), CHUNK));
    with_headers(status, base, body)
}

fn with_headers(status: StatusCode, headers: HeaderMap, body: Body) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

fn header_text(headers: &HeaderMap, name: HeaderName) -> Option<&str> {
    headers.get(name)?.to_str().ok()
}

/// What a `Range` header asks of a file.
#[derive(Debug, PartialEq, Eq)]
pub enum Requested {
    /// No usable range: the whole file (a header that is malformed, of another unit or with
    /// several ranges is ignored, as HTTP allows).
    Whole,
    /// The bytes `start..=end` (inside the file).
    Part { start: u64, end: u64 },
    /// A valid range that starts behind the end of the file (416).
    Unsatisfiable,
}

/// Reads one `bytes=` range for a file of `len` bytes.
pub fn parse_range(text: &str, len: u64) -> Requested {
    let Some(spec) = text.trim().strip_prefix("bytes=") else {
        return Requested::Whole;
    };
    if spec.contains(',') {
        return Requested::Whole;
    }
    let Some((first, last)) = spec.trim().split_once('-') else {
        return Requested::Whole;
    };
    let (first, last) = (first.trim(), last.trim());
    let number = |s: &str| {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse::<u64>().ok())
    };
    match (number(first), number(last)) {
        // `-n`: the last n bytes.
        (None, Some(Some(n))) if first.is_empty() => {
            if n == 0 || len == 0 {
                Requested::Unsatisfiable
            } else {
                Requested::Part {
                    start: len.saturating_sub(n),
                    end: len - 1,
                }
            }
        }
        // `a-`: from a to the end.
        (Some(Some(start)), None) if last.is_empty() => {
            if start >= len {
                Requested::Unsatisfiable
            } else {
                Requested::Part {
                    start,
                    end: len - 1,
                }
            }
        }
        // `a-b`.
        (Some(Some(start)), Some(Some(end))) => {
            if end < start {
                Requested::Whole
            } else if start >= len {
                Requested::Unsatisfiable
            } else {
                Requested::Part {
                    start,
                    end: end.min(len - 1),
                }
            }
        }
        // A number too large for 64 bits cannot lie inside any file.
        (Some(None), _) if last.is_empty() || number(last).is_some() => Requested::Unsatisfiable,
        _ => Requested::Whole,
    }
}

/// `If-Range`: the range holds only while the file is the one the client saw. The value is a
/// date (this server sends no ETag); anything else means the range is not trusted.
fn range_applies(if_range: Option<&str>, modified: Option<SystemTime>) -> bool {
    let Some(text) = if_range else {
        return true;
    };
    let (Ok(seen), Some(modified)) = (httpdate::parse_http_date(text), modified) else {
        return false;
    };
    seconds(modified) == seconds(seen)
}

/// `If-Modified-Since`: true when the file has not changed after that date.
fn not_modified_since(since: Option<&str>, modified: SystemTime) -> bool {
    since
        .and_then(|text| httpdate::parse_http_date(text).ok())
        .is_some_and(|since| seconds(modified) <= seconds(since))
}

/// Whole seconds since the epoch (HTTP dates have no finer unit).
fn seconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn outside() -> Response {
    failure(
        StatusCode::FORBIDDEN,
        AppError::invalid_input("That file is not inside the Editing Folder."),
    )
}

fn missing() -> Response {
    failure(StatusCode::NOT_FOUND, AppError::not_found("No such file."))
}

/// An error answer: the core's `AppError` as JSON.
fn failure(status: StatusCode, error: AppError) -> Response {
    let body = serde_json::to_string(&error).unwrap_or_default();
    let mut response = (status, body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                HeaderName::from_static(name),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    async fn get(folder: &Path, path: &Path) -> Response {
        respond(folder.to_str(), path.to_str(), &HeaderMap::new()).await
    }

    async fn body(response: Response) -> Vec<u8> {
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec()
    }

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("Editing Folder");
        fs::create_dir_all(folder.join("ch").join("my video")).unwrap();
        fs::write(
            folder.join("ch").join("my video").join("thumb 1.jpg"),
            b"JPEGDATA",
        )
        .unwrap();
        fs::write(folder.join("clip.mp4"), (0..=255u8).collect::<Vec<_>>()).unwrap();
        fs::write(root.path().join("secret.txt"), b"secret").unwrap();
        (root, folder)
    }

    #[tokio::test]
    async fn serves_a_file_inside_with_its_type_and_cache_headers() {
        let (_root, folder) = setup();
        let file = folder.join("ch").join("my video").join("thumb 1.jpg");
        let response = get(&folder, &file).await;
        assert_eq!(response.status(), StatusCode::OK);
        let h = response.headers();
        assert_eq!(h[header::CONTENT_TYPE], "image/jpeg");
        assert_eq!(h[header::CACHE_CONTROL], CACHE_CONTROL);
        assert_eq!(h[header::ACCEPT_RANGES], "bytes");
        assert_eq!(h[header::CONTENT_LENGTH], "8");
        assert!(h.contains_key(header::LAST_MODIFIED));
        assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(body(response).await, b"JPEGDATA");
    }

    #[tokio::test]
    async fn a_query_with_percent_encoded_characters_and_spaces_reaches_the_file() {
        // The query goes through axum's own decoder, as in the real route.
        let (_root, folder) = setup();
        let file = folder.join("ch").join("my video").join("thumb 1.jpg");
        let encoded = file
            .to_str()
            .unwrap()
            .replace(' ', "%20")
            .replace('/', "%2F");
        let uri: axum::http::Uri = format!("/api/asset?path={encoded}").parse().unwrap();
        let Query(query) = Query::<AssetQuery>::try_from_uri(&uri).unwrap();
        assert_eq!(query.path.as_deref(), file.to_str());
        let response = respond(folder.to_str(), query.path.as_deref(), &HeaderMap::new()).await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn invalid_utf8_in_the_query_is_safe() {
        let (_root, folder) = setup();
        let uri: axum::http::Uri = "/api/asset?path=%2Ftmp%FF%FE%2Fx.jpg".parse().unwrap();
        let query = Query::<AssetQuery>::try_from_uri(&uri).map(|q| q.0.path);
        if let Ok(path) = query {
            let response = respond(folder.to_str(), path.as_deref(), &HeaderMap::new()).await;
            assert!(matches!(
                response.status(),
                StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
            ));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_file_name_that_is_not_utf8_is_served_by_its_own_bytes_or_refused_never_panics() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let (_root, folder) = setup();
        let odd = folder.join(OsStr::from_bytes(b"odd-\xff.jpg"));
        // macOS file systems refuse such a name, so there is nothing to test there.
        if fs::write(&odd, b"x").is_err() {
            return;
        }
        // The query is text, so the path cannot be asked for; the lossy text names nothing.
        let lossy = odd.to_string_lossy().into_owned();
        let response = respond(folder.to_str(), Some(&lossy), &HeaderMap::new()).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        // The same bytes through the plain path work, so the check itself is sound.
        let response = serve(&odd, &HeaderMap::new()).await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn dot_dot_out_of_the_folder_is_refused() {
        let (root, folder) = setup();
        let sneaky = folder.join("ch").join("..").join("..").join("secret.txt");
        assert!(root.path().join("secret.txt").exists());
        let response = get(&folder, &sneaky).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        // A missing target outside is refused the same way.
        let sneaky = folder.join("..").join("nothing-here.txt");
        assert_eq!(get(&folder, &sneaky).await.status(), StatusCode::FORBIDDEN);
        // A `..` that stays inside is fine.
        let inside = folder.join("ch").join("..").join("clip.mp4");
        assert_eq!(get(&folder, &inside).await.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn a_sibling_folder_with_the_same_prefix_is_outside() {
        let (root, folder) = setup();
        let sibling = root.path().join("Editing Folder 2");
        fs::create_dir_all(&sibling).unwrap();
        fs::write(sibling.join("a.jpg"), b"x").unwrap();
        let response = get(&folder, &sibling.join("a.jpg")).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn relative_and_empty_paths_are_refused() {
        let (_root, folder) = setup();
        for path in ["clip.mp4", "./clip.mp4", "../secret.txt"] {
            let response = respond(folder.to_str(), Some(path), &HeaderMap::new()).await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
        }
        let response = respond(folder.to_str(), Some(""), &HeaderMap::new()).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let response = respond(folder.to_str(), None, &HeaderMap::new()).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn no_editing_folder_is_403_and_a_missing_file_inside_is_404() {
        let (_root, folder) = setup();
        let file = folder.join("clip.mp4");
        let response = respond(None, file.to_str(), &HeaderMap::new()).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = respond(Some(""), file.to_str(), &HeaderMap::new()).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = get(&folder, &folder.join("nope.jpg")).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        // The error is the core's AppError JSON.
        let value: serde_json::Value = serde_json::from_slice(&body(response).await).unwrap();
        assert_eq!(value["code"], "notFound");
    }

    #[tokio::test]
    async fn a_folder_is_not_a_file() {
        let (_root, folder) = setup();
        let response = get(&folder, &folder.join("ch")).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let response = get(&folder, &folder).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_link_inside_that_points_outside_is_refused_and_one_to_inside_works() {
        use std::os::unix::fs::symlink;
        let (root, folder) = setup();
        symlink(root.path().join("secret.txt"), folder.join("leak.txt")).unwrap();
        symlink(root.path(), folder.join("dir-leak")).unwrap();
        symlink(folder.join("clip.mp4"), folder.join("alias.mp4")).unwrap();
        symlink(root.path().join("gone.txt"), folder.join("broken.txt")).unwrap();

        let r = get(&folder, &folder.join("leak.txt")).await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let r = get(&folder, &folder.join("dir-leak").join("secret.txt")).await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let r = get(&folder, &folder.join("alias.mp4")).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(body(r).await.len(), 256);
        // A dangling link inside is just a missing file.
        let r = get(&folder, &folder.join("broken.txt")).await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_editing_folder_itself_may_be_a_link() {
        use std::os::unix::fs::symlink;
        let (root, real) = setup();
        let link = root.path().join("link-to-folder");
        symlink(&real, &link).unwrap();
        // Asked through the link or through the real path, with the folder saved as the link.
        let r = get(&link, &link.join("clip.mp4")).await;
        assert_eq!(r.status(), StatusCode::OK);
        let r = get(&link, &real.join("clip.mp4")).await;
        assert_eq!(r.status(), StatusCode::OK);
        // And saved as the real folder.
        let r = get(&real, &link.join("clip.mp4")).await;
        assert_eq!(r.status(), StatusCode::OK);
        // Still nothing outside.
        let r = get(&link, &root.path().join("secret.txt")).await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        // A missing file below the link is a 404, not a 403.
        let r = get(&link, &link.join("missing.jpg")).await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_vanished_editing_folder_serves_nothing() {
        let (root, folder) = setup();
        let gone = root.path().join("gone");
        let r = get(&gone, &folder.join("clip.mp4")).await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let r = get(&gone, &gone.join("clip.mp4")).await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }

    async fn ranged(folder: &Path, range: &str) -> Response {
        respond(
            folder.to_str(),
            folder.join("clip.mp4").to_str(),
            &headers(&[("range", range)]),
        )
        .await
    }

    #[tokio::test]
    async fn a_range_gets_206_with_content_range() {
        let (_root, folder) = setup();
        let r = ranged(&folder, "bytes=10-19").await;
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 10-19/256");
        assert_eq!(r.headers()[header::CONTENT_LENGTH], "10");
        assert_eq!(r.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(body(r).await, (10..20u8).collect::<Vec<_>>());

        let r = ranged(&folder, "bytes=250-").await;
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 250-255/256");
        assert_eq!(body(r).await, (250..=255u8).collect::<Vec<_>>());

        let r = ranged(&folder, "bytes=-4").await;
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 252-255/256");

        // The end is clamped to the file.
        let r = ranged(&folder, "bytes=254-9999").await;
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 254-255/256");
        assert_eq!(body(r).await, vec![254, 255]);
    }

    #[tokio::test]
    async fn an_unsatisfiable_range_is_416_and_a_bad_one_is_ignored() {
        let (_root, folder) = setup();
        let r = ranged(&folder, "bytes=256-").await;
        assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes */256");
        for bad in [
            "bytes=abc",
            "items=0-1",
            "bytes=5-2",
            "bytes=0-1,4-5",
            "bytes=",
        ] {
            let r = ranged(&folder, bad).await;
            assert_eq!(r.status(), StatusCode::OK, "{bad}");
            assert_eq!(body(r).await.len(), 256, "{bad}");
        }
    }

    #[test]
    fn range_parsing() {
        use Requested::*;
        assert_eq!(parse_range("bytes=0-0", 10), Part { start: 0, end: 0 });
        assert_eq!(parse_range("bytes=0-", 10), Part { start: 0, end: 9 });
        assert_eq!(parse_range("bytes=-3", 10), Part { start: 7, end: 9 });
        assert_eq!(parse_range("bytes=-30", 10), Part { start: 0, end: 9 });
        assert_eq!(parse_range("bytes=-0", 10), Unsatisfiable);
        assert_eq!(parse_range("bytes=10-", 10), Unsatisfiable);
        assert_eq!(parse_range("bytes=0-", 0), Unsatisfiable);
        assert_eq!(parse_range("bytes=-1", 0), Unsatisfiable);
        assert_eq!(
            parse_range("bytes=99999999999999999999-", 10),
            Unsatisfiable
        );
        assert_eq!(parse_range(" bytes= 2 - 4 ", 10), Part { start: 2, end: 4 });
        assert_eq!(parse_range("bytes=+1-2", 10), Whole);
        assert_eq!(parse_range("bytes=-", 10), Whole);
        assert_eq!(parse_range("bytes", 10), Whole);
    }

    #[tokio::test]
    async fn if_modified_since_gives_304_and_a_newer_file_is_sent_again() {
        let (_root, folder) = setup();
        let file = folder.join("ch").join("my video").join("thumb 1.jpg");
        let first = get(&folder, &file).await;
        let stamp = first.headers()[header::LAST_MODIFIED]
            .to_str()
            .unwrap()
            .to_owned();

        let same = respond(
            folder.to_str(),
            file.to_str(),
            &headers(&[("if-modified-since", &stamp)]),
        )
        .await;
        assert_eq!(same.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(same.headers()[header::CACHE_CONTROL], CACHE_CONTROL);
        assert_eq!(same.headers()[header::LAST_MODIFIED], stamp.as_str());
        assert!(body(same).await.is_empty());

        // The client's copy is older than the file: the file is sent.
        let old = httpdate::fmt_http_date(UNIX_EPOCH + Duration::from_secs(1_000_000));
        let again = respond(
            folder.to_str(),
            file.to_str(),
            &headers(&[("if-modified-since", &old)]),
        )
        .await;
        assert_eq!(again.status(), StatusCode::OK);

        // A date that cannot be read counts as no date.
        let garbage = respond(
            folder.to_str(),
            file.to_str(),
            &headers(&[("if-modified-since", "yesterday")]),
        )
        .await;
        assert_eq!(garbage.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn if_range_with_another_date_sends_the_whole_file() {
        let (_root, folder) = setup();
        let file = folder.join("clip.mp4");
        let first = get(&folder, &file).await;
        let stamp = first.headers()[header::LAST_MODIFIED]
            .to_str()
            .unwrap()
            .to_owned();
        let same = respond(
            folder.to_str(),
            file.to_str(),
            &headers(&[("range", "bytes=0-9"), ("if-range", &stamp)]),
        )
        .await;
        assert_eq!(same.status(), StatusCode::PARTIAL_CONTENT);
        let old = httpdate::fmt_http_date(UNIX_EPOCH + Duration::from_secs(1_000_000));
        let other = respond(
            folder.to_str(),
            file.to_str(),
            &headers(&[("range", "bytes=0-9"), ("if-range", &old)]),
        )
        .await;
        assert_eq!(other.status(), StatusCode::OK);
        let etag = respond(
            folder.to_str(),
            file.to_str(),
            &headers(&[("range", "bytes=0-9"), ("if-range", "\"abc\"")]),
        )
        .await;
        assert_eq!(etag.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn an_empty_file_is_served_and_unknown_types_are_octet_stream() {
        let (_root, folder) = setup();
        fs::write(folder.join("empty.bin"), b"").unwrap();
        fs::write(folder.join("data.zzzunknown"), b"x").unwrap();
        let r = get(&folder, &folder.join("empty.bin")).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()[header::CONTENT_LENGTH], "0");
        let r = get(&folder, &folder.join("data.zzzunknown")).await;
        assert_eq!(
            r.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
    }
}

//! The user interface the server gives out (SPEC section 12, Server): files, the `index.html`
//! fallback, the environment script and the caching. A debug server reads the folder in
//! `VIDAI_WEB_DIST`, so these tests do not depend on the state of `dist/`.

#![cfg(debug_assertions)]

mod support;

use std::fs;
use std::path::Path;

use support::Server;

const INDEX: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>VidAI</title>
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-abc123.css">
  </head>
  <body><div id="root"></div></body>
</html>
"#;

/// A UI folder with `index.html`, hashed assets and a plain file, and a secret next to it.
fn fake_dist() -> tempfile::TempDir {
    let outer = tempfile::tempdir().unwrap();
    let dist = outer.path().join("dist");
    fs::create_dir_all(dist.join("assets")).unwrap();
    fs::write(dist.join("index.html"), INDEX).unwrap();
    fs::write(dist.join("assets/index-abc123.js"), "console.log('app');").unwrap();
    fs::write(dist.join("assets/index-abc123.css"), "body{margin:0}").unwrap();
    fs::write(
        dist.join("logo.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
    )
    .unwrap();
    fs::write(outer.path().join("secret.txt"), "SECRET").unwrap();
    outer
}

fn start(outer: &Path) -> Server {
    Server::start_with(&[("VIDAI_WEB_DIST", &outer.join("dist"))])
}

#[test]
fn the_index_gets_the_environment_script_before_its_first_script() {
    let outer = fake_dist();
    let server = start(outer.path());
    for path in ["/", "/index.html"] {
        let response = server.get(path);
        assert_eq!(response.status, 200, "{path}");
        assert_eq!(
            response.header("content-type").as_deref(),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(
            response.header("cache-control").as_deref(),
            Some("no-store")
        );
        let tag = response
            .body
            .find(r#"<script src="/vidai-env.js"></script>"#)
            .expect(path);
        let module = response.body.find(r#"<script type="module""#).unwrap();
        assert!(tag < module, "{path}: {}", response.body);
        assert!(response.body.contains(r#"src="/assets/index-abc123.js""#));
        assert_eq!(response.body.matches("vidai-env.js").count(), 1);
    }
}

#[test]
fn pages_of_the_app_get_the_index_and_missing_files_are_404() {
    let outer = fake_dist();
    let server = start(outer.path());
    let index = server.get("/").body;
    for path in [
        "/library",
        "/channel/abc/video/def",
        "/settings/",
        "/assets",
    ] {
        let response = server.get(path);
        assert_eq!(response.status, 200, "{path}");
        assert_eq!(response.body, index, "{path}");
    }
    // A name with an extension is a file: no file, no page.
    for path in [
        "/assets/missing.js",
        "/nope.png",
        "/a/b/c.css",
        "/favicon.ico",
    ] {
        let response = server.get(path);
        assert_eq!(response.status, 404, "{path}");
        assert!(!response.body.contains("<div id=\"root\">"), "{path}");
    }
    // Unknown API paths are not pages either.
    assert_eq!(server.get("/api/nothing").status, 404);
    assert_eq!(
        server.request("POST", "/api/nothing", "{}", &[]).status,
        404
    );
    // Only GET and HEAD read files.
    let response = server.request("POST", "/library", "", &[]);
    assert_eq!(response.status, 405);
}

#[test]
fn a_path_cannot_leave_the_ui_folder() {
    let outer = fake_dist();
    let server = start(outer.path());
    for path in [
        "/../secret.txt",
        "/assets/../../secret.txt",
        "/%2e%2e/secret.txt",
        "/..%2fsecret.txt",
        "/assets/..%5c..%5csecret.txt",
        "//secret.txt",
        "/..\\secret.txt",
        "/%00.js",
    ] {
        let response = server.get(path);
        assert!(
            !response.body.contains("SECRET"),
            "{path}: {}",
            response.body
        );
    }
}

#[test]
fn files_have_their_type_and_caching() {
    let outer = fake_dist();
    let server = start(outer.path());

    let script = server.get("/assets/index-abc123.js");
    assert_eq!(script.status, 200);
    assert_eq!(
        script.header("content-type").as_deref(),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(
        script.header("cache-control").as_deref(),
        Some("public, max-age=31536000, immutable")
    );
    assert_eq!(script.body, "console.log('app');");
    let style = server.get("/assets/index-abc123.css");
    assert_eq!(
        style.header("content-type").as_deref(),
        Some("text/css; charset=utf-8")
    );

    let logo = server.get("/logo.svg");
    assert_eq!(logo.status, 200);
    assert_eq!(
        logo.header("content-type").as_deref(),
        Some("image/svg+xml")
    );
    assert_eq!(logo.header("cache-control").as_deref(), Some("no-cache"));

    // A file that has not changed is not sent again.
    let etag = logo.header("etag").expect("an ETag");
    let again = server.request("GET", "/logo.svg", "", &[("If-None-Match", &etag)]);
    assert_eq!(again.status, 304);
    assert!(again.bytes.is_empty());
    let other = server.request("GET", "/logo.svg", "", &[("If-None-Match", "\"other\"")]);
    assert_eq!(other.status, 200);

    // HEAD gives the head only.
    let head = server.request("HEAD", "/assets/index-abc123.js", "", &[]);
    assert_eq!(head.status, 200);
    assert!(head.bytes.is_empty());
}

#[test]
fn the_environment_script_says_platform_and_version() {
    let outer = fake_dist();
    let server = start(outer.path());
    let response = server.get("/vidai-env.js");
    assert_eq!(response.status, 200);
    assert_eq!(
        response.header("content-type").as_deref(),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(
        response.header("cache-control").as_deref(),
        Some("no-store")
    );
    let platform = if cfg!(windows) { "windows" } else { "macos" };
    assert!(
        response.body.contains(&format!(
            "Object.defineProperty(window, \"__VIDAI_PLATFORM__\", {{ value: \"{platform}\" }})"
        )),
        "{}",
        response.body
    );
    assert!(
        response.body.contains(&format!(
            "Object.defineProperty(window, \"__VIDAI_WEB__\", {{ value: {{ version: \"{}\" }} }})",
            env!("CARGO_PKG_VERSION")
        )),
        "{}",
        response.body
    );
    assert!(!response.body.contains('\u{2014}'));
}

#[test]
fn a_build_without_ui_files_says_how_to_build_them() {
    let empty = tempfile::tempdir().unwrap();
    let server = Server::start_with(&[("VIDAI_WEB_DIST", empty.path())]);
    let response = server.get("/");
    assert_eq!(response.status, 503);
    assert!(response.body.contains("npm run build"), "{}", response.body);
    assert!(!response.body.contains('\u{2014}'));
    assert_eq!(server.get("/library").status, 503);
    // The rest still works, and the terminal was told.
    assert_eq!(server.get("/vidai-env.js").status, 200);
    assert_eq!(server.invoke("get_settings", &serde_json::json!({})).0, 200);
    let said = server
        .errors
        .recv_timeout(support::PATIENCE)
        .expect("a warning");
    assert!(
        said.contains("no user interface files") && said.contains("npm run build"),
        "{said}"
    );
}

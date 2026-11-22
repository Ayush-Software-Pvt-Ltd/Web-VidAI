//! The file routes of the real server: `/api/asset` and the file picker's `/api/fs/*` (SPEC
//! section 12, Server). The path rules themselves are unit-tested in `src/asset.rs` and
//! `src/fs.rs`; these tests drive the real routes behind the token, the headers and the core's
//! settings.

mod support;

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use support::{Response, Server};

/// Percent-encodes everything but unreserved characters, as `encodeURIComponent` does.
fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                char::from(b).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn asset(server: &Server, path: &Path, headers: &[(&str, &str)]) -> Response {
    let target = format!("/api/asset?path={}", encode(path.to_str().unwrap()));
    server.request("GET", &target, "", headers)
}

fn post(server: &Server, route: &str, body: &Value) -> (u16, Value) {
    let response = server.request("POST", &format!("/api/fs/{route}"), &body.to_string(), &[]);
    let value = serde_json::from_str(&response.body).expect("a JSON answer");
    (response.status, value)
}

struct World {
    server: Server,
    _root: tempfile::TempDir,
    folder: PathBuf,
    outside: PathBuf,
}

/// A server whose Editing Folder holds a picture; a file with a secret lies next to the folder.
fn world() -> World {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("My Videos");
    let video = folder.join("Channel").join("video 1");
    fs::create_dir_all(&video).unwrap();
    fs::write(video.join("thumb 1.jpg"), (0..=255u8).collect::<Vec<_>>()).unwrap();
    let outside = root.path().join("secret.txt");
    fs::write(&outside, b"secret").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, folder.join("leak.txt")).unwrap();
    let server = Server::start();
    let (status, _) = server.invoke("set_editing_folder", &json!({ "path": folder }));
    assert_eq!(status, 200);
    World {
        server,
        _root: root,
        folder,
        outside,
    }
}

#[test]
fn an_asset_inside_the_editing_folder_is_served_with_range_and_revalidation() {
    let w = world();
    let file = w.folder.join("Channel").join("video 1").join("thumb 1.jpg");
    let r = asset(&w.server, &file, &[]);
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-type").as_deref(), Some("image/jpeg"));
    assert_eq!(r.header("accept-ranges").as_deref(), Some("bytes"));
    assert_eq!(
        r.header("cache-control").as_deref(),
        Some("private, max-age=0, must-revalidate")
    );
    assert_eq!(r.bytes.len(), 256);

    let r = asset(&w.server, &file, &[("Range", "bytes=10-19")]);
    assert_eq!(r.status, 206);
    assert_eq!(
        r.header("content-range").as_deref(),
        Some("bytes 10-19/256")
    );
    assert_eq!(r.bytes, (10..20u8).collect::<Vec<_>>());

    let r = asset(&w.server, &file, &[("Range", "bytes=999-")]);
    assert_eq!(r.status, 416);
    assert_eq!(r.header("content-range").as_deref(), Some("bytes */256"));

    let stamp = asset(&w.server, &file, &[])
        .header("last-modified")
        .unwrap();
    let r = asset(&w.server, &file, &[("If-Modified-Since", &stamp)]);
    assert_eq!(r.status, 304);
    assert!(r.bytes.is_empty());
}

#[test]
fn an_asset_outside_the_editing_folder_is_refused() {
    let w = world();
    assert_eq!(asset(&w.server, &w.outside, &[]).status, 403);
    let sneaky = w.folder.join("..").join("secret.txt");
    assert_eq!(asset(&w.server, &sneaky, &[]).status, 403);
    #[cfg(unix)]
    assert_eq!(
        asset(&w.server, &w.folder.join("leak.txt"), &[]).status,
        403
    );
    assert_eq!(
        asset(&w.server, &w.folder.join("nope.jpg"), &[]).status,
        404
    );
    // No path, a relative path.
    assert_eq!(w.server.get("/api/asset").status, 400);
    assert_eq!(
        w.server.get("/api/asset?path=thumb.jpg").status,
        403,
        "relative"
    );
    // Not without the access cookie, either.
    let target = format!("/api/asset?path={}", encode(w.outside.to_str().unwrap()));
    assert_eq!(w.server.anonymous("GET", &target, "", &[]).status, 401);
}

#[test]
fn without_an_editing_folder_nothing_is_served() {
    let server = Server::start();
    let r = server.get("/api/asset?path=%2Ftmp%2Fx.jpg");
    assert_eq!(r.status, 403);
    let value: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(value["code"], "noEditingFolder");
}

#[test]
fn the_picker_lists_places_and_makes_folders() {
    let w = world();
    let folder = w.folder.to_str().unwrap();

    // A folder: folders first, then files, hidden ones left out.
    fs::create_dir(w.folder.join(".hidden")).unwrap();
    let (status, listing) = post(&w.server, "list", &json!({ "path": folder }));
    assert_eq!(status, 200);
    assert_eq!(listing["path"], folder);
    assert_eq!(listing["name"], Value::Null);
    assert_eq!(
        listing["parent"],
        w.folder.parent().unwrap().to_str().unwrap()
    );
    let kinds: Vec<(String, String)> = listing["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["name"].as_str().unwrap().to_owned(),
                e["kind"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert!(
        kinds.contains(&("Channel".into(), "folder".into())),
        "{kinds:?}"
    );
    assert!(
        kinds.iter().all(|(name, _)| !name.starts_with('.')),
        "{kinds:?}"
    );
    let first_file = kinds.iter().position(|(_, k)| k == "file");
    let last_folder = kinds.iter().rposition(|(_, k)| k == "folder");
    if let (Some(file), Some(folder)) = (first_file, last_folder) {
        assert!(folder < file, "folders first: {kinds:?}");
    }

    // null is the home folder; a missing path is its nearest existing parent.
    let (status, home) = post(&w.server, "list", &json!({ "path": null }));
    assert_eq!(status, 200);
    assert_eq!(home["name"], Value::Null);
    let missing = w.folder.join("Channel").join("new").join("deeper");
    let (_, near) = post(&w.server, "list", &json!({ "path": missing }));
    assert_eq!(near["path"], w.folder.join("Channel").to_str().unwrap());
    assert_eq!(near["name"], "deeper");

    // An unreadable path is an AppError.
    let (status, bad) = post(&w.server, "list", &json!({ "path": 5 }));
    assert_eq!(status, 400);
    assert_eq!(bad["code"], "invalidInput");

    // Places: an array of `{ name, path, kind }` with the home folder first.
    let (status, places) = post(&w.server, "places", &json!({}));
    assert_eq!(status, 200);
    let places = places.as_array().unwrap();
    assert_eq!(places[0]["kind"], "home");
    assert!(
        places
            .iter()
            .all(|p| p["name"].is_string() && p["path"].is_string())
    );

    // New folder, once.
    let body = json!({ "parent": folder, "name": "New Folder" });
    let (status, created) = post(&w.server, "create-folder", &body);
    assert_eq!(status, 200);
    assert_eq!(
        created["path"],
        w.folder.join("New Folder").to_str().unwrap()
    );
    assert!(w.folder.join("New Folder").is_dir());
    let (status, again) = post(&w.server, "create-folder", &body);
    assert_eq!(status, 400);
    assert_eq!(again["code"], "conflict");
    let (status, bad) = post(
        &w.server,
        "create-folder",
        &json!({ "parent": folder, "name": "../escape" }),
    );
    assert_eq!(status, 400);
    assert_eq!(bad["code"], "invalidInput");
    assert!(!w.folder.parent().unwrap().join("escape").exists());
}

#[test]
fn the_fs_routes_need_the_access_cookie() {
    let server = Server::start();
    for route in ["list", "places", "create-folder"] {
        let r = server.anonymous("POST", &format!("/api/fs/{route}"), "{}", &[]);
        assert_eq!(r.status, 401, "{route}");
    }
}

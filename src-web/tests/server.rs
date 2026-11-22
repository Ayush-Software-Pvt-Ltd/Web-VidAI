//! Drives the built `vidai-web` over HTTP, the way the browser will: commands, errors, the event
//! stream, one copy per data directory, ports and Ctrl+C (SPEC section 12). Access rules are in
//! `access.rs`, the UI in `ui.rs`.

mod support;

use std::net::{Ipv4Addr, TcpListener};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::{Events, PATIENCE, Server, command};
#[cfg(unix)]
use support::{forward_lines, parse_running};

#[test]
fn commands_run_through_the_cores_own_handler() {
    let server = Server::start();

    let (status, settings) = server.invoke("get_settings", &json!({}));
    assert_eq!(
        (status, &settings["setup"]),
        (200, &json!("claudeSubscription"))
    );

    let (status, system) = server.invoke("check_system", &json!({}));
    assert_eq!(status, 200);
    assert_eq!(
        system["platform"],
        if cfg!(windows) { "windows" } else { "macos" }
    );

    // The bundled resources are found next to the binary.
    let (status, prompt) = server.invoke("get_default_prompt", &json!({}));
    assert_eq!(status, 200);
    assert!(prompt.as_str().unwrap().contains("MAIN_FOLDER"));

    // A channel with a video folder, as SPEC section 2 lays it out.
    let editing = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(editing.path().join("Chan/vid1")).unwrap();
    let path = editing.path().to_str().unwrap();
    let (status, settings) = server.invoke("set_editing_folder", &json!({ "path": path }));
    assert_eq!(
        (status, settings["editingFolder"].as_str()),
        (200, Some(path))
    );
    let (status, _) = server.invoke("add_channel", &json!({ "folderName": "Chan" }));
    assert_eq!(status, 200);
    let (status, toolkit) = server.invoke("get_toolkit_status", &json!({}));
    assert_eq!(
        (status, &toolkit["standard"]["exists"]),
        (200, &json!(true))
    );
    let (status, library) = server.invoke("get_library", &json!({}));
    assert_eq!(status, 200);
    assert_eq!(library["channels"][0]["folderName"], "Chan");
    assert_eq!(library["channels"][0]["videos"][0]["folderName"], "vid1");

    // The appearance applies to the hidden window without showing it, and is saved.
    let appearance = json!({ "appearance": { "theme": "dark", "textSize": 17 } });
    let (status, settings) = server.invoke("update_appearance", &appearance);
    assert_eq!(
        (status, &settings["theme"], &settings["textSize"]),
        (200, &json!("dark"), &json!(17))
    );
    let (_, settings) = server.invoke("get_settings", &json!({}));
    assert_eq!(settings["theme"], "dark");

    let response = server.request("POST", "/api/invoke/get_settings", "", &[]);
    assert_eq!(response.status, 200, "no body means no arguments");
    assert!(
        response
            .head
            .to_lowercase()
            .contains("cache-control: no-store")
    );
    assert!(
        response
            .head
            .to_lowercase()
            .contains("content-type: application/json")
    );
}

#[test]
fn failures_have_the_status_and_shape_of_the_spec() {
    let server = Server::start();

    // Unknown: Tauri's message as a JSON string.
    let (status, error) = server.invoke("no_such_command", &json!({}));
    assert_eq!(status, 400);
    assert!(error.as_str().unwrap().contains("not found"), "{error}");

    // A command error: the AppError of SPEC section 5.
    let (status, error) =
        server.invoke("set_editing_folder", &json!({ "path": "/no/such/folder" }));
    assert_eq!((status, &error["code"]), (400, &json!("notFound")));
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .contains("/no/such/folder")
    );

    // Bad arguments and a bad body.
    let (status, error) = server.invoke("set_editing_folder", &json!({}));
    assert_eq!(status, 400);
    assert!(error.as_str().unwrap().contains("path"), "{error}");
    let response = server.request("POST", "/api/invoke/get_settings", "{nope", &[]);
    assert_eq!(response.status, 400);

    // Not allowed by the capability: plugins other than opener and notification (the file pickers
    // are a page of the UI, so there are no dialog permissions), and the core's own window and
    // event commands.
    for command in [
        "plugin%3Afs%7Cread_file",
        "plugin%3Adialog%7Copen",
        "plugin%3Awindow%7Cclose",
        "plugin%3Aevent%7Clisten",
    ] {
        let (status, error) = server.invoke(command, &json!({}));
        assert_eq!(status, 400, "{command}");
        assert!(
            error.as_str().unwrap().contains("not allowed"),
            "{command}: {error}"
        );
    }

    // A plugin command that is allowed reaches the plugin (which rejects the empty arguments).
    let (status, error) = server.invoke("plugin%3Aopener%7Creveal_item_in_dir", &json!({}));
    assert_eq!(status, 400);
    assert!(!error.as_str().unwrap().contains("not allowed"), "{error}");
}

#[test]
fn the_event_stream_says_hello_and_carries_backend_events() {
    let server = Server::start();
    let events = Events::open(&server);
    let (name, payload) = events.next();
    assert_eq!(name, "vidai-web://hello");
    let instance = payload["instance"].as_str().unwrap().to_owned();
    assert!(!instance.is_empty());

    // Another stream of the same start gets the same instance id.
    let other = Events::open(&server);
    assert_eq!(other.next().1["instance"], instance.as_str());

    let editing = tempfile::tempdir().unwrap();
    let path = editing.path().to_str().unwrap();
    let (status, _) = server.invoke("set_editing_folder", &json!({ "path": path }));
    assert_eq!(status, 200);
    assert_eq!(events.wait_for("library-changed"), Value::Null);
    assert_eq!(other.wait_for("library-changed"), Value::Null);

    // A new start has a new id.
    let again = Server::start();
    let (_, payload) = Events::open(&again).next();
    assert_ne!(payload["instance"], instance.as_str());
}

#[test]
fn a_second_server_on_the_same_data_asks_the_first_and_ends() {
    let server = Server::start();
    let second = command(server.data(), 0).output().unwrap();
    assert!(second.status.success(), "{second:?}");
    let said = String::from_utf8_lossy(&second.stdout);
    assert!(said.contains("already running"), "{said}");
    let address = format!("http://127.0.0.1:{}/?token={}", server.port, server.token);
    assert!(said.contains(&address), "{said}");
    // The first one was asked to open the browser, with the tokenized address.
    let started = Instant::now();
    while started.elapsed() < PATIENCE {
        if let Ok(line) = server.lines.recv_timeout(Duration::from_millis(200))
            && let Some(opened) = line.strip_prefix("Open VidAI Web in your browser: ")
        {
            assert_eq!(opened, address);
            return;
        }
    }
    panic!("the first server was not asked to open the browser");
}

#[test]
fn the_desktop_app_holding_the_data_stops_the_server_with_status_one() {
    use vidai_lib::instance::{Claim, claim};
    let data = tempfile::tempdir().unwrap();
    // This process plays the desktop app: it holds the lock and answers show requests.
    let Claim::First(instance) = claim(data.path()).unwrap() else {
        panic!("the data directory is free");
    };
    let (shown, shown_rx) = mpsc::channel();
    let _lock = instance.serve(move || {
        let _ = shown.send(());
    });
    let output = command(data.path(), 0).output().unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let said = String::from_utf8_lossy(&output.stderr);
    assert!(said.contains("desktop app"), "{said}");
    shown_rx
        .recv_timeout(PATIENCE)
        .expect("the running copy was asked to show");
}

#[test]
fn a_taken_port_ends_with_status_one_and_a_message() {
    let taken = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = taken.local_addr().unwrap().port();
    let data = tempfile::tempdir().unwrap();
    let output = command(data.path(), port).output().unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let said = String::from_utf8_lossy(&output.stderr);
    assert!(
        said.contains(&format!("port {port}")) && said.contains("already in use"),
        "{said}"
    );
}

#[cfg(unix)]
#[test]
fn ctrl_c_quits_cleanly() {
    let mut server = Server::start();
    let status = server.interrupt();
    assert_eq!(status.code(), Some(0), "{status:?}");
    let said: Vec<String> = server.lines.try_iter().collect();
    assert!(
        said.iter().any(|line| line.contains("Quitting VidAI Web")),
        "{said:?}"
    );
    // The lock is let go: a new server can take the data directory at once.
    let mut again = command(server.data(), 0).spawn().unwrap();
    let lines = forward_lines(again.stdout.take().unwrap());
    let line = lines.recv_timeout(PATIENCE).unwrap();
    assert!(parse_running(&line).is_some(), "{line}");
    let _ = again.kill();
    let _ = again.wait();
}

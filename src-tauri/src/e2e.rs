//! End-to-end test hook used by `scripts/e2e.mjs` (`npm run e2e`).
//!
//! Compiled only into debug builds (`lib.rs` declares this module under
//! `#[cfg(debug_assertions)]`), and inactive unless `VIDAI_E2E_SCRIPT` is set:
//!
//! - `VIDAI_E2E_SCRIPT=<file>`: JavaScript evaluated once in the main webview when the page has
//!   loaded. It drives the real UI through the DOM, like a user.
//! - `VIDAI_E2E_REPORT=<file>`: every `vidai-e2e` event the page emits is appended to this file
//!   as one line (its JSON payload). Notifications are written there too instead of being shown.
//! - stdin: every line the runner writes is handed to the page as
//!   `window.__vidaiE2E.receive(line)`, except `!quit` (quit like Cmd+Q), `!close` (close the
//!   main window like its red button) and `!menu <id>` (choose the app menu item with that id,
//!   for example `vidai-text-bigger`, like its keyboard shortcut).
//! - File dialogs: a native dialog cannot be driven from the DOM, so a stand-in for the dialog
//!   plugin's `open` and `save` commands answers them with the paths the page queued before
//!   (`{"t":"pick","path":...}` events). A dialog without a queued answer fails instead of
//!   opening, so a run can never hang on one.
//! - The app does not take keyboard focus from the user when it starts.

use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};

use serde_json::{Value, json};
use tauri::plugin::TauriPlugin;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Builder, Listener, Manager, Webview, Wry};

use crate::lifecycle::MAIN_WINDOW;

/// Name of the event the page reports through.
const REPORT_EVENT: &str = "vidai-e2e";

struct Config {
    script: String,
    report: Option<PathBuf>,
}

fn config() -> Option<&'static Config> {
    static CONFIG: OnceLock<Option<Config>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let path = std::env::var_os("VIDAI_E2E_SCRIPT")?;
            let script = std::fs::read_to_string(&path)
                .unwrap_or_else(|err| panic!("VIDAI_E2E_SCRIPT {path:?}: {err}"));
            Some(Config {
                script,
                report: std::env::var_os("VIDAI_E2E_REPORT").map(PathBuf::from),
            })
        })
        .as_ref()
}

/// Whether this run is an end-to-end run (`VIDAI_E2E_SCRIPT` is set).
pub fn active() -> bool {
    config().is_some()
}

fn append_report(line: &str) {
    let Some(path) = config().and_then(|c| c.report.as_ref()) else {
        return;
    };
    let written = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| writeln!(f, "{}", line.replace('\n', " ")));
    if let Err(err) = written {
        eprintln!("vidai-e2e: could not write the report: {err}");
    }
}

/// Builder changes for an end-to-end run: evaluate the script once the page has loaded, and do
/// not take focus when the app starts.
pub fn configure(builder: Builder<Wry>) -> Builder<Wry> {
    if config().is_none() {
        return builder;
    }
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(false);
    builder.on_page_load(on_page_load)
}

fn on_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    static INJECTED: AtomicBool = AtomicBool::new(false);
    if payload.event() != PageLoadEvent::Finished || webview.label() != MAIN_WINDOW {
        return;
    }
    if let Some(config) = config()
        && !INJECTED.swap(true, Ordering::SeqCst)
        && let Err(err) = webview.eval(&config.script)
    {
        eprintln!("vidai-e2e: could not run the script: {err}");
    }
}

/// Startup hook: reports from the page go to the report file, lines on stdin go to the page.
pub fn setup(app: &AppHandle) {
    if config().is_none() {
        return;
    }
    eprintln!("vidai-e2e: end-to-end hook active");
    #[cfg(target_os = "macos")]
    show_on_every_space(app);
    let native_app = app.clone();
    app.listen_any(REPORT_EVENT, move |event| {
        append_report(event.payload());
        let Ok(message) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        if message["t"] == "pick" {
            picks().push_back(message["path"].as_str().map(str::to_owned));
        } else if message["t"] == "native" {
            // Window getters wait for the main thread, which may be the one emitting this event.
            let app = native_app.clone();
            std::thread::spawn(move || native(&app, &message));
        }
    });
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("vidai-e2e-stdin".into())
        .spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                match line.as_str() {
                    "!quit" => crate::jobs::request_quit(&app),
                    "!close" => {
                        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                            let _ = window.close();
                        }
                    }
                    _ if line.starts_with("!menu ") => {
                        crate::lifecycle::on_menu_item(&app, line["!menu ".len()..].trim());
                    }
                    _ => {
                        let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
                            continue;
                        };
                        let arg = serde_json::to_string(&line).unwrap_or_default();
                        let js = format!("window.__vidaiE2E && window.__vidaiE2E.receive({arg})");
                        if let Err(err) = window.eval(&js) {
                            eprintln!("vidai-e2e: could not deliver a message: {err}");
                        }
                    }
                }
            }
        });
    if let Err(err) = spawned {
        eprintln!("vidai-e2e: could not read stdin: {err}");
    }
}

/// Keeps the window on the Space the person is looking at, also when another app is in full
/// screen there. Otherwise macOS puts the window on another Space, where it is not drawn (no
/// screenshots) and its web content runs no animation frames (menus and images never appear).
/// For the same reason the page keeps running while the person's own windows cover the test
/// window: WebKit would otherwise treat a covered page as hidden.
///
/// A regular app's window cannot join another app's full-screen Space without activating the
/// app (which would take the screen from the person), so the test app runs as an accessory app
/// (no Dock icon, no menu bar) whose window joins every Space as a full-screen auxiliary window.
/// Menus are chosen through the hook (`!menu <id>`) and the Dock reopen through `open`, which
/// work the same for an accessory app.
#[cfg(target_os = "macos")]
fn show_on_every_space(app: &AppHandle) {
    if let Err(err) = app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
        eprintln!("vidai-e2e: could not make the app an accessory app: {err}");
    }
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if let Err(err) = crate::platform::appkit::show_on_every_space(&window) {
        eprintln!("vidai-e2e: could not show the window on every Space: {err}");
    }
    // The person's own windows cover the test window whenever they like (the test app never
    // takes the focus); the page must go on running as if it were in front.
    let kept = crate::platform::appkit::keep_page_visible_when_covered(&window, |offered| {
        if !offered {
            eprintln!(
                "vidai-e2e: WebKit cannot keep the page visible while the window is covered; \
                 keep the test window uncovered"
            );
        }
    });
    if let Err(err) = kept {
        eprintln!("vidai-e2e: could not keep the page visible while covered: {err}");
    }
}

/// Answers a request of the page (`host.native`) itself, through `window.__vidaiE2E.receive`.
fn reply(app: &AppHandle, id: &Value, result: Result<Value, String>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let message = match result {
        Ok(value) => json!({ "id": id, "ok": true, "value": value }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    };
    let arg = serde_json::to_string(&message.to_string()).unwrap_or_default();
    if let Err(err) = window.eval(format!(
        "window.__vidaiE2E && window.__vidaiE2E.receive({arg})"
    )) {
        eprintln!("vidai-e2e: could not answer a native request: {err}");
    }
}

/// A native request of the page (`{"t":"native","id","op","args"}`): what only the app itself
/// can measure or do with its window (see `scripts/e2e/page/harness.js`, `host.native`).
fn native(app: &AppHandle, message: &Value) {
    let id = message["id"].clone();
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return reply(app, &id, Err("the main window does not exist".into()));
    };
    let args = &message["args"];
    let done = |r: tauri::Result<()>| r.map(|()| Value::Null).map_err(|e| e.to_string());
    let result = match message["op"].as_str().unwrap_or_default() {
        "window" => window_state(app, &window),
        #[cfg(target_os = "macos")]
        "trafficLights" => {
            let answer = app.clone();
            let reply_id = id.clone();
            let queued = crate::platform::appkit::probe::traffic_lights(&window, move |frames| {
                reply(&answer, &reply_id, Ok(json!(frames)));
            });
            match queued {
                Ok(()) => return,
                Err(err) => Err(err.to_string()),
            }
        }
        #[cfg(target_os = "macos")]
        "appearance" => {
            let answer = app.clone();
            let reply_id = id.clone();
            let queued = crate::platform::appkit::probe::app_appearance(&window, move |name| {
                reply(&answer, &reply_id, Ok(json!(name)));
            });
            match queued {
                Ok(()) => return,
                Err(err) => Err(err.to_string()),
            }
        }
        #[cfg(target_os = "macos")]
        "minSize" => {
            let answer = app.clone();
            let reply_id = id.clone();
            let queued = crate::platform::appkit::probe::min_content_size(&window, move |size| {
                reply(&answer, &reply_id, Ok(json!(size)));
            });
            match queued {
                Ok(()) => return,
                Err(err) => Err(err.to_string()),
            }
        }
        #[cfg(target_os = "macos")]
        "hitTest" => {
            let answer = app.clone();
            let reply_id = id.clone();
            let queued = crate::platform::appkit::probe::hit_test(
                &window,
                args["x"].as_f64().unwrap_or(0.0),
                args["y"].as_f64().unwrap_or(0.0),
                move |chain| reply(&answer, &reply_id, Ok(json!(chain))),
            );
            match queued {
                Ok(()) => return,
                Err(err) => Err(err.to_string()),
            }
        }
        // The theme the window is drawn in ("Light", "Dark"), which native dialogs and the web
        // content's colour scheme follow.
        #[cfg(not(target_os = "macos"))]
        "appearance" => window
            .theme()
            .map(|theme| json!(format!("{theme:?}")))
            .map_err(|e| e.to_string()),
        // The minimum content size VidAI gave the window. Windows does not apply it to a
        // programmatic resize (only to a person's drag, which the runner checks for real).
        #[cfg(not(target_os = "macos"))]
        "minSize" => crate::appearance::applied_min_size()
            .map(|min| json!([min.width, min.height]))
            .ok_or_else(|| "no minimum size was set".to_owned()),
        "setSize" => done(window.set_size(tauri::LogicalSize::new(
            args["width"].as_f64().unwrap_or(1200.0),
            args["height"].as_f64().unwrap_or(800.0),
        ))),
        "maximize" => done(window.maximize()),
        "minimize" => done(window.minimize()),
        "unmaximize" => done(window.unmaximize()),
        "fullscreen" => done(window.set_fullscreen(args["on"].as_bool().unwrap_or(false))),
        "focus" => done(window.set_focus()),
        #[cfg(target_os = "macos")]
        "blur" => done(crate::platform::appkit::probe::blur(&window)),
        #[cfg(target_os = "macos")]
        "key" => done(crate::platform::appkit::probe::press_key(
            &window,
            args["characters"].as_str().unwrap_or_default().to_owned(),
            args["keyCode"]
                .as_u64()
                .and_then(|c| u16::try_from(c).ok())
                .unwrap_or(0),
            args["shift"].as_bool().unwrap_or(false),
        )),
        other => Err(format!("unknown native request {other:?}")),
    };
    reply(app, &id, result);
}

/// The window as the person sees it: frame and content size in points, the scale, full screen
/// and zoomed, the screen's usable area, and which View menu text size items are enabled.
fn window_state(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<Value, String> {
    let state = || -> tauri::Result<Value> {
        let scale = window.scale_factor()?;
        let outer = window.outer_size()?.to_logical::<f64>(scale);
        let inner = window.inner_size()?.to_logical::<f64>(scale);
        let position = window.outer_position()?.to_logical::<f64>(scale);
        let screen = window.current_monitor()?.map(|m| {
            let area = m.work_area();
            let size = area.size.to_logical::<f64>(m.scale_factor());
            let origin = area.position.to_logical::<f64>(m.scale_factor());
            json!({ "name": m.name(), "x": origin.x, "y": origin.y, "width": size.width, "height": size.height, "scale": m.scale_factor() })
        });
        #[cfg(target_os = "macos")]
        let menu = crate::lifecycle::text_size_items_enabled(app);
        #[cfg(not(target_os = "macos"))]
        let menu: Option<[bool; 3]> = {
            let _ = app;
            None
        };
        Ok(json!({
            "x": position.x, "y": position.y,
            "width": outer.width, "height": outer.height,
            "innerWidth": inner.width, "innerHeight": inner.height,
            "scale": scale,
            "fullscreen": window.is_fullscreen()?,
            "maximized": window.is_maximized()?,
            "focused": window.is_focused()?,
            "screen": screen,
            "textSizeItems": menu,
        }))
    };
    state().map_err(|e| e.to_string())
}

/// Writes a notification to the report instead of showing it. Returns whether it did.
pub fn capture_notification(title: &str, body: &str) -> bool {
    if config().is_none() {
        return false;
    }
    let line = serde_json::json!({ "t": "notification", "title": title, "body": body });
    append_report(&line.to_string());
    true
}

/// Answers for the next file dialogs, in order (`None` = the user cancelled).
fn picks() -> std::sync::MutexGuard<'static, VecDeque<Option<String>>> {
    static PICKS: Mutex<VecDeque<Option<String>>> = Mutex::new(VecDeque::new());
    PICKS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The stand-in for the dialog plugin while the hook is active, else `None`.
pub fn dialog_stand_in() -> Option<TauriPlugin<Wry>> {
    config()?;
    Some(
        tauri::plugin::Builder::new("dialog")
            .invoke_handler(tauri::generate_handler![open, save])
            .build(),
    )
}

fn next_pick(kind: &str) -> Result<Option<String>, String> {
    match picks().pop_front() {
        Some(path) => {
            append_report(&json!({ "t": "picked", "kind": kind, "path": path }).to_string());
            Ok(path)
        }
        None => {
            let message = format!("a file dialog ({kind}) opened without a queued answer");
            append_report(&json!({ "t": "fail", "message": message }).to_string());
            Err(message)
        }
    }
}

#[tauri::command]
fn open(options: Value) -> Result<Option<String>, String> {
    let _ = options;
    next_pick("open")
}

#[tauri::command]
fn save(options: Value) -> Result<Option<String>, String> {
    let _ = options;
    next_pick("save")
}

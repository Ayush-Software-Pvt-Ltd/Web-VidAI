//! VidAI desktop app: Tauri setup and wiring only.
//!
//! Module map (SPEC section 3): `model` (IPC types), `error`, `store` (persistence), `events`,
//! `bindings` (command and event registration, TypeScript generation), `commands/*` (thin
//! command functions), `lifecycle` (menu, window close and reopen), `appearance` (theme and
//! text size of the window), `instance` (one running copy per data directory), the feature
//! modules `scanner`, `media`, `toolkit`, `claude`, `jobs`, `platform`, `assets`, `resources`,
//! `secrets`, `sleep` (sleep prevention), and `e2e` (debug builds only: the end-to-end test hook).
//!
//! Feature modules plug in through the hooks called below (`toolkit::on_startup`,
//! `claude::setup`, `sleep::setup`, `jobs::setup`, `scanner::setup`, `scanner::on_window_event`,
//! `jobs::on_run_event`, `appearance::setup`, and the `lifecycle` hooks), so filling them in never requires editing
//! this file.

pub mod appearance;
pub mod assets;
pub mod bindings;
pub mod claude;
pub mod commands;
#[cfg(debug_assertions)]
pub mod e2e;
pub mod error;
pub mod events;
pub mod harness;
pub mod instance;
pub mod jobs;
pub mod lifecycle;
pub mod media;
pub mod model;
pub mod opencode;
pub mod orientation;
pub mod platform;
pub mod readiness;
pub mod resources;
pub mod scanner;
pub mod secrets;
pub mod sleep;
pub mod store;
pub mod toolkit;

use std::path::Path;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

use crate::error::AppResult;
use crate::model::Platform;
use crate::store::Store;

/// How long a second launch waits for the running copy to answer before it gives up (and ends
/// anyway: two copies must never run on one data directory).
const SECOND_LAUNCH_PATIENCE: Duration = Duration::from_secs(5);

/// Logs a failed startup hook without stopping the app: the UI reports the problem through the
/// regular commands (for example `check_system`).
fn run_hook(name: &str, hook: fn(&AppHandle) -> AppResult<()>, app: &AppHandle) {
    if let Err(err) = hook(app) {
        eprintln!("vidai: startup step {name} failed: {err}");
    }
}

/// The script that tells the page what it runs in before any of its own scripts run, so the very
/// first frame has the right fonts, shortcuts and wording:
///
/// - `window.__VIDAI_PLATFORM__`, read by `src/lib/platform.ts`: a `model::Platform`, the type
///   that `SystemStatus.platform` carries too;
/// - `window.__VIDAI_WEBVIEW_GUARD__`, read by `src/app/webviewGuard.ts`: whether the page
///   declines the browser's own keys and context menu (on Windows, see [`guards_webview`]).
pub fn platform_init_script(platform: Platform, guard_webview: bool) -> String {
    format!(
        "Object.defineProperty(window, {:?}, {{ value: {:?} }}); \
         Object.defineProperty(window, {:?}, {{ value: {guard_webview} }});",
        "__VIDAI_PLATFORM__",
        platform.as_str(),
        "__VIDAI_WEBVIEW_GUARD__",
    )
}

/// Whether the page declines the browser's own keys and context menu (SPEC section 11, "No
/// browser in the window"): always in release builds, and in debug builds only while the
/// end-to-end hook runs, so the suite checks the guard with real key presses, while a developer's
/// debug build keeps reload and the developer tools.
pub fn guards_webview() -> bool {
    #[cfg(debug_assertions)]
    {
        e2e::active()
    }
    #[cfg(not(debug_assertions))]
    {
        true
    }
}

/// Runs [`platform_init_script`] in every page of the app.
fn platform_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("vidai-platform")
        .js_init_script(platform_init_script(Platform::current(), guards_webview()))
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let specta = bindings::builder();

    let builder = tauri::Builder::default()
        .plugin(platform_plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(specta.invoke_handler());
    // During an end-to-end run the hook answers file dialogs itself (debug builds only).
    #[cfg(debug_assertions)]
    let builder = match e2e::dialog_stand_in() {
        Some(stand_in) => builder.plugin(stand_in),
        None => builder.plugin(tauri_plugin_dialog::init()),
    };
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(lifecycle::menu);
    #[cfg(debug_assertions)]
    let builder = e2e::configure(builder);

    builder
        .setup(move |app| {
            specta.mount_events(app);
            let handle = app.handle();

            let data_dir = store::resolve_data_dir(app.path().app_data_dir()?);
            // One copy per data directory: a second launch brings the running copy to the front
            // and ends here, before it has shown a window or touched any state.
            let instance = match instance::claim(&data_dir) {
                Ok(instance::Claim::First(instance)) => Some(instance),
                Ok(instance::Claim::Taken) => {
                    instance::ask_to_show(&data_dir, SECOND_LAUNCH_PATIENCE);
                    std::process::exit(0);
                }
                Err(err) => {
                    eprintln!("vidai: could not lock {}: {err}", data_dir.display());
                    None
                }
            };
            let store = Store::open(data_dir)?;
            if let Some(folder) = store.settings().editing_folder
                && Path::new(&folder).is_dir()
                && let Err(err) = assets::allow_editing_folder(handle, Path::new(&folder))
            {
                eprintln!("vidai: {err}");
            }
            app.manage(store);
            let secrets = secrets::Secrets::new(secrets::platform_store());
            // The one read of the saved keys in this run (macOS: any Keychain dialog shows now,
            // as the app opens, and never later in the middle of work). Off the main thread, so
            // the window appears meanwhile; whoever needs a key before it is done waits for it.
            let preloading = secrets.clone();
            let migrating = handle.clone();
            if let Err(err) = std::thread::Builder::new()
                .name("vidai-secrets".into())
                .spawn(move || {
                    preloading.preload();
                    // A 0.2.4 install that edited with Claude Code on OpenCode still has to copy
                    // its key to the Anthropic API field before its settings are saved (SPEC
                    // section 7a, Migration from 0.2.4); a keychain that is not readable yet
                    // leaves it for Try Again (`retry_secrets`).
                    if let Err(err) = secrets::finish_key_migration(
                        &migrating.state::<store::Store>(),
                        &preloading,
                    ) {
                        eprintln!("vidai: the API key migration waits: {}", err.message);
                    }
                })
            {
                eprintln!("vidai: could not start reading the saved keys: {err}");
            }
            app.manage(secrets);
            app.manage(opencode::usage::UsageService::default());
            // The machine facts of the edit instructions and Settings, probed off the UI path.
            platform::machine::probe_in_background();

            // First: the window is created hidden and shown here, with its theme and zoom set.
            run_hook("appearance", appearance::setup, handle);

            run_hook("toolkit", toolkit::on_startup, handle);
            run_hook("claude", claude::setup, handle);
            opencode::usage::start(handle);
            run_hook("sleep", sleep::setup, handle);
            run_hook("jobs", jobs::setup, handle);
            run_hook("scanner", scanner::setup, handle);
            #[cfg(debug_assertions)]
            e2e::setup(handle);
            // Last: a later launch may now bring the (shown) window to the front.
            if let Some(instance) = instance {
                let shown = handle.clone();
                app.manage(instance.serve(move || lifecycle::show_main_window(&shown)));
            }
            Ok(())
        })
        .on_menu_event(lifecycle::on_menu_event)
        .on_window_event(|window, event| {
            lifecycle::on_window_event(window, event);
            scanner::on_window_event(window, event);
        })
        .build(tauri::generate_context!())
        .expect("error while building VidAI")
        .run(|app, event| {
            lifecycle::on_run_event(app, &event);
            jobs::on_run_event(app, &event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Tauri merges a platform's configuration file into tauri.conf.json as a JSON Merge Patch
    /// (RFC 7396): objects merge, everything else (arrays too) is replaced.
    fn merge_patch(target: &mut Value, patch: &Value) {
        match (target, patch) {
            (Value::Object(target), Value::Object(patch)) => {
                for (key, value) in patch {
                    if value.is_null() {
                        target.remove(key);
                    } else {
                        merge_patch(target.entry(key.clone()).or_insert(Value::Null), value);
                    }
                }
            }
            (target, patch) => *target = patch.clone(),
        }
    }

    /// The Windows configuration replaces the whole `app.windows` array (arrays do not merge),
    /// so it repeats the main window: it must stay the same window apart from the keys that
    /// only one platform has, and the merged result must be a valid Tauri configuration.
    #[test]
    fn the_windows_configuration_keeps_the_main_window() {
        let base: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows: Value =
            serde_json::from_str(include_str!("../tauri.windows.conf.json")).unwrap();
        let mac_only = ["titleBarStyle", "hiddenTitle"];
        let windows_only = ["zoomHotkeysEnabled", "dragDropEnabled", "scrollBarStyle"];

        let base_window = base["app"]["windows"][0].as_object().unwrap();
        let windows_window = windows["app"]["windows"][0].as_object().unwrap();
        for (key, value) in base_window {
            if mac_only.contains(&key.as_str()) {
                assert!(!windows_window.contains_key(key), "{key} is macOS only");
            } else {
                assert_eq!(
                    windows_window.get(key),
                    Some(value),
                    "{key} differs on Windows"
                );
            }
        }
        for key in windows_window.keys() {
            assert!(
                base_window.contains_key(key) || windows_only.contains(&key.as_str()),
                "{key} is new on Windows: list it as Windows only or add it to both files"
            );
        }

        let mut merged = base.clone();
        merge_patch(&mut merged, &windows);
        let config: tauri::utils::config::Config = serde_json::from_value(merged).unwrap();
        let main = &config.app.windows[0];
        assert_eq!(main.label, lifecycle::MAIN_WINDOW);
        assert!(main.decorations, "Windows uses the native title bar");
        assert_eq!(main.title_bar_style, tauri::TitleBarStyle::Visible);
        assert!(
            !main.visible,
            "shown by appearance::setup once the theme and zoom are set"
        );
        assert!(
            !main.zoom_hotkeys_enabled,
            "the app's own text size owns Ctrl+Plus and Ctrl+wheel"
        );
        assert!(
            main.drag_drop_enabled,
            "dropped files must never navigate the webview"
        );
        assert_eq!(
            main.scroll_bar_style,
            tauri::utils::config::ScrollBarStyle::FluentOverlay
        );
        assert_eq!(config.bundle.publisher.as_deref(), Some("VidAI"));
    }

    #[test]
    fn the_page_learns_its_platform() {
        assert_eq!(
            platform_init_script(Platform::Windows, true),
            r#"Object.defineProperty(window, "__VIDAI_PLATFORM__", { value: "windows" }); Object.defineProperty(window, "__VIDAI_WEBVIEW_GUARD__", { value: true });"#
        );
        let mac = platform_init_script(Platform::Macos, false);
        assert!(mac.contains(r#"value: "macos""#));
        assert!(mac.contains(r#""__VIDAI_WEBVIEW_GUARD__", { value: false }"#));
    }

    /// A developer's debug build keeps reload and the developer tools; the end-to-end hook (not
    /// set in unit tests) and release builds turn the guard on.
    #[test]
    fn a_debug_build_guards_the_webview_only_for_the_end_to_end_tests() {
        assert_eq!(guards_webview(), !cfg!(debug_assertions));
    }
}

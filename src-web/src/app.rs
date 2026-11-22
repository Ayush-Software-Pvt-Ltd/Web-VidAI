//! The Tauri app of VidAI Web: `vidai_lib::run()` without a visible window (SPEC section 12).
//!
//! The same plugins, managed state and startup hooks as `src-tauri/src/lib.rs`. Left out are the
//! desktop-only parts: `appearance::setup`, the `lifecycle` hooks, the menu, the window event
//! hooks and the e2e hook. The one window, `main`, is created hidden and never shown: Tauri hands a
//! command to a webview, so the server needs one.

use std::path::Path;
use std::process::ExitCode;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use vidai_lib::error::AppResult;
use vidai_lib::lifecycle::MAIN_WINDOW;
use vidai_lib::store::{self, Store};
use vidai_lib::{assets, bindings, claude, instance, jobs, opencode, platform, scanner, secrets};
use vidai_lib::{sleep, toolkit};

use crate::args::Options;
use crate::browser;
use crate::events::Hub;
use crate::token::{self, Access};
use crate::{server, shutdown, single, ui, usage};

/// Logs a failed startup hook without stopping the app: the UI reports the problem through the
/// regular commands (for example `check_system`).
fn run_hook(name: &str, hook: fn(&AppHandle) -> AppResult<()>, app: &AppHandle) {
    if let Err(err) = hook(app) {
        eprintln!("vidai-web: startup step {name} failed: {err}");
    }
}

/// Builds the app and runs it until the process ends. Returns only when it cannot start.
pub fn run(options: Options) -> ExitCode {
    let specta = bindings::builder();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(specta.invoke_handler());
    #[cfg(target_os = "macos")]
    let builder = builder.enable_macos_default_menu(false);

    let app = builder
        .setup(move |app| {
            specta.mount_events(app);
            start(app.handle(), &options)?;
            Ok(())
        })
        .build(tauri::generate_context!());
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut app = match app {
        Ok(app) => app,
        Err(err) => {
            eprintln!("vidai-web: could not start the VidAI core: {err}");
            return ExitCode::FAILURE;
        }
    };
    // Before the event loop runs: no Dock icon, not even for a moment.
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    app.run(|app, event| jobs::on_run_event(app, &event));
    ExitCode::SUCCESS
}

/// The setup of `vidai_lib::run`, then the server.
fn start(handle: &AppHandle, options: &Options) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = store::resolve_data_dir(handle.path().app_data_dir()?);
    // One copy per data directory: a second start asks the running copy to show itself and ends
    // here, before it has touched any state.
    let instance = match instance::claim(&data_dir) {
        Ok(instance::Claim::First(instance)) => Some(instance),
        Ok(instance::Claim::Taken) => {
            std::process::exit(i32::from(single::second_start(&data_dir)))
        }
        Err(err) => {
            eprintln!("vidai-web: could not lock {}: {err}", data_dir.display());
            None
        }
    };
    let listener = server::bind(options.port).unwrap_or_else(|err| {
        eprintln!("{}", err.message());
        std::process::exit(1);
    });
    let port = listener.local_addr()?.port();
    let access = match token::load_or_create(&data_dir) {
        Ok(token) => Access { port, token },
        Err(err) => {
            eprintln!(
                "vidai-web: could not make the access token in {}: {err}",
                data_dir.display()
            );
            std::process::exit(1);
        }
    };
    if let Some(problem) = ui::problem() {
        eprintln!("vidai-web: {problem}");
    }

    let store = Store::open(data_dir.clone())?;
    if let Some(folder) = store.settings().editing_folder
        && Path::new(&folder).is_dir()
        && let Err(err) = assets::allow_editing_folder(handle, Path::new(&folder))
    {
        eprintln!("vidai-web: {err}");
    }
    handle.manage(store);
    let secrets = secrets::Secrets::new(secrets::platform_store());
    // The one read of the saved keys in this run, off the thread that starts the app; whoever
    // needs a key before it is done waits for it.
    let preloading = secrets.clone();
    let migrating = handle.clone();
    if let Err(err) = std::thread::Builder::new()
        .name("vidai-secrets".into())
        .spawn(move || {
            preloading.preload();
            // A 0.2.4 install that edited with Claude Code on OpenCode still has to copy its key
            // to the Anthropic API field (SPEC section 7a, Migration from 0.2.4).
            if let Err(err) =
                secrets::finish_key_migration(&migrating.state::<store::Store>(), &preloading)
            {
                eprintln!("vidai-web: the API key migration waits: {}", err.message);
            }
        })
    {
        eprintln!("vidai-web: could not start reading the saved keys: {err}");
    }
    handle.manage(secrets);
    handle.manage(opencode::usage::UsageService::default());
    // The machine facts of the edit instructions and Settings, probed off the UI path.
    platform::machine::probe_in_background();

    create_hidden_window(handle)?;

    run_hook("toolkit", toolkit::on_startup, handle);
    run_hook("claude", claude::setup, handle);
    opencode::usage::start(handle);
    run_hook("sleep", sleep::setup, handle);
    run_hook("jobs", jobs::setup, handle);
    run_hook("scanner", scanner::setup, handle);

    let hub = Hub::new(uuid::Uuid::new_v4().to_string());
    hub.listen(handle);
    usage::start(handle, hub.clone());
    handle.manage(access.clone());
    shutdown::install(handle);
    let router = server::router(handle.clone(), hub, access.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(err) = server::serve(listener, router).await {
            eprintln!("vidai-web: the server stopped: {err}");
            std::process::exit(1);
        }
    });

    // Last: a later start may now ask this one to open the browser.
    if let Some(instance) = instance {
        single::write_marker(&data_dir, port);
        let asked = handle.clone();
        handle.manage(instance.serve(move || browser::open_browser(&asked)));
    }
    println!("VidAI Web is running at {}", access.address());
    if options.open_browser {
        browser::open_browser(handle);
    }
    Ok(())
}

/// The window the commands are handed to. It is never shown.
fn create_hidden_window(handle: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(handle, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("VidAI Web")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .build()
        .map(|_| ())
}

//! VidAI Web: the unchanged VidAI core behind a local web server (SPEC section 12).
//!
//! Module map: `args` (command line), `app` (the Tauri app and its startup, mirroring
//! `src-tauri/src/lib.rs`), `single` (one copy per data directory), `server` (the router and the
//! listener), `invoke` (`POST /api/invoke/<command>`), `events` (`GET /api/events`), `shutdown`
//! (Ctrl+C), `browser` (opening the address), `token` (the access token), `auth` (`Host`, `Origin` and
//! token checks), `headers` (security headers), `ui` (the files of the page and `/vidai-env.js`).

pub mod app;
pub mod args;
pub mod asset;
pub mod auth;
pub mod browser;
pub mod events;
pub mod fs;
pub mod headers;
pub mod invoke;
pub mod server;
pub mod shutdown;
pub mod single;
pub mod token;
pub mod ui;
pub mod usage;

use std::process::ExitCode;

/// The program: reads the command line and runs the app.
pub fn run() -> ExitCode {
    let env_port = std::env::var(args::PORT_ENV).ok();
    match args::parse(std::env::args_os().skip(1), env_port.as_deref()) {
        Ok(args::Parsed::Run(options)) => app::run(options),
        Ok(args::Parsed::Help(text)) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("vidai-web: {message}");
            ExitCode::from(2)
        }
    }
}

//! Ctrl+C and SIGTERM: quit the way a confirmed quit does in the desktop app (SPEC section 12).
//!
//! Running and waiting edits are paused first (`JobManager::pause_all_for_quit`, as
//! `confirm_quit` does), the server says how many, then the app exits. A second Ctrl+C ends the
//! process at once. The pause comes before `AppHandle::exit` on purpose: with edits busy and no
//! confirmed quit under way, the core's `jobs::on_run_event` would hold the exit back and show
//! the window to ask, and this window is never shown.

use std::time::Duration;

use tauri::{AppHandle, Manager};
use vidai_lib::jobs::JobManager;

/// How long the pause may take, as in `confirm_quit` (the core's orphan watchdog ends whatever
/// is left after that).
pub const PAUSE_TIMEOUT: Duration = Duration::from_secs(40);

/// The exit status of a second Ctrl+C (128 + SIGINT, the shell's own convention).
const IMPATIENT_STATUS: i32 = 130;

/// What the first signal says before it starts, by the number of busy edits.
pub fn pausing_message(busy: u32) -> String {
    match busy {
        0 => "Quitting VidAI Web.".to_owned(),
        1 => {
            "Pausing 1 running or waiting edit before quitting. Press Ctrl+C again to quit at once."
                .to_owned()
        }
        n => format!(
            "Pausing {n} running or waiting edits before quitting. Press Ctrl+C again to quit at once."
        ),
    }
}

/// Starts waiting for the signals (call once, from the core's startup).
pub fn install(app: &AppHandle) {
    tauri::async_runtime::spawn(wait(app.clone()));
}

async fn wait(app: AppHandle) {
    let mut signals = match Signals::new() {
        Ok(signals) => signals,
        Err(err) => {
            eprintln!(
                "vidai-web: Ctrl+C will not pause edits first, the signals are not available: {err}"
            );
            return;
        }
    };
    signals.next().await;
    let quitting = tauri::async_runtime::spawn_blocking(move || quit(&app));
    tokio::select! {
        _ = signals.next() => {
            eprintln!("Quitting at once. Edits that were still running are ended by VidAI on its next start.");
            std::process::exit(IMPATIENT_STATUS);
        }
        _ = quitting => {}
    }
}

/// The quit of `confirm_quit`: pause everything, write what is pending, exit.
fn quit(app: &AppHandle) {
    if let Some(jobs) = app.try_state::<JobManager>() {
        println!("{}", pausing_message(jobs.busy_count()));
        if !jobs.pause_all_for_quit(PAUSE_TIMEOUT) {
            eprintln!("vidai-web: some edits did not pause in time; exiting anyway");
        }
        jobs.shutdown();
    }
    app.exit(0);
}

#[cfg(unix)]
struct Signals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl Signals {
    fn new() -> std::io::Result<Self> {
        use tokio::signal::unix::{SignalKind, signal};
        Ok(Self {
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate())?,
        })
    }

    async fn next(&mut self) {
        tokio::select! {
            _ = self.interrupt.recv() => {}
            _ = self.terminate.recv() => {}
        }
    }
}

#[cfg(windows)]
struct Signals {
    ctrl_c: tokio::signal::windows::CtrlC,
    ctrl_break: tokio::signal::windows::CtrlBreak,
    ctrl_close: tokio::signal::windows::CtrlClose,
}

#[cfg(windows)]
impl Signals {
    fn new() -> std::io::Result<Self> {
        use tokio::signal::windows;
        Ok(Self {
            ctrl_c: windows::ctrl_c()?,
            ctrl_break: windows::ctrl_break()?,
            ctrl_close: windows::ctrl_close()?,
        })
    }

    async fn next(&mut self) {
        tokio::select! {
            _ = self.ctrl_c.recv() => {}
            _ = self.ctrl_break.recv() => {}
            _ = self.ctrl_close.recv() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_signal_says_how_many_edits_are_paused() {
        assert_eq!(pausing_message(0), "Quitting VidAI Web.");
        assert!(pausing_message(1).starts_with("Pausing 1 running or waiting edit before"));
        assert!(pausing_message(3).starts_with("Pausing 3 running or waiting edits before"));
        assert!(pausing_message(3).contains("Ctrl+C again"));
    }
}

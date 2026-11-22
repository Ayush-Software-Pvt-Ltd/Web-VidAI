//! Keeping the machine awake while jobs run.
//!
//! macOS: a `caffeinate -i` child process. `caffeinate` is started with `-w <VidAI's pid>`, so it
//! ends by itself when VidAI ends for any reason, including a crash.
//!
//! Windows: a small thread holds a "system required" execution state (`keepawake`, which uses
//! `SetThreadExecutionState`) while sleep prevention is on. The state belongs to that thread, so
//! it ends when the thread ends, and with VidAI itself. Like `caffeinate -i`, it keeps the system
//! from sleeping when idle but lets the display turn off.
//!
//! On other platforms this is a no-op.

#[cfg(not(windows))]
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, PoisonError};

#[cfg(target_os = "macos")]
const CAFFEINATE: &str = "/usr/bin/caffeinate";

/// Holds the sleep prevention while switched on. Dropping it switches it off.
#[derive(Default)]
pub struct KeepAwake {
    #[cfg(not(windows))]
    child: Mutex<Option<Child>>,
    #[cfg(windows)]
    child: Mutex<Option<windows::Holder>>,
}

impl KeepAwake {
    pub fn new() -> Self {
        Self::default()
    }

    /// Switches sleep prevention on or off. Idempotent; failures are logged and ignored (the job
    /// keeps running, the Mac may just sleep).
    pub fn set(&self, on: bool) {
        let mut child = self.child.lock().unwrap_or_else(PoisonError::into_inner);
        // A caffeinate that died on its own is restarted on the next `set(true)`.
        if let Some(c) = child.as_mut()
            && !matches!(c.try_wait(), Ok(None))
        {
            *child = None;
        }
        match (on, child.is_some()) {
            (true, false) => match spawn() {
                Ok(c) => *child = c,
                Err(err) => eprintln!("vidai: could not keep the {MACHINE} awake: {err}"),
            },
            (false, true) => {
                if let Some(mut c) = child.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
            _ => {}
        }
    }

    /// Whether sleep prevention is active right now.
    pub fn is_on(&self) -> bool {
        let mut child = self.child.lock().unwrap_or_else(PoisonError::into_inner);
        child
            .as_mut()
            .is_some_and(|c| matches!(c.try_wait(), Ok(None)))
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        self.set(false);
    }
}

#[cfg(target_os = "macos")]
fn spawn() -> std::io::Result<Option<Child>> {
    let pid = std::process::id().to_string();
    Command::new(CAFFEINATE)
        .args(["-i", "-w", &pid])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(Some)
}

/// What the log calls this machine.
const MACHINE: &str = if cfg!(target_os = "macos") {
    "Mac"
} else {
    "computer"
};

#[cfg(all(not(target_os = "macos"), not(windows)))]
fn spawn() -> std::io::Result<Option<Child>> {
    let _ = (Command::new::<&str>, Stdio::null);
    Ok(None)
}

#[cfg(windows)]
fn spawn() -> std::io::Result<Option<windows::Holder>> {
    windows::Holder::start().map(Some)
}

#[cfg(windows)]
mod windows {
    use std::sync::mpsc;
    use std::thread::{self, JoinHandle};

    /// A thread that keeps the system awake until [`Holder::kill`] (or until it is dropped).
    pub struct Holder {
        stop: Option<mpsc::Sender<()>>,
        thread: Option<JoinHandle<()>>,
    }

    impl Holder {
        /// Starts the thread and waits until it holds the execution state (or failed to).
        pub fn start() -> std::io::Result<Self> {
            let (stop, stopped) = mpsc::channel::<()>();
            let (ready_tx, ready) = mpsc::channel::<Result<(), String>>();
            let thread = thread::Builder::new()
                .name("vidai-keep-awake".into())
                .spawn(move || {
                    let awake = keepawake::Builder::default()
                        .idle(true)
                        .reason("VidAI is running video edits")
                        .app_name("VidAI")
                        .app_reverse_domain("com.vidai.desktop")
                        .create();
                    let held = awake.is_ok();
                    let _ = ready_tx.send(awake.as_ref().map(|_| ()).map_err(|e| e.to_string()));
                    if held {
                        // Returns when `stop` is used or dropped.
                        let _ = stopped.recv();
                    }
                    drop(awake);
                })?;
            match ready.recv() {
                Ok(Ok(())) => Ok(Self {
                    stop: Some(stop),
                    thread: Some(thread),
                }),
                Ok(Err(err)) => {
                    let _ = thread.join();
                    Err(std::io::Error::other(err))
                }
                Err(_) => Err(std::io::Error::other("the keep-awake thread ended early")),
            }
        }

        /// Whether the execution state is still held: `Ok(None)` like a running child process.
        pub fn try_wait(&mut self) -> std::io::Result<Option<()>> {
            let finished = self.thread.as_ref().is_none_or(JoinHandle::is_finished);
            Ok(finished.then_some(()))
        }

        /// Releases the execution state.
        pub fn kill(&mut self) -> std::io::Result<()> {
            self.stop.take();
            Ok(())
        }

        /// Waits until the thread has released the execution state.
        pub fn wait(&mut self) -> std::io::Result<()> {
            self.stop.take();
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
            Ok(())
        }
    }

    impl Drop for Holder {
        fn drop(&mut self) {
            let _ = self.wait();
        }
    }
}

#[cfg(all(test, any(target_os = "macos", windows)))]
mod tests {
    use super::*;

    #[test]
    fn switches_sleep_prevention_on_and_off() {
        let awake = KeepAwake::new();
        assert!(!awake.is_on());
        awake.set(true);
        awake.set(true);
        assert!(awake.is_on());
        awake.set(false);
        assert!(!awake.is_on());
        awake.set(false);
    }
}

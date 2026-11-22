//! OS-specific code behind small functions, so the Windows port only touches this folder.
//!
//! Responsibility: starting a child so that its whole tree can be ended later (macOS: its own
//! process group; Windows: a kill-on-close job object, without a console window), opening a
//! terminal with a command, keeping the machine awake while jobs run (macOS: a `caffeinate -i`
//! child; Windows: a system-required execution state), reading the user's environment (macOS: the
//! login shell; Windows: the registry), starting programs that are scripts or shims ([`launch`]),
//! finding faces in sampled video frames for the picture check of the type detection
//! ([`orientation`], macOS: the `vidai-orient` helper; Windows: the app binary started again as
//! a helper with WinRT media and face detection), the facts about this computer for the edit
//! instructions and Settings ([`machine`]), whether a program file was built for this Mac's
//! processor ([`macho`]), and telling whether the platform is supported.
//!
//! [`output_with_timeout`] serves the short-lived helper processes of `claude` (the login shell,
//! `claude --version`, `claude auth status`). Process groups and ending process trees, for those
//! helpers and for long-running job processes, live in [`process`]; sleep prevention in
//! [`power`]. The AppKit calls VidAI makes itself (the traffic-light placement that follows the
//! text size, and for the end-to-end hook a window on every Space) live in [`appkit`], the one
//! module allowed to use `unsafe`.

#[cfg(target_os = "macos")]
pub mod appkit;
pub mod launch;
pub mod machine;
pub mod macho;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod orientation;
pub mod power;
pub mod process;
// Compiled everywhere: its lookups and quoting are pure, so the Windows rules of the locators
// (`opencode::harness::locate2`) are tested on every platform. Only the Win32 calls are `cfg(windows)`.
pub mod windows;

use std::collections::HashMap;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::AppResult;

/// Whether VidAI supports this build target: macOS on Apple Silicon or Intel, and Windows on
/// x64 (SPEC section 1).
pub fn platform_supported() -> bool {
    cfg!(any(
        all(
            target_os = "macos",
            any(target_arch = "aarch64", target_arch = "x86_64")
        ),
        all(target_os = "windows", target_arch = "x86_64"),
    ))
}

/// Why the file or folder name `name` cannot be stored on Windows, or `None` when it can:
/// reserved device names (`CON`, `NUL`, `COM1`, ... with any extension), the characters
/// `<>:"|?*\` and control characters, and a trailing dot or space. Used on every platform
/// where a name must also work on Windows.
pub fn windows_name_problem(name: &str) -> Option<&'static str> {
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if name
        .chars()
        .any(|c| c.is_control() || "<>:\"|?*\\".contains(c))
    {
        return Some("the name contains a character Windows does not allow");
    }
    if name.ends_with(['.', ' ']) {
        return Some("the name ends with a dot or a space");
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return Some("the name is reserved on Windows");
    }
    None
}

/// `std::fs::rename`, except that on Windows a rename that fails with "access denied" is tried
/// again for up to three seconds: a virus scanner or the search indexer often holds a file that
/// was just written open for a moment. Used for every atomic replace and for toolkit seeding.
pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let mut attempts = 0;
        loop {
            match std::fs::rename(from, to) {
                Err(e) if e.kind() == io::ErrorKind::PermissionDenied && attempts < 30 => {
                    attempts += 1;
                    thread::sleep(Duration::from_millis(100));
                }
                result => return result,
            }
        }
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(from, to)
    }
}

/// Lets the process `pid` bring its window to the front, which this process may do because the
/// person just started it. Windows lets only the process that owns the foreground (or one it
/// started, such as a program started from the Start menu by Explorer) take the foreground; a
/// second launch of VidAI hands that right to the running copy with `AllowSetForegroundWindow`
/// before it asks it to show its window, so the window comes to the front even when it is open
/// behind other windows. Elsewhere nothing is needed (macOS activates the app that is opened
/// again by itself). True when the right was handed over.
pub fn allow_to_take_foreground(pid: u32) -> bool {
    #[cfg(windows)]
    {
        winsafe::AllowSetForegroundWindow(Some(pid)).is_ok()
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
}

/// Set while the login shell runs for the environment capture, so a user's startup files can
/// skip slow or interactive parts if they want to (like `VSCODE_RESOLVING_ENVIRONMENT`).
pub const RESOLVING_ENV_VAR: &str = "VIDAI_RESOLVING_ENVIRONMENT";

/// The environment of the user's login shell, or `None` when it could not be read within
/// `timeout` (or the platform has no such concept). See `claude::env`.
///
/// Windows has no login shell: a GUI app already has the user's environment. It returns VidAI's
/// own environment with `PATH` rebuilt from the registry (see `windows::user_env`).
pub fn login_shell_env(timeout: Duration) -> Option<HashMap<String, String>> {
    #[cfg(target_os = "macos")]
    {
        macos::login_shell_env(timeout)
    }
    #[cfg(windows)]
    {
        let _ = timeout;
        windows::user_env()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = timeout;
        None
    }
}

/// Opens a new terminal window that runs the script `body`: a shell script (without a shebang
/// line) on macOS, a PowerShell script on Windows. `scratch_dir` is a folder VidAI owns where a
/// temporary script file may be written; on macOS the script deletes itself when it starts.
/// Never asks macOS for Automation permission.
pub fn open_terminal_script(scratch_dir: &Path, body: &str) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        macos::open_terminal_script(scratch_dir, body)
    }
    #[cfg(windows)]
    {
        windows::open_terminal_script(scratch_dir, body)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (scratch_dir, body);
        Err(crate::error::AppError::internal(
            "Opening a terminal is not supported on this system yet.",
        ))
    }
}

/// What a finished helper process produced.
#[derive(Debug)]
pub struct HelperOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// After the process exits, how long to keep reading output that a lingering grandchild might
/// still hold open (a login shell can leave background daemons behind).
const OUTPUT_GRACE: Duration = Duration::from_millis(500);

/// Runs `cmd` to completion with stdin closed, collecting its output, and ends its whole
/// process tree when it takes longer than `timeout` (error kind `TimedOut`).
///
/// Robust against children that leave grandchildren holding the output pipes open: once the
/// process itself has exited, output is collected for at most [`OUTPUT_GRACE`] more.
pub fn output_with_timeout(cmd: &mut Command, timeout: Duration) -> io::Result<HelperOutput> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (mut child, _group) = process::spawn_in_new_group(cmd)?;
    let (done_tx, done_rx) = mpsc::channel();
    let stdout = collect(child.stdout.take(), done_tx.clone());
    let stderr = collect(child.stderr.take(), done_tx);
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                process::kill_now(&mut child);
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("did not finish within {} seconds", timeout.as_secs()),
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(err) => {
                process::kill_now(&mut child);
                return Err(err);
            }
        }
    };
    let grace = Instant::now() + OUTPUT_GRACE;
    let drained = (0..2).all(|_| {
        done_rx
            .recv_timeout(grace.saturating_duration_since(Instant::now()))
            .is_ok()
    });
    if !drained {
        // Something the process started still holds the pipes: end what is left of the group.
        process::ProcessTree::group(child.id()).terminate(Duration::ZERO);
    }
    let take = |buf: Arc<Mutex<Vec<u8>>>| {
        std::mem::take(&mut *buf.lock().unwrap_or_else(PoisonError::into_inner))
    };
    Ok(HelperOutput {
        status,
        stdout: take(stdout),
        stderr: take(stderr),
    })
}

/// Reads `source` to its end on a background thread into a shared buffer, and signals `done`.
fn collect(
    source: Option<impl Read + Send + 'static>,
    done: mpsc::Sender<()>,
) -> Arc<Mutex<Vec<u8>>> {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let Some(mut source) = source else {
        let _ = done.send(());
        return buf;
    };
    let shared = Arc::clone(&buf);
    thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match source.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => shared
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .extend_from_slice(&chunk[..n]),
            }
        }
        let _ = done.send(());
    });
    buf
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// Apple Silicon and Intel builds alike (SPEC section 1).
    #[cfg(target_os = "macos")]
    #[test]
    fn every_mac_is_supported() {
        assert!(platform_supported());
    }

    #[test]
    fn collects_output_and_status() {
        let out = output_with_timeout(
            Command::new("/bin/sh").args(["-c", "printf out; printf err >&2; exit 3"]),
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(out.stdout, b"out");
        assert_eq!(out.stderr, b"err");
        assert_eq!(out.status.code(), Some(3));
    }

    #[test]
    fn times_out_and_ends_the_tree() {
        // Ended after 300 ms instead of running for 10 minutes (the bound leaves a busy machine
        // plenty of room and still tells the two apart).
        let started = Instant::now();
        let err = output_with_timeout(
            Command::new("/bin/sh").args(["-c", "sleep 600 & sleep 600"]),
            Duration::from_millis(300),
        )
        .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(120));
    }

    #[test]
    fn lingering_grandchild_does_not_block() {
        // The background `sleep` keeps stdout open after the shell itself has exited.
        // Waiting for the grandchild would run into the timeout (an error) after 5 minutes.
        let started = Instant::now();
        let out = output_with_timeout(
            Command::new("/bin/sh").args(["-c", "printf done; sleep 600 &"]),
            Duration::from_secs(300),
        )
        .unwrap();
        assert_eq!(out.stdout, b"done");
        assert!(started.elapsed() < Duration::from_secs(120));
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::os::windows::process::CommandExt;

    fn cmd_exe(line: &str) -> Command {
        let mut cmd = Command::new("cmd.exe");
        cmd.raw_arg(format!("/d /c \"{line}\""));
        cmd
    }

    #[test]
    fn collects_output_and_status() {
        let out = output_with_timeout(
            &mut cmd_exe("echo out& echo err 1>&2& exit 3"),
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "out");
        assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "err");
        assert_eq!(out.status.code(), Some(3));
    }

    #[test]
    fn times_out_and_ends_the_tree() {
        let started = Instant::now();
        let err = output_with_timeout(
            &mut cmd_exe("ping -n 30 127.0.0.1 >nul& ping -n 30 127.0.0.1 >nul"),
            Duration::from_millis(300),
        )
        .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn lingering_grandchild_does_not_block() {
        // `start /b` leaves a ping running that still holds stdout after cmd.exe has exited.
        let started = Instant::now();
        let out = output_with_timeout(
            &mut cmd_exe("start /b ping -n 30 127.0.0.1& echo done"),
            Duration::from_secs(10),
        )
        .unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("done"));
        assert!(started.elapsed() < Duration::from_secs(8));
    }
}

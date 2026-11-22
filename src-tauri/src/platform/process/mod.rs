//! Child processes in a group of their own, and ending a whole process tree. Used by
//! `claude::session`, `claude::control`, the helper processes of [`super::output_with_timeout`]
//! and the job manager.
//!
//! The same small API on every platform:
//!
//! - [`spawn_in_new_group`] starts a child so that everything it starts can be found and ended
//!   later, and returns a [`ChildGroup`] that the owner of the child keeps.
//! - [`ProcessTree`] follows a child and everything it started, lists it for the registry
//!   ([`ProcessTree::entries`]) and ends it ([`ProcessTree::terminate`]).
//! - [`kill_now`] ends a short-lived helper and its tree at once.
//! - Crash safety: the registry file (`running-processes.tsv`, [`write_registry`]),
//!   [`sweep_registry`] at the next start, and the [`OrphanWatchdog`].
//!
//! macOS and other Unix systems (`unix.rs`): process groups, SIGTERM then SIGKILL, `/bin/ps`, and a
//! tiny `sh` watchdog that waits on a pipe only VidAI holds.
//!
//! Windows (`windows.rs`): every child is started without a console window and put into a Job
//! Object of its own that kills everything in it when its last handle closes. Children cannot
//! leave the job, so the job always holds the whole tree, and the kernel ends it even when VidAI
//! crashes or is killed. There is no polite stop signal for windowless processes on Windows: the
//! job manager first asks Claude Code to stop through stdin (SPEC section 6), and whatever is left
//! after that is ended at once.

use std::io;
use std::path::Path;
use std::process::Child;
use std::time::Duration;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

/// One process of a tree, as the platform reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcInfo {
    pub pid: u32,
    pub ppid: u32,
    /// The process group (Unix). Always 0 on Windows, which has no process groups.
    pub pgid: u32,
    pub zombie: bool,
    pub command: String,
}

/// Where the CPU time of a process cannot be read (everywhere but Unix for now), no process is
/// ever seen as busy and the job engine falls back to its other rules.
#[cfg(not(unix))]
pub fn cpu_times(_pids: &[u32]) -> std::collections::BTreeMap<u32, u64> {
    std::collections::BTreeMap::new()
}

/// For a short helper that is started without [`spawn_in_new_group`]: on Windows it gets no
/// console window (`CREATE_NO_WINDOW`), so none flashes up. Nothing on other platforms.
pub fn hide_console(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(windows::CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Ends `child` (started with [`spawn_in_new_group`] or [`configure_new_group`]) and everything
/// it started right away (no grace period), then reaps it. Never fails: a process that is already
/// gone is fine. For short-lived helper processes; job processes get a grace period through
/// [`ProcessTree::terminate`].
pub fn kill_now(child: &mut Child) {
    if matches!(child.try_wait(), Ok(None)) {
        ProcessTree::new(child.id()).terminate(Duration::ZERO);
    }
    let _ = child.kill();
    let _ = child.wait();
}

// ---------------------------------------------------------------------------------------------
// Registry of running trees
// ---------------------------------------------------------------------------------------------

/// One process VidAI is responsible for, as written to the registry file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryEntry {
    pub pid: u32,
    pub command: String,
}

/// Writes the registry atomically: one `pid<TAB>command` line per process.
pub fn write_registry(path: &Path, entries: &[RegistryEntry]) -> io::Result<()> {
    let mut text = String::new();
    for e in entries {
        let command: String = e
            .command
            .chars()
            .map(|c| if c == '\n' || c == '\t' { ' ' } else { c })
            .collect();
        text.push_str(&format!("{}\t{}\n", e.pid, command));
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    super::rename(&tmp, path)
}

fn read_registry(path: &Path) -> Vec<RegistryEntry> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            let (pid, command) = line.split_once('\t')?;
            Some(RegistryEntry {
                pid: pid.trim().parse().ok()?,
                command: command.to_owned(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_round_trip_flattens_tabs_and_newlines() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("running-processes.tsv");
        assert!(read_registry(&path).is_empty());
        write_registry(
            &path,
            &[
                RegistryEntry {
                    pid: 12,
                    command: "claude -p\t--verbose".into(),
                },
                RegistryEntry {
                    pid: 34,
                    command: "C:\\Program Files\\Git\\usr\\bin\\sleep.exe 300\nx".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(
            read_registry(&path),
            vec![
                RegistryEntry {
                    pid: 12,
                    command: "claude -p --verbose".into(),
                },
                RegistryEntry {
                    pid: 34,
                    command: "C:\\Program Files\\Git\\usr\\bin\\sleep.exe 300 x".into(),
                },
            ]
        );
        write_registry(&path, &[]).unwrap();
        assert!(read_registry(&path).is_empty());
    }
}

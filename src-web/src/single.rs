//! One copy per data directory (SPEC section 12, Architecture).
//!
//! The core's `instance::claim` locks the data directory for the desktop app and for `vidai-web`
//! alike. When the lock is taken, this module asks the running copy to show itself (the desktop
//! app shows its window, another `vidai-web` opens the browser) and says what happened. It tells
//! the two kinds apart by a small file the web server writes, `vidai-web.json` (`{ "pid", "port" }`),
//! which only counts while its pid is the one in the core's `instance.json`: the lock holder
//! rewrites that file on every start, so a file left by a crash never matches a later desktop copy.

use std::fs;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use vidai_lib::instance::{self, ADDRESS_FILE};
use vidai_lib::store::write_atomic;

use crate::token::{self, Access};

/// Where a running `vidai-web` says which port it listens on.
pub const WEB_FILE: &str = "vidai-web.json";

/// How long a second start waits for the running copy to answer.
const PATIENCE: Duration = Duration::from_secs(5);

/// The copy that holds the data directory.
#[derive(Debug, PartialEq, Eq)]
pub enum Holder {
    /// Another `vidai-web`, on this port.
    Web { port: u16 },
    /// The desktop app (or a copy that does not say what it is).
    Desktop,
}

/// What a start does when another copy has the data directory: the text to print and the
/// exit status.
#[derive(Debug, PartialEq, Eq)]
pub struct Verdict {
    pub message: String,
    pub status: u8,
}

/// Writes which port the running server listens on, for later starts.
pub fn write_marker(data_dir: &Path, port: u16) {
    let json = serde_json::json!({ "pid": std::process::id(), "port": port });
    let result = serde_json::to_vec(&json)
        .map_err(|e| e.to_string())
        .and_then(|bytes| write_atomic(&data_dir.join(WEB_FILE), &bytes).map_err(|e| e.message));
    if let Err(err) = result {
        eprintln!("vidai-web: could not write {WEB_FILE}: {err}");
    }
}

/// Who holds the data directory, from `instance.json` and `vidai-web.json`.
pub fn holder(data_dir: &Path) -> Holder {
    let read = |name: &str| -> Option<Value> {
        serde_json::from_slice(&fs::read(data_dir.join(name)).ok()?).ok()
    };
    let pid = |value: &Value| value.get("pid").and_then(Value::as_u64);
    let running = read(ADDRESS_FILE);
    let web = read(WEB_FILE);
    match (running.as_ref().and_then(pid), web.as_ref()) {
        (Some(running_pid), Some(web)) if pid(web) == Some(running_pid) => web
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .map_or(Holder::Desktop, |port| Holder::Web { port }),
        _ => Holder::Desktop,
    }
}

/// The address of the running server: with the token when the data directory has one.
fn running_address(data_dir: &Path, port: u16) -> String {
    match fs::read_to_string(token::path(data_dir)) {
        Ok(text) if !text.trim().is_empty() => Access {
            port,
            token: text.trim().to_owned(),
        }
        .address(),
        _ => format!("http://127.0.0.1:{port}/"),
    }
}

/// The message and exit status for a start that found the data directory taken, given who holds
/// it and whether it answered the request to show itself.
pub fn verdict(holder: &Holder, answered: bool, data_dir: &Path) -> Verdict {
    let folder = data_dir.display();
    match (holder, answered) {
        (Holder::Web { port }, true) => Verdict {
            message: format!(
                "VidAI Web is already running at {} - asked it to open the browser.",
                running_address(data_dir, *port)
            ),
            status: 0,
        },
        (Holder::Desktop, true) => Verdict {
            message: format!(
                "VidAI cannot start: the VidAI desktop app is running on {folder} and only one copy may use it. \
                 Its window was brought to the front. Quit the desktop app, then start vidai-web again."
            ),
            status: 1,
        },
        (_, false) => Verdict {
            message: format!(
                "VidAI cannot start: another copy of VidAI holds {folder} and did not answer. \
                 Quit it (or wait a moment if it is still starting), then start vidai-web again."
            ),
            status: 1,
        },
    }
}

/// A second start: asks the running copy to show itself and reports. Returns the exit status.
pub fn second_start(data_dir: &Path) -> u8 {
    let answered = instance::ask_to_show(data_dir, PATIENCE);
    let verdict = verdict(&holder(data_dir), answered, data_dir);
    if verdict.status == 0 {
        println!("{}", verdict.message);
    } else {
        eprintln!("{}", verdict.message);
    }
    verdict.status
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_with(instance_pid: u32, web: Option<(u32, u16)>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let instance = serde_json::json!({ "port": 1, "token": "t", "pid": instance_pid });
        fs::write(dir.path().join(ADDRESS_FILE), instance.to_string()).unwrap();
        if let Some((pid, port)) = web {
            let web = serde_json::json!({ "pid": pid, "port": port });
            fs::write(dir.path().join(WEB_FILE), web.to_string()).unwrap();
        }
        dir
    }

    #[test]
    fn the_marker_counts_only_for_the_process_that_holds_the_lock() {
        let web = dir_with(10, Some((10, 14200)));
        assert_eq!(holder(web.path()), Holder::Web { port: 14200 });
        let stale = dir_with(11, Some((10, 14200)));
        assert_eq!(holder(stale.path()), Holder::Desktop);
        let desktop = dir_with(10, None);
        assert_eq!(holder(desktop.path()), Holder::Desktop);
        assert_eq!(holder(Path::new("/nonexistent/vidai")), Holder::Desktop);
    }

    #[test]
    fn a_second_web_server_is_fine_but_the_desktop_app_is_a_failure() {
        let path = Path::new("/data");
        let web = verdict(&Holder::Web { port: 14200 }, true, path);
        assert_eq!(web.status, 0);
        assert!(web.message.contains("http://127.0.0.1:14200/"));
        let desktop = verdict(&Holder::Desktop, true, path);
        assert_eq!(desktop.status, 1);
        assert!(desktop.message.contains("desktop app"));
        assert_eq!(verdict(&Holder::Web { port: 1 }, false, path).status, 1);
    }

    #[test]
    fn the_marker_is_written_with_this_process() {
        let dir = tempfile::tempdir().unwrap();
        write_marker(dir.path(), 4242);
        let text = fs::read_to_string(dir.path().join(WEB_FILE)).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["port"], 4242);
        assert_eq!(value["pid"], u64::from(std::process::id()));
    }
}

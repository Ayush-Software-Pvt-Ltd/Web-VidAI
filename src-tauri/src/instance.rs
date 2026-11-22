//! One running VidAI per data directory (SPEC section 9, "Window, menu and quitting").
//!
//! Two copies on the same data directory would run two job managers on the same `state.json`.
//! So the first copy takes an exclusive lock on `<data dir>/instance.lock` before anything else
//! starts, and holds it for the rest of its run; the operating system lets go of it when the
//! process ends in any way (quit, crash, ended in Task Manager or Activity Monitor), so a stale
//! lock is impossible. A later copy (a second click on the Windows Start menu entry, `open -n` on
//! macOS) finds the lock taken, asks the running copy to show its window, and exits before it
//! shows any window of its own.
//!
//! The request travels over a loopback TCP connection: the running copy listens on `127.0.0.1`
//! (a port the system picks; loopback only, so no firewall prompt) and writes the port, a
//! random token and its process id to `<data dir>/instance.json`. A request must carry that token, so only a program
//! that can read the user's own app data can ask, and all it can ask for is showing the window.
//!
//! The lock is keyed by the data directory, not the bundle id, so copies with their own
//! `VIDAI_DATA_DIR` (development runs, the end-to-end tests next to an installed VidAI) never
//! get in each other's way, while every copy that would share `state.json` does.
//!
//! Coming to the front: Windows lets a process take the foreground only when it owns it or was
//! started by the process that does (the person's click in the Start menu starts the second
//! copy through Explorer). A window that is open behind other windows would stay there, so the
//! second copy hands that right to the running one (`platform::allow_to_take_foreground`, with
//! the process id from `instance.json`) before it asks; a minimized window comes back by itself
//! when it is restored.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::store::write_atomic;

/// Held (locked) by the running copy for its whole run.
pub const LOCK_FILE: &str = "instance.lock";
/// Where the running copy listens: `{ "port": <u16>, "token": "<uuid>" }`.
pub const ADDRESS_FILE: &str = "instance.json";

/// The one request there is.
const SHOW: &str = "show";
/// The answer to a request with the right token.
const SHOWN: &str = "shown";
/// How long either side waits for the other on an open connection.
const IO_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Serialize, Deserialize)]
struct Address {
    port: u16,
    token: String,
    /// The running copy's process id, so a later copy can hand it the right to come to the
    /// front (absent in files of copies that did not write it yet).
    #[serde(default)]
    pid: Option<u32>,
}

/// The outcome of [`claim`].
#[derive(Debug)]
pub enum Claim {
    /// This is the only copy on the data directory; keep the [`Instance`] for the whole run.
    First(Instance),
    /// Another copy runs on the data directory.
    Taken,
}

/// The lock and the listener of the running copy.
#[derive(Debug)]
pub struct Instance {
    lock: File,
    listener: TcpListener,
    token: String,
}

/// Keeps the data directory locked while it lives (managed by the app for its whole run).
#[derive(Debug)]
pub struct InstanceLock {
    _lock: File,
}

/// Takes the data directory for this copy, or reports that another copy has it.
pub fn claim(data_dir: &Path) -> io::Result<Claim> {
    fs::create_dir_all(data_dir)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data_dir.join(LOCK_FILE))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Ok(Claim::Taken),
        Err(TryLockError::Error(err)) => return Err(err),
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let address = Address {
        port: listener.local_addr()?.port(),
        token: uuid::Uuid::new_v4().to_string(),
        pid: Some(std::process::id()),
    };
    let json = serde_json::to_vec(&address).map_err(io::Error::other)?;
    write_atomic(&data_dir.join(ADDRESS_FILE), &json).map_err(io::Error::other)?;
    Ok(Claim::First(Instance {
        lock,
        listener,
        token: address.token,
    }))
}

impl Instance {
    /// Answers the show requests of later copies on a background thread, calling `on_show` for
    /// each one, and returns the lock to keep for the rest of the run.
    pub fn serve(self, on_show: impl Fn() + Send + 'static) -> InstanceLock {
        let Self {
            lock,
            listener,
            token,
        } = self;
        let spawned = thread::Builder::new()
            .name("vidai-instance".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    match stream {
                        Ok(stream) => answer(stream, &token, &on_show),
                        // A connection that failed before it was accepted; keep listening.
                        Err(err) => eprintln!("vidai: a second launch could not connect: {err}"),
                    }
                }
            });
        if let Err(err) = spawned {
            eprintln!("vidai: could not listen for a second launch: {err}");
        }
        InstanceLock { _lock: lock }
    }
}

/// Reads one request and, when it is a show request with the right token, calls `on_show` and
/// then confirms, so a confirmed request has always been carried out.
fn answer(stream: TcpStream, token: &str, on_show: &impl Fn()) {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let mut line = String::new();
    let mut reader = BufReader::new((&stream).take(256));
    if reader.read_line(&mut line).is_err() || !is_show_request(&line, token) {
        return;
    }
    on_show();
    let _ = (&stream).write_all(format!("{SHOWN}\n").as_bytes());
}

/// `show <token>`, exactly.
fn is_show_request(line: &str, token: &str) -> bool {
    line.trim_end_matches(['\r', '\n'])
        .split_once(' ')
        .is_some_and(|(request, sent)| request == SHOW && sent == token)
}

/// Asks the copy that holds the data directory to show its window. It may still be starting
/// (locked, but `instance.json` not written yet), so this tries again until `patience` has
/// passed. True when the running copy confirmed.
pub fn ask_to_show(data_dir: &Path, patience: Duration) -> bool {
    let deadline = Instant::now() + patience;
    loop {
        match try_ask(data_dir) {
            Ok(()) => return true,
            Err(err) if Instant::now() >= deadline => {
                eprintln!("vidai: VidAI is already running, but it did not answer: {err}");
                return false;
            }
            Err(_) => thread::sleep(Duration::from_millis(100)),
        }
    }
}

fn try_ask(data_dir: &Path) -> io::Result<()> {
    let bytes = fs::read(data_dir.join(ADDRESS_FILE))?;
    let address: Address = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    // Windows lets the running copy come to the front only with a right that this copy has
    // when the person started it; hand it over before asking.
    if let Some(pid) = address.pid {
        crate::platform::allow_to_take_foreground(pid);
    }
    let target = SocketAddr::from((Ipv4Addr::LOCALHOST, address.port));
    let mut stream = TcpStream::connect_timeout(&target, IO_TIMEOUT)?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    stream.write_all(format!("{SHOW} {}\n", address.token).as_bytes())?;
    let mut reply = String::new();
    BufReader::new(&stream).read_line(&mut reply)?;
    if reply.trim_end() == SHOWN {
        Ok(())
    } else {
        Err(io::Error::other("unexpected answer"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tempfile::TempDir;

    #[test]
    fn a_second_claim_on_the_same_data_dir_is_refused() {
        let dir = TempDir::new().unwrap();
        let Claim::First(first) = claim(dir.path()).unwrap() else {
            panic!("the first claim must succeed");
        };
        assert!(matches!(claim(dir.path()).unwrap(), Claim::Taken));

        // Another data directory is independent.
        let other = TempDir::new().unwrap();
        assert!(matches!(claim(other.path()).unwrap(), Claim::First(_)));

        // Once the first copy is gone, the next one gets the directory.
        drop(first);
        assert!(matches!(claim(dir.path()).unwrap(), Claim::First(_)));
    }

    #[test]
    fn the_address_names_the_running_process() {
        let dir = TempDir::new().unwrap();
        let Claim::First(_first) = claim(dir.path()).unwrap() else {
            panic!("the first claim must succeed");
        };
        let bytes = fs::read(dir.path().join(ADDRESS_FILE)).unwrap();
        let address: Address = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(address.pid, Some(std::process::id()));

        // A file written before the process id was added still works.
        let old: Address = serde_json::from_str(r#"{"port":1234,"token":"t"}"#).unwrap();
        assert_eq!((old.port, old.pid), (1234, None));
    }

    #[test]
    fn a_second_launch_asks_the_first_to_show_its_window() {
        let dir = TempDir::new().unwrap();
        let Claim::First(first) = claim(dir.path()).unwrap() else {
            panic!("the first claim must succeed");
        };
        let shown = Arc::new(AtomicU32::new(0));
        let counter = Arc::clone(&shown);
        let lock = first.serve(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        assert!(matches!(claim(dir.path()).unwrap(), Claim::Taken));
        assert!(ask_to_show(dir.path(), Duration::from_secs(5)));
        assert!(ask_to_show(dir.path(), Duration::from_secs(5)));
        assert_eq!(shown.load(Ordering::SeqCst), 2);
        // The lock is still held while the guard lives.
        assert!(matches!(claim(dir.path()).unwrap(), Claim::Taken));
        drop(lock);
    }

    #[test]
    fn requests_without_the_token_are_ignored() {
        let dir = TempDir::new().unwrap();
        let Claim::First(first) = claim(dir.path()).unwrap() else {
            panic!("the first claim must succeed");
        };
        let shown = Arc::new(AtomicU32::new(0));
        let counter = Arc::clone(&shown);
        let _lock = first.serve(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        let bytes = fs::read(dir.path().join(ADDRESS_FILE)).unwrap();
        let address: Address = serde_json::from_slice(&bytes).unwrap();
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, address.port)).unwrap();
        stream.write_all(b"show not-the-token\n").unwrap();
        let mut reply = String::new();
        stream.set_read_timeout(Some(IO_TIMEOUT)).unwrap();
        let _ = BufReader::new(&stream).read_line(&mut reply);
        assert_eq!(reply, "");
        assert_eq!(shown.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn nobody_answering_gives_up_after_the_patience() {
        let dir = TempDir::new().unwrap();
        let started = Instant::now();
        assert!(!ask_to_show(dir.path(), Duration::from_millis(300)));
        assert!(started.elapsed() >= Duration::from_millis(300));
    }

    #[test]
    fn show_request_parsing() {
        assert!(is_show_request("show abc\n", "abc"));
        assert!(is_show_request("show abc\r\n", "abc"));
        assert!(!is_show_request("show abcd\n", "abc"));
        assert!(!is_show_request("hide abc\n", "abc"));
        assert!(!is_show_request("show\n", "abc"));
        assert!(!is_show_request("", "abc"));
    }
}

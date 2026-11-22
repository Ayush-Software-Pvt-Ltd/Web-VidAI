//! Helpers shared by the integration tests.

pub mod engine;

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};

/// An executable copy of the script `source` (a fake `claude`), shared by every test and test
/// process that uses the same script.
///
/// macOS checks a new executable file (XProtect) the first time it runs, and it does those checks
/// one at a time for the whole machine. A fresh copy for every test made each launch of the fake
/// wait in that queue, which took minutes when many test processes ran at once. The copy is
/// named after its content, so an edited script gets a new copy and concurrent test processes
/// never write over a copy another one runs.
pub fn installed(source: &Path) -> PathBuf {
    let bytes = fs::read(source).unwrap_or_else(|e| panic!("cannot read {source:?}: {e}"));
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    let stem = source.file_stem().unwrap().to_string_lossy();
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"));
    let ext = source
        .extension()
        .map_or("sh".into(), |e| e.to_string_lossy());
    let target = dir.join(format!("{stem}-{:016x}.{ext}", hasher.finish()));
    if target.exists() {
        return target;
    }
    // Written under a name of its own, then renamed: never seen half written.
    let thread = format!("{:?}", std::thread::current().id());
    let thread: String = thread.chars().filter(char::is_ascii_digit).collect();
    let tmp = dir.join(format!(".{stem}-{}-{thread}.tmp", std::process::id()));
    fs::write(&tmp, &bytes).unwrap();
    // On Windows the `#!` line makes VidAI run the fake with Git Bash (`fake-claude.sh`) or with
    // the machine's Python (`fake-opencode2.py`).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::rename(&tmp, &target).unwrap();
    target
}

/// `dir` with every link resolved (macOS: `/var` is `/private/var`, as the fake's `$PWD` shows).
/// Windows: also without the `\\?\` prefix that `canonicalize` adds, the long path as Git Bash
/// shows it.
#[allow(dead_code)] // Not every test crate needs it.
pub fn real_path(dir: &Path) -> PathBuf {
    let path = dir.canonicalize().unwrap();
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().trim_start_matches(r"\\?\"))
    } else {
        path
    }
}

/// The environment a fake `claude` starts with: a minimal `PATH` on Unix; on Windows the whole
/// environment of the test, which Windows programs and Git Bash need (`SystemRoot`, `PATH`).
#[allow(dead_code)] // Not every test crate needs it.
pub fn base_env() -> HashMap<String, String> {
    if cfg!(windows) {
        std::env::vars().collect()
    } else {
        HashMap::from([("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into())])
    }
}

/// Wakes every fake `claude` waiting in `state` (its FAKE_STATE folder), so it looks at the files
/// the test just dropped at once instead of within a second (see tests/support/fake-claude.sh).
/// A FIFO is opened for reading and writing, which never blocks, also when its fake just ended.
///
/// Windows: the fakes run in Git Bash and have no wake-up FIFO (MSYS2's FIFOs can only be opened
/// by MSYS2 programs, and several fakes opening theirs at once could hang), so there is nothing
/// to write and each fake notices the dropped file within its one-second sleep, as in the
/// end-to-end runs.
#[allow(dead_code)] // Not every test crate drives the fake of the job engine.
pub fn wake_fakes(state: &Path) {
    if cfg!(windows) {
        let _ = state;
        return;
    }
    let Ok(entries) = fs::read_dir(state) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with("wake.") {
            continue;
        }
        if let Ok(mut fifo) = OpenOptions::new().read(true).write(true).open(entry.path()) {
            let _ = fifo.write_all(b"\n");
        }
    }
}

//! Machine locks left behind by a job that was ended (SPEC section 6, "Locks of ended jobs").
//!
//! The bundled toolkit serializes heavy steps between sessions with `cpu.lock` and `gpu.lock` in
//! the Editing Folder (`locks.py`): a JSON file with the pid of the holder, held while that pid
//! is alive or its lease (15 minutes) has not run out. A job that is paused, stopped, quit or
//! crashed while its model holds one leaves the file behind, with a live lease, and the next
//! session that wants the lock waits for it (up to the model's own `--wait`) and may give up.
//!
//! VidAI ends the whole process tree of a job, so it knows exactly which processes it killed.
//! A lock whose holder is one of them is removed; a lock of any other pid (another session of
//! the owner's, a job of another video) is never touched.

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::Value;

/// The lock files of the toolkit, in the Editing Folder.
const LOCK_FILES: [&str; 2] = ["cpu.lock", "gpu.lock"];

/// Removes the locks of `editing_folder` held by one of `pids` (the processes of a job's tree that
/// were just ended). Returns the names of the removed files. A missing, unreadable or
/// differently shaped lock file is left alone.
pub fn release_held_by(editing_folder: &Path, pids: &BTreeSet<u32>) -> Vec<&'static str> {
    let mut released = Vec::new();
    for name in LOCK_FILES {
        let path = editing_folder.join(name);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let holder = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("pid").and_then(Value::as_u64))
            .and_then(|pid| u32::try_from(pid).ok());
        if holder.is_some_and(|pid| pids.contains(&pid)) && std::fs::remove_file(&path).is_ok() {
            released.push(name);
        }
    }
    released
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_locks_of_the_ended_processes_are_removed() {
        let dir = tempfile::TempDir::new().unwrap();
        let lock = |name: &str, pid: u64| {
            std::fs::write(
                dir.path().join(name),
                format!(r#"{{"pid": {pid}, "host": "mac", "started": 1.0, "lease_until": 2.0e12, "note": "whisper"}}"#),
            )
            .unwrap();
        };
        lock("cpu.lock", 4242);
        lock("gpu.lock", 999);
        let ended = BTreeSet::from([4242, 4243]);
        assert_eq!(release_held_by(dir.path(), &ended), ["cpu.lock"]);
        assert!(!dir.path().join("cpu.lock").exists());
        // Another session's lock stays.
        assert!(dir.path().join("gpu.lock").exists());
        // Nothing to do: no files, unreadable or foreign content.
        assert!(release_held_by(dir.path(), &BTreeSet::from([1])).is_empty());
        std::fs::write(dir.path().join("cpu.lock"), "not json").unwrap();
        assert!(release_held_by(dir.path(), &ended).is_empty());
        assert!(dir.path().join("cpu.lock").exists());
        assert!(release_held_by(&dir.path().join("missing"), &ended).is_empty());
    }
}

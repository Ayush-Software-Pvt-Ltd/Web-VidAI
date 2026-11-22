//! The platform part of the picture check (SPEC section 8): find faces in sampled frames.
//!
//! - macOS: the `vidai-orient` helper (src-tauri/helpers/orient, AVFoundation and Vision), built
//!   by build.rs and bundled as a Tauri sidecar next to the app binary ([`helper`]).
//! - Windows: the app binary itself, started again as a helper process with
//!   [`windows_helper::HELPER_FLAG`]; it reads frames with `Windows.Media.Editing` and finds faces
//!   with `Windows.Media.FaceAnalysis` (see [`windows_helper`]). A separate process, so a crash or
//!   hang in a video decoder never takes the app down and can always be ended.
//! - Other platforms: not available, so detection uses the metadata alone.
//!
//! Every platform implements [`available`] and [`observe_faces`] with the same contract: sample
//! `frames` frames evenly between 5 % and 95 % of the duration with any rotation flag applied,
//! find faces with their roll in degrees (0 = upright, negative = turned clockwise), confidence
//! (0 to 1) and area (fraction of the frame), finish within a hard time limit, never touch the
//! network, and report the outcome as `Ok(Observations)`, `Unreadable` (the file is not a video
//! the platform can decode), `Failed` (anything that may pass) or `NotAvailable`. Both helpers
//! speak the same protocol ([`sidecar`]).

use std::path::Path;

use crate::orientation::{Observations, PictureCheckError};

#[cfg(any(windows, test))]
pub mod windows_helper;
#[cfg(windows)]
mod winrt;

/// True when the picture check can run on this platform and installation.
pub fn available() -> bool {
    #[cfg(target_os = "macos")]
    {
        helper::path().is_some()
    }
    #[cfg(windows)]
    {
        windows_helper::available()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        false
    }
}

/// Finds faces in `frames` sampled frames of the video at `path`. Blocking, bounded by a time
/// limit.
pub fn observe_faces(path: &Path, frames: u32) -> Result<Observations, PictureCheckError> {
    #[cfg(target_os = "macos")]
    {
        let helper = helper::path().ok_or(PictureCheckError::NotAvailable)?;
        helper::run(helper, path, frames)
    }
    #[cfg(windows)]
    {
        windows_helper::observe_faces(path, frames)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (path, frames);
        Err(PictureCheckError::NotAvailable)
    }
}

/// Running a picture check helper process and reading its answer, the same on every platform.
///
/// Usage: `<helper> [arguments that must come first] --frames N --time-limit SECONDS -- <video>`.
/// On success the helper prints exactly one JSON line of [`Observations`] on stdout and exits 0.
/// Every other exit code comes with one JSON line `{"error": "..."}` on stderr: 2 usage error,
/// 3 the file cannot be read as a video, 4 the helper's own time limit was reached, 5 any other
/// failure.
#[cfg(any(target_os = "macos", windows))]
pub mod sidecar {
    use std::io;
    use std::path::Path;
    use std::process::Command;
    use std::time::Duration;

    use crate::orientation::{Observations, PROTOCOL, PictureCheckError};
    use crate::platform::output_with_timeout;

    /// The exit code for a file that cannot be read as a video.
    pub const EXIT_UNREADABLE: i32 = 3;

    /// Runs the helper command `cmd` (its program, plus any arguments that must come first) on
    /// `video` with the given time limits. `name` names the helper in messages.
    pub fn run(
        name: &str,
        mut cmd: Command,
        video: &Path,
        frames: u32,
        time_limit: Duration,
        kill_after: Duration,
    ) -> Result<Observations, PictureCheckError> {
        cmd.arg("--frames")
            .arg(frames.to_string())
            .arg("--time-limit")
            .arg(time_limit.as_secs_f64().to_string())
            .arg("--")
            .arg(video);
        let output = output_with_timeout(&mut cmd, kill_after).map_err(|err| {
            PictureCheckError::Failed(match err.kind() {
                io::ErrorKind::TimedOut => format!("{name} did not finish in time"),
                _ => format!("could not run {name}: {err}"),
            })
        })?;
        let reason = || helper_error(&output.stderr);
        match output.status.code() {
            Some(0) => parse(name, &output.stdout),
            Some(EXIT_UNREADABLE) => Err(PictureCheckError::Unreadable(reason())),
            Some(code) => Err(PictureCheckError::Failed(format!(
                "{name} exited with code {code}: {}",
                reason()
            ))),
            None => Err(PictureCheckError::Failed(format!(
                "{name} was ended by a signal"
            ))),
        }
    }

    /// The observations in the helper's stdout (one JSON line of a protocol this build knows).
    pub fn parse(name: &str, stdout: &[u8]) -> Result<Observations, PictureCheckError> {
        let observations: Observations = serde_json::from_slice(stdout)
            .map_err(|e| PictureCheckError::Failed(format!("unexpected {name} output: {e}")))?;
        if observations.protocol != PROTOCOL {
            return Err(PictureCheckError::Failed(format!(
                "{name} speaks protocol {}, expected {PROTOCOL}",
                observations.protocol
            )));
        }
        Ok(observations)
    }

    /// The `{"error": "..."}` line the helper writes on stderr, else the raw text (shortened).
    fn helper_error(stderr: &[u8]) -> String {
        #[derive(serde::Deserialize)]
        struct ErrorLine {
            error: String,
        }
        let text = String::from_utf8_lossy(stderr);
        let message = text
            .lines()
            .rev()
            .find_map(|line| serde_json::from_str::<ErrorLine>(line).ok())
            .map_or_else(|| text.trim().to_owned(), |line| line.error);
        let mut message: String = message.chars().take(300).collect();
        if message.is_empty() {
            message = "no details".to_owned();
        }
        message
    }
}

/// Finding and running the `vidai-orient` sidecar.
#[cfg(target_os = "macos")]
pub mod helper {
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::OnceLock;
    use std::time::Duration;

    use super::sidecar;
    use crate::orientation::{Observations, PictureCheckError};

    /// File name of the sidecar (Tauri strips the target triple when it copies it).
    pub const NAME: &str = "vidai-orient";

    /// The helper's own time limit. A 4K file on a local disk takes about 0.3 seconds; the
    /// margin is for slow disks and a busy machine.
    pub const TIME_LIMIT: Duration = Duration::from_secs(20);

    /// The hard limit from outside, in case the helper hangs before its own timer runs.
    const KILL_AFTER: Duration = Duration::from_secs(30);

    /// Where the helper is, looked up once: next to the running binary (`VidAI.app/Contents/MacOS`
    /// in the bundle, `target/<profile>` for debug runs), or one folder up for test binaries in
    /// `target/<profile>/deps`.
    pub fn path() -> Option<&'static Path> {
        static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
        PATH.get_or_init(|| {
            let found = std::env::current_exe()
                .ok()
                .and_then(|exe| locate(&exe));
            if found.is_none() {
                eprintln!(
                    "vidai: the picture check helper {NAME} was not found next to the app, so Long / Short detection uses the file's metadata only"
                );
            }
            found
        })
        .as_deref()
    }

    /// The helper next to `exe`, or next to its folder when that folder is cargo's `deps`.
    pub fn locate(exe: &Path) -> Option<PathBuf> {
        let dir = exe.parent()?;
        let mut candidates = vec![dir.join(NAME)];
        if dir.file_name() == Some(OsStr::new("deps")) {
            candidates.extend(dir.parent().map(|up| up.join(NAME)));
        }
        candidates.into_iter().find(|c| is_executable(c))
    }

    fn is_executable(path: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }

    /// Runs `helper` on `video` and reads its observations.
    pub fn run(
        helper: &Path,
        video: &Path,
        frames: u32,
    ) -> Result<Observations, PictureCheckError> {
        run_with_limits(Command::new(helper), video, frames, TIME_LIMIT, KILL_AFTER)
    }

    /// Runs the helper command `cmd` (its program, plus any arguments that must come first) on
    /// `video` with the given time limits.
    pub(crate) fn run_with_limits(
        cmd: Command,
        video: &Path,
        frames: u32,
        time_limit: Duration,
        kill_after: Duration,
    ) -> Result<Observations, PictureCheckError> {
        sidecar::run(NAME, cmd, video, frames, time_limit, kill_after)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::orientation::PROTOCOL;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::time::Instant;

        /// An executable file (for the lookup tests; never executed).
        fn executable(dir: &Path, name: &str) -> PathBuf {
            let path = dir.join(name);
            fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        fn fixture(name: &str) -> PathBuf {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/media")
                .join(name)
        }

        /// Runs a fake helper: a shell script, run by `/bin/sh` rather than executed directly,
        /// because executing a file written moments ago can fail with "text file busy" when
        /// another test thread forks at the same time.
        /// Runs a fake helper that ends by itself; the kill limit only catches a hang, so it
        /// does not assume a fast machine.
        fn run_fake(body: &str) -> Result<Observations, PictureCheckError> {
            run_fake_killed_after(body, Duration::from_secs(60))
        }

        fn run_fake_killed_after(
            body: &str,
            kill_after: Duration,
        ) -> Result<Observations, PictureCheckError> {
            let dir = tempfile::tempdir().unwrap();
            let script = dir.path().join("fake-helper.sh");
            fs::write(&script, body).unwrap();
            let mut cmd = Command::new("/bin/sh");
            cmd.arg(&script);
            run_with_limits(
                cmd,
                Path::new("/x.mov"),
                7,
                Duration::from_secs(5),
                kill_after,
            )
        }

        #[test]
        fn maps_exit_codes_and_output() {
            let ok = r#"printf '%s\n' '{"protocol":1,"durationSeconds":1,"frameWidth":64,"frameHeight":36,"frames":[]}'"#;
            assert_eq!(run_fake(ok).unwrap().frame_width, 64);
            assert_eq!(
                run_fake(r#"echo '{"error":"no video track"}' >&2; exit 3"#),
                Err(PictureCheckError::Unreadable("no video track".into()))
            );
            assert!(matches!(
                run_fake("echo boom >&2; exit 5"),
                Err(PictureCheckError::Failed(m)) if m.contains("code 5") && m.contains("boom")
            ));
            assert!(matches!(
                run_fake("echo 'not json'"),
                Err(PictureCheckError::Failed(m)) if m.contains("unexpected")
            ));
            assert!(matches!(
                run_fake(r#"echo '{"protocol":2,"durationSeconds":1,"frameWidth":1,"frameHeight":1,"frames":[]}'"#),
                Err(PictureCheckError::Failed(m)) if m.contains("protocol 2")
            ));
            assert!(matches!(
                run_fake("kill -9 $$"),
                Err(PictureCheckError::Failed(m)) if m.contains("signal")
            ));
        }

        #[test]
        fn passes_the_arguments() {
            // The fake prints its arguments as the error message.
            let result = run_fake(r#"echo "{\"error\":\"$*\"}" >&2; exit 3"#);
            assert_eq!(
                result,
                Err(PictureCheckError::Unreadable(
                    "--frames 7 --time-limit 5 -- /x.mov".into()
                ))
            );
        }

        #[test]
        fn a_hanging_helper_is_killed() {
            // Killed after 2 s instead of running for 10 minutes (the bound leaves a busy machine
            // plenty of room and still tells the two apart).
            let started = Instant::now();
            let result = run_fake_killed_after("sleep 600", Duration::from_secs(2));
            assert!(matches!(result, Err(PictureCheckError::Failed(m)) if m.contains("in time")));
            assert!(started.elapsed() < Duration::from_secs(120));
        }

        #[test]
        fn a_missing_helper_fails_without_panicking() {
            let result = run_with_limits(
                Command::new("/nonexistent/vidai-orient"),
                Path::new("/x.mov"),
                7,
                TIME_LIMIT,
                KILL_AFTER,
            );
            assert!(
                matches!(result, Err(PictureCheckError::Failed(m)) if m.contains("could not run"))
            );
        }

        #[test]
        fn locates_next_to_the_binary_and_above_deps() {
            let dir = tempfile::tempdir().unwrap();
            let deps = dir.path().join("deps");
            fs::create_dir(&deps).unwrap();
            assert_eq!(locate(&deps.join("test-binary")), None);
            let helper = executable(dir.path(), NAME);
            assert_eq!(locate(&deps.join("test-binary")), Some(helper.clone()));
            assert_eq!(locate(&dir.path().join("VidAI")), Some(helper));
            // Not executable: not a helper.
            fs::set_permissions(dir.path().join(NAME), fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(locate(&dir.path().join("VidAI")), None);
        }

        /// The real helper, built by build.rs, on files without faces: a synthetic clip, a file
        /// that is not a video, a missing file and bad arguments.
        #[test]
        fn real_helper_handles_files_without_faces_and_bad_input() {
            let helper = path().expect("build.rs builds vidai-orient next to the test binaries");
            let observations = run(helper, &fixture("landscape.mp4"), 7).unwrap();
            assert_eq!(observations.protocol, PROTOCOL);
            assert_eq!(
                (observations.frame_width, observations.frame_height),
                (64, 36)
            );
            assert_eq!(observations.frames.len(), 7);
            assert!(observations.frames.iter().all(|f| f.faces.is_empty()));
            // The rotation flag is applied before looking.
            let rotated = run(helper, &fixture("rotated-90.mov"), 3).unwrap();
            assert_eq!((rotated.frame_width, rotated.frame_height), (36, 64));

            let dir = tempfile::tempdir().unwrap();
            let junk = dir.path().join("junk.mov");
            fs::write(&junk, b"definitely not a movie").unwrap();
            assert!(matches!(
                run(helper, &junk, 7),
                Err(PictureCheckError::Unreadable(_))
            ));
            assert!(matches!(
                run(helper, &dir.path().join("missing.mov"), 7),
                Err(PictureCheckError::Unreadable(_))
            ));
            assert!(matches!(
                run(helper, &junk, 0),
                Err(PictureCheckError::Failed(m)) if m.contains("code 2")
            ));
        }

        #[test]
        fn real_helper_honors_its_time_limit() {
            let helper = path().expect("build.rs builds vidai-orient next to the test binaries");
            // A FIFO nobody writes to: opening it for reading blocks until the time limit.
            let dir = tempfile::tempdir().unwrap();
            let fifo = dir.path().join("stuck.mov");
            let made = Command::new("mkfifo").arg(&fifo).status().unwrap();
            assert!(made.success());
            let started = Instant::now();
            let result = run_with_limits(
                Command::new(helper),
                &fifo,
                7,
                Duration::from_millis(500),
                Duration::from_secs(300),
            );
            // The helper's own limit ends it, long before it would be killed.
            assert!(started.elapsed() < Duration::from_secs(120), "{result:?}");
            assert!(result.is_err(), "{result:?}");
        }
    }
}

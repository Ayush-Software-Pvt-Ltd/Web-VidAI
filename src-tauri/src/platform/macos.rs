//! macOS implementations: process groups and tree termination, Terminal.app launching,
//! `caffeinate -i` sleep prevention and the login-shell environment capture.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crate::error::{AppError, AppResult};

/// Used when `$SHELL` is missing or unusable: the default shell of every current macOS.
const FALLBACK_SHELL: &str = "/bin/zsh";

/// Runs the user's shell as a login interactive shell that prints its environment between two
/// random markers, so whatever the startup files print (banners, prompts, warnings) is ignored.
/// Stdin is closed, so a startup file that asks a question (an update prompt, `compinit` about
/// folders owned by another user) gets no answer and goes on.
///
/// When the user's shell fails at once (an unusual shell that does not take these flags, or
/// startup files that end it), the capture is tried once more with the default shell of macOS,
/// `/bin/zsh`; a shell that is merely slow is not, so the wait stays bounded by `timeout`.
pub fn login_shell_env(timeout: Duration) -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| Path::new(s).is_absolute() && Path::new(s).is_file())
        .unwrap_or_else(|| FALLBACK_SHELL.to_owned());
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    match shell_env(&shell, &home, &[], timeout) {
        Ok(env) => Some(env),
        Err(CaptureError::Failed) if shell != FALLBACK_SHELL => {
            eprintln!("vidai: reading the environment with {FALLBACK_SHELL} instead");
            shell_env(FALLBACK_SHELL, &home, &[], timeout).ok()
        }
        Err(_) => None,
    }
}

/// Why a shell did not give its environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureError {
    /// It was still running when the time was up (and was ended).
    TimedOut,
    /// It could not start, or ended without printing the environment.
    Failed,
}

/// The flags that make `shell` read the user's startup files before it runs a command: login and
/// interactive. csh and tcsh take `-l` only as their one flag, and read `~/.cshrc` or
/// `~/.tcshrc` (where their users set `PATH`) with `-i` alone.
pub fn startup_flags(shell: &str) -> &'static [&'static str] {
    match Path::new(shell).file_name().and_then(|n| n.to_str()) {
        Some("csh" | "tcsh") => &["-i"],
        _ => &["-l", "-i"],
    }
}

/// The environment `shell` prints after reading its startup files, run in the folder `dir` with
/// the extra variables `vars` (tests use them for a home folder of their own).
pub fn shell_env(
    shell: &str,
    dir: &str,
    vars: &[(&str, &str)],
    timeout: Duration,
) -> Result<HashMap<String, String>, CaptureError> {
    let marker = format!("__VIDAI_ENV_{}__", uuid::Uuid::new_v4().simple());
    let script = format!("printf '%s' '{marker}'; /usr/bin/env -0; printf '%s' '{marker}'");
    let mut cmd = Command::new(shell);
    cmd.args(startup_flags(shell))
        .args(["-c", &script])
        .env(super::RESOLVING_ENV_VAR, "1")
        .envs(vars.iter().copied())
        .current_dir(dir);
    let output = match super::output_with_timeout(&mut cmd, timeout) {
        Ok(output) => output,
        Err(err) => {
            eprintln!("vidai: reading the login-shell environment from {shell} failed: {err}");
            return Err(if err.kind() == std::io::ErrorKind::TimedOut {
                CaptureError::TimedOut
            } else {
                CaptureError::Failed
            });
        }
    };
    parse_marked_env(&output.stdout, marker.as_bytes()).ok_or_else(|| {
        eprintln!(
            "vidai: the login shell {shell} did not print its environment (exit {:?})",
            output.status.code()
        );
        CaptureError::Failed
    })
}

/// Extracts the `env -0` output between the first two occurrences of `marker`.
pub fn parse_marked_env(stdout: &[u8], marker: &[u8]) -> Option<HashMap<String, String>> {
    let start = find(stdout, marker)? + marker.len();
    let len = find(&stdout[start..], marker)?;
    let block = &stdout[start..start + len];
    let env: HashMap<String, String> = block
        .split(|b| *b == 0)
        .filter_map(|entry| {
            let entry = String::from_utf8_lossy(entry);
            let (key, value) = entry.split_once('=')?;
            (!key.is_empty()).then(|| (key.to_owned(), value.to_owned()))
        })
        .collect();
    (!env.is_empty()).then_some(env)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Writes `body` into a self-deleting `.command` file in `scratch_dir` and opens it with
/// Terminal.app through LaunchServices (`open -a Terminal`), which needs no Automation
/// permission (unlike AppleScript `do script`).
pub fn open_terminal_script(scratch_dir: &Path, body: &str) -> AppResult<()> {
    fs::create_dir_all(scratch_dir)
        .map_err(|e| AppError::io_at("Could not create", scratch_dir, e))?;
    remove_stale_scripts(scratch_dir);
    let path = scratch_dir.join(format!("vidai-{}.command", uuid::Uuid::new_v4().simple()));
    let script = format!("#!/bin/bash\nrm -f -- \"$0\"\nclear\n{body}\n");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&path)
        .map_err(|e| AppError::io_at("Could not create", &path, e))?;
    file.write_all(script.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| AppError::io_at("Could not write", &path, e))?;
    drop(file);
    let output = super::output_with_timeout(
        Command::new("/usr/bin/open")
            .args(["-a", "Terminal"])
            .arg(&path),
        Duration::from_secs(15),
    )
    .map_err(|e| AppError::io(format!("Could not open Terminal: {e}")))?;
    if !output.status.success() {
        let _ = fs::remove_file(&path);
        return Err(AppError::io(format!(
            "Could not open Terminal: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(())
}

/// Removes scripts older than an hour that were never run (for example Terminal was closed
/// before it started them).
fn remove_stale_scripts(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_ours = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("vidai-") && n.ends_with(".command"));
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(3600));
        if is_ours && old {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_env_between_markers_despite_noise() {
        let mut out = b"Welcome!\nlast login...\x1b[1m%\x1b[0m MARK".to_vec();
        out.extend_from_slice(b"PATH=/a:/b\0EMPTY=\0MULTI=line1\nline2\0=bad\0noequals\0");
        out.extend_from_slice(b"MARKtrailing prompt MARK");
        let env = parse_marked_env(&out, b"MARK").unwrap();
        assert_eq!(env["PATH"], "/a:/b");
        assert_eq!(env["EMPTY"], "");
        assert_eq!(env["MULTI"], "line1\nline2");
        assert_eq!(env.len(), 3);
    }

    #[test]
    fn missing_markers_mean_no_env() {
        assert!(parse_marked_env(b"no markers here", b"MARK").is_none());
        assert!(parse_marked_env(b"MARK only one", b"MARK").is_none());
        assert!(parse_marked_env(b"MARKMARK", b"MARK").is_none());
    }

    #[test]
    fn startup_flags_per_shell() {
        assert_eq!(startup_flags("/bin/zsh"), ["-l", "-i"]);
        assert_eq!(startup_flags("/opt/homebrew/bin/fish"), ["-l", "-i"]);
        assert_eq!(startup_flags("/usr/local/bin/bash"), ["-l", "-i"]);
        assert_eq!(startup_flags("/bin/tcsh"), ["-i"]);
        assert_eq!(startup_flags("/bin/csh"), ["-i"]);
    }

    const TIMEOUT: Duration = Duration::from_secs(30);

    /// A home folder of the test's own with these startup files.
    fn home_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let home = tempfile::TempDir::new().unwrap();
        for (name, body) in files {
            fs::write(home.path().join(name), body).unwrap();
        }
        home
    }

    fn path_of(env: &HashMap<String, String>) -> Vec<&str> {
        env["PATH"].split(':').collect()
    }

    /// zsh, the default shell: `~/.zprofile` (login: Homebrew's `brew shellenv`) and `~/.zshrc`
    /// (interactive: the OpenCode installer, nvm) are both read; banners, a question that waits
    /// for an answer and colour codes do not get in the way.
    #[test]
    fn zsh_reads_zprofile_and_zshrc() {
        let home = home_with(&[
            (
                ".zprofile",
                "echo 'Last login: today'\nexport PATH=\"/vidai-test/usr/local/bin:$PATH\"\n",
            ),
            (
                ".zshrc",
                "echo '\\e[1mWelcome\\e[0m'\nexport PATH=\"$HOME/.opencode/bin:$PATH\"\nread 'REPLY?Update now? [y/N] '\nexport VIDAI_TEST_ANSWER=\"[$REPLY]\"\n",
            ),
        ]);
        let dir = home.path().to_str().unwrap();
        // ZDOTDIR too, in case the test runs with one set.
        let env = shell_env("/bin/zsh", dir, &[("HOME", dir), ("ZDOTDIR", dir)], TIMEOUT).unwrap();
        let path = path_of(&env);
        let opencode = format!("{dir}/.opencode/bin");
        assert_eq!(path[0], opencode, "{path:?}");
        assert!(path.contains(&"/vidai-test/usr/local/bin"), "{path:?}");
        assert!(path.contains(&"/usr/bin"), "{path:?}");
        // The question read the closed stdin: no answer, and the startup went on.
        assert_eq!(env["VIDAI_TEST_ANSWER"], "[]");
        assert_eq!(env[crate::platform::RESOLVING_ENV_VAR], "1");
    }

    /// bash reads `~/.bash_profile` as a login shell.
    #[test]
    fn bash_reads_bash_profile() {
        let home = home_with(&[(
            ".bash_profile",
            "echo banner\nexport PATH=\"/vidai-test/bash/bin:$PATH\"\n",
        )]);
        let dir = home.path().to_str().unwrap();
        let env = shell_env("/bin/bash", dir, &[("HOME", dir)], TIMEOUT).unwrap();
        assert_eq!(path_of(&env)[0], "/vidai-test/bash/bin");
    }

    /// tcsh refuses `-l` with other flags; with `-i` it reads `~/.tcshrc`.
    #[test]
    fn tcsh_reads_tcshrc() {
        let home = home_with(&[(
            ".tcshrc",
            "echo banner\nsetenv PATH /vidai-test/tcsh/bin:$PATH\n",
        )]);
        let dir = home.path().to_str().unwrap();
        let env = shell_env("/bin/tcsh", dir, &[("HOME", dir)], TIMEOUT).unwrap();
        assert_eq!(path_of(&env)[0], "/vidai-test/tcsh/bin");
    }

    /// A slow startup file is ended at the time limit; a shell that fails says so at once.
    #[test]
    fn slow_and_failing_shells() {
        let home = home_with(&[(".bash_profile", "sleep 600\n")]);
        let dir = home.path().to_str().unwrap();
        let started = std::time::Instant::now();
        assert_eq!(
            shell_env(
                "/bin/bash",
                dir,
                &[("HOME", dir)],
                Duration::from_millis(500)
            ),
            Err(CaptureError::TimedOut)
        );
        assert!(started.elapsed() < Duration::from_secs(60));
        let home = home_with(&[(".bash_profile", "exit 3\n")]);
        let dir = home.path().to_str().unwrap();
        assert_eq!(
            shell_env("/bin/bash", dir, &[("HOME", dir)], TIMEOUT),
            Err(CaptureError::Failed)
        );
        assert_eq!(
            shell_env("/nonexistent/shell", dir, &[], TIMEOUT),
            Err(CaptureError::Failed)
        );
    }
}

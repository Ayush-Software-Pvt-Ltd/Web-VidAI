//! Login-shell environment capture.
//!
//! A GUI app does not inherit the shell `PATH`. At startup the user's shell is run as a login
//! interactive shell that prints its environment (with a timeout); the result is kept for the
//! life of the app and used for every child process (`claude`, `ffprobe`, `caffeinate`, ...), so
//! tools resolve exactly as in the user's terminal. OS-specific parts live in `platform`.
//!
//! Windows has no login shell: a GUI app already has the user's environment, and `platform`
//! only rebuilds `PATH` from the registry so it is as fresh as in a new terminal. `PATH` is then
//! `;`-separated, always spelled `PATH` in the map, and the home folder is `USERPROFILE`
//! (no `HOME` is added, which would change how Git Bash and Claude Code pick their home).
//!
//! [`warm_up`] starts the capture on a background thread at startup. [`child_env`] returns the
//! cached result; a caller that comes before the capture has finished waits for it (at most
//! [`CAPTURE_TIMEOUT`]), so nothing ever runs with a half-known `PATH`. When the capture fails,
//! the app's own environment is used with the well-known tool folders added to `PATH`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use crate::platform;

/// How long the login shell may take to start and print its environment.
pub const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

/// Homebrew's `bin` folders, this Mac's own first: Homebrew lives in `/opt/homebrew` on Apple
/// Silicon and in `/usr/local` on an Intel Mac. The other one only exists on a Mac that was set
/// up from one of the other kind (Migration Assistant), and its programs are built for the other
/// processor, so it comes second (and `platform::macho` skips programs that cannot run here).
pub fn homebrew_bins(apple_silicon: bool) -> [&'static str; 2] {
    if apple_silicon {
        ["/opt/homebrew/bin", "/usr/local/bin"]
    } else {
        ["/usr/local/bin", "/opt/homebrew/bin"]
    }
}

/// Folders added to the end of `PATH` when missing, so tools installed in the usual places are
/// found even when the user's startup files do not add them (or the capture failed): the native
/// installers' `~/.local/bin`, Homebrew ([`homebrew_bins`]), MacPorts and the system folders.
/// `~` is the home folder.
#[cfg(not(windows))]
pub fn well_known_dirs(apple_silicon: bool) -> Vec<&'static str> {
    let [homebrew, other_homebrew] = homebrew_bins(apple_silicon);
    vec![
        "~/.local/bin",
        homebrew,
        other_homebrew,
        "/opt/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
}

/// Folders added to the end of `PATH` when missing on Windows: where Claude Code's native
/// installer puts `claude.exe`. `~` is the user's profile folder.
#[cfg(windows)]
pub fn well_known_dirs(_apple_silicon: bool) -> Vec<&'static str> {
    vec![r"~/.local\bin"]
}

/// The separator of `PATH`.
const PATH_SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

/// The variable that holds the home folder.
const HOME_VAR: &str = if cfg!(windows) { "USERPROFILE" } else { "HOME" };

/// Variables that describe the capture shell itself, not the user's environment.
const SHELL_ONLY_VARS: &[&str] = &["_", "SHLVL", "PWD", "OLDPWD", platform::RESOLVING_ENV_VAR];

static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

/// The environment every child process gets: the captured login-shell environment, or this
/// process's own environment (with the well-known tool folders on `PATH`) when the capture did
/// not succeed. Blocks until the one-time capture has finished.
pub fn child_env() -> HashMap<String, String> {
    ENV.get_or_init(capture).clone()
}

/// Starts the one-time capture on a background thread, so the first real use does not wait.
pub fn warm_up() {
    std::thread::Builder::new()
        .name("vidai-login-env".into())
        .spawn(|| {
            ENV.get_or_init(capture);
        })
        .ok();
}

fn capture() -> HashMap<String, String> {
    let own: HashMap<String, String> = std::env::vars().collect();
    match platform::login_shell_env(CAPTURE_TIMEOUT) {
        Some(shell) if shell.contains_key("PATH") => finish(shell, &own),
        _ => finish(own.clone(), &own),
    }
}

/// The user's home folder in `env` (`HOME`; `USERPROFILE` on Windows).
pub fn home(env: &HashMap<String, String>) -> Option<&str> {
    env.get(HOME_VAR)
        .map(String::as_str)
        .filter(|h| !h.is_empty())
}

/// Cleans a captured environment: drops the capture shell's own variables, makes sure `HOME` is
/// set (not on Windows), and appends the well-known tool folders to `PATH`.
pub fn finish(
    mut env: HashMap<String, String>,
    own: &HashMap<String, String>,
) -> HashMap<String, String> {
    #[cfg(windows)]
    {
        env = platform::windows::normalize_path_key(env);
    }
    for var in SHELL_ONLY_VARS {
        env.remove(*var);
    }
    if !cfg!(windows)
        && !env.contains_key("HOME")
        && let Some(home) = own.get("HOME")
    {
        env.insert("HOME".into(), home.clone());
    }
    let home = home(&env).map(str::to_owned);
    let well_known = well_known_dirs(platform::machine::is_apple_silicon_mac());
    let path = with_dirs(
        env.get("PATH").map(String::as_str),
        home.as_deref(),
        &well_known,
    );
    env.insert("PATH".into(), path);
    env
}

/// `path` with every entry of `extra` (for example [`well_known_dirs`]) that is not on it yet
/// appended, in order.
pub fn with_dirs(path: Option<&str>, home: Option<&str>, extra: &[&str]) -> String {
    let mut dirs: Vec<String> = path
        .unwrap_or_default()
        .split(PATH_SEPARATOR)
        .filter(|d| !d.is_empty())
        .map(str::to_owned)
        .collect();
    for dir in extra {
        let Some(dir) = expand_home(dir, home) else {
            continue;
        };
        let dir = dir.to_string_lossy().into_owned();
        let known = if cfg!(windows) {
            dirs.iter()
                .any(|d| d.trim_end_matches('\\').eq_ignore_ascii_case(&dir))
        } else {
            dirs.contains(&dir)
        };
        if !known {
            dirs.push(dir);
        }
    }
    dirs.join(&PATH_SEPARATOR.to_string())
}

/// Expands a leading `~/` with `home`; `None` when it is needed but unknown.
pub fn expand_home(dir: &str, home: Option<&str>) -> Option<PathBuf> {
    match dir.strip_prefix("~/") {
        Some(rest) => home
            .filter(|h| !h.is_empty())
            .map(|h| PathBuf::from(h).join(rest)),
        None => Some(PathBuf::from(dir)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[cfg(not(windows))]
    #[test]
    fn appends_missing_well_known_dirs_once() {
        let apple_silicon = well_known_dirs(true);
        let path = with_dirs(
            Some("/opt/homebrew/bin:/x/bin::"),
            Some("/Users/me"),
            &apple_silicon,
        );
        assert_eq!(
            path,
            "/opt/homebrew/bin:/x/bin:/Users/me/.local/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        );
        let without_home = with_dirs(None, None, &apple_silicon);
        assert!(without_home.starts_with("/opt/homebrew/bin:/usr/local/bin:"));
        assert!(!without_home.contains(".local"));
    }

    /// An Intel Mac: Homebrew's `/usr/local/bin` comes before `/opt/homebrew/bin` (which only a
    /// Mac set up from an Apple Silicon Mac has), whatever the login shell put on `PATH`.
    #[cfg(not(windows))]
    #[test]
    fn intel_mac_puts_its_homebrew_first() {
        assert_eq!(
            homebrew_bins(false),
            ["/usr/local/bin", "/opt/homebrew/bin"]
        );
        assert_eq!(homebrew_bins(true), ["/opt/homebrew/bin", "/usr/local/bin"]);
        let intel = well_known_dirs(false);
        // The capture failed: launchd's own PATH.
        assert_eq!(
            with_dirs(
                Some("/usr/bin:/bin:/usr/sbin:/sbin"),
                Some("/Users/me"),
                &intel
            ),
            "/usr/bin:/bin:/usr/sbin:/sbin:/Users/me/.local/bin:/usr/local/bin:/opt/homebrew/bin:/opt/local/bin"
        );
        // The real PATH of a job on an Intel Mac (the official OpenCode installer's folder
        // first, macOS's path_helper folders): nothing is moved, the rest is appended.
        let captured = "/Users/me/.opencode/bin:/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin";
        assert_eq!(
            with_dirs(Some(captured), Some("/Users/me"), &intel),
            format!("{captured}:/Users/me/.local/bin:/opt/homebrew/bin:/opt/local/bin")
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn finish_drops_shell_variables_and_keeps_the_rest() {
        let captured = map(&[
            ("PATH", "/custom/bin"),
            ("SHLVL", "2"),
            ("_", "/usr/bin/env"),
            ("PWD", "/Users/me"),
            ("VIDAI_RESOLVING_ENVIRONMENT", "1"),
            ("LANG", "en_US.UTF-8"),
        ]);
        let env = finish(captured, &map(&[("HOME", "/Users/me")]));
        assert_eq!(env["HOME"], "/Users/me");
        assert_eq!(env["LANG"], "en_US.UTF-8");
        assert!(env["PATH"].starts_with("/custom/bin:/Users/me/.local/bin:"));
        for gone in ["SHLVL", "_", "PWD", "VIDAI_RESOLVING_ENVIRONMENT"] {
            assert!(!env.contains_key(gone), "{gone} should be removed");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_finish_normalizes_path_and_adds_no_home() {
        let own = map(&[
            ("Path", r"C:\Windows\system32;C:\Users\Ana\.local\bin\"),
            ("USERPROFILE", r"C:\Users\Ana"),
            ("SystemRoot", r"C:\Windows"),
        ]);
        let env = finish(own.clone(), &own);
        assert!(!env.contains_key("Path"));
        assert!(!env.contains_key("HOME"));
        assert_eq!(env["SystemRoot"], r"C:\Windows");
        assert_eq!(home(&env), Some(r"C:\Users\Ana"));
        // The native installer's folder is not repeated (letter case and backslash ignored).
        let env = finish(
            map(&[("PATH", r"C:\Windows"), ("USERPROFILE", r"C:\Users\Ana")]),
            &own,
        );
        assert_eq!(env["PATH"], r"C:\Windows;C:\Users\Ana\.local\bin");
        let again = with_dirs(
            Some(&env["PATH"].to_uppercase()),
            Some(r"C:\Users\Ana"),
            &well_known_dirs(false),
        );
        assert_eq!(again, env["PATH"].to_uppercase());
    }
}

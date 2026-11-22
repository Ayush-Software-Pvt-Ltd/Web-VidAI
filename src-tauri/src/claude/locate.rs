//! Finding the `claude` executable.
//!
//! Lookup order: `VIDAI_CLAUDE_BIN`, the login-shell `PATH` (see `env`), then the well-known
//! locations: on macOS `~/.local/bin`, `~/.claude/local` and Homebrew's `bin` folder, this Mac's
//! own first (`/opt/homebrew/bin` then `/usr/local/bin` on Apple Silicon, the other way round on
//! an Intel Mac, `env::homebrew_bins`); on Windows the native installer's
//! `%USERPROFILE%\.local\bin\claude.exe`, the WinGet links folder and the npm global folder
//! (SPEC section 11). On Windows `PATH` is searched with `PATHEXT`, as a terminal does. On a Mac
//! a program built only for the other processor is passed over (`platform::macho`). Also reports
//! the version (`claude --version`) for `SystemStatus`, and resolves the helper tools (`ffmpeg`,
//! `ffprobe`, `python3`, `node`) through the login-shell `PATH`.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::env;
use crate::platform;

/// Environment variable naming the executable to use instead of searching (tests, development).
pub const OVERRIDE_VAR: &str = "VIDAI_CLAUDE_BIN";

/// Folders searched after the login-shell `PATH`, in order: the native installer's, the old npm
/// local install's, then Homebrew's ([`env::homebrew_bins`]). `~` is the home folder.
#[cfg(not(windows))]
pub fn well_known_dirs(apple_silicon: bool) -> Vec<&'static str> {
    let [homebrew, other_homebrew] = env::homebrew_bins(apple_silicon);
    vec!["~/.local/bin", "~/.claude/local", homebrew, other_homebrew]
}

/// Files tried after `PATH` on Windows, in order. `~` is the user's profile folder
/// (`USERPROFILE`): the native installer, WinGet, then npm's global folder.
#[cfg(windows)]
pub const WELL_KNOWN_FILES: &[&str] = &[
    r"~/.local\bin\claude.exe",
    r"~/AppData\Local\Microsoft\WinGet\Links\claude.exe",
    r"~/AppData\Roaming\npm\claude.cmd",
];

/// How long `claude --version` may take.
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);

/// The `claude` executable to run, or `None` when Claude Code is not installed.
///
/// When `VIDAI_CLAUDE_BIN` is set, it is the only candidate: a wrong value means "not found"
/// rather than silently running a different Claude Code.
pub fn find() -> Option<PathBuf> {
    let env = env::child_env();
    find_in(
        std::env::var_os(OVERRIDE_VAR),
        env.get("PATH").map(String::as_str),
        &well_known(env::home(&env), platform::machine::is_apple_silicon_mac()),
    )
}

/// [`find`] with its inputs made explicit: the override, the `PATH` and the files tried after it
/// (for example [`well_known`]).
pub fn find_in(
    override_bin: Option<OsString>,
    path: Option<&str>,
    well_known: &[PathBuf],
) -> Option<PathBuf> {
    if let Some(bin) = override_bin.filter(|b| !b.is_empty()) {
        let bin = PathBuf::from(bin);
        return is_executable(&bin).then_some(bin);
    }
    which_in("claude", path).or_else(|| {
        well_known
            .iter()
            .find(|candidate| is_runnable(candidate))
            .cloned()
    })
}

/// The `claude` files tried after `PATH`, in order, for a Mac with or without Apple Silicon.
#[cfg(not(windows))]
pub fn well_known(home: Option<&str>, apple_silicon: bool) -> Vec<PathBuf> {
    in_dirs("claude", &well_known_dirs(apple_silicon), home)
}

/// The `claude` files tried after `PATH` on Windows, in order.
#[cfg(windows)]
pub fn well_known(home: Option<&str>, _apple_silicon: bool) -> Vec<PathBuf> {
    WELL_KNOWN_FILES
        .iter()
        .filter_map(|file| env::expand_home(file, home))
        .collect()
}

/// `name` in each of `dirs` (`~/` is `home`; a folder under an unknown home is left out).
pub fn in_dirs(name: &str, dirs: &[&str], home: Option<&str>) -> Vec<PathBuf> {
    dirs.iter()
        .filter_map(|dir| env::expand_home(dir, home))
        .map(|dir| dir.join(name))
        .collect()
}

/// The first executable called `name` on the `PATH` of `env`.
pub fn which(name: &str, env: &HashMap<String, String>) -> Option<PathBuf> {
    which_in(name, env.get("PATH").map(String::as_str))
}

/// The first executable called `name` in the folder list `path` (`:`-separated; on Windows
/// `;`-separated and searched with `PATHEXT`). On a Mac a program built only for the other
/// processor is passed over.
pub fn which_in(name: &str, path: Option<&str>) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let pathext = std::env::var("PATHEXT").ok();
        platform::windows::which_in(name, path, pathext.as_deref())
    }
    #[cfg(not(windows))]
    {
        path?
            .split(':')
            .filter(|dir| !dir.is_empty() && Path::new(dir).is_absolute())
            .map(|dir| Path::new(dir).join(name))
            .find(|candidate| is_runnable(candidate))
    }
}

/// Every executable called `name` in the folder list `path`, in order (what `which -a` lists).
pub fn which_all_in(name: &str, path: Option<&str>) -> Vec<PathBuf> {
    let separator = if cfg!(windows) { ';' } else { ':' };
    path.unwrap_or_default()
        .split(separator)
        .filter_map(|dir| which_in(name, Some(dir)))
        .collect()
}

/// A helper tool of `SystemStatus` on the `PATH` of `env`.
///
/// On Windows Python is usually `python.exe` (or the `py` launcher) rather than `python3.exe`,
/// and `%LOCALAPPDATA%\Microsoft\WindowsApps` holds placeholders that only open the Microsoft
/// Store: those count only when they really run.
pub fn which_tool(name: &str, env: &HashMap<String, String>) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let names: &[&str] = if name == "python3" {
            &["python3", "python", "py"]
        } else {
            &[name]
        };
        names
            .iter()
            .filter_map(|n| which(n, env))
            .find(|path| !is_store_alias(path) || runs(path, env))
    }
    #[cfg(not(windows))]
    {
        which(name, env)
    }
}

/// An App Execution Alias in `...\Microsoft\WindowsApps`.
#[cfg(windows)]
fn is_store_alias(path: &Path) -> bool {
    path.parent()
        .is_some_and(|dir| dir.ends_with(Path::new(r"Microsoft\WindowsApps")))
}

/// Whether `program --version` succeeds within a few seconds.
#[cfg(windows)]
fn runs(program: &Path, env: &HashMap<String, String>) -> bool {
    let mut cmd = std::process::Command::new(program);
    cmd.arg("--version").env_clear().envs(env);
    platform::output_with_timeout(&mut cmd, Duration::from_secs(5))
        .is_ok_and(|out| out.status.success())
}

/// [`is_executable`], and on a Mac not a program built only for the other processor
/// (`platform::macho`): what a lookup accepts.
pub fn is_runnable(path: &Path) -> bool {
    is_executable(path) && platform::macho::runs_here(path)
}

/// A regular file (after following symlinks) with an execute bit set. On Windows: a regular
/// file (what can run is decided by `platform::launch`).
pub fn is_executable(path: &Path) -> bool {
    let Ok(meta) = path.metadata() else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// The version `claude --version` reports, for example "2.1.319", or `None` when it fails.
pub fn version(bin: &Path, env: &HashMap<String, String>) -> Option<String> {
    let mut cmd = platform::launch::command(bin, env, ["--version"]).ok()?;
    cmd.env_clear().envs(env);
    let output = platform::output_with_timeout(&mut cmd, VERSION_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    parse_version(&String::from_utf8_lossy(&output.stdout))
}

/// The first thing in `stdout` that looks like a version number (an optional `v` prefix, then
/// digits with at least a `major.minor` part): "opencode v2.2.6" becomes "2.2.6",
/// "2.1.319 (Claude Code)" becomes "2.1.319". `None` when nothing looks like one. Newer CLIs
/// print their name in front (`opencode v2.2.6`), which the plain first line would keep whole.
pub fn parse_version(stdout: &str) -> Option<String> {
    parse_version_number(stdout)
}

/// [`parse_version`] with its inputs made explicit, for tests.
fn parse_version_number(stdout: &str) -> Option<String> {
    stdout
        .split_whitespace()
        .map(|token| token.trim_start_matches('v'))
        .find(|token| {
            let mut parts = token.split(['.', '-', '+']);
            let major_minor = (parts.next(), parts.next());
            matches!(major_minor, (Some(major), Some(minor)) if is_digits(major) && is_digits(minor))
        })
        .map(|token| token.chars().take(64).collect())
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// The file name of program `name` on this platform.
    fn exe(name: &str) -> String {
        if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_owned()
        }
    }

    /// A folder list in the format of `PATH`.
    fn path_of(dirs: &[&Path]) -> String {
        let sep = if cfg!(windows) { ";" } else { ":" };
        dirs.iter()
            .map(|d| d.display().to_string())
            .collect::<Vec<_>>()
            .join(sep)
    }

    fn executable(dir: &Path, name: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[test]
    fn override_wins_and_is_the_only_candidate() {
        let tmp = TempDir::new().unwrap();
        let on_path = executable(&tmp.path().join("bin"), &exe("claude"));
        let fake = executable(&tmp.path().join("fake"), "fake-claude");
        let path = path_of(&[&tmp.path().join("bin")]);
        assert_eq!(
            find_in(Some(fake.clone().into()), Some(&path), &[]),
            Some(fake)
        );
        // A wrong override is "not installed", never a fallback to another claude.
        let missing = tmp.path().join("nope");
        assert_eq!(find_in(Some(missing.into()), Some(&path), &[]), None);
        // An empty override is ignored.
        assert_eq!(
            find_in(Some(OsString::new()), Some(&path), &[]),
            Some(on_path)
        );
    }

    #[test]
    fn path_comes_before_well_known_locations() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().join("home");
        let in_home = executable(&home.join(".local").join("bin"), &exe("claude"));
        let first = executable(&tmp.path().join("a"), &exe("claude"));
        executable(&tmp.path().join("b"), &exe("claude"));
        let path = path_of(&[&tmp.path().join("a"), &tmp.path().join("b")]);
        let home = home.to_string_lossy().into_owned();
        let known = well_known(Some(&home), false);
        assert_eq!(find_in(None, Some(&path), &known), Some(first));
        // Not on PATH: the well-known locations are searched in order.
        let empty = path_of(&[&tmp.path().join("empty")]);
        assert_eq!(find_in(None, Some(&empty), &known), Some(in_home));
    }

    #[cfg(unix)]
    #[test]
    fn well_known_order_prefers_local_bin_over_claude_local() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let local = executable(&home.join(".claude/local"), "claude");
        let home_str = home.to_string_lossy().into_owned();
        for apple_silicon in [false, true] {
            let known = well_known(Some(&home_str), apple_silicon);
            assert_eq!(find_in(None, None, &known), Some(local.clone()));
        }
        let bin = executable(&home.join(".local/bin"), "claude");
        assert_eq!(
            find_in(None, None, &well_known(Some(&home_str), false)),
            Some(bin)
        );
    }

    /// The real well-known list: Homebrew's own prefix of the hardware first.
    #[cfg(unix)]
    #[test]
    fn well_known_homebrew_order_follows_the_hardware() {
        let intel = well_known(Some("/Users/me"), false);
        let apple = well_known(Some("/Users/me"), true);
        let strings = |list: &[PathBuf]| -> Vec<String> {
            list.iter().map(|p| p.display().to_string()).collect()
        };
        assert_eq!(
            strings(&intel),
            [
                "/Users/me/.local/bin/claude",
                "/Users/me/.claude/local/claude",
                "/usr/local/bin/claude",
                "/opt/homebrew/bin/claude",
            ]
        );
        assert_eq!(
            strings(&apple)[2..],
            ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]
        );
        // No home: only the absolute folders.
        assert_eq!(well_known(None, false).len(), 2);
    }

    /// An Intel Mac's layout in a temporary folder: a Homebrew prefix that is not
    /// `/opt/homebrew`, an empty `PATH` (the capture failed) and either prefix holding `claude`,
    /// in both orders.
    #[cfg(unix)]
    #[test]
    fn either_homebrew_prefix_in_either_order() {
        let tmp = TempDir::new().unwrap();
        let usr_local = tmp.path().join("usr/local/bin");
        let opt_homebrew = tmp.path().join("opt/homebrew/bin");
        let dirs = |first: &Path, second: &Path| -> Vec<String> {
            vec![first.display().to_string(), second.display().to_string()]
        };
        let lookup = |dirs: &[String]| {
            let dirs: Vec<&str> = dirs.iter().map(String::as_str).collect();
            find_in(None, Some(""), &in_dirs("claude", &dirs, None))
        };
        let intel = dirs(&usr_local, &opt_homebrew);
        let apple = dirs(&opt_homebrew, &usr_local);
        assert_eq!(lookup(&intel), None);
        let in_usr_local = executable(&usr_local, "claude");
        assert_eq!(lookup(&intel), Some(in_usr_local.clone()));
        assert_eq!(lookup(&apple), Some(in_usr_local.clone()));
        let in_opt = executable(&opt_homebrew, "claude");
        assert_eq!(lookup(&intel), Some(in_usr_local));
        assert_eq!(lookup(&apple), Some(in_opt.clone()));
        fs::remove_file(usr_local.join("claude")).unwrap();
        assert_eq!(lookup(&intel), Some(in_opt));
    }

    /// A program built only for the other processor (a folder copied from a Mac of the other
    /// kind) is passed over, on `PATH` and in the well-known folders, and the next one is used.
    #[cfg(target_os = "macos")]
    #[test]
    fn skips_a_program_for_the_other_processor() {
        let tmp = TempDir::new().unwrap();
        let apple_silicon = platform::machine::is_apple_silicon_mac();
        let rosetta = Path::new("/Library/Apple/usr/libexec/oah/libRosettaRuntime").exists();
        if apple_silicon && rosetta {
            // Every Mach-O program runs here; nothing to tell apart.
            return;
        }
        // CPU_TYPE_X86_64 or CPU_TYPE_ARM64, whichever this Mac cannot run.
        let other_cpu: u32 = if apple_silicon {
            0x0100_0007
        } else {
            0x0100_000C
        };
        let foreign_dir = tmp.path().join("foreign");
        fs::create_dir_all(&foreign_dir).unwrap();
        let foreign = foreign_dir.join("claude");
        let mut header = vec![0xCF, 0xFA, 0xED, 0xFE];
        header.extend_from_slice(&other_cpu.to_le_bytes());
        header.extend_from_slice(&[0; 24]);
        fs::write(&foreign, header).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&foreign, fs::Permissions::from_mode(0o755)).unwrap();
        let good = executable(&tmp.path().join("good"), "claude");
        let path = path_of(&[&foreign_dir, &tmp.path().join("good")]);
        assert_eq!(which_in("claude", Some(&path)), Some(good.clone()));
        assert_eq!(which_all_in("claude", Some(&path)), vec![good.clone()]);
        assert_eq!(
            find_in(None, Some(""), &[foreign.clone(), good.clone()]),
            Some(good)
        );
        // The override is taken as given.
        assert_eq!(
            find_in(Some(foreign.clone().into()), None, &[]),
            Some(foreign)
        );
    }

    #[cfg(unix)]
    #[test]
    fn which_all_lists_every_match_in_path_order() {
        let tmp = TempDir::new().unwrap();
        let a = executable(&tmp.path().join("a"), "opencode");
        let c = executable(&tmp.path().join("c"), "opencode");
        let path = path_of(&[
            &tmp.path().join("a"),
            &tmp.path().join("b"),
            &tmp.path().join("c"),
        ]);
        assert_eq!(which_all_in("opencode", Some(&path)), vec![a, c]);
        assert!(which_all_in("opencode", None).is_empty());
        assert!(which_all_in("opencode", Some("")).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn well_known_order_native_then_winget_then_npm() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let home_str = home.to_string_lossy().into_owned();
        let known = well_known(Some(&home_str), false);
        assert_eq!(find_in(None, None, &known), None);
        let npm = executable(&home.join(r"AppData\Roaming\npm"), "claude.cmd");
        assert_eq!(find_in(None, None, &known), Some(npm));
        let winget = executable(
            &home.join(r"AppData\Local\Microsoft\WinGet\Links"),
            "claude.exe",
        );
        assert_eq!(find_in(None, None, &known), Some(winget));
        let native = executable(&home.join(r".local\bin"), "claude.exe");
        assert_eq!(find_in(None, None, &known), Some(native));
    }

    #[cfg(unix)]
    #[test]
    fn skips_non_executables_and_directories() {
        let tmp = TempDir::new().unwrap();
        let a = tmp.path().join("a");
        fs::create_dir_all(a.join("claude")).unwrap(); // a directory called claude
        let b = tmp.path().join("b");
        fs::create_dir_all(&b).unwrap();
        fs::write(b.join("claude"), "not executable").unwrap();
        let c = executable(&tmp.path().join("c"), "claude");
        let path = format!(
            "{}:{}:relative/dir:{}",
            a.display(),
            b.display(),
            tmp.path().join("c").display()
        );
        assert_eq!(which_in("claude", Some(&path)), Some(c));
        assert_eq!(which_in("claude", None), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_lookup_uses_pathext_and_skips_directories() {
        let tmp = TempDir::new().unwrap();
        let a = tmp.path().join("a");
        fs::create_dir_all(a.join("claude.exe")).unwrap(); // a directory called claude.exe
        let b = tmp.path().join("b");
        fs::create_dir_all(&b).unwrap();
        fs::write(b.join("claude"), "no extension: not a program on PATH").unwrap();
        let c = executable(&tmp.path().join("c"), "claude.cmd");
        let path = format!(
            "{};{};relative\\dir;{}",
            a.display(),
            b.display(),
            c.parent().unwrap().display()
        );
        assert_eq!(which_in("claude", Some(&path)), Some(c));
        assert_eq!(which_in("claude", None), None);
    }

    #[test]
    fn helper_tools_are_found_on_path() {
        let tmp = TempDir::new().unwrap();
        let ffmpeg = executable(&tmp.path().join("bin"), &exe("ffmpeg"));
        let env = HashMap::from([("PATH".to_owned(), path_of(&[&tmp.path().join("bin")]))]);
        assert_eq!(which_tool("ffmpeg", &env), Some(ffmpeg));
        assert_eq!(which_tool("node", &env), None);
    }

    #[cfg(windows)]
    #[test]
    fn python3_also_matches_python_on_windows() {
        let tmp = TempDir::new().unwrap();
        let python = executable(&tmp.path().join("Python313"), "python.exe");
        let env = HashMap::from([("PATH".to_owned(), path_of(&[&tmp.path().join("Python313")]))]);
        assert_eq!(which_tool("python3", &env), Some(python));
        // A Microsoft Store placeholder that does not run is no Python.
        let store = tmp.path().join(r"Microsoft\WindowsApps");
        executable(&store, "python3.exe");
        let env = HashMap::from([("PATH".to_owned(), path_of(&[&store]))]);
        assert_eq!(which_tool("python3", &env), None);
    }

    #[test]
    fn parses_versions() {
        assert_eq!(
            parse_version("2.1.319 (Claude Code)\n").as_deref(),
            Some("2.1.319")
        );
        assert_eq!(parse_version("\n  3.0.0\n").as_deref(), Some("3.0.0"));
        assert_eq!(parse_version("opencode v2.2.6\n").as_deref(), Some("2.2.6"));
        assert_eq!(parse_version("v1.18.31\n").as_deref(), Some("1.18.31"));
        // No version number in there at all.
        assert_eq!(parse_version("Claude Code dev build"), None);
        assert_eq!(parse_version("  \n"), None);
        assert_eq!(parse_version("opencode"), None);
    }
}

//! Finding the OpenCode 2 program and telling whether VidAI can drive it.
//!
//! OpenCode 2 comes in several shapes on disk: the v2 install script
//! (`curl -fsSL https://opencode.ai/v2/install | bash`) writes its binary as
//! `~/.opencode/bin/opencode` (the same file the v1 installer writes, so installing one replaces
//! the other) plus an `opencode2` shim that runs the `opencode` next to it; npm's `@opencode/cli`
//! links both `opencode` and `opencode2` to its binary; Homebrew provides `opencode`.
//!
//! Candidates: `VIDAI_OPENCODE2_BIN` (tests, development; when set it is the only candidate),
//! then every `opencode2`, then every `opencode`, each on the login-shell `PATH` and then in the
//! folders the installers use (`well_known_dirs`). The first that reports a 2.x version
//! is the program: an `opencode2` usually, or an `opencode` that is 2.x. An `opencode2` shim left
//! behind after the v1 installer replaced the binary next to it reports 1.x and is passed over;
//! when nothing is 2.x such a shim is reported as found but not supported, with its version,
//! while a 1.x `opencode` alone means OpenCode 2 is not installed.
//!
//! On Windows the official installer is bash-only, so OpenCode 2 comes from WinGet
//! (`winget install --id Anomaly.OpenCode --exact`, which puts a link in
//! `%LOCALAPPDATA%\Microsoft\WinGet\Links`), an older manual install in
//! `%USERPROFILE%\.opencode\bin`, npm's global folder (`%APPDATA%\npm`, `.cmd` shims) or scoop
//! (`%USERPROFILE%\scoop\shims`). Each name is looked for with `PATHEXT` (always `.exe` and
//! `.cmd` too) on `PATH` and then in those folders ([`windows_dirs`]). A `.cmd` shim is never
//! run through `cmd.exe` by hand: `platform::launch` reads npm's shim and starts the program it
//! points to (an `.exe`, or `node <script>`), and runs any other batch file the way Rust does
//! (quoted for `cmd.exe`, refusing arguments it cannot pass safely). Every process, the version
//! check included, starts with `CREATE_NO_WINDOW` (`platform::process`).
//!
//! The version comes from `--version` (auto-update off), which 2.x prints as `opencode v2.2.6`.
//! VidAI drives the v2 API of OpenCode 2.x.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::claude::{env, locate as claude_locate};
use crate::model::OpencodeCli;
use crate::platform;

/// Environment variable naming the executable to use instead of searching (tests,
/// development).
pub const OVERRIDE_VAR: &str = "VIDAI_OPENCODE2_BIN";

/// The official installer command on a Mac (installs OpenCode 2 as `opencode`, plus an
/// `opencode2` shim, into `~/.opencode/bin`).
pub const INSTALL_COMMAND_MAC: &str = "curl -fsSL https://opencode.ai/v2/install | bash";

/// The way to install OpenCode 2 on Windows (the official installer is bash-only).
pub const INSTALL_COMMAND_WINDOWS: &str = "winget install --id Anomaly.OpenCode --exact";

/// The install command of this platform, the one the terminal window of `open_opencode2_install`
/// shows and runs.
pub const INSTALL_COMMAND: &str = if cfg!(windows) {
    INSTALL_COMMAND_WINDOWS
} else {
    INSTALL_COMMAND_MAC
};

/// The oldest major version VidAI drives as the OpenCode 2 program.
pub const MIN_MAJOR: u64 = 2;

/// Folders searched after the login-shell `PATH`, in order: the official installers' folder,
/// Homebrew's ([`env::homebrew_bins`]) and `~/.local/bin`. `~` is the home folder. Shared with
/// the OpenCode 2 program (`locate2`).
pub fn well_known_dirs(apple_silicon: bool) -> Vec<&'static str> {
    let [homebrew, other_homebrew] = env::homebrew_bins(apple_silicon);
    vec!["~/.opencode/bin", homebrew, other_homebrew, "~/.local/bin"]
}

/// How long `--version` may take. The first run of a newly installed or updated binary of
/// 100 MB and more can be slow: macOS checks it before it runs the first time, and an older
/// Intel Mac reads it from a slower disk. Measured: 0.1 to 0.7 s once checked, 3 s for the first
/// run of the Intel build under Rosetta.
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(45);

/// A program file and what its `--version` said (`None` when it did not answer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub path: PathBuf,
    pub version: Option<String>,
}

impl Found {
    /// The status Settings shows for this file, with `supported` deciding about its version.
    pub fn into_cli(self, supported: fn(&str) -> bool) -> OpencodeCli {
        OpencodeCli {
            found: true,
            path: Some(self.path.to_string_lossy().into_owned()),
            supported: self.version.as_deref().is_some_and(supported),
            version: self.version,
            install_command: INSTALL_COMMAND.to_owned(),
        }
    }
}

/// Where candidates are looked for: on a Mac (and other Unix systems) the `PATH` and a list of
/// folders where `~/` is the home folder; on Windows the `PATH` and absolute folders, with the
/// extensions of `PATHEXT`. Both are plain data, so the lookups are tested on every platform.
#[derive(Debug, Clone, Copy)]
pub enum Folders<'a> {
    Unix {
        path: Option<&'a str>,
        home: Option<&'a str>,
        dirs: &'a [&'a str],
    },
    Windows {
        path: Option<&'a str>,
        pathext: Option<&'a str>,
        dirs: &'a [PathBuf],
    },
}

/// Every runnable file called one of `names`, in this order: each name on the `PATH`, then in
/// the well-known folders. A file reached under two names or folders (a symlink, npm's
/// `opencode` and `opencode2`) is listed once, where it is first met.
pub fn candidates(names: &[&str], folders: Folders) -> Vec<PathBuf> {
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut found = Vec::new();
    for name in names {
        for candidate in candidates_named(name, folders) {
            let real = std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
            if !seen.contains(&real) {
                seen.push(real);
                found.push(candidate);
            }
        }
    }
    found
}

/// Every runnable file called `name`, `PATH` first.
fn candidates_named(name: &str, folders: Folders) -> Vec<PathBuf> {
    match folders {
        Folders::Unix { path, home, dirs } => {
            let on_path = claude_locate::which_all_in(name, path);
            let in_dirs = claude_locate::in_dirs(name, dirs, home)
                .into_iter()
                .filter(|candidate| claude_locate::is_runnable(candidate));
            on_path.into_iter().chain(in_dirs).collect()
        }
        Folders::Windows {
            path,
            pathext,
            dirs,
        } => {
            let extensions = windows_extensions(pathext);
            let on_path = path
                .unwrap_or_default()
                .split(';')
                .map(|dir| PathBuf::from(dir.trim().trim_matches('"')))
                .filter(|dir| dir.is_absolute());
            on_path
                .chain(dirs.iter().cloned())
                .filter_map(|dir| platform::windows::find_in_dir(&dir, name, &extensions))
                .collect()
        }
    }
}

/// The extensions a Windows lookup tries: those of `PATHEXT`, and `.exe` and `.cmd` (what
/// OpenCode 2 comes as) when it does not list them.
fn windows_extensions(pathext: Option<&str>) -> Vec<String> {
    let mut extensions = platform::windows::path_extensions(pathext);
    for needed in [".exe", ".cmd"] {
        if !extensions.iter().any(|e| e == needed) {
            extensions.push(needed.to_owned());
        }
    }
    extensions
}

/// The folders Windows installs of OpenCode 2 use, searched after `PATH`, in order: WinGet's
/// links (the official way), the older manual install, npm's global folder, scoop's shims and
/// `~\.local\bin`. `env` is the child environment (names ignore letter case); a missing
/// `LOCALAPPDATA` or `APPDATA` falls back to the usual place inside `USERPROFILE`.
pub fn windows_dirs(env: &HashMap<String, String>) -> Vec<PathBuf> {
    use platform::windows::get_var;
    let profile = get_var(env, "USERPROFILE").map(PathBuf::from);
    let under_profile = |parts: &[&str]| {
        profile
            .as_ref()
            .map(|p| parts.iter().fold(p.clone(), |dir, part| dir.join(part)))
    };
    let local = get_var(env, "LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| under_profile(&["AppData", "Local"]));
    let roaming = get_var(env, "APPDATA")
        .map(PathBuf::from)
        .or_else(|| under_profile(&["AppData", "Roaming"]));
    [
        local.map(|dir| dir.join("Microsoft").join("WinGet").join("Links")),
        under_profile(&[".opencode", "bin"]),
        roaming.map(|dir| dir.join("npm")),
        under_profile(&["scoop", "shims"]),
        under_profile(&[".local", "bin"]),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// The first of `candidates` whose version is `supported`; otherwise the first one, so its
/// version can say why it cannot be used. Versions are asked in order and only as far as needed.
pub fn first_supported(
    candidates: impl IntoIterator<Item = PathBuf>,
    version_of: &dyn Fn(&Path) -> Option<String>,
    supported: fn(&str) -> bool,
) -> Option<Found> {
    let mut first = None;
    for path in candidates {
        let found = Found {
            version: version_of(&path),
            path,
        };
        if found.version.as_deref().is_some_and(supported) {
            return Some(found);
        }
        first.get_or_insert(found);
    }
    first
}

/// The OpenCode 2 executable to run and its version, or `None` when it is not installed.
pub fn find() -> Option<Found> {
    let env = env::child_env();
    let path = env.get("PATH").map(String::as_str);
    let override_bin = std::env::var_os(OVERRIDE_VAR);
    let version_of = |bin: &Path| version(bin, &env);
    if cfg!(windows) {
        let dirs = windows_dirs(&env);
        let pathext = platform::windows::get_var(&env, "PATHEXT");
        find_in(
            override_bin,
            Folders::Windows {
                path,
                pathext,
                dirs: &dirs,
            },
            &version_of,
        )
    } else {
        find_in(
            override_bin,
            Folders::Unix {
                path,
                home: env::home(&env),
                dirs: &well_known_dirs(platform::machine::is_apple_silicon_mac()),
            },
            &version_of,
        )
    }
}

/// [`find`] with its inputs (the folders and the version check) made explicit.
fn find_in(
    override_bin: Option<OsString>,
    folders: Folders,
    version_of: &dyn Fn(&Path) -> Option<String>,
) -> Option<Found> {
    if let Some(bin) = override_bin.filter(|b| !b.is_empty()) {
        let bin = PathBuf::from(bin);
        return claude_locate::is_executable(&bin).then(|| Found {
            version: version_of(&bin),
            path: bin,
        });
    }
    let shims = candidates(&["opencode2"], folders);
    let all = candidates(&["opencode2", "opencode"], folders);
    let found = first_supported(all, version_of, supported)?;
    // Nothing is 2.x: only an `opencode2` counts as a (wrong) OpenCode 2, never a 1.x `opencode`.
    (found.version.as_deref().is_some_and(supported) || shims.contains(&found.path))
        .then_some(found)
}

/// The version `--version` prints, for example "1.18.31" (1.x) or "2.2.6" (2.x prints
/// "opencode v2.2.6"), or `None` when it fails. Auto-update is switched off for the call, so
/// checking never upgrades the program.
pub fn version(bin: &Path, env: &HashMap<String, String>) -> Option<String> {
    let mut env = env.clone();
    env.insert("OPENCODE_DISABLE_AUTOUPDATE".into(), "1".into());
    let mut cmd = platform::launch::command(bin, &env, ["--version"]).ok()?;
    cmd.env_clear().envs(&env);
    // No console window flashes up on Windows: `output_with_timeout` starts the process with
    // `CREATE_NO_WINDOW` in a job object of its own.
    let output = platform::output_with_timeout(&mut cmd, VERSION_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    claude_locate::parse_version(&String::from_utf8_lossy(&output.stdout))
}

/// Whether VidAI drives this version: OpenCode 2.x.
pub fn supported(version: &str) -> bool {
    let mut parts = version
        .trim()
        .trim_start_matches('v')
        .split(['.', '-', '+'])
        .map(|p| p.parse::<u64>().ok());
    let (Some(Some(major)), Some(Some(_minor))) = (parts.next(), parts.next()) else {
        return false;
    };
    major == MIN_MAJOR
}

/// The status Settings shows: found, where, which version, and whether VidAI drives it.
pub fn status() -> OpencodeCli {
    find().map_or_else(OpencodeCli::default, |found| found.into_cli(supported))
}

/// The executable when the program can run a job here, else the reason as `invalidInput`.
pub fn ready() -> crate::error::AppResult<PathBuf> {
    use crate::error::AppError;
    let cli = status();
    match (problem(&cli), cli.path) {
        (None, Some(path)) => Ok(PathBuf::from(path)),
        (Some(problem), _) => Err(AppError::invalid_input(problem)),
        (None, None) => Err(AppError::invalid_input(not_installed())),
    }
}

/// "OpenCode 2 is not installed on this Mac." (this PC on Windows).
fn not_installed() -> String {
    let computer = if cfg!(windows) { "PC" } else { "Mac" };
    format!("OpenCode 2 is not installed on this {computer}.")
}

/// One sentence about a program that is installed but cannot be used; `None` when usable.
pub fn problem(cli: &OpencodeCli) -> Option<String> {
    if !cli.found {
        return Some(not_installed());
    }
    if cli.supported {
        return None;
    }
    Some(match cli.version.as_deref() {
        Some(version) => {
            format!("OpenCode {version} is installed; VidAI needs OpenCode 2.0 or later.")
        }
        None => "OpenCode 2 is installed but did not say which version it is.".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// An executable script at `path` (its folders are created).
    #[cfg(unix)]
    pub(crate) fn executable(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// A version check that answers from the script body written by [`executable`] or [`file`]
    /// (`echo <version>`) without running anything; `None` for a missing file or another body.
    pub(crate) fn scripted_version(path: &Path) -> Option<String> {
        let text = std::fs::read_to_string(path).ok()?;
        let line = text.lines().find_map(|l| l.strip_prefix("echo "))?;
        claude_locate::parse_version(line.trim_matches('\''))
    }

    /// An Intel Mac's folders inside a temporary folder: a home, a `/usr/local/bin` and an
    /// `/opt/homebrew/bin` stand-in, and the well-known folder list made of them (Homebrew's own
    /// prefix first, as on an Intel Mac).
    #[cfg(unix)]
    pub(crate) struct Layout {
        _dir: tempfile::TempDir,
        pub root: PathBuf,
        pub home: PathBuf,
        pub usr_local: PathBuf,
        pub opt_homebrew: PathBuf,
    }

    #[cfg(unix)]
    impl Layout {
        pub(crate) fn new() -> Self {
            let dir = tempfile::TempDir::new().unwrap();
            let root = dir.path().canonicalize().unwrap();
            Self {
                home: root.join("Users/me"),
                usr_local: root.join("usr/local/bin"),
                opt_homebrew: root.join("opt/homebrew/bin"),
                root,
                _dir: dir,
            }
        }

        pub(crate) fn home(&self) -> Option<&str> {
            self.home.to_str()
        }

        /// The real well-known list with the two Homebrew prefixes moved into the layout.
        pub(crate) fn dirs(&self, apple_silicon: bool) -> Vec<String> {
            well_known_dirs(apple_silicon)
                .into_iter()
                .map(|dir| match dir {
                    "/usr/local/bin" => self.usr_local.display().to_string(),
                    "/opt/homebrew/bin" => self.opt_homebrew.display().to_string(),
                    other => other.to_owned(),
                })
                .collect()
        }

        /// A folder of the layout for `PATH` (`npm/bin` for npm's global folder and so on).
        pub(crate) fn folder(&self, relative: &str) -> PathBuf {
            self.root.join(relative)
        }
    }
    #[test]
    fn well_known_folders_follow_the_hardware() {
        assert_eq!(
            well_known_dirs(false),
            [
                "~/.opencode/bin",
                "/usr/local/bin",
                "/opt/homebrew/bin",
                "~/.local/bin"
            ]
        );
        assert_eq!(
            well_known_dirs(true),
            [
                "~/.opencode/bin",
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "~/.local/bin"
            ]
        );
    }

    /// A file reached twice (a symlink on `PATH` to the installer's file) is asked once.
    #[cfg(unix)]
    #[test]
    fn a_file_reached_twice_is_one_candidate() {
        let layout = Layout::new();
        let real = layout.home.join(".opencode/bin/opencode");
        executable(&real, "echo 2.2.6");
        let link_dir = layout.folder("links");
        fs::create_dir_all(&link_dir).unwrap();
        std::os::unix::fs::symlink(&real, link_dir.join("opencode")).unwrap();
        let dirs = layout.dirs(false);
        let dirs: Vec<&str> = dirs.iter().map(String::as_str).collect();
        let list = candidates(
            &["opencode"],
            Folders::Unix {
                path: link_dir.to_str(),
                home: layout.home(),
                dirs: &dirs,
            },
        );
        assert_eq!(list, vec![link_dir.join("opencode")]);
    }

    #[test]
    fn versions_vidai_drives() {
        for good in [
            "2.0.0",
            "2.2.6",
            "2.3.1",
            "v2.1.0",
            "2.10.0-beta.1",
            " 2.0.0\n",
        ] {
            assert!(supported(good), "{good}");
        }
        for bad in [
            "1.18.0", "1.18.31", "1.40.2", "3.0.0", "", "opencode", "2", "2.x",
        ] {
            assert!(!supported(bad), "{bad}");
        }
        let parsed = |stdout: &str| claude_locate::parse_version(stdout).unwrap();
        assert!(supported(&parsed("opencode v2.2.6\n")));
        assert!(!supported(&parsed("1.18.31\n")));
    }

    #[cfg(unix)]
    fn lookup(layout: &Layout, path: &str, apple_silicon: bool) -> Option<Found> {
        let dirs = layout.dirs(apple_silicon);
        let dirs: Vec<&str> = dirs.iter().map(String::as_str).collect();
        let folders = Folders::Unix {
            path: Some(path),
            home: layout.home(),
            dirs: &dirs,
        };
        find_in(None, folders, &scripted_version)
    }

    /// `find_in` with fake binaries on its own `PATH`: an `opencode2` wins, otherwise an
    /// `opencode` that reports 2.x counts (Homebrew, npm), and a 1.x `opencode` alone counts as
    /// no OpenCode 2.
    #[cfg(unix)]
    #[test]
    fn lookup_prefers_the_shim_then_a_2x_opencode() {
        let layout = Layout::new();
        let bin = layout.folder("bin");
        let path = bin.display().to_string();

        // Only `opencode` 2.3.0 (Homebrew): it is the OpenCode 2 program.
        executable(&bin.join("opencode"), "echo 2.3.0");
        assert_eq!(
            lookup(&layout, &path, false).map(|f| f.path),
            Some(bin.join("opencode"))
        );
        // Only `opencode` 1.18.31: not OpenCode 2.
        executable(&bin.join("opencode"), "echo 1.18.31");
        assert_eq!(lookup(&layout, &path, false), None);
        // Both: the `opencode2` shim wins.
        executable(&bin.join("opencode"), "echo 2.3.0");
        executable(&bin.join("opencode2"), "echo 2.3.0");
        assert_eq!(
            lookup(&layout, &path, false),
            Some(Found {
                path: bin.join("opencode2"),
                version: Some("2.3.0".into())
            })
        );
        // Neither: nothing found.
        fs::remove_file(bin.join("opencode")).unwrap();
        fs::remove_file(bin.join("opencode2")).unwrap();
        assert_eq!(lookup(&layout, &path, false), None);
    }

    /// Every combination an Intel Mac may have (the layouts above).
    #[cfg(unix)]
    #[test]
    fn intel_mac_combinations() {
        // Only v1 (installer): no OpenCode 2.
        let layout = Layout::new();
        let installer = layout.home.join(".opencode/bin");
        executable(&installer.join("opencode"), "echo 1.18.31");
        assert_eq!(lookup(&layout, "/usr/bin:/bin", false), None);

        // Only v2 through its installer: the shim (which runs the 2.x `opencode` next to it).
        executable(&installer.join("opencode"), "echo 'opencode v2.2.6'");
        executable(&installer.join("opencode2"), "echo 'opencode v2.2.6'");
        let found = lookup(&layout, "", false).unwrap();
        assert_eq!(found.path, installer.join("opencode2"));
        assert!(found.into_cli(supported).supported);

        // v2 through npm in a Node version manager's folder, found through PATH only: npm links
        // `opencode` and `opencode2` to one binary, which is asked once.
        let layout = Layout::new();
        let npm = layout.folder("Users/me/.nvm/versions/node/v22.11.0");
        let binary = npm.join("lib/node_modules/@opencode/cli/bin/opencode.exe");
        executable(&binary, "echo 'opencode v2.2.6'");
        fs::create_dir_all(npm.join("bin")).unwrap();
        for name in ["opencode", "opencode2"] {
            std::os::unix::fs::symlink(&binary, npm.join("bin").join(name)).unwrap();
        }
        let path = format!("/usr/bin:/bin:{}", npm.join("bin").display());
        let asked = std::cell::RefCell::new(Vec::new());
        let dirs = layout.dirs(false);
        let dirs: Vec<&str> = dirs.iter().map(String::as_str).collect();
        let folders = Folders::Unix {
            path: Some(&path),
            home: layout.home(),
            dirs: &dirs,
        };
        let found = find_in(None, folders, &|bin| {
            asked.borrow_mut().push(bin.to_path_buf());
            scripted_version(bin)
        })
        .unwrap();
        assert_eq!(found.path, npm.join("bin/opencode2"));
        assert_eq!(asked.borrow().len(), 1);
        assert_eq!(lookup(&layout, "/usr/bin:/bin", false), None);

        // A v1 `opencode` earlier on PATH and a v2 `opencode2` elsewhere: the `opencode2`.
        let layout = Layout::new();
        executable(&layout.usr_local.join("opencode"), "echo 1.19.5");
        let elsewhere = layout.folder("Users/me/.hermes/node/bin");
        executable(&elsewhere.join("opencode2"), "echo 'opencode v2.2.6'");
        let path = format!("{}:{}", layout.usr_local.display(), elsewhere.display());
        assert_eq!(
            lookup(&layout, &path, false).unwrap().path,
            elsewhere.join("opencode2")
        );

        // A stale shim: the v1 installer replaced ~/.opencode/bin/opencode with 1.x after the v2
        // installer had written the shim. A real 2.x elsewhere wins; without one, the shim is
        // reported with the version it runs.
        let layout = Layout::new();
        let installer = layout.home.join(".opencode/bin");
        executable(&installer.join("opencode"), "echo 1.18.31");
        executable(&installer.join("opencode2"), "echo 1.18.31");
        let brew = layout.usr_local.join("opencode");
        executable(&brew, "echo 'opencode v2.2.6'");
        assert_eq!(lookup(&layout, "", false).unwrap().path, brew);
        fs::remove_file(&brew).unwrap();
        let stale = lookup(&layout, "", false).unwrap();
        assert_eq!(stale.path, installer.join("opencode2"));
        assert_eq!(
            problem(&stale.into_cli(supported)).as_deref(),
            Some("OpenCode 1.18.31 is installed; VidAI needs OpenCode 2.0 or later.")
        );
    }

    /// A file with `body` at `path` (its folders are created), the stand-in of a Windows program
    /// for the lookups, which only ask whether the file exists and what its script says.
    fn file(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("{body}\r\n")).unwrap();
    }

    /// A Windows user's folders inside a temporary folder.
    struct Profile {
        _dir: tempfile::TempDir,
        home: PathBuf,
    }

    impl Profile {
        fn new() -> Self {
            let dir = tempfile::TempDir::new().unwrap();
            let home = dir.path().canonicalize().unwrap().join("Users").join("Ana");
            Self { _dir: dir, home }
        }

        fn env(&self) -> HashMap<String, String> {
            HashMap::from([(
                "UserProfile".to_owned(),
                self.home.to_string_lossy().into_owned(),
            )])
        }

        fn at(&self, parts: &[&str]) -> PathBuf {
            parts.iter().fold(self.home.clone(), |dir, p| dir.join(p))
        }

        fn winget(&self, name: &str) -> PathBuf {
            self.at(&["AppData", "Local", "Microsoft", "WinGet", "Links", name])
        }

        fn npm(&self, name: &str) -> PathBuf {
            self.at(&["AppData", "Roaming", "npm", name])
        }

        fn lookup(&self, path: &str) -> Option<Found> {
            let dirs = windows_dirs(&self.env());
            let folders = Folders::Windows {
                path: Some(path),
                pathext: Some(".COM;.EXE;.BAT;.CMD"),
                dirs: &dirs,
            };
            find_in(None, folders, &scripted_version)
        }
    }

    #[test]
    fn windows_folders_follow_the_installers() {
        let profile = Profile::new();
        let home = &profile.home;
        let expected = [
            home.join("AppData/Local/Microsoft/WinGet/Links"),
            home.join(".opencode/bin"),
            home.join("AppData/Roaming/npm"),
            home.join("scoop/shims"),
            home.join(".local/bin"),
        ];
        // Only USERPROFILE is known (names ignore letter case): the usual places inside it.
        assert_eq!(windows_dirs(&profile.env()), expected);
        // A moved AppData wins.
        let mut moved = profile.env();
        moved.insert("LOCALAPPDATA".into(), "/Data/Local".into());
        moved.insert("appdata".into(), "/Data/Roaming".into());
        let dirs = windows_dirs(&moved);
        assert_eq!(dirs[0], Path::new("/Data/Local/Microsoft/WinGet/Links"));
        assert_eq!(dirs[2], Path::new("/Data/Roaming/npm"));
        // Nothing is known: nothing is searched.
        assert!(windows_dirs(&HashMap::new()).is_empty());
    }

    #[test]
    fn install_commands() {
        assert_eq!(
            INSTALL_COMMAND_MAC,
            "curl -fsSL https://opencode.ai/v2/install | bash"
        );
        assert_eq!(
            INSTALL_COMMAND_WINDOWS,
            "winget install --id Anomaly.OpenCode --exact"
        );
        assert_eq!(
            INSTALL_COMMAND,
            if cfg!(windows) {
                INSTALL_COMMAND_WINDOWS
            } else {
                INSTALL_COMMAND_MAC
            }
        );
    }

    /// WinGet's link, npm's `.cmd` shims, an older manual install and scoop each make OpenCode 2
    /// found, with `.exe` and `.cmd` tried through `PATHEXT`.
    #[test]
    fn windows_finds_each_installer() {
        let profile = Profile::new();
        assert_eq!(profile.lookup(""), None);

        let winget = profile.winget("opencode.exe");
        file(&winget, "echo opencode v2.2.6");
        assert_eq!(profile.lookup("").unwrap().path, winget);
        fs::remove_file(&winget).unwrap();

        let manual = profile.at(&[".opencode", "bin", "opencode.exe"]);
        file(&manual, "echo opencode v2.2.6");
        assert_eq!(profile.lookup("").unwrap().path, manual);
        fs::remove_file(&manual).unwrap();

        // npm links both names to one program: the `opencode2.cmd` shim is the answer, once.
        for name in ["opencode.cmd", "opencode2.cmd"] {
            file(&profile.npm(name), "echo opencode v2.2.6");
        }
        let found = profile.lookup("").unwrap();
        assert_eq!(found.path, profile.npm("opencode2.cmd"));
        assert_eq!(found.version.as_deref(), Some("2.2.6"));
        assert!(found.into_cli(supported).supported);
        fs::remove_dir_all(profile.at(&["AppData"])).unwrap();

        let scoop = profile.at(&["scoop", "shims", "opencode.exe"]);
        file(&scoop, "echo opencode v2.2.6");
        assert_eq!(profile.lookup("").unwrap().path, scoop);
        fs::remove_file(&scoop).unwrap();

        let local = profile.at(&[".local", "bin", "opencode2.exe"]);
        file(&local, "echo opencode v2.2.6");
        assert_eq!(profile.lookup("").unwrap().path, local);
    }

    /// `PATH` comes first (quoted, spaced and relative entries as Windows allows), `PATHEXT`
    /// decides between `.exe` and `.cmd` of one folder, and the extensionless file that npm
    /// writes for Git Bash is never a program.
    #[test]
    fn windows_path_comes_first() {
        let profile = Profile::new();
        let tools = profile.at(&["My Tools"]);
        let other = profile.at(&["other"]);
        file(&tools.join("opencode.cmd"), "echo 2.4.0");
        file(&tools.join("opencode.exe"), "echo 2.4.0");
        file(&tools.join("opencode2"), "echo 2.4.0");
        file(&other.join("opencode2.exe"), "echo 2.4.0");
        file(&profile.winget("opencode.exe"), "echo 2.2.6");
        let path = format!("relative;\"{}\";{}", tools.display(), other.display());
        // `opencode2` is asked first, so the first name's file wins before any `opencode`.
        assert_eq!(
            profile.lookup(&path).unwrap().path,
            other.join("opencode2.exe")
        );
        fs::remove_file(other.join("opencode2.exe")).unwrap();
        assert_eq!(
            profile.lookup(&path).unwrap().path,
            tools.join("opencode.exe")
        );
        // A PATHEXT without `.exe` and `.cmd` still finds them.
        let dirs = windows_dirs(&profile.env());
        let folders = Folders::Windows {
            path: Some(&path),
            pathext: Some(".BAT"),
            dirs: &dirs,
        };
        assert_eq!(
            candidates(&["opencode"], folders)[0],
            tools.join("opencode.exe")
        );
        assert_eq!(candidates(&["opencode"], folders).len(), 2);
    }

    /// A 1.x `opencode` on `PATH` does not hide a 2.x one in WinGet's folder, and a stale
    /// `opencode2.cmd` of 1.x is reported as not supported when nothing better exists.
    #[test]
    fn windows_skips_one_x() {
        let profile = Profile::new();
        let old = profile.at(&["old"]);
        file(&old.join("opencode.exe"), "echo 1.18.31");
        assert_eq!(profile.lookup(&old.display().to_string()), None);
        file(&profile.winget("opencode.exe"), "echo opencode v2.2.6");
        assert_eq!(
            profile.lookup(&old.display().to_string()).unwrap().path,
            profile.winget("opencode.exe")
        );
        fs::remove_dir_all(profile.at(&["AppData"])).unwrap();
        file(&profile.npm("opencode2.cmd"), "echo 1.18.31");
        let stale = profile.lookup("").unwrap();
        assert_eq!(stale.path, profile.npm("opencode2.cmd"));
        assert_eq!(
            problem(&stale.into_cli(supported)).as_deref(),
            Some("OpenCode 1.18.31 is installed; VidAI needs OpenCode 2.0 or later.")
        );
    }

    /// `VIDAI_OPENCODE2_BIN` is the only candidate, on Windows too.
    #[test]
    fn the_override_is_the_only_candidate() {
        let profile = Profile::new();
        file(&profile.winget("opencode.exe"), "echo opencode v2.2.6");
        let bin = profile.at(&["bin", "opencode2.exe"]);
        file(&bin, "echo 2.5.0");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let dirs = windows_dirs(&profile.env());
        let folders = Folders::Windows {
            path: None,
            pathext: None,
            dirs: &dirs,
        };
        let found = find_in(Some(bin.clone().into()), folders, &scripted_version).unwrap();
        assert_eq!(found.path, bin);
        let missing = profile.at(&["bin", "missing.exe"]);
        assert_eq!(
            find_in(Some(missing.into()), folders, &scripted_version),
            None
        );
    }

    #[test]
    fn the_status_carries_the_install_command_of_this_platform() {
        assert_eq!(OpencodeCli::default().install_command, INSTALL_COMMAND);
        let found = Found {
            path: "/bin/opencode".into(),
            version: Some("2.2.6".into()),
        };
        assert_eq!(found.into_cli(supported).install_command, INSTALL_COMMAND);
        assert!(!INSTALL_COMMAND.is_empty());
    }

    #[test]
    fn not_installed_names_the_computer() {
        let said = problem(&OpencodeCli::default()).unwrap();
        assert_eq!(
            said,
            if cfg!(windows) {
                "OpenCode 2 is not installed on this PC."
            } else {
                "OpenCode 2 is not installed on this Mac."
            }
        );
    }

    /// The real thing on Windows: a `.cmd` file is run (through `cmd.exe`, without a window)
    /// and its output is the version.
    #[cfg(windows)]
    #[test]
    fn runs_a_cmd_shim_on_windows() {
        let dir = tempfile::TempDir::new().unwrap();
        let shim = dir.path().join("opencode2.cmd");
        fs::write(&shim, "@echo off\r\necho opencode v2.2.6\r\n").unwrap();
        let env: HashMap<String, String> = std::env::vars().collect();
        assert_eq!(version(&shim, &env).as_deref(), Some("2.2.6"));
    }

    /// The real OpenCode 2 output format (`opencode v2.2.6`) parses to a supported version.
    #[cfg(unix)]
    #[test]
    fn reads_a_2x_version_line() {
        let dir = tempfile::TempDir::new().unwrap();
        let bin = dir.path().join("opencode");
        executable(&bin, "echo 'opencode v2.2.6'");
        let env =
            std::collections::HashMap::from([("PATH".to_owned(), "/usr/bin:/bin".to_owned())]);
        let version = version(&bin, &env).unwrap();
        assert_eq!(version, "2.2.6");
        assert!(supported(&version));
    }
}

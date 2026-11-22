//! Windows implementations: the user's current environment, terminal windows (PowerShell),
//! finding programs with `PATHEXT`, and finding Git Bash.
//!
//! Environment: a Windows GUI app already gets the user's environment from Explorer, so there is
//! no login shell to ask. But that copy can be stale (VidAI may have been started before Claude
//! Code, ffmpeg or Python were installed, or by an installer), so `PATH` is rebuilt from the
//! registry at startup, exactly as a newly opened terminal would see it: the machine `Path`, then
//! the user `Path`, then whatever else VidAI's own `PATH` has. Every other variable is VidAI's
//! own. Windows variable names ignore letter case; the result always spells it `PATH`.
//!
//! The pure helpers are compiled on every platform so their unit tests also run on macOS.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use crate::error::{AppError, AppResult};

/// The executable extensions used when `PATHEXT` is not set.
pub const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// Claude Code's own setting for where Git Bash is (see the Claude Code setup documentation).
pub const GIT_BASH_VAR: &str = "CLAUDE_CODE_GIT_BASH_PATH";

/// The user's environment with a fresh `PATH` (see the module documentation).
#[cfg(windows)]
pub fn user_env() -> Option<HashMap<String, String>> {
    let mut env = normalize_path_key(std::env::vars().collect());
    let read = |key: &windows_registry::Key, path: &str| {
        key.open(path)
            .and_then(|k| k.get_string("Path"))
            .unwrap_or_default()
    };
    let machine = read(
        windows_registry::LOCAL_MACHINE,
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
    );
    let user = read(windows_registry::CURRENT_USER, "Environment");
    let own = env.get("PATH").cloned().unwrap_or_default();
    let path = merge_path_lists(&[
        &expand_vars(&machine, &env),
        &expand_vars(&user, &env),
        &own,
    ]);
    env.insert("PATH".into(), path);
    Some(env)
}

/// Spells the `PATH` variable `PATH` (Windows often calls it `Path`), keeping one value.
pub fn normalize_path_key(mut env: HashMap<String, String>) -> HashMap<String, String> {
    let keys: Vec<String> = env
        .keys()
        .filter(|k| k.eq_ignore_ascii_case("PATH") && k.as_str() != "PATH")
        .cloned()
        .collect();
    for key in keys {
        if let Some(value) = env.remove(&key) {
            env.entry("PATH".into()).or_insert(value);
        }
    }
    env
}

/// Looks up a variable the way Windows does: ignoring letter case.
pub fn get_var<'a>(env: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    env.get(name)
        .or_else(|| {
            env.iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v)
        })
        .map(String::as_str)
        .filter(|v| !v.is_empty())
}

/// Expands `%NAME%` references with `env` (unknown names stay as they are), like
/// `ExpandEnvironmentStrings` does for the `REG_EXPAND_SZ` values of the registry.
pub fn expand_vars(text: &str, env: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match get_var(env, name) {
                    Some(value) => out.push_str(value),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Joins `;`-separated folder lists in order, without empty entries and without repeating a
/// folder (compared ignoring letter case and a trailing backslash).
pub fn merge_path_lists(lists: &[&str]) -> String {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<&str> = Vec::new();
    for entry in lists.iter().flat_map(|l| l.split(';')) {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let key = entry.trim_end_matches(['\\', '/']).to_lowercase();
        if !seen.contains(&key) {
            seen.push(key);
            out.push(entry);
        }
    }
    out.join(";")
}

/// The extensions of `PATHEXT` (lowercase, with the dot), or the Windows default.
pub fn path_extensions(pathext: Option<&str>) -> Vec<String> {
    pathext
        .filter(|p| !p.trim().is_empty())
        .unwrap_or(DEFAULT_PATHEXT)
        .split(';')
        .map(|e| e.trim().to_lowercase())
        .filter(|e| e.starts_with('.') && e.len() > 1)
        .collect()
}

/// The program `name` in `dir` as Windows would start it from a terminal: `name` itself when it
/// already has one of the `extensions`, else `name` plus the first extension that exists.
pub fn find_in_dir(dir: &Path, name: &str, extensions: &[String]) -> Option<PathBuf> {
    let lower = name.to_lowercase();
    if extensions.iter().any(|e| lower.ends_with(e.as_str())) {
        let candidate = dir.join(name);
        return candidate.is_file().then_some(candidate);
    }
    extensions
        .iter()
        .map(|ext| dir.join(format!("{name}{ext}")))
        .find(|candidate| candidate.is_file())
}

/// The first program called `name` on the `;`-separated folder list `path`.
pub fn which_in(name: &str, path: Option<&str>, pathext: Option<&str>) -> Option<PathBuf> {
    let extensions = path_extensions(pathext);
    path?
        .split(';')
        .map(|dir| dir.trim().trim_matches('"'))
        .filter(|dir| !dir.is_empty() && Path::new(dir).is_absolute())
        .find_map(|dir| find_in_dir(Path::new(dir), name, &extensions))
}

/// Git Bash (`bash.exe` of Git for Windows), which Claude Code uses for its Bash tool on Windows
/// and VidAI uses to run `#!` scripts. Never the `bash.exe` of WSL in `System32`.
pub fn git_bash(env: &HashMap<String, String>) -> Option<PathBuf> {
    git_bash_candidates(env)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

/// Where Git Bash may be, in the order Claude Code looks: its own setting, next to the `git` on
/// `PATH`, then the usual install folders.
pub fn git_bash_candidates(env: &HashMap<String, String>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(configured) = get_var(env, GIT_BASH_VAR) {
        out.push(PathBuf::from(configured));
    }
    let path = get_var(env, "PATH");
    let pathext = get_var(env, "PATHEXT");
    if let Some(git) = which_in("git", path, pathext) {
        // <root>\cmd\git.exe, <root>\bin\git.exe or <root>\mingw64\bin\git.exe.
        for root in git.ancestors().skip(2).take(2) {
            out.push(root.join("bin").join("bash.exe"));
        }
    }
    for (var, sub) in [
        ("ProgramFiles", r"Git\bin\bash.exe"),
        ("ProgramW6432", r"Git\bin\bash.exe"),
        ("ProgramFiles(x86)", r"Git\bin\bash.exe"),
        ("LOCALAPPDATA", r"Programs\Git\bin\bash.exe"),
        ("USERPROFILE", r"scoop\apps\git\current\bin\bash.exe"),
    ] {
        if let Some(base) = get_var(env, var) {
            out.push(Path::new(base).join(sub));
        }
    }
    out.retain(|p| !is_system_bash(p));
    let mut unique: Vec<PathBuf> = Vec::new();
    for p in out {
        if !unique
            .iter()
            .any(|u| u.as_os_str().eq_ignore_ascii_case(p.as_os_str()))
        {
            unique.push(p);
        }
    }
    unique
}

/// The WSL launcher (`C:\Windows\System32\bash.exe`), which is not Git Bash.
fn is_system_bash(path: &Path) -> bool {
    path.to_string_lossy()
        .to_lowercase()
        .replace('/', "\\")
        .ends_with(r"\system32\bash.exe")
}

// ---------------------------------------------------------------------------------------------
// Terminal windows
// ---------------------------------------------------------------------------------------------

/// `text` as a PowerShell single-quoted string.
pub fn ps_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// `script` encoded for `powershell.exe -EncodedCommand`: Base64 of its UTF-16LE bytes.
pub fn encode_powershell(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64(&bytes)
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[(n >> (18 - 6 * i)) as usize & 63]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Windows PowerShell, which every supported Windows has.
#[cfg(windows)]
pub fn powershell_exe() -> PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
}

/// Opens a new PowerShell window that runs the PowerShell script `body` and stays open.
///
/// The script is passed with `-EncodedCommand`, so no file is written, nothing needs quoting
/// and the execution policy (which only applies to script files) does not matter. The window is
/// opened through `cmd /c start`, which gives PowerShell a console window of its own.
/// `scratch_dir` is not needed on Windows.
#[cfg(windows)]
pub fn open_terminal_script(scratch_dir: &Path, body: &str) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let _ = scratch_dir;
    let cmd_exe = std::env::var_os("ComSpec")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| {
            let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
            PathBuf::from(root).join(r"System32\cmd.exe")
        });
    // Every part is either a fixed word, a quoted path without quotes in it, or Base64.
    let line = format!(
        "/d /c start \"VidAI\" \"{}\" -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -EncodedCommand {}",
        powershell_exe().display(),
        encode_powershell(body)
    );
    let status = Command::new(&cmd_exe)
        .raw_arg(line)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(super::process::CREATE_NO_WINDOW)
        .status()
        .map_err(|e| AppError::io(format!("Could not open PowerShell: {e}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::io(format!(
            "Could not open PowerShell (exit {:?}).",
            status.code()
        )))
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

    #[test]
    fn path_key_is_normalized() {
        let env = normalize_path_key(map(&[("Path", r"C:\a"), ("windir", r"C:\Windows")]));
        assert_eq!(env["PATH"], r"C:\a");
        assert!(!env.contains_key("Path"));
        assert_eq!(get_var(&env, "WINDIR"), Some(r"C:\Windows"));
        assert_eq!(get_var(&env, "missing"), None);
    }

    #[test]
    fn expands_variables_like_windows() {
        let env = map(&[
            ("SystemRoot", r"C:\Windows"),
            ("USERPROFILE", r"C:\Users\Ana"),
        ]);
        assert_eq!(
            expand_vars(
                r"%SystemRoot%\system32;%userprofile%\bin;%NOPE%\x;50%;%",
                &env
            ),
            r"C:\Windows\system32;C:\Users\Ana\bin;%NOPE%\x;50%;%"
        );
        assert_eq!(expand_vars("plain", &env), "plain");
        assert_eq!(expand_vars("%%", &env), "%%");
    }

    #[test]
    fn merges_path_lists_without_repeats() {
        assert_eq!(
            merge_path_lists(&[
                r"C:\Windows\system32;C:\Windows;",
                r"C:\Users\Ana\.local\bin; ;C:\WINDOWS\System32\",
                r"C:\Users\Ana\.local\bin\;D:\tools",
            ]),
            r"C:\Windows\system32;C:\Windows;C:\Users\Ana\.local\bin;D:\tools"
        );
        assert_eq!(merge_path_lists(&["", ";"]), "");
    }

    #[test]
    fn pathext_parsing() {
        assert_eq!(path_extensions(None), [".com", ".exe", ".bat", ".cmd"]);
        assert_eq!(path_extensions(Some(".EXE;;.Js;x")), [".exe", ".js"]);
        assert_eq!(path_extensions(Some(" ")), [".com", ".exe", ".bat", ".cmd"]);
    }

    #[test]
    fn finds_programs_with_pathext_in_path_order() {
        let tmp = tempfile::TempDir::new().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("claude.cmd"), "").unwrap();
        std::fs::write(b.join("claude.exe"), "").unwrap();
        std::fs::write(b.join("claude"), "").unwrap();
        std::fs::create_dir(b.join("node.exe")).unwrap(); // a folder is never a program
        let path = format!("{};relative;\"{}\"", a.display(), b.display());
        // PATH order first, then PATHEXT order within one folder.
        assert_eq!(
            which_in("claude", Some(&path), None),
            Some(a.join("claude.cmd"))
        );
        let b_only = b.display().to_string();
        assert_eq!(
            which_in("claude", Some(&b_only), None),
            Some(b.join("claude.exe"))
        );
        assert_eq!(
            which_in("claude.exe", Some(&path), None),
            Some(b.join("claude.exe"))
        );
        assert_eq!(which_in("node", Some(&path), None), None);
        assert_eq!(which_in("claude", None, None), None);
    }

    #[test]
    fn git_bash_candidates_follow_claude_codes_order() {
        let tmp = tempfile::TempDir::new().unwrap();
        let git_cmd = tmp.path().join("Git").join("cmd");
        std::fs::create_dir_all(&git_cmd).unwrap();
        std::fs::write(git_cmd.join("git.exe"), "").unwrap();
        let env = map(&[
            (GIT_BASH_VAR, r"D:\PortableGit\bin\bash.exe"),
            ("PATH", &git_cmd.display().to_string()),
            ("ProgramFiles", r"C:\Program Files"),
            ("ProgramW6432", r"C:\Program Files"),
            ("LOCALAPPDATA", r"C:\Users\Ana\AppData\Local"),
        ]);
        let candidates = git_bash_candidates(&env);
        assert_eq!(candidates[0], PathBuf::from(r"D:\PortableGit\bin\bash.exe"));
        assert_eq!(
            candidates[1],
            tmp.path().join("Git").join("bin").join("bash.exe")
        );
        assert!(candidates.contains(&Path::new(r"C:\Program Files").join(r"Git\bin\bash.exe")));
        assert_eq!(
            candidates
                .iter()
                .filter(|c| c.starts_with(r"C:\Program Files"))
                .count(),
            1,
            "{candidates:?}"
        );
        let wsl = map(&[(GIT_BASH_VAR, r"C:\Windows\System32\bash.exe")]);
        assert!(git_bash_candidates(&wsl).is_empty());
    }

    #[test]
    fn powershell_quoting_and_encoding() {
        assert_eq!(ps_quote(r"C:\it's\claude.exe"), r"'C:\it''s\claude.exe'");
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // "dir" as UTF-16LE, as PowerShell documents for -EncodedCommand.
        assert_eq!(encode_powershell("dir"), "ZABpAHIA");
    }
}

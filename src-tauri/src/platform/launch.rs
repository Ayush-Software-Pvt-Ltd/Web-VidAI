//! Turning the path of a program (for example the `claude` that `claude::locate` found) into a
//! command that starts it.
//!
//! macOS and other Unix systems: the program is started directly (the kernel reads `#!` lines).
//!
//! Windows can only start `.exe` files directly, and Claude Code may be installed in several
//! shapes (SPEC section 11):
//!
//! - `claude.exe` (native installer, WinGet, or the binary of the npm package): started directly.
//! - An npm `.cmd` shim (`%APPDATA%\npm\claude.cmd`): never run through `cmd.exe`, whose quoting
//!   rules make arguments such as the JSON of `--settings` unsafe. The shim is read and its target
//!   is started instead: the `.exe` it points to, or `node <script>` for a JavaScript target.
//! - A JavaScript file: `node <file>`.
//! - A script whose `#!` line names Python (`#!/usr/bin/env -S python3 -I`, the fake OpenCode 2 of
//!   the tests): run with the machine's Python, with the flags of the line, because Git Bash
//!   would look for a `python3` of its own.
//! - Any other script with a `#!` line (the fake `claude` of the tests, or a user's own wrapper): run
//!   with Git Bash. Git Bash is an MSYS2 program, which splits its command line by its own rules
//!   (and expands `{}`, `*`, `~` and `@file` in words that are not quoted), so every argument is
//!   passed fully quoted in the form MSYS2 reads back literally ([`msys_quote`]).
//! - Anything else is handed to Windows as is.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

/// A program and the arguments that go before the caller's own arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// The program is an MSYS2 program (Git Bash): arguments are quoted with [`msys_quote`].
    pub msys: bool,
}

impl Launch {
    fn direct(program: &Path) -> Self {
        Self {
            program: program.to_path_buf(),
            args: Vec::new(),
            msys: false,
        }
    }

    /// A command for this launch with the caller's `args` after the launch's own.
    pub fn command<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut cmd = Command::new(&self.program);
        let all = self
            .args
            .iter()
            .map(|a| a.as_os_str().to_owned())
            .chain(args.into_iter().map(|a| a.as_ref().to_owned()));
        if self.msys {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                for arg in all {
                    cmd.raw_arg(msys_quote(&arg.to_string_lossy()));
                }
            }
            #[cfg(not(windows))]
            cmd.args(all);
        } else {
            cmd.args(all);
        }
        cmd
    }
}

/// `arg` quoted for the command line of an MSYS2 program started from a Windows program:
/// inside double quotes, with `\` and `"` escaped by a backslash, every character is literal
/// (no brace, wildcard, `~` or `@file` expansion).
pub fn msys_quote(arg: &str) -> String {
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    for c in arg.chars() {
        if c == '\\' || c == '"' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// How to start `program` with the child environment `env` (used to find Git Bash and Node.js on
/// Windows). Errors when a needed interpreter is missing.
pub fn resolve(program: &Path, env: &HashMap<String, String>) -> io::Result<Launch> {
    #[cfg(windows)]
    {
        resolve_windows(
            program,
            &|| super::windows::git_bash(env),
            &|dir| node_for(dir, env),
            &|| crate::claude::locate::which_tool("python3", env),
        )
    }
    #[cfg(not(windows))]
    {
        let _ = env;
        Ok(Launch::direct(program))
    }
}

/// A command that starts `program` with `args` (see [`resolve`]).
pub fn command<I, S>(program: &Path, env: &HashMap<String, String>, args: I) -> io::Result<Command>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    resolve(program, env).map(|launch| launch.command(args))
}

/// `node.exe` next to an npm shim (`dir`), else the first one on `PATH`.
#[cfg(windows)]
fn node_for(dir: Option<&Path>, env: &HashMap<String, String>) -> Option<PathBuf> {
    use super::windows::{get_var, which_in};
    dir.map(|d| d.join("node.exe"))
        .filter(|p| p.is_file())
        .or_else(|| which_in("node", get_var(env, "PATH"), get_var(env, "PATHEXT")))
}

/// The Windows rules of the module documentation, with the interpreters found by `git_bash`,
/// `node` (which gets the folder of the shim, if any) and `python`. Compiled everywhere for its tests.
#[cfg(any(windows, test))]
fn resolve_windows(
    program: &Path,
    git_bash: &dyn Fn() -> Option<PathBuf>,
    node: &dyn Fn(Option<&Path>) -> Option<PathBuf>,
    python: &dyn Fn() -> Option<PathBuf>,
) -> io::Result<Launch> {
    let ext = extension(program);
    match ext.as_str() {
        "exe" | "com" => Ok(Launch::direct(program)),
        "cmd" | "bat" => {
            let text = std::fs::read(program).map(|b| String::from_utf8_lossy(&b).into_owned());
            let dir = program.parent().unwrap_or(Path::new(""));
            match text.ok().and_then(|t| npm_shim_target(&t, dir)) {
                Some(target) if matches!(extension(&target).as_str(), "exe" | "com") => {
                    Ok(Launch::direct(&target))
                }
                Some(target) if is_javascript(&target) => with_node(node(Some(dir)), &target),
                // Not an npm shim: Windows runs it through cmd.exe (Rust quotes the arguments
                // for batch files and refuses arguments it cannot pass safely).
                _ => Ok(Launch::direct(program)),
            }
        }
        _ if is_javascript(program) => with_node(node(None), program),
        _ if python_shebang(program).is_some() => {
            let flags = python_shebang(program).unwrap_or_default();
            match python() {
                Some(python) => Ok(Launch {
                    program: python,
                    args: flags
                        .into_iter()
                        .map(OsString::from)
                        .chain([program.as_os_str().to_owned()])
                        .collect(),
                    msys: false,
                }),
                None => Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("{} needs Python, which was not found", program.display()),
                )),
            }
        }
        _ if has_shebang(program) => match git_bash() {
            Some(bash) => Ok(Launch {
                program: bash,
                args: vec![posix_style(program).into()],
                msys: true,
            }),
            None => Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "{} is a shell script, which needs Git for Windows (Git Bash)",
                    program.display()
                ),
            )),
        },
        _ => Ok(Launch::direct(program)),
    }
}

#[cfg(any(windows, test))]
fn with_node(node: Option<PathBuf>, script: &Path) -> io::Result<Launch> {
    match node {
        Some(node) => Ok(Launch {
            program: node,
            args: vec![script.as_os_str().to_owned()],
            msys: false,
        }),
        None => Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{} needs Node.js, which was not found", script.display()),
        )),
    }
}

#[cfg(any(windows, test))]
fn extension(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

#[cfg(any(windows, test))]
fn is_javascript(path: &Path) -> bool {
    matches!(extension(path).as_str(), "js" | "mjs" | "cjs")
}

/// Whether the file starts with `#!`.
#[cfg(any(windows, test))]
fn has_shebang(path: &Path) -> bool {
    use std::io::Read;
    let mut start = [0u8; 2];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut start))
        .is_ok_and(|()| &start == b"#!")
}

/// The flags of a `#!` line that starts Python (`#!/usr/bin/env -S python3 -I` gives `["-I"]`,
/// `#!/usr/bin/python3` gives none), or `None` when the file has no such line.
#[cfg(any(windows, test))]
fn python_shebang(path: &Path) -> Option<Vec<String>> {
    use std::io::Read;
    let mut start = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(256)
        .read_to_end(&mut start)
        .ok()?;
    let text = String::from_utf8_lossy(&start);
    let line = text.lines().next()?.strip_prefix("#!")?;
    let mut words = line.split_whitespace().peekable();
    let name = |word: &str| word.rsplit('/').next().unwrap_or(word).to_owned();
    if words.peek().map(|w| name(w)).as_deref() == Some("env") {
        words.next();
        while words.next_if(|w| w.starts_with('-')).is_some() {}
    }
    let interpreter = words.next()?;
    name(interpreter)
        .starts_with("python")
        .then(|| words.map(str::to_owned).collect())
}

/// `C:\a\b.sh` as `C:/a/b.sh`, which Git Bash reads without any escaping question.
#[cfg(any(windows, test))]
fn posix_style(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// The program an npm `.cmd` shim starts: the last quoted `%dp0%\...` (or `%~dp0\...`) path in
/// it, resolved against the shim's folder `dir`.
///
/// npm writes shims like `"%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*`
/// (a Node.js script) or `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*`.
#[cfg(any(windows, test))]
pub fn npm_shim_target(text: &str, dir: &Path) -> Option<PathBuf> {
    let mut target = None;
    let mut rest = text;
    while let Some(start) = rest.find('"') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('"') else {
            break;
        };
        let quoted = &after[..end];
        let relative = quoted
            .strip_prefix("%dp0%\\")
            .or_else(|| quoted.strip_prefix("%~dp0\\"));
        if let Some(relative) = relative.filter(|r| !r.is_empty() && !r.contains('%')) {
            let mut path = dir.to_path_buf();
            for part in relative.split('\\').filter(|p| !p.is_empty()) {
                if part == ".." {
                    path.pop();
                } else if part != "." {
                    path.push(part);
                }
            }
            target = Some(path);
        }
        rest = &after[end + 1..];
    }
    // `node.exe` next to the shim is the interpreter, not the target.
    target.filter(|t| {
        !t.file_name()
            .is_some_and(|n| n.eq_ignore_ascii_case("node.exe"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const NODE_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n";
    const EXE_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n";

    #[test]
    fn reads_npm_shims() {
        let dir = Path::new("npm");
        assert_eq!(
            npm_shim_target(NODE_SHIM, dir),
            Some(dir.join("node_modules/@anthropic-ai/claude-code/cli.js"))
        );
        assert_eq!(
            npm_shim_target(EXE_SHIM, dir),
            Some(dir.join("node_modules/@anthropic-ai/claude-code/bin/claude.exe"))
        );
        assert_eq!(
            npm_shim_target("@\"%~dp0\\..\\lib\\tool.js\" %*", Path::new("a/bin")),
            Some(Path::new("a").join("lib/tool.js"))
        );
        assert_eq!(npm_shim_target("@echo off\r\nclaude.exe %*\r\n", dir), None);
        assert_eq!(npm_shim_target("\"%dp0%\\node.exe\" x", dir), None);
    }

    fn write(path: &Path, text: &str) -> PathBuf {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
        path.to_path_buf()
    }

    #[test]
    fn windows_rules() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        let bash = || Some(PathBuf::from("bash.exe"));
        let no_bash = || None;
        let node = |dir: Option<&Path>| {
            Some(dir.map_or(PathBuf::from("node.exe"), |d| d.join("node.exe")))
        };
        let no_node = |_: Option<&Path>| None;
        let no_python = || None;

        let exe = root.join("claude.exe");
        assert_eq!(
            resolve_windows(&exe, &no_bash, &no_node, &no_python).unwrap(),
            Launch::direct(&exe)
        );

        let npm = root.join("npm");
        let node_shim = write(&npm.join("claude.cmd"), NODE_SHIM);
        let launch = resolve_windows(&node_shim, &no_bash, &node, &no_python).unwrap();
        assert_eq!(launch.program, npm.join("node.exe"));
        assert_eq!(launch.args.len(), 1);
        assert_eq!(
            PathBuf::from(&launch.args[0]),
            npm.join("node_modules/@anthropic-ai/claude-code/cli.js")
        );
        assert!(resolve_windows(&node_shim, &no_bash, &no_node, &no_python).is_err());

        let exe_shim = write(&npm.join("other.CMD"), EXE_SHIM);
        assert_eq!(
            resolve_windows(&exe_shim, &no_bash, &no_node, &no_python).unwrap(),
            Launch::direct(&npm.join("node_modules/@anthropic-ai/claude-code/bin/claude.exe"))
        );

        let batch = write(&root.join("plain.bat"), "@echo hi\r\n");
        assert_eq!(
            resolve_windows(&batch, &no_bash, &no_node, &no_python).unwrap(),
            Launch::direct(&batch)
        );

        let script = write(
            &root.join("dir").join("fake-claude"),
            "#!/bin/sh\necho hi\n",
        );
        let launch = resolve_windows(&script, &bash, &no_node, &no_python).unwrap();
        assert_eq!(launch.program, PathBuf::from("bash.exe"));
        assert_eq!(launch.args, vec![OsString::from(posix_style(&script))]);
        assert!(launch.msys);
        assert!(!posix_style(&script).contains('\\'));
        let err = resolve_windows(&script, &no_bash, &no_node, &no_python).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert!(err.to_string().contains("Git for Windows"));

        // A script that starts Python runs with Python and the flags of its line, never Git Bash.
        let fake = write(
            &root.join("dir").join("fake-opencode2.py"),
            "#!/usr/bin/env -S python3 -I\nprint()\n",
        );
        let python = || Some(PathBuf::from("python.exe"));
        let launch = resolve_windows(&fake, &bash, &no_node, &python).unwrap();
        assert_eq!(launch.program, PathBuf::from("python.exe"));
        assert_eq!(
            launch.args,
            vec![OsString::from("-I"), fake.clone().into_os_string()]
        );
        assert!(!launch.msys);
        let err = resolve_windows(&fake, &bash, &no_node, &no_python).unwrap_err();
        assert!(err.to_string().contains("needs Python"));

        let js = root.join("cli.mjs");
        assert_eq!(
            resolve_windows(&js, &no_bash, &node, &no_python)
                .unwrap()
                .args,
            vec![js.clone().into_os_string()]
        );

        let other = write(&root.join("binary"), "MZ...");
        assert_eq!(
            resolve_windows(&other, &bash, &node, &no_python).unwrap(),
            Launch::direct(&other)
        );
    }

    #[test]
    fn python_shebangs() {
        let tmp = tempfile::TempDir::new().unwrap();
        let line = |text: &str| python_shebang(&write(&tmp.path().join("s"), text));
        assert_eq!(
            line("#!/usr/bin/env -S python3 -I\nx"),
            Some(vec!["-I".into()])
        );
        assert_eq!(line("#!/usr/bin/env python3\nx"), Some(vec![]));
        assert_eq!(line("#!/usr/bin/python3 -u\r\nx"), Some(vec!["-u".into()]));
        assert_eq!(line("#!/bin/sh\necho python3"), None);
        assert_eq!(line("#!/usr/bin/env bash\npython3"), None);
        assert_eq!(line("print()"), None);
        assert_eq!(python_shebang(&tmp.path().join("missing")), None);
    }

    #[test]
    fn msys_quoting_keeps_every_character_literal() {
        assert_eq!(
            msys_quote(r#"{"mcpServers":{}}"#),
            r#""{\"mcpServers\":{}}""#
        );
        assert_eq!(msys_quote(r"C:\a b\*.sh"), r#""C:\\a b\\*.sh""#);
        assert_eq!(msys_quote("@file ~ हिंदी"), "\"@file ~ हिंदी\"");
        assert_eq!(msys_quote(""), "\"\"");
    }

    /// The fake `claude` run through Git Bash gets exactly the arguments VidAI passes, also the
    /// JSON of the helper's `--settings` and words that MSYS2 would otherwise expand.
    #[cfg(windows)]
    #[test]
    fn git_bash_receives_arguments_unchanged() {
        let tmp = tempfile::TempDir::new().unwrap();
        let script = write(
            &tmp.path().join("echo-args"),
            "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done\n",
        );
        let env: HashMap<String, String> = std::env::vars().collect();
        let args = [
            r#"{"mcpServers":{}}"#,
            r#"{"disableAllHooks":true,"remoteControlAtStartup":false}"#,
            "*",
            "~",
            "@nothing",
            "a b",
            r"back\slash",
            "it's",
            "हिंदी",
        ];
        let out = command(&script, &env, args).unwrap().output().unwrap();
        assert!(out.status.success(), "{out:?}");
        let printed: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(printed, args);
    }

    #[cfg(unix)]
    #[test]
    fn unix_starts_programs_directly() {
        let env = HashMap::new();
        let program = Path::new("/usr/local/bin/claude");
        assert_eq!(resolve(program, &env).unwrap(), Launch::direct(program));
    }
}

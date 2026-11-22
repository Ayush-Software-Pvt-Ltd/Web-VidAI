//! macOS: the Keychain item of VidAI, reached only through Apple's `/usr/bin/security` tool.
//!
//! Why a child process and not the Security framework: macOS decides per program whether a
//! Keychain item may be read without a password dialog. An item created through the framework
//! names the program that created it, and VidAI is ad-hoc signed (there is no Apple Developer ID),
//! so every new build and each slice of the universal binary is a different program to the
//! Keychain: the item's access list does not name it, and macOS asks for the login password,
//! possibly twice for one read (the access list, then the partition list). `/usr/bin/security`
//! is signed by Apple with a stable identity (`identifier "com.apple.security" and anchor
//! apple`, partition `apple-tool:`). An item created by it names that identity, so whichever
//! VidAI build runs, the program that reads it is always the same one and macOS asks nothing.
//! This is how Claude Code keeps its own login in the Keychain.
//!
//! The price: any program of the same user can run `security find-generic-password` and read the
//! item without a dialog, as it can read a key file of the user (SPEC section 7a).
//!
//! The invocations:
//! - read: `security find-generic-password -s <service> -a <account> -w [<keychain>]`; the text
//!   arrives on stdout (printed in hex when it holds anything but printable ASCII, see
//!   [`decode_text`]); exit code 44 is "no such item".
//! - write: the command `add-generic-password -s <service> -a <account> -T /usr/bin/security
//!   -X <hex> [<keychain>]` is sent on the standard input of `security -i`, never in the argument
//!   list, where other programs could see it. The data is hex encoded so no quoting can break it.
//!   `-i` reports a failed command inconsistently, so every write is confirmed by reading the
//!   item back. An item is never updated (`-U`): `security` then asks macOS to change the
//!   access list of the item, which can show a dialog; the store writes the other of two slots
//!   instead (`secrets::Slot`).
//! - delete: `security delete-generic-password -s <service> -a <account> [<keychain>]`.
//!
//! Every call has a hard time limit and the child is killed when it is exceeded. Nothing the tool
//! prints is logged; errors name the exit code and, except for a write, the tool's own message.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::{
    BUNDLE_ACCOUNT_A, BUNDLE_ACCOUNT_B, BundleBackend, PREVIOUS_BUNDLE_ACCOUNT, RETIRED_KEY, Slot,
};
use crate::error::{AppError, AppResult};

/// Apple's tool, always by absolute path: a `PATH` lookup could run something else.
pub const SECURITY_TOOL: &str = "/usr/bin/security";

/// `security` exit code for `errSecItemNotFound`.
const EXIT_NOT_FOUND: i32 = 44;
/// `security -i` reads lines of at most 4095 characters and runs the rest of a longer line as
/// the next command, so a write line above this is refused instead of sent.
const MAX_LINE: usize = 4000;
/// What is kept of the output of the tool, in bytes: far above any key, below any harm.
const OUTPUT_LIMIT: u64 = 64 * 1024;
/// The longest stderr text that goes into an error message.
const MESSAGE_LIMIT: usize = 200;

/// How long a call may take.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// For the item VidAI created itself: macOS cannot ask a question about it, except to unlock
    /// a locked keychain.
    pub quick: Duration,
    /// For the items of earlier versions, which may show the password dialog once: the user needs
    /// time to answer it.
    pub patient: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            quick: Duration::from_secs(30),
            patient: Duration::from_secs(180),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Wait {
    Quick,
    Patient,
}

/// What a finished call left.
struct Done {
    code: i32,
    stdout: Vec<u8>,
    stderr: String,
}

/// The Keychain of the logged-in user through [`SECURITY_TOOL`].
pub struct SecurityCli {
    tool: PathBuf,
    service: String,
    /// `None`: the default keychain (the login keychain). The tests always name a scratch file.
    keychain: Option<PathBuf>,
    limits: Limits,
}

impl SecurityCli {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            tool: PathBuf::from(SECURITY_TOOL),
            service: service.into(),
            keychain: None,
            limits: Limits::default(),
        }
    }

    /// Another program in place of the tool, another keychain file, other limits: for tests.
    #[cfg(test)]
    pub fn for_test(
        tool: impl Into<PathBuf>,
        service: impl Into<String>,
        keychain: Option<PathBuf>,
        limits: Limits,
    ) -> Self {
        Self {
            tool: tool.into(),
            service: service.into(),
            keychain,
            limits,
        }
    }

    fn limit(&self, wait: Wait) -> Duration {
        match wait {
            Wait::Quick => self.limits.quick,
            Wait::Patient => self.limits.patient,
        }
    }

    /// `args` plus the keychain file, when one is named.
    fn command_args(&self, mut args: Vec<OsString>) -> Vec<OsString> {
        if let Some(keychain) = &self.keychain {
            args.push(keychain.clone().into_os_string());
        }
        args
    }

    fn run(&self, args: Vec<OsString>, stdin: Option<Vec<u8>>, limit: Duration) -> AppResult<Done> {
        let mut command = Command::new(&self.tool);
        command
            .args(args)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|err| AppError::internal(format!("Could not start {SECURITY_TOOL}: {err}")))?;

        // The data goes in from a thread so a tool that does not read cannot block this one.
        let writer = stdin.and_then(|data| {
            let mut pipe = child.stdin.take()?;
            Some(thread::spawn(move || {
                let _ = pipe.write_all(&data);
            }))
        });
        let stdout = child.stdout.take().map(read_limited);
        let stderr = child.stderr.take().map(read_limited);

        let deadline = Instant::now() + limit;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                Ok(None) => {
                    // The reader threads end with the pipes; nothing waits for them here.
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::internal(format!(
                        "Could not reach the macOS Keychain: {SECURITY_TOOL} did not answer within {} seconds.",
                        limit.as_secs().max(1)
                    )));
                }
                Err(err) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::internal(format!(
                        "Could not wait for {SECURITY_TOOL}: {err}"
                    )));
                }
            }
        };
        if let Some(writer) = writer {
            let _ = writer.join();
        }
        let stdout = stdout.and_then(|t| t.join().ok()).unwrap_or_default();
        let stderr = stderr.and_then(|t| t.join().ok()).unwrap_or_default();
        Ok(Done {
            // A tool ended by a signal has no code.
            code: status.code().unwrap_or(-1),
            stdout,
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }

    fn find(&self, account: &str, wait: Wait) -> AppResult<Option<Vec<u8>>> {
        let args = self.command_args(vec![
            "find-generic-password".into(),
            "-s".into(),
            self.service.clone().into(),
            "-a".into(),
            account.into(),
            "-w".into(),
        ]);
        let done = self.run(args, None, self.limit(wait))?;
        match done.code {
            0 => Ok(Some(done.stdout)),
            EXIT_NOT_FOUND => Ok(None),
            code => Err(tool_error("read from", code, Some(&done.stderr))),
        }
    }

    /// The item as its text: `None` when there is no such item.
    fn read_json(&self, account: &str, wait: Wait) -> AppResult<Option<String>> {
        self.find(account, wait)?
            .map(|out| {
                decode_text(&out).ok_or_else(|| {
                    AppError::internal("The saved API keys in the macOS Keychain are not readable.")
                })
            })
            .transpose()
    }

    fn delete(&self, account: &str, wait: Wait) -> AppResult<()> {
        let args = self.command_args(vec![
            "delete-generic-password".into(),
            "-s".into(),
            self.service.clone().into(),
            "-a".into(),
            account.into(),
        ]);
        match self.run(args, None, self.limit(wait))?.code {
            0 | EXIT_NOT_FOUND => Ok(()),
            code => Err(tool_error("remove from", code, None)),
        }
    }

    /// The command line of a write, one line for `security -i`.
    fn write_line(&self, account: &str, text: &str) -> AppResult<String> {
        let mut line = format!(
            "add-generic-password -s {} -a {} -T {} -X {}",
            quote(&self.service),
            quote(account),
            quote(SECURITY_TOOL),
            hex(text.as_bytes()),
        );
        if let Some(keychain) = &self.keychain {
            line.push(' ');
            line.push_str(&quote(&keychain.to_string_lossy()));
        }
        if line.len() > MAX_LINE {
            return Err(AppError::invalid_input(
                "The API keys are too long to save in the macOS Keychain.",
            ));
        }
        line.push('\n');
        Ok(line)
    }

    fn write(&self, account: &str, text: &str) -> AppResult<()> {
        let line = self.write_line(account, text)?;
        let args = vec![OsString::from("-i")];
        let done = self.run(args, Some(line.into_bytes()), self.limit(Wait::Quick))?;
        // Never the tool's text for a write: it could echo the command.
        if done.code != 0 {
            return Err(tool_error("save to", done.code, None));
        }
        // `-i` exits with 0 for a command that failed, so the item is read back.
        match self.read_json(account, Wait::Quick) {
            Ok(Some(back)) if back == text => Ok(()),
            Ok(_) => Err(AppError::internal(
                "Could not save to the macOS Keychain: the saved item did not read back.",
            )),
            Err(err) => Err(err),
        }
    }
}

fn account(slot: Slot) -> &'static str {
    match slot {
        Slot::A => BUNDLE_ACCOUNT_A,
        Slot::B => BUNDLE_ACCOUNT_B,
    }
}

impl BundleBackend for SecurityCli {
    fn read_slot(&self, slot: Slot) -> AppResult<Option<String>> {
        self.read_json(account(slot), Wait::Quick)
    }

    fn write_slot(&self, slot: Slot, text: &str) -> AppResult<()> {
        self.write(account(slot), text)
    }

    fn delete_slot(&self, slot: Slot) -> AppResult<()> {
        self.delete(account(slot), Wait::Quick)
    }

    fn read_previous_bundle(&self) -> AppResult<Option<String>> {
        self.read_json(PREVIOUS_BUNDLE_ACCOUNT, Wait::Patient)
    }

    fn delete_previous_items(&self) -> AppResult<()> {
        // Both are attempted; the first failure is the one reported.
        let bundle = self.delete(PREVIOUS_BUNDLE_ACCOUNT, Wait::Patient);
        let retired = self.delete(RETIRED_KEY, Wait::Patient);
        bundle.and(retired)
    }
}

/// Reads at most [`OUTPUT_LIMIT`] bytes of a pipe, and drains the rest.
fn read_limited(pipe: impl Read + Send + 'static) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut kept = Vec::new();
        let mut pipe = pipe;
        let _ = (&mut pipe).take(OUTPUT_LIMIT).read_to_end(&mut kept);
        let _ = std::io::copy(&mut pipe, &mut std::io::sink());
        kept
    })
}

/// An error that names the exit code and, when `message` is given, the tool's own first line
/// (for a read or a delete: such a line holds the Security framework's reason, never a secret).
fn tool_error(action: &str, code: i32, message: Option<&str>) -> AppError {
    let reason = message
        .and_then(|text| text.lines().find(|line| !line.trim().is_empty()))
        .map(|line| line.trim().chars().take(MESSAGE_LIMIT).collect::<String>());
    match reason {
        Some(reason) => AppError::internal(format!(
            "Could not {action} the macOS Keychain (security exit code {code}): {reason}"
        )),
        None => AppError::internal(format!(
            "Could not {action} the macOS Keychain (security exit code {code})."
        )),
    }
}

/// Lower-case hex of `bytes`.
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.is_empty() || !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    text.as_bytes()
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect()
}

/// A word of a `security -i` line in double quotes, with `\` and `"` escaped.
fn quote(word: &str) -> String {
    let mut out = String::with_capacity(word.len() + 2);
    out.push('"');
    for c in word.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// The text of an item from what `find-generic-password -w` printed. The tool prints the data as
/// is when it is printable ASCII and in hex otherwise. VidAI's items are JSON objects, so text
/// that starts with `{` is the data, and anything else must be the hex of such text.
fn decode_text(stdout: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(stdout).ok()?;
    let text = text.strip_suffix('\n').unwrap_or(text);
    if text.starts_with('{') {
        return Some(text.to_owned());
    }
    let decoded = String::from_utf8(unhex(text)?).ok()?;
    decoded.starts_with('{').then_some(decoded)
}

#[cfg(test)]
mod tests;

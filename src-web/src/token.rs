//! The access token (SPEC section 12, Server): 32 random bytes as hex in `<data dir>/web-token`,
//! created on the first start and kept, readable by the owner only on Unix.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use subtle::ConstantTimeEq;

/// The file in the data directory.
pub const FILE: &str = "web-token";

/// Random bytes in a token.
const BYTES: usize = 32;

/// What grants access: the token and the port it is valid on, managed by `app::run`.
#[derive(Debug, Clone)]
pub struct Access {
    pub port: u16,
    pub token: String,
}

impl Access {
    /// The address the user opens, with the token (`GET /` turns it into a cookie).
    pub fn address(&self) -> String {
        format!("http://127.0.0.1:{}/?token={}", self.port, self.token)
    }
}

/// Whether `given` is `token`, in time that does not depend on how much of it matches.
pub fn matches(token: &str, given: &str) -> bool {
    token.as_bytes().ct_eq(given.as_bytes()).into()
}

/// The path of the token file.
pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

/// Reads the token of `data_dir`, or makes one when there is none (or the file is not a token).
pub fn load_or_create(data_dir: &Path) -> io::Result<String> {
    let file = path(data_dir);
    if let Ok(text) = fs::read_to_string(&file) {
        let token = text.trim();
        if is_token(token) {
            restrict(&file)?;
            return Ok(token.to_owned());
        }
    }
    fs::create_dir_all(data_dir)?;
    let mut bytes = [0u8; BYTES];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(format!("no random bytes: {e}")))?;
    let token = hex(&bytes);
    write_private(&file, &token)?;
    Ok(token)
}

/// 64 lowercase hex digits.
fn is_token(text: &str) -> bool {
    text.len() == BYTES * 2 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Writes `text` to a file that only the owner can read (the mode is set when it is created).
fn write_private(file: &Path, text: &str) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut out = options.open(file)?;
    out.write_all(text.as_bytes())?;
    out.write_all(b"\n")?;
    restrict(file)
}

/// Owner-only access for a file that may have been made with other permissions.
fn restrict(file: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(file)?.permissions().mode() & 0o077 != 0 {
            fs::set_permissions(file, fs::Permissions::from_mode(0o600))?;
        }
    }
    #[cfg(not(unix))]
    let _ = file;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_is_made_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create(dir.path()).unwrap();
        assert!(is_token(&first), "{first}");
        assert_eq!(load_or_create(dir.path()).unwrap(), first);
        let other = tempfile::tempdir().unwrap();
        assert_ne!(load_or_create(other.path()).unwrap(), first);
    }

    #[test]
    fn something_that_is_not_a_token_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(path(dir.path()), "short").unwrap();
        let token = load_or_create(dir.path()).unwrap();
        assert!(is_token(&token));
        assert_eq!(fs::read_to_string(path(dir.path())).unwrap().trim(), token);
    }

    #[cfg(unix)]
    #[test]
    fn only_the_owner_can_read_the_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        load_or_create(dir.path()).unwrap();
        let mode = |dir: &Path| fs::metadata(path(dir)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(dir.path()), 0o600);
        // A file from an older copy with open permissions is closed again.
        fs::set_permissions(path(dir.path()), fs::Permissions::from_mode(0o644)).unwrap();
        load_or_create(dir.path()).unwrap();
        assert_eq!(mode(dir.path()), 0o600);
    }

    #[test]
    fn comparison_is_exact() {
        assert!(matches("abc", "abc"));
        assert!(!matches("abc", "abd"));
        assert!(!matches("abc", "ab"));
        assert!(!matches("abc", ""));
    }

    #[test]
    fn the_address_carries_the_token() {
        let access = Access {
            port: 14200,
            token: "t0".into(),
        };
        assert_eq!(access.address(), "http://127.0.0.1:14200/?token=t0");
    }
}

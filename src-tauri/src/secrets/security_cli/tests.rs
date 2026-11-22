//! Tests of the Keychain through `security`: against a fake program that behaves like the tool,
//! and against the real `/usr/bin/security` with a scratch keychain file that has nothing to do
//! with the keychains of the user (never in the search list, unlocked with a password chosen here,
//! so macOS can show no dialog). Nothing here touches the login keychain.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tempfile::TempDir;

use super::*;
use crate::secrets::{
    Bundle, CachedSecretStore, OPENCODE_GO_KEY, RETIRED_KEY, Secrets, UNREADABLE_MESSAGE,
};

const TEST_SERVICE: &str = "com.vidai.desktop.test";

// ---------------------------------------------------------------------------------------------
// The fake tool
// ---------------------------------------------------------------------------------------------

struct Fake {
    dir: TempDir,
}

impl Fake {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("keychain");
        let script = format!(
            "#!/bin/bash\ndir='{}'\n{}",
            state.display(),
            include_str!("fake-security.sh")
        );
        let tool = dir.path().join("security");
        fs::write(&tool, script).unwrap();
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
        Self { dir }
    }

    fn tool(&self) -> PathBuf {
        self.dir.path().join("security")
    }

    fn state(&self) -> PathBuf {
        self.dir.path().join("keychain")
    }

    fn cli(&self, limits: Limits) -> SecurityCli {
        SecurityCli::for_test(self.tool(), TEST_SERVICE, None, limits)
    }

    fn quick(&self) -> SecurityCli {
        self.cli(Limits {
            quick: Duration::from_secs(20),
            patient: Duration::from_secs(20),
        })
    }

    fn mode(&self, lines: &str) {
        fs::create_dir_all(self.state()).unwrap();
        fs::write(self.state().join("mode"), lines).unwrap();
    }

    fn log(&self, name: &str) -> String {
        fs::read_to_string(self.state().join(name)).unwrap_or_default()
    }

    fn item(&self, account: &str) -> Option<Vec<u8>> {
        let hex = fs::read_to_string(
            self.state()
                .join("items")
                .join(format!("{TEST_SERVICE}__{account}")),
        )
        .ok()?;
        unhex(&hex)
    }

    /// The current item of this version: of the two slots, the one with the higher generation.
    fn current(&self) -> Bundle {
        let mut bundles: Vec<Bundle> = [BUNDLE_ACCOUNT_A, BUNDLE_ACCOUNT_B]
            .into_iter()
            .filter_map(|account| self.item(account))
            .map(|data| serde_json::from_slice(&data).unwrap())
            .collect();
        bundles.sort_by_key(|bundle| bundle.generation);
        bundles.pop().expect("an item of this version")
    }

    fn slots_in_use(&self) -> usize {
        [BUNDLE_ACCOUNT_A, BUNDLE_ACCOUNT_B]
            .into_iter()
            .filter(|account| self.item(account).is_some())
            .count()
    }

    /// Puts an item in as an earlier version would have.
    fn seed(&self, account: &str, data: &str) {
        let items = self.state().join("items");
        fs::create_dir_all(&items).unwrap();
        fs::write(
            items.join(format!("{TEST_SERVICE}__{account}")),
            hex(data.as_bytes()),
        )
        .unwrap();
    }
}

#[test]
fn nothing_stored_reads_as_none() {
    let fake = Fake::new();
    let cli = fake.quick();
    assert_eq!(cli.read_slot(Slot::A).unwrap(), None);
    assert_eq!(cli.read_previous_bundle().unwrap(), None);
    // Deleting nothing is fine.
    cli.delete_slot(Slot::A).unwrap();
    cli.delete_previous_items().unwrap();
}

#[test]
fn write_read_update_delete() {
    let fake = Fake::new();
    let cli = fake.quick();
    cli.write_slot(Slot::A, r#"{"secrets":{"a":"1"}}"#).unwrap();
    assert_eq!(
        cli.read_slot(Slot::A).unwrap().as_deref(),
        Some(r#"{"secrets":{"a":"1"}}"#)
    );
    // A slot is written once; the other slot takes the next version.
    cli.write_slot(Slot::B, r#"{"secrets":{"a":"2"}}"#).unwrap();
    assert_eq!(
        cli.read_slot(Slot::B).unwrap().as_deref(),
        Some(r#"{"secrets":{"a":"2"}}"#)
    );
    assert!(
        cli.write_slot(Slot::A, "{}").is_err(),
        "an item is never updated"
    );
    cli.delete_slot(Slot::B).unwrap();
    cli.delete_slot(Slot::A).unwrap();
    assert_eq!(cli.read_slot(Slot::A).unwrap(), None);
    assert!(fake.item(BUNDLE_ACCOUNT_A).is_none());
}

/// The secret reaches the tool on stdin only, hex encoded, for a tool trusted by itself alone.
#[test]
fn a_write_never_puts_the_secret_in_the_argument_list() {
    let fake = Fake::new();
    let cli = fake.quick();
    let text = r#"{"secrets":{"opencode-api-key":"sk-very-secret-value"}}"#;
    cli.write_slot(Slot::A, text).unwrap();
    cli.read_slot(Slot::A).unwrap();
    cli.delete_slot(Slot::A).unwrap();
    let argv = fake.log("argv.log");
    assert!(!argv.contains("very-secret"), "{argv}");
    assert!(!argv.contains(&hex(b"very-secret")), "{argv}");
    assert!(!argv.contains("add-generic-password"), "{argv}");
    assert!(argv.lines().any(|l| l == "-i"), "{argv}");
    let stdin = fake.log("stdin.log");
    assert_eq!(stdin.lines().count(), 1);
    assert!(
        stdin.contains(&format!("-X {}", hex(text.as_bytes()))),
        "{stdin}"
    );
    assert!(!stdin.contains(" -U"), "an item is never updated: {stdin}");
    assert!(stdin.contains(r#"-T "/usr/bin/security""#), "{stdin}");
    assert!(
        stdin.contains(&format!(r#"-s "{TEST_SERVICE}" -a "{BUNDLE_ACCOUNT_A}""#)),
        "{stdin}"
    );
}

/// Quotes, backslashes, newlines and non-ASCII text survive, whether the tool prints them as they
/// are or in hex.
#[test]
fn awkward_text_round_trips() {
    let fake = Fake::new();
    let cli = fake.quick();
    for text in [
        // Raw: the tool answers with hex for these.
        "{\"k\":\"quote \\\" and 'single' and \\\\ \nsecond line\"}",
        "{\"k\":\"caf\u{e9} \u{20ac} \u{1f600}\"}",
        "{\"k\":\"tab\there\r\n\"}",
        r#"{"k":"$(touch /tmp/x) `x` ; & | > < * ?"}"#,
    ] {
        cli.write_slot(Slot::A, text).unwrap();
        assert_eq!(cli.read_slot(Slot::A).unwrap().as_deref(), Some(text));
        cli.delete_slot(Slot::A).unwrap();
    }
    // Through the store, with the real item text.
    let secrets = Secrets::new(Arc::new(CachedSecretStore::new(fake.quick())));
    secrets.preload();
    let key = "k\u{e9}y\"with'quotes\\and\u{1f600}";
    secrets.set(OPENCODE_GO_KEY, key).unwrap();
    let next_run = Secrets::new(Arc::new(CachedSecretStore::new(fake.quick())));
    assert_eq!(next_run.get(OPENCODE_GO_KEY).unwrap().as_deref(), Some(key));
    let stored = fake.item(BUNDLE_ACCOUNT_A).unwrap();
    assert!(stored.iter().all(|b| (0x20..0x7f).contains(b)));
}

#[test]
fn a_write_too_long_for_security_i_is_refused_before_anything_runs() {
    let fake = Fake::new();
    let cli = fake.quick();
    let text = format!(r#"{{"secrets":{{"k":"{}"}}}}"#, "x".repeat(2100));
    let err = cli.write_slot(Slot::A, &text).unwrap_err();
    assert_eq!(err.code, crate::error::ErrorCode::InvalidInput);
    assert!(fake.log("argv.log").is_empty());
    // Just under the limit works.
    let text = format!(r#"{{"secrets":{{"k":"{}"}}}}"#, "x".repeat(1500));
    cli.write_slot(Slot::A, &text).unwrap();
    assert_eq!(
        cli.read_slot(Slot::A).unwrap().as_deref(),
        Some(text.as_str())
    );
}

#[test]
fn a_denied_or_failing_tool_is_an_error_with_a_scrubbed_message() {
    let fake = Fake::new();
    let cli = fake.quick();
    cli.write_slot(Slot::A, r#"{"secrets":{"k":"sk-secret-1234"}}"#)
        .unwrap();

    fake.mode("deny-find\n");
    let err = cli.read_slot(Slot::A).unwrap_err();
    assert!(err.message.contains("exit code 36"), "{}", err.message);
    assert!(!err.message.contains("sk-secret"));

    fake.mode("fail-find\n");
    let err = cli.read_slot(Slot::A).unwrap_err();
    assert!(err.message.contains("exit code 1"), "{}", err.message);
    assert!(err.message.contains("boom"));

    // A failed write names no text of the tool at all.
    fake.mode("fail-add\n");
    let err = cli
        .write_slot(Slot::A, r#"{"secrets":{"k":"sk-secret-5678"}}"#)
        .unwrap_err();
    assert!(err.message.contains("Could not save"), "{}", err.message);
    assert!(!err.message.contains("sk-secret"));
    assert!(!err.message.contains("25299"));

    fake.mode("fail-delete\n");
    assert!(cli.delete_slot(Slot::A).is_err());
    fake.seed(PREVIOUS_BUNDLE_ACCOUNT, "{}");
    assert!(cli.delete_previous_items().is_err());

    // The item is untouched by all of it.
    fake.mode("");
    assert_eq!(
        cli.read_slot(Slot::A).unwrap().as_deref(),
        Some(r#"{"secrets":{"k":"sk-secret-1234"}}"#)
    );
}

/// `security -i` can fail without a word and without an exit code; the read-back catches it.
#[test]
fn a_write_that_did_not_happen_is_an_error() {
    let fake = Fake::new();
    let cli = fake.quick();
    fake.mode("drop-add\n");
    let err = cli
        .write_slot(Slot::A, r#"{"secrets":{"k":"v"}}"#)
        .unwrap_err();
    assert!(err.message.contains("did not read back"), "{}", err.message);
    // An old value that stays is not taken for the new one either.
    fake.mode("");
    cli.write_slot(Slot::A, r#"{"secrets":{"k":"old"}}"#)
        .unwrap();
    fake.mode("drop-add\n");
    assert!(
        cli.write_slot(Slot::A, r#"{"secrets":{"k":"new"}}"#)
            .is_err()
    );
}

#[test]
fn a_missing_program_is_an_error() {
    let cli = SecurityCli::for_test(
        "/nonexistent/security",
        TEST_SERVICE,
        None,
        Limits::default(),
    );
    let err = cli.read_slot(Slot::A).unwrap_err();
    assert!(err.message.contains("Could not start"), "{}", err.message);
    assert!(cli.write_slot(Slot::A, "{}").is_err());
}

#[test]
fn a_tool_that_hangs_is_killed_at_the_limit() {
    let fake = Fake::new();
    fake.mode("hang-find\n");
    let cli = fake.cli(Limits {
        quick: Duration::from_millis(300),
        patient: Duration::from_millis(300),
    });
    let started = Instant::now();
    let err = cli.read_slot(Slot::A).unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(err.message.contains("did not answer"), "{}", err.message);
    // The same through the store: unreadable, with Try Again.
    let secrets = Secrets::new(Arc::new(CachedSecretStore::new(fake.cli(Limits {
        quick: Duration::from_secs(4),
        patient: Duration::from_secs(4),
    }))));
    secrets.preload();
    assert_eq!(secrets.unreadable().as_deref(), Some(UNREADABLE_MESSAGE));
    fake.mode("");
    secrets.retry().unwrap();
    assert_eq!(secrets.unreadable(), None);
}

/// The item of this version never asks a question, so it gets the short limit; the old items may
/// show the password dialog, so they get the long one.
#[test]
fn old_items_get_time_to_answer_a_dialog() {
    let fake = Fake::new();
    fake.seed(PREVIOUS_BUNDLE_ACCOUNT, r#"{"secrets":{"k":"v"}}"#);
    fake.seed(BUNDLE_ACCOUNT_A, r#"{"secrets":{"k":"v"}}"#);
    fake.mode("slow-find\n");
    let cli = fake.cli(Limits {
        quick: Duration::from_millis(400),
        patient: Duration::from_secs(20),
    });
    assert!(cli.read_slot(Slot::A).is_err());
    assert!(cli.read_previous_bundle().unwrap().is_some());
}

#[test]
fn migration_through_the_tool_moves_the_previous_item() {
    let fake = Fake::new();
    fake.seed(
        PREVIOUS_BUNDLE_ACCOUNT,
        r#"{"secrets":{"typesafe-api-key":"ts_prev","opencode-api-key":"oc_prev"}}"#,
    );
    fake.seed(RETIRED_KEY, "ts_leftover");
    let secrets = Secrets::new(Arc::new(CachedSecretStore::new(fake.quick())));
    secrets.preload();
    assert_eq!(
        secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
        Some("oc_prev")
    );
    assert!(fake.item(PREVIOUS_BUNDLE_ACCOUNT).is_none());
    assert!(fake.item(RETIRED_KEY).is_none());
    let bundle = fake.current();
    assert!(
        !bundle.secrets.contains_key(RETIRED_KEY),
        "the retired key is dropped"
    );
    assert_eq!(bundle.secrets[OPENCODE_GO_KEY], "oc_prev");
    assert!(bundle.legacy_removed);
    assert_eq!(fake.slots_in_use(), 1);
    // Every write was confirmed with a read, but the migration only read the old items once.
    let finds = fake
        .log("argv.log")
        .lines()
        .filter(|l| l.contains("-a vidai-keys -w"))
        .count();
    assert_eq!(finds, 1);
}

#[test]
fn migration_stops_where_the_tool_fails() {
    // The new item cannot be written: the old one stays, the key is used meanwhile.
    let fake = Fake::new();
    fake.seed(
        PREVIOUS_BUNDLE_ACCOUNT,
        r#"{"secrets":{"opencode-api-key":"oc_prev"}}"#,
    );
    fake.mode("fail-add\n");
    let secrets = Secrets::new(Arc::new(CachedSecretStore::new(fake.quick())));
    assert_eq!(
        secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
        Some("oc_prev")
    );
    assert!(fake.item(PREVIOUS_BUNDLE_ACCOUNT).is_some());
    assert_eq!(fake.slots_in_use(), 0);

    // The old item cannot be removed: the new item says so, and a later start does not look.
    let fake = Fake::new();
    fake.seed(
        PREVIOUS_BUNDLE_ACCOUNT,
        r#"{"secrets":{"opencode-api-key":"oc_prev"}}"#,
    );
    fake.mode("fail-delete\n");
    let secrets = Secrets::new(Arc::new(CachedSecretStore::new(fake.quick())));
    assert_eq!(
        secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
        Some("oc_prev")
    );
    assert!(!fake.current().legacy_removed);
    assert!(fake.item(PREVIOUS_BUNDLE_ACCOUNT).is_some());
    fs::remove_file(fake.state().join("argv.log")).unwrap();
    let next = Secrets::new(Arc::new(CachedSecretStore::new(fake.quick())));
    assert_eq!(
        next.get(OPENCODE_GO_KEY).unwrap().as_deref(),
        Some("oc_prev")
    );
    let argv = fake.log("argv.log");
    assert_eq!(argv.lines().count(), 2, "{argv}");
    assert!(argv.contains(BUNDLE_ACCOUNT_A) && argv.contains(BUNDLE_ACCOUNT_B));

    // The old item cannot be read (denied): nothing changes, Try Again reads again.
    let fake = Fake::new();
    fake.seed(
        PREVIOUS_BUNDLE_ACCOUNT,
        r#"{"secrets":{"opencode-api-key":"oc_prev"}}"#,
    );
    fake.mode("deny-find\n");
    let secrets = Secrets::new(Arc::new(CachedSecretStore::new(fake.quick())));
    secrets.preload();
    assert_eq!(secrets.unreadable().as_deref(), Some(UNREADABLE_MESSAGE));
    assert!(fake.item(PREVIOUS_BUNDLE_ACCOUNT).is_some());
    assert_eq!(fake.slots_in_use(), 0);
    fake.mode("");
    secrets.retry().unwrap();
    assert_eq!(
        secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
        Some("oc_prev")
    );
    assert!(fake.item(PREVIOUS_BUNDLE_ACCOUNT).is_none());
}

#[test]
fn text_helpers() {
    assert_eq!(hex(b"a\n\xc3\xa9"), "610ac3a9");
    assert_eq!(unhex("610ac3a9").unwrap(), b"a\n\xc3\xa9");
    assert_eq!(unhex(""), None);
    assert_eq!(unhex("abc"), None);
    assert_eq!(unhex("zz"), None);
    assert_eq!(quote(r#"a "b" \c"#), r#""a \"b\" \\c""#);
    assert_eq!(decode_text(b"{\"a\":1}\n").as_deref(), Some("{\"a\":1}"));
    assert_eq!(
        decode_text(hex(b"{\"a\":\"\xc3\xa9\"}").as_bytes()).as_deref(),
        Some("{\"a\":\"\u{e9}\"}")
    );
    assert_eq!(decode_text(b"not json\n"), None);
    assert_eq!(decode_text(b"\xff\xfe"), None);
    // Hex of text that is not JSON is not taken for a bundle.
    assert_eq!(decode_text(hex(b"plain").as_bytes()), None);
}

// ---------------------------------------------------------------------------------------------
// The real /usr/bin/security with a scratch keychain
// ---------------------------------------------------------------------------------------------

/// A keychain file of its own, in a scratch folder: unlocked with this password, never added to
/// the search list, deleted when dropped.
struct Scratch {
    dir: TempDir,
    path: PathBuf,
}

const SCRATCH_PASSWORD: &str = "vidai-scratch-password";

impl Scratch {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("scratch.keychain-db");
        security(&["create-keychain", "-p", SCRATCH_PASSWORD, path_str(&path)]);
        // No automatic locking, then unlocked: a locked keychain is the only thing that could ask.
        security(&["set-keychain-settings", path_str(&path)]);
        security(&["unlock-keychain", "-p", SCRATCH_PASSWORD, path_str(&path)]);
        Self { dir, path }
    }

    fn cli(&self) -> SecurityCli {
        SecurityCli::for_test(
            SECURITY_TOOL,
            TEST_SERVICE,
            Some(self.path.clone()),
            Limits::default(),
        )
    }

    fn store(&self) -> Secrets {
        Secrets::new(Arc::new(CachedSecretStore::new(self.cli())))
    }

    /// Creates an item the way an earlier version did, as far as a tool can: same names, text.
    fn seed(&self, account: &str, text: &str) {
        security(&[
            "add-generic-password",
            "-s",
            TEST_SERVICE,
            "-a",
            account,
            "-w",
            text,
            path_str(&self.path),
        ]);
    }

    /// Whether an item exists, by its attributes (no secret is read).
    fn exists(&self, account: &str) -> bool {
        Command::new(SECURITY_TOOL)
            .args(["find-generic-password", "-s", TEST_SERVICE, "-a", account])
            .arg(&self.path)
            .output()
            .unwrap()
            .status
            .success()
    }

    fn dump_acl(&self) -> String {
        let out = Command::new(SECURITY_TOOL)
            .args(["dump-keychain", "-a"])
            .arg(&self.path)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = Command::new(SECURITY_TOOL)
            .arg("delete-keychain")
            .arg(&self.path)
            .output();
        let _ = fs::remove_file(&self.path);
        let _ = &self.dir;
    }
}

fn path_str(path: &Path) -> &str {
    path.to_str().unwrap()
}

fn security(args: &[&str]) {
    let out = Command::new(SECURITY_TOOL).args(args).output().unwrap();
    assert!(
        out.status.success(),
        "security {} failed: {}",
        args[0],
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn the_real_tool_round_trips_awkward_text() {
    let scratch = Scratch::new();
    let cli = scratch.cli();
    assert_eq!(cli.read_slot(Slot::A).unwrap(), None);
    for text in [
        r#"{"secrets":{"a":"1"}}"#,
        "{\"k\":\"quote \\\" and 'single' and \\\\ \nsecond line\"}",
        "{\"k\":\"caf\u{e9} \u{20ac} \u{1f600}\"}",
    ] {
        cli.write_slot(Slot::A, text).unwrap();
        assert_eq!(cli.read_slot(Slot::A).unwrap().as_deref(), Some(text));
        cli.delete_slot(Slot::A).unwrap();
    }
    // The longest write that fits one `security -i` line.
    let longest = format!(r#"{{"secrets":{{"k":"{}"}}}}"#, "z".repeat(1500));
    cli.write_slot(Slot::A, &longest).unwrap();
    assert_eq!(
        cli.read_slot(Slot::A).unwrap().as_deref(),
        Some(longest.as_str())
    );
    cli.delete_slot(Slot::A).unwrap();
    assert_eq!(cli.read_slot(Slot::A).unwrap(), None);
    cli.delete_slot(Slot::A).unwrap();
}

/// The item is created for Apple's tool alone, by its stable identity: that is why any VidAI
/// build reads it without a dialog.
#[test]
fn the_real_item_trusts_apples_tool_by_its_stable_identity_only() {
    let scratch = Scratch::new();
    let cli = scratch.cli();
    cli.write_slot(Slot::A, r#"{"secrets":{"opencode-api-key":"sk-scratch"}}"#)
        .unwrap();
    let dump = scratch.dump_acl();
    assert!(dump.contains(BUNDLE_ACCOUNT_A), "{dump}");
    assert!(dump.contains("0: /usr/bin/security (OK)"), "{dump}");
    assert!(
        dump.contains(r#"requirement: identifier "com.apple.security" and anchor apple"#),
        "{dump}"
    );
    // Exactly one application is trusted to decrypt.
    assert_eq!(dump.matches("applications (1):").count(), 1, "{dump}");
    assert!(!dump.contains("sk-scratch"), "the dump shows no secret");
}

#[test]
fn the_real_tool_migrates_the_previous_items_and_reads_the_new_one_after() {
    let scratch = Scratch::new();
    scratch.seed(
        PREVIOUS_BUNDLE_ACCOUNT,
        r#"{"secrets":{"typesafe-api-key":"ts_prev","opencode-api-key":"oc_prev"}}"#,
    );
    scratch.seed(RETIRED_KEY, "ts_leftover");
    let secrets = scratch.store();
    secrets.preload();
    assert_eq!(
        secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
        Some("oc_prev")
    );
    assert!(!scratch.exists(PREVIOUS_BUNDLE_ACCOUNT));
    assert!(!scratch.exists(RETIRED_KEY));
    assert!(!scratch.exists(BUNDLE_ACCOUNT_A));
    assert!(
        scratch.exists(BUNDLE_ACCOUNT_B),
        "the second save went to the other slot"
    );

    // A later run reads the new item.
    let next_run = scratch.store();
    next_run.preload();
    assert_eq!(
        next_run.get(OPENCODE_GO_KEY).unwrap().as_deref(),
        Some("oc_prev")
    );
    next_run.set(OPENCODE_GO_KEY, "oc_new").unwrap();
    let third = scratch.store();
    assert_eq!(
        third.get(OPENCODE_GO_KEY).unwrap().as_deref(),
        Some("oc_new")
    );
    third.delete(OPENCODE_GO_KEY).unwrap();
    assert!(!scratch.exists(BUNDLE_ACCOUNT_A));
    assert!(!scratch.exists(BUNDLE_ACCOUNT_B));
}

/// Saves take turns between the two items, and every save leaves exactly one.
#[test]
fn the_real_tool_alternates_between_the_two_items() {
    let scratch = Scratch::new();
    let secrets = scratch.store();
    for (round, expected_slot) in [
        (1, BUNDLE_ACCOUNT_A),
        (2, BUNDLE_ACCOUNT_B),
        (3, BUNDLE_ACCOUNT_A),
        (4, BUNDLE_ACCOUNT_B),
    ] {
        secrets
            .set(OPENCODE_GO_KEY, &format!("key-{round}"))
            .unwrap();
        assert!(scratch.exists(expected_slot), "round {round}");
        let other = if expected_slot == BUNDLE_ACCOUNT_A {
            BUNDLE_ACCOUNT_B
        } else {
            BUNDLE_ACCOUNT_A
        };
        assert!(!scratch.exists(other), "round {round}");
        // A new run finds the latest key.
        assert_eq!(
            scratch.store().get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some(format!("key-{round}").as_str())
        );
    }
}

/// A previous item that holds only a retired key leaves nothing to keep: the old items go and no
/// item of this version is created.
#[test]
fn the_real_tool_removes_a_previous_item_that_holds_only_a_retired_key() {
    let scratch = Scratch::new();
    scratch.seed(
        PREVIOUS_BUNDLE_ACCOUNT,
        r#"{"secrets":{"typesafe-api-key":"ts_prev"}}"#,
    );
    scratch.seed(RETIRED_KEY, "ts_leftover");
    let secrets = scratch.store();
    secrets.preload();
    assert_eq!(secrets.get(OPENCODE_GO_KEY).unwrap(), None);
    assert!(!scratch.exists(PREVIOUS_BUNDLE_ACCOUNT));
    assert!(!scratch.exists(RETIRED_KEY));
    assert!(!scratch.exists(BUNDLE_ACCOUNT_A));
    assert!(!scratch.exists(BUNDLE_ACCOUNT_B));
}

#[test]
fn the_real_tool_with_nothing_stored_creates_nothing() {
    let scratch = Scratch::new();
    let secrets = scratch.store();
    secrets.preload();
    assert_eq!(secrets.get(OPENCODE_GO_KEY).unwrap(), None);
    assert!(!scratch.exists(BUNDLE_ACCOUNT_A));
    assert!(!scratch.exists(BUNDLE_ACCOUNT_B));
    assert!(!scratch.dump_acl().contains("class: \"genp\""));
}

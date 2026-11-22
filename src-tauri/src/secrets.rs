//! Secret storage (SPEC section 7a): the only place secrets live.
//!
//! Secrets are kept in the OS keychain (macOS Keychain, Windows Credential Manager), never in
//! `settings.json`, `state.json`, logs or exports. The `Store` in `store.rs` deliberately has no
//! API for secrets; code that needs one asks the managed [`Secrets`] state.
//!
//! - [`SecretStore`] is the small interface (get / set / delete by name, plus the startup read).
//! - macOS: [`CachedSecretStore`] over the Keychain (`security_cli::SecurityCli`). All of VidAI's
//!   secrets live in ONE generic password (service [`SERVICE`], account [`BUNDLE_ACCOUNT_A`] or
//!   [`BUNDLE_ACCOUNT_B`], taking turns), a
//!   small JSON object, that is read and written only through Apple's `/usr/bin/security` tool
//!   (module `security_cli` explains why): the program that accesses the item is then always
//!   Apple's tool, whichever ad-hoc signed VidAI build runs, so macOS never shows its Keychain
//!   password dialog for it. The item is read at most once per run of the app: at startup
//!   ([`SecretStore::preload`]), or when the user presses Try Again after the read failed
//!   ([`SecretStore::retry`]). Every later read (job launches, status and hint displays, Test,
//!   the model list, the quota refresh) is served from memory. Saving or removing a key writes
//!   through to the Keychain and updates the copy in memory. When nothing is saved there is no
//!   item. The one-time migration from the items of earlier versions, which were created through
//!   the Security framework and name the build that created them, is described at
//!   [`CachedSecretStore`].
//! - `CredentialManagerSecretStore` (Windows) keeps them in the Windows Credential Manager as
//!   generic credentials named `<SERVICE>/<name>`, local to this computer. It shows no dialog,
//!   so it reads on demand as before.
//! - [`MemorySecretStore`] keeps secrets in memory only. Unit tests use it directly.
//! - [`platform_store`] returns the implementation `lib.rs` manages at startup. With
//!   `VIDAI_SECRETS=memory` it returns the in-memory store, so development runs and end-to-end
//!   tests never touch the real keychain.
//!
//! Usage from a command: `secrets: State<'_, Secrets>`, then
//! `secrets.get(secrets::key_name(option))?` (or `opencode::saved_key(&secrets, option)`).

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsStr;
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[cfg(target_os = "macos")]
mod security_cli;

/// Keychain service name for every VidAI secret.
pub const SERVICE: &str = "com.vidai.desktop";
/// The name a key of an integration VidAI no longer has was stored under (also, before the
/// combined item, its own Keychain account and, on Windows, its own credential). VidAI never
/// reads or writes it any more: it is dropped from a combined item that still holds it, and the
/// old separate items and credential are removed.
pub(crate) const RETIRED_KEY: &str = "typesafe-api-key";
/// Name of the API key of `opencodeGo`.
pub const OPENCODE_GO_KEY: &str = "opencode-go-api-key";
/// Name of the API key of `anthropicApi`.
pub const ANTHROPIC_KEY: &str = "anthropic-api-key";
/// Name of the API key of `openaiApi`.
pub const OPENAI_KEY: &str = "openai-api-key";
/// The name of the only OpenCode key of VidAI 0.2.4 and earlier: it is read as
/// [`OPENCODE_GO_KEY`] (SPEC section 7a, Migration from 0.2.4) and the next write leaves it out.
pub(crate) const LEGACY_OPENCODE_KEY: &str = "opencode-api-key";

/// The secret name of the API key of `option`.
pub fn key_name(option: crate::model::ApiOption) -> &'static str {
    use crate::model::ApiOption;
    match option {
        ApiOption::OpencodeGo => OPENCODE_GO_KEY,
        ApiOption::AnthropicApi => ANTHROPIC_KEY,
        ApiOption::OpenaiApi => OPENAI_KEY,
    }
}
/// macOS: the Keychain accounts of the two items that take turns holding every VidAI secret
/// (see [`Slot`]). They are created through `/usr/bin/security`, so any VidAI build can read them
/// without a dialog.
pub const BUNDLE_ACCOUNT_A: &str = "vidai-keys-v2-a";
/// See [`BUNDLE_ACCOUNT_A`].
pub const BUNDLE_ACCOUNT_B: &str = "vidai-keys-v2-b";
/// macOS: the account of the combined item of versions 0.2.0 to 0.2.2, created through the
/// Security framework. Its access list names the build that created it, so reading it from
/// another build shows the password dialog; it is read once to move it to [`BUNDLE_ACCOUNT_A`] and
/// removed.
pub const PREVIOUS_BUNDLE_ACCOUNT: &str = "vidai-keys";
/// Environment variable that selects the secret store. `memory` means [`MemorySecretStore`].
pub const SECRETS_ENV: &str = "VIDAI_SECRETS";

/// Get, set and delete secrets by name. Implementations must be thread-safe.
pub trait SecretStore: Send + Sync {
    /// The secret, or `None` when nothing is stored under `name`.
    fn get(&self, name: &str) -> AppResult<Option<String>>;
    /// Stores or replaces the secret.
    fn set(&self, name: &str, value: &str) -> AppResult<()>;
    /// Removes the secret; removing a missing secret is not an error.
    fn delete(&self, name: &str) -> AppResult<()>;
    /// Reads what the store keeps outside this process, once, at startup. Nothing by default.
    fn preload(&self) {}
    /// Why the saved secrets could not be read, while that is so. `None` by default.
    fn unreadable(&self) -> Option<String> {
        None
    }
    /// Reads the saved secrets again after [`SecretStore::unreadable`] (the user pressed Try
    /// Again). Nothing to do by default.
    fn retry(&self) -> AppResult<()> {
        Ok(())
    }
}

/// In-memory secrets: for tests, and for `VIDAI_SECRETS=memory`. Nothing survives a restart.
#[derive(Default)]
pub struct MemorySecretStore {
    values: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemorySecretStore {
    fn get(&self, name: &str) -> AppResult<Option<String>> {
        let values = self.values.lock().unwrap_or_else(PoisonError::into_inner);
        Ok(values.get(name).cloned())
    }

    fn set(&self, name: &str, value: &str) -> AppResult<()> {
        let mut values = self.values.lock().unwrap_or_else(PoisonError::into_inner);
        values.insert(name.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, name: &str) -> AppResult<()> {
        let mut values = self.values.lock().unwrap_or_else(PoisonError::into_inner);
        values.remove(name);
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// The cached store: one read per run (macOS)
// ---------------------------------------------------------------------------------------------

/// Where [`CachedSecretStore`] keeps its items: the macOS Keychain through `/usr/bin/security`
/// in the app, a counting fake in the tests. Every method is one Keychain call.
pub trait BundleBackend: Send + Sync {
    /// The text of the combined item in `slot`, `None` when the slot is empty. Never shows a
    /// macOS dialog.
    fn read_slot(&self, slot: Slot) -> AppResult<Option<String>>;
    /// Stores `text` in `slot`, which the caller has emptied. Returns `Ok` only once the item is
    /// stored and has been read back, so the caller may remove other copies of its content.
    fn write_slot(&self, slot: Slot, text: &str) -> AppResult<()>;
    /// Empties `slot`; a slot that is empty already is not an error.
    fn delete_slot(&self, slot: Slot) -> AppResult<()>;
    /// The combined item of versions 0.2.0 to 0.2.2 (account [`PREVIOUS_BUNDLE_ACCOUNT`]). This
    /// is the one read that can show the macOS password dialog, once.
    fn read_previous_bundle(&self) -> AppResult<Option<String>>;
    /// Removes the items of earlier versions (the previous combined item and the separate item of
    /// a retired key, [`RETIRED_KEY`]); an item that is missing is not an error. Fails when one
    /// could not be removed.
    fn delete_previous_items(&self) -> AppResult<()>;
}

/// One of the two Keychain items that take turns holding the secrets. A save writes the slot that
/// is not current and only then removes the current one, so there is a complete item at every
/// moment, however the app ends, and no item is ever updated in place (`security` asks macOS to
/// change the access list of an item it updates, which can show a dialog).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    A,
    B,
}

impl Slot {
    fn other(self) -> Self {
        match self {
            Self::A => Self::B,
            Self::B => Self::A,
        }
    }
}

/// The JSON object in the combined item.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bundle {
    /// Secret values by name ([`OPENCODE_GO_KEY`], [`ANTHROPIC_KEY`], [`OPENAI_KEY`]). A retired
    /// or legacy name may still be in an item written by an earlier version; it is dropped or
    /// renamed when the item is read (see [`current_names`]).
    #[serde(default)]
    secrets: BTreeMap<String, String>,
    /// `false` while the items of earlier versions may still exist (the migration copied their
    /// keys here but was interrupted, or could not remove them yet).
    #[serde(default = "yes")]
    legacy_removed: bool,
    /// Counts the saves: of the two slots the one with the higher number is the current one.
    #[serde(default)]
    generation: u64,
}

fn yes() -> bool {
    true
}

/// `secrets` as this version names them: the retired names are dropped and the legacy OpenCode
/// key becomes the OpenCode Go key (unless that one exists already), so the next write leaves the
/// item with the new fields only.
fn current_names(mut secrets: BTreeMap<String, String>) -> BTreeMap<String, String> {
    secrets.remove(RETIRED_KEY);
    if let Some(legacy) = secrets.remove(LEGACY_OPENCODE_KEY) {
        secrets.entry(OPENCODE_GO_KEY.to_owned()).or_insert(legacy);
    }
    secrets
}

impl Bundle {
    /// The text of the item: printable ASCII only (non-ASCII characters are written as
    /// `\uXXXX`), so `security find-generic-password -w` prints it as it is.
    fn to_text(&self) -> AppResult<String> {
        Ok(ascii_json(&serde_json::to_string(self)?))
    }

    fn parse(text: &str) -> AppResult<Self> {
        serde_json::from_str(text).map_err(|_| {
            AppError::internal("The saved API keys in the macOS Keychain are not readable.")
        })
    }
}

/// `json` with every non-ASCII character written as a `\uXXXX` escape (a surrogate pair above
/// U+FFFF). Outside strings JSON has no such characters, so the result is the same JSON.
fn ascii_json(json: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(json.len());
    for c in json.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut units = [0u16; 2];
            for unit in c.encode_utf16(&mut units) {
                let _ = write!(out, "\\u{unit:04x}");
            }
        }
    }
    out
}

/// The saved secrets as read, and where they are.
struct Loaded {
    secrets: BTreeMap<String, String>,
    /// The current slot and its generation; `None` when there is no item.
    at: Option<(Slot, u64)>,
    /// Items of earlier versions may still exist and are removed with the next write.
    legacy_pending: bool,
}

/// What [`CachedSecretStore`] holds in memory.
enum Cache {
    /// Nothing read yet (before [`SecretStore::preload`]).
    NotRead,
    /// The saved secrets, read once.
    Read(Loaded),
    /// The read failed (denied, locked). Nothing is read again until [`SecretStore::retry`].
    Unreadable,
}

/// What the user sees when the saved keys could not be read.
pub const UNREADABLE_MESSAGE: &str = "VidAI could not read your saved API keys from the macOS Keychain. Edits run as if no key is saved until you press Try Again.";

/// Every secret in memory, behind the combined item of a [`BundleBackend`] that is read at most
/// once per run (SPEC section 7a): at [`SecretStore::preload`] (startup), or at the first `get`
/// should that come first, and again only on [`SecretStore::retry`] after a failed read.
///
/// The item of this version (accounts [`BUNDLE_ACCOUNT_A`] and [`BUNDLE_ACCOUNT_B`], see [`Slot`])
/// is created and read only through `/usr/bin/security`, so macOS asks nothing for it, on any
/// build. Items of earlier versions were created through the Security framework and are moved
/// once, never losing a key, also when interrupted at any point:
/// 1. An item of this version exists: it is used as it is; the old items are not touched at
///    startup (a leftover is removed with the next write, see `legacyRemoved`).
/// 2. Otherwise the previous combined item (account [`PREVIOUS_BUNDLE_ACCOUNT`]) is read. Nothing
///    there means nothing is saved and nothing is written. A retired key in it is not carried
///    over; when nothing else is in it, only the old items are removed. This read is the only one that can show the macOS
///    password dialog (SPEC section 7a says how many dialogs), once, at the first start.
/// 3. The keys are written to the item of this version with `legacyRemoved: false` and read back
///    (the backend confirms it).
/// 4. Only then the old items are removed, and the keys are written again with
///    `legacyRemoved: true`.
///
/// An interruption before step 3 leaves the old items, which the next start migrates again; one
/// after it leaves `legacyRemoved: false`, so the old items are removed with the next write (a
/// leftover nobody reads is otherwise harmless). A failed read of the old items (the dialog was
/// denied) leaves everything as it is and the state unreadable until Try Again.
pub struct CachedSecretStore<B: BundleBackend> {
    backend: B,
    cache: Mutex<Cache>,
}

impl<B: BundleBackend> CachedSecretStore<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            cache: Mutex::new(Cache::NotRead),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Cache> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The current item of this version: of the two slots the one with the higher generation. An
    /// item that is not a bundle is an error, never skipped: it could be the newest.
    fn read_current(&self) -> AppResult<Option<(Slot, Bundle)>> {
        let mut current: Option<(Slot, Bundle)> = None;
        for slot in [Slot::A, Slot::B] {
            let Some(text) = self.backend.read_slot(slot)? else {
                continue;
            };
            let bundle = Bundle::parse(&text)?;
            if current
                .as_ref()
                .is_none_or(|(_, best)| bundle.generation > best.generation)
            {
                current = Some((slot, bundle));
            }
        }
        Ok(current)
    }

    /// Reads the saved secrets. An error means they could not be read.
    fn read(&self) -> AppResult<Loaded> {
        if let Some((slot, bundle)) = self.read_current()? {
            return Ok(Loaded {
                secrets: current_names(bundle.secrets),
                at: Some((slot, bundle.generation)),
                legacy_pending: !bundle.legacy_removed,
            });
        }
        let previous = self
            .backend
            .read_previous_bundle()?
            .map(|text| Bundle::parse(&text))
            .transpose()?;
        let found = previous.is_some();
        let mut loaded = Loaded {
            secrets: previous
                .map(|bundle| current_names(bundle.secrets))
                .unwrap_or_default(),
            at: None,
            legacy_pending: false,
        };
        if !loaded.secrets.is_empty() {
            loaded.legacy_pending = true;
            self.migrate(&mut loaded);
        } else if found {
            // Nothing left to keep (only a retired key, or nothing): the old items just go.
            if let Err(err) = self.backend.delete_previous_items() {
                eprintln!(
                    "vidai: could not remove the old Keychain items yet: {}",
                    err.message
                );
            }
        }
        Ok(loaded)
    }

    /// Steps 3 and 4. A failure leaves `loaded.legacy_pending` up; the keys are in memory either
    /// way.
    fn migrate(&self, loaded: &mut Loaded) {
        let secrets = loaded.secrets.clone();
        if let Err(err) = self.put(loaded, &secrets, false) {
            eprintln!(
                "vidai: could not move the saved API keys to the new Keychain item yet: {}",
                err.message
            );
            return;
        }
        if let Err(err) = self.backend.delete_previous_items() {
            eprintln!(
                "vidai: could not remove the old Keychain items yet: {}",
                err.message
            );
            return;
        }
        // The old items are gone, so a failure here leaves nothing to remove with the next write.
        match self.put(loaded, &secrets, true) {
            Ok(()) => loaded.legacy_pending = false,
            Err(err) => eprintln!("vidai: could not update the Keychain item: {}", err.message),
        }
    }

    /// Stores `secrets` as the next generation, in the slot that is not current: empties it, writes
    /// it (confirmed by the backend), and only then empties the former current slot, so one
    /// complete item exists at every moment. On an error `loaded` is unchanged.
    fn put(
        &self,
        loaded: &mut Loaded,
        secrets: &BTreeMap<String, String>,
        legacy_removed: bool,
    ) -> AppResult<()> {
        let (slot, generation) = match loaded.at {
            Some((current, generation)) => (current.other(), generation + 1),
            None => (Slot::A, 1),
        };
        let text = Bundle {
            secrets: secrets.clone(),
            legacy_removed,
            generation,
        }
        .to_text()?;
        // What is in the target slot is older than the current item, or nothing.
        self.backend.delete_slot(slot)?;
        self.backend.write_slot(slot, &text)?;
        if let Some((former, _)) = loaded.at.replace((slot, generation)) {
            // A leftover that cannot be removed now is older, so it never wins, and the next
            // save finds it in the target slot and removes it first.
            let _ = self.backend.delete_slot(former);
        }
        Ok(())
    }

    fn load(&self) -> Cache {
        match self.read() {
            Ok(loaded) => Cache::Read(loaded),
            Err(err) => {
                // The message names an exit code and the tool's own reason, never a secret.
                eprintln!("vidai: could not read the saved API keys: {}", err.message);
                Cache::Unreadable
            }
        }
    }

    /// Makes sure the item was read once, then runs `f` on what was read, or fails with
    /// `secretsUnavailable` while it cannot be read.
    fn with_loaded<R>(&self, f: impl FnOnce(&mut Loaded) -> R) -> AppResult<R> {
        let mut cache = self.lock();
        if matches!(*cache, Cache::NotRead) {
            *cache = self.load();
        }
        match &mut *cache {
            Cache::Read(loaded) => Ok(f(loaded)),
            Cache::Unreadable | Cache::NotRead => {
                Err(AppError::secrets_unavailable(UNREADABLE_MESSAGE))
            }
        }
    }

    /// Writes `secrets` through: the combined item, or no item at all when nothing is left, and
    /// updates `loaded`. While `legacy_pending`, the items of earlier versions are removed first
    /// (the item of this version already holds their keys); the item then records whether that
    /// worked. Writes happen on user action (saving or removing a key), never at startup.
    fn write(&self, loaded: &mut Loaded, secrets: BTreeMap<String, String>) -> AppResult<()> {
        let removed = !loaded.legacy_pending || self.backend.delete_previous_items().is_ok();
        if secrets.is_empty() && removed {
            if let Some((current, _)) = loaded.at {
                // The older slot first: a leftover must not outlive the current item.
                self.backend.delete_slot(current.other())?;
                self.backend.delete_slot(current)?;
                loaded.at = None;
            }
        } else {
            // Nothing left but old items that could not be removed: the item stays, empty, so
            // the next start does not bring a removed key back from them.
            self.put(loaded, &secrets, removed)?;
        }
        loaded.legacy_pending = !removed;
        loaded.secrets = secrets;
        Ok(())
    }
}

impl<B: BundleBackend> SecretStore for CachedSecretStore<B> {
    fn get(&self, name: &str) -> AppResult<Option<String>> {
        self.with_loaded(|loaded| loaded.secrets.get(name).cloned())
    }

    fn set(&self, name: &str, value: &str) -> AppResult<()> {
        // While the item cannot be read, a save would replace keys VidAI could not see, so it is
        // refused until Try Again succeeds.
        self.with_loaded(|loaded| {
            let mut next = loaded.secrets.clone();
            next.insert(name.to_owned(), value.to_owned());
            self.write(loaded, next)
        })?
    }

    fn delete(&self, name: &str) -> AppResult<()> {
        self.with_loaded(|loaded| {
            if !loaded.secrets.contains_key(name) {
                return Ok(());
            }
            let mut next = loaded.secrets.clone();
            next.remove(name);
            self.write(loaded, next)
        })?
    }

    fn preload(&self) {
        let mut cache = self.lock();
        if matches!(*cache, Cache::NotRead) {
            *cache = self.load();
        }
    }

    fn unreadable(&self) -> Option<String> {
        matches!(*self.lock(), Cache::Unreadable).then(|| UNREADABLE_MESSAGE.to_owned())
    }

    fn retry(&self) -> AppResult<()> {
        let mut cache = self.lock();
        if !matches!(*cache, Cache::Read(_)) {
            *cache = self.load();
        }
        match &*cache {
            Cache::Read(_) => Ok(()),
            Cache::Unreadable | Cache::NotRead => {
                Err(AppError::secrets_unavailable(UNREADABLE_MESSAGE))
            }
        }
    }
}

/// Which store [`platform_store`] returns, decided by the value of `VIDAI_SECRETS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StoreChoice {
    Memory,
    Platform,
}

fn choose_store(value: Option<&OsStr>) -> StoreChoice {
    match value {
        Some(v) if v.eq_ignore_ascii_case("memory") => StoreChoice::Memory,
        _ => StoreChoice::Platform,
    }
}

/// The secret store for this platform: the macOS Keychain or the Windows Credential Manager, or
/// the in-memory store when `VIDAI_SECRETS=memory` is set (development runs and end-to-end
/// tests).
pub fn platform_store() -> Arc<dyn SecretStore> {
    let env = std::env::var_os(SECRETS_ENV);
    match choose_store(env.as_deref()) {
        StoreChoice::Memory => Arc::new(MemorySecretStore::default()),
        StoreChoice::Platform => os_store(),
    }
}

#[cfg(target_os = "macos")]
fn os_store() -> Arc<dyn SecretStore> {
    Arc::new(CachedSecretStore::new(security_cli::SecurityCli::new(
        SERVICE,
    )))
}

#[cfg(windows)]
fn os_store() -> Arc<dyn SecretStore> {
    Arc::new(CredentialManagerSecretStore::new(SERVICE))
}

/// No OS store on this platform: secrets live in memory and do not survive a restart.
#[cfg(not(any(target_os = "macos", windows)))]
fn os_store() -> Arc<dyn SecretStore> {
    Arc::new(MemorySecretStore::default())
}

/// Secrets in the Windows Credential Manager, as generic credentials of the current user named
/// `<SERVICE>/<name>` (for example `com.vidai.desktop/opencode-go-api-key`), with local persistence
/// (they stay on this computer and never roam with the user profile). Never used by unit tests.
#[cfg(windows)]
pub struct CredentialManagerSecretStore {
    service: String,
}

#[cfg(windows)]
impl CredentialManagerSecretStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    /// The Credential Manager entry of the secret `name`.
    fn entry(&self, name: &str) -> AppResult<keyring_core::Entry> {
        use keyring_core::api::CredentialStoreApi;
        let target = format!("{}/{name}", self.service);
        let modifiers = HashMap::from([("target", target.as_str()), ("persistence", "Local")]);
        windows_native_keyring_store::Store::new()
            .and_then(|store| store.build(&self.service, name, Some(&modifiers)))
            .map_err(|err| credential_error("open", &err))
    }
}

#[cfg(windows)]
fn credential_error(action: &str, err: &keyring_core::Error) -> crate::error::AppError {
    crate::error::AppError::internal(format!(
        "Could not {action} the Windows Credential Manager: {err}"
    ))
}

#[cfg(windows)]
impl CredentialManagerSecretStore {
    /// The credential `name`, `None` when there is none.
    fn read(&self, name: &str) -> AppResult<Option<String>> {
        match self.entry(name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(err) => Err(credential_error("read from", &err)),
        }
    }

    fn remove(&self, name: &str) -> AppResult<()> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(err) => Err(credential_error("remove from", &err)),
        }
    }

    /// The credential of VidAI 0.2.4's OpenCode key becomes the OpenCode Go credential, and is
    /// removed once that one reads back (SPEC section 11, Secrets). Interrupted at any point it
    /// leaves a state the next start finishes.
    fn move_legacy_key(&self) -> AppResult<()> {
        let Some(old) = self.read(LEGACY_OPENCODE_KEY)? else {
            return Ok(());
        };
        if self.read(OPENCODE_GO_KEY)?.is_none() {
            self.entry(OPENCODE_GO_KEY)?
                .set_password(&old)
                .map_err(|err| credential_error("save to", &err))?;
            if self.read(OPENCODE_GO_KEY)?.as_deref() != Some(old.as_str()) {
                return Err(AppError::internal(
                    "The new Windows Credential Manager entry did not read back.",
                ));
            }
        }
        self.remove(LEGACY_OPENCODE_KEY)
    }
}

#[cfg(windows)]
impl SecretStore for CredentialManagerSecretStore {
    /// Nothing is read ahead. The credential of the retired key ([`RETIRED_KEY`]) is removed and
    /// the legacy OpenCode credential is moved to its new name, best effort: a failure is only
    /// logged and never stops the app (it is tried again at the next start).
    fn preload(&self) {
        if let Err(err) = self.remove(RETIRED_KEY) {
            eprintln!("vidai: could not remove an old credential: {}", err.message);
        }
        if let Err(err) = self.move_legacy_key() {
            eprintln!("vidai: could not move an old credential: {}", err.message);
        }
    }

    fn get(&self, name: &str) -> AppResult<Option<String>> {
        match self.read(name)? {
            Some(value) => Ok(Some(value)),
            // Until the legacy credential is moved, it is the OpenCode Go key.
            None if name == OPENCODE_GO_KEY => self.read(LEGACY_OPENCODE_KEY),
            None => Ok(None),
        }
    }

    fn set(&self, name: &str, value: &str) -> AppResult<()> {
        self.entry(name)?
            .set_password(value)
            .map_err(|err| credential_error("save to", &err))
    }

    fn delete(&self, name: &str) -> AppResult<()> {
        self.remove(name)?;
        if name == OPENCODE_GO_KEY {
            // A removed key must not come back from the legacy credential.
            self.remove(LEGACY_OPENCODE_KEY)?;
        }
        Ok(())
    }
}

/// Managed Tauri state wrapping the active [`SecretStore`]. `Debug` never prints values.
#[derive(Clone)]
pub struct Secrets(Arc<dyn SecretStore>);

impl Secrets {
    pub fn new(store: Arc<dyn SecretStore>) -> Self {
        Self(store)
    }

    pub fn get(&self, name: &str) -> AppResult<Option<String>> {
        self.0.get(name)
    }

    pub fn set(&self, name: &str, value: &str) -> AppResult<()> {
        self.0.set(name, value)
    }

    pub fn delete(&self, name: &str) -> AppResult<()> {
        self.0.delete(name)
    }

    /// The one startup read of the saved secrets (see [`SecretStore::preload`]).
    pub fn preload(&self) {
        self.0.preload();
    }

    /// Why the saved secrets could not be read, while that is so.
    pub fn unreadable(&self) -> Option<String> {
        self.0.unreadable()
    }

    /// Reads the saved secrets again after a failed read (Try Again).
    pub fn retry(&self) -> AppResult<()> {
        self.0.retry()
    }
}

/// Completes the migration of a 0.2.4 install that edited with Claude Code on OpenCode: copies the
/// old key to the field of `anthropicApi` (unless that field already has a key) and only then lets
/// the store write `settings.json` at version 9 (SPEC section 7a, Migration from 0.2.4, "Order").
/// Must run after [`Secrets::preload`]. Does nothing when no migration is pending; on an error
/// (for example the keychain is not readable yet) nothing is written and it can run again.
pub fn finish_key_migration(store: &crate::store::Store, secrets: &Secrets) -> AppResult<()> {
    store.finish_api_key_migration(|| {
        let go = secrets.get(OPENCODE_GO_KEY)?;
        if let Some(key) = go
            && secrets.get(ANTHROPIC_KEY)?.is_none()
        {
            secrets.set(ANTHROPIC_KEY, &key)?;
            // Read back: the copy counts only when it can be read.
            if secrets.get(ANTHROPIC_KEY)?.as_deref() != Some(key.as_str()) {
                return Err(AppError::secrets_unavailable(
                    "The copied API key could not be read back.".to_owned(),
                ));
            }
        }
        Ok(())
    })
}

impl fmt::Debug for Secrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secrets(..)")
    }
}

/// The one test that touches the real Windows Credential Manager: the API keys make a round
/// trip through a credential of their own service name (never VidAI's), which is removed again.
#[cfg(all(test, windows))]
mod credential_manager_tests {
    use super::*;

    #[test]
    fn the_api_keys_round_trip_through_the_credential_manager() {
        let service = format!("com.vidai.desktop.test-{}", std::process::id());
        let store = CredentialManagerSecretStore::new(service);
        let secrets = Secrets::new(Arc::new(store));
        for (name, value) in [
            (ANTHROPIC_KEY, "sk_ant_credential_test_1"),
            (OPENCODE_GO_KEY, "oc_sk_credential_test_2"),
            (OPENAI_KEY, "sk_credential_test_3"),
        ] {
            assert_eq!(secrets.get(name).unwrap(), None, "{name} starts empty");
            secrets.set(name, value).unwrap();
            assert_eq!(secrets.get(name).unwrap().as_deref(), Some(value));
            secrets.set(name, "replaced").unwrap();
            assert_eq!(secrets.get(name).unwrap().as_deref(), Some("replaced"));
            secrets.delete(name).unwrap();
            assert_eq!(secrets.get(name).unwrap(), None, "{name} is gone");
            // Removing what is not there is not an error.
            secrets.delete(name).unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A second secret name, to show that the store keeps every name apart.
    const SECOND: &str = "second-api-key";

    #[test]
    fn memory_store_round_trip() {
        let secrets = Secrets::new(Arc::new(MemorySecretStore::default()));
        assert_eq!(secrets.get(SECOND).unwrap(), None);
        secrets.set(SECOND, "abc").unwrap();
        assert_eq!(secrets.get(SECOND).unwrap().as_deref(), Some("abc"));
        secrets.set(SECOND, "def").unwrap();
        assert_eq!(secrets.get(SECOND).unwrap().as_deref(), Some("def"));
        secrets.delete(SECOND).unwrap();
        secrets.delete(SECOND).unwrap();
        assert_eq!(secrets.get(SECOND).unwrap(), None);
        assert_eq!(format!("{secrets:?}"), "Secrets(..)");
    }

    /// A stand-in for the Keychain that counts every call and can fail on demand.
    #[derive(Default)]
    pub(crate) struct FakeKeychain {
        /// The two items of this version.
        pub slot_a: Mutex<Option<String>>,
        pub slot_b: Mutex<Option<String>>,
        /// The combined item of versions 0.2.0 to 0.2.2.
        pub previous: Mutex<Option<String>>,
        /// The separate item of a retired key of still older versions.
        pub legacy: Mutex<Option<String>>,
        /// Every read of any item.
        pub reads: Mutex<u32>,
        /// Reads of the old items: the ones that can show the macOS dialog.
        pub old_reads: Mutex<u32>,
        /// Items stored (`write_slot`) and slots emptied (`delete_slot`).
        pub writes: Mutex<u32>,
        pub slot_deletes: Mutex<u32>,
        pub old_deletes: Mutex<u32>,
        /// The next `read_slot` fails (the keychain is locked), once per entry.
        pub deny_reads: Mutex<u32>,
        /// The next reads of the old items fail (the dialog was denied), once per entry.
        pub deny_old_reads: Mutex<u32>,
        /// Writes (counted from 1, for the whole life of the fake) that fail.
        pub failing_writes: Mutex<Vec<u32>>,
        pub fail_old_deletes: Mutex<bool>,
    }

    impl FakeKeychain {
        fn slot(&self, slot: Slot) -> &Mutex<Option<String>> {
            match slot {
                Slot::A => &self.slot_a,
                Slot::B => &self.slot_b,
            }
        }
    }

    fn bump(counter: &Mutex<u32>) -> u32 {
        let mut counter = counter.lock().unwrap();
        *counter += 1;
        *counter
    }

    fn take_denial(counter: &Mutex<u32>) -> bool {
        let mut counter = counter.lock().unwrap();
        if *counter > 0 {
            *counter -= 1;
            return true;
        }
        false
    }

    impl BundleBackend for Arc<FakeKeychain> {
        fn read_slot(&self, slot: Slot) -> AppResult<Option<String>> {
            bump(&self.reads);
            if take_denial(&self.deny_reads) {
                return Err(AppError::internal(
                    "Could not read from the macOS Keychain (security exit code 36).",
                ));
            }
            Ok(self.slot(slot).lock().unwrap().clone())
        }

        fn write_slot(&self, slot: Slot, text: &str) -> AppResult<()> {
            let number = bump(&self.writes);
            if self.failing_writes.lock().unwrap().contains(&number) {
                return Err(AppError::internal(
                    "Could not save to the macOS Keychain (security exit code 1).",
                ));
            }
            let mut item = self.slot(slot).lock().unwrap();
            assert!(item.is_none(), "a slot is emptied before it is written");
            *item = Some(text.to_owned());
            Ok(())
        }

        fn delete_slot(&self, slot: Slot) -> AppResult<()> {
            bump(&self.slot_deletes);
            *self.slot(slot).lock().unwrap() = None;
            Ok(())
        }

        fn read_previous_bundle(&self) -> AppResult<Option<String>> {
            bump(&self.reads);
            bump(&self.old_reads);
            if take_denial(&self.deny_old_reads) {
                return Err(AppError::internal(
                    "Could not read from the macOS Keychain (security exit code 51).",
                ));
            }
            Ok(self.previous.lock().unwrap().clone())
        }

        fn delete_previous_items(&self) -> AppResult<()> {
            bump(&self.old_deletes);
            if *self.fail_old_deletes.lock().unwrap() {
                return Err(AppError::internal(
                    "Could not remove from the macOS Keychain (security exit code 1).",
                ));
            }
            *self.previous.lock().unwrap() = None;
            *self.legacy.lock().unwrap() = None;
            Ok(())
        }
    }

    fn cached(fake: &Arc<FakeKeychain>) -> Secrets {
        Secrets::new(Arc::new(CachedSecretStore::new(Arc::clone(fake))))
    }

    fn count(counter: &Mutex<u32>) -> u32 {
        *counter.lock().unwrap()
    }

    fn put(slot: &Mutex<Option<String>>, text: &str) {
        slot.lock().unwrap().replace(text.to_owned());
    }

    /// The current item of this version, as the store would find it.
    fn stored(fake: &FakeKeychain) -> Bundle {
        let a = fake.slot_a.lock().unwrap().clone();
        let b = fake.slot_b.lock().unwrap().clone();
        let mut items: Vec<Bundle> = [a, b]
            .into_iter()
            .flatten()
            .map(|text| serde_json::from_str(&text).unwrap())
            .collect();
        items.sort_by_key(|bundle| bundle.generation);
        items.pop().expect("an item")
    }

    fn items(fake: &FakeKeychain) -> usize {
        usize::from(fake.slot_a.lock().unwrap().is_some())
            + usize::from(fake.slot_b.lock().unwrap().is_some())
    }

    const PREVIOUS: &str =
        r#"{"secrets":{"second-api-key":"ts_prev","opencode-api-key":"oc_prev"}}"#;

    /// Nothing saved: the startup read finds nothing, nothing is written (so no item appears),
    /// and no later call reads again.
    #[test]
    fn nothing_stored_reads_once_and_writes_nothing() {
        let fake = Arc::new(FakeKeychain::default());
        let secrets = cached(&fake);
        secrets.preload();
        for _ in 0..5 {
            assert_eq!(secrets.get(SECOND).unwrap(), None);
            assert_eq!(secrets.get(OPENCODE_GO_KEY).unwrap(), None);
        }
        assert_eq!(
            count(&fake.reads),
            3,
            "the two slots of this version, then the previous item"
        );
        assert_eq!(count(&fake.writes), 0);
        assert_eq!(count(&fake.old_deletes), 0);
        assert_eq!(items(&fake), 0);
        assert_eq!(secrets.unreadable(), None);
    }

    /// Both keys live in one item that is read once; saving and removing write through and keep
    /// the copy in memory current. Each save moves to the other slot and leaves one item.
    #[test]
    fn one_item_holds_both_keys_and_is_read_once() {
        let fake = Arc::new(FakeKeychain::default());
        let secrets = cached(&fake);
        secrets.preload();
        secrets.set(SECOND, "ts_key").unwrap();
        assert!(fake.slot_a.lock().unwrap().is_some());
        secrets.set(OPENCODE_GO_KEY, "oc_sk_key").unwrap();
        assert!(fake.slot_a.lock().unwrap().is_none());
        assert!(fake.slot_b.lock().unwrap().is_some());
        let bundle = stored(&fake);
        assert_eq!(bundle.secrets.len(), 2);
        assert_eq!(bundle.generation, 2);
        assert!(bundle.legacy_removed);
        assert_eq!(items(&fake), 1);
        assert_eq!(
            secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some("oc_sk_key")
        );
        secrets.delete(SECOND).unwrap();
        assert_eq!(secrets.get(SECOND).unwrap(), None);
        assert_eq!(stored(&fake).secrets.len(), 1);
        assert_eq!(stored(&fake).generation, 3);
        // Removing the last key removes the item, so the next start reads nothing.
        secrets.delete(OPENCODE_GO_KEY).unwrap();
        assert_eq!(items(&fake), 0);
        assert_eq!(count(&fake.reads), 3, "only the startup read");
        assert_eq!(count(&fake.old_deletes), 0, "nothing old to remove");

        // A new run reads the two slots once, and nothing else.
        *fake.reads.lock().unwrap() = 0;
        *fake.old_reads.lock().unwrap() = 0;
        put(
            &fake.slot_b,
            r#"{"secrets":{"opencode-api-key":"k2"},"generation":7}"#,
        );
        let next_run = cached(&fake);
        next_run.preload();
        assert_eq!(
            next_run.get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some("k2")
        );
        assert_eq!(next_run.get(SECOND).unwrap(), None);
        assert_eq!(count(&fake.reads), 2);
        assert_eq!(count(&fake.old_reads), 0);
        // Its first save goes to the other slot.
        next_run.set(SECOND, "ts").unwrap();
        assert!(fake.slot_b.lock().unwrap().is_none());
        assert_eq!(stored(&fake).generation, 8);
    }

    /// Of two items the newest is current, and a save removes the other one first, so a leftover
    /// of an interrupted save never wins and never survives.
    #[test]
    fn the_newest_slot_wins_and_the_leftover_is_removed_by_the_next_save() {
        let fake = Arc::new(FakeKeychain::default());
        put(
            &fake.slot_a,
            r#"{"secrets":{"opencode-api-key":"newer"},"generation":6}"#,
        );
        put(
            &fake.slot_b,
            r#"{"secrets":{"opencode-api-key":"older"},"generation":5}"#,
        );
        let secrets = cached(&fake);
        assert_eq!(
            secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some("newer")
        );
        secrets.set(SECOND, "ts").unwrap();
        assert!(fake.slot_a.lock().unwrap().is_none());
        assert_eq!(items(&fake), 1);
        let bundle = stored(&fake);
        assert_eq!(bundle.generation, 7);
        assert_eq!(bundle.secrets[OPENCODE_GO_KEY], "newer");
        // Removing the last keys removes both.
        put(
            &fake.slot_a,
            r#"{"secrets":{"opencode-api-key":"leftover"},"generation":1}"#,
        );
        secrets.delete(SECOND).unwrap();
        secrets.delete(OPENCODE_GO_KEY).unwrap();
        assert_eq!(items(&fake), 0);
    }

    /// A save that fails to store the new item changes nothing: the current item stays, in
    /// memory and in the Keychain.
    #[test]
    fn a_failed_save_keeps_the_current_item() {
        let fake = Arc::new(FakeKeychain::default());
        let secrets = cached(&fake);
        secrets.set(OPENCODE_GO_KEY, "first").unwrap();
        let writes = count(&fake.writes);
        *fake.failing_writes.lock().unwrap() = vec![writes + 1];
        assert!(secrets.set(OPENCODE_GO_KEY, "second").is_err());
        assert_eq!(
            secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some("first")
        );
        assert_eq!(stored(&fake).secrets[OPENCODE_GO_KEY], "first");
        assert_eq!(items(&fake), 1);
        // And the next one works.
        secrets.set(OPENCODE_GO_KEY, "third").unwrap();
        assert_eq!(stored(&fake).secrets[OPENCODE_GO_KEY], "third");
        assert_eq!(items(&fake), 1);
    }

    /// The combined item of 0.2.x moves to this version's item; the old one is removed only once
    /// the new one is stored and read back, and the old items are never read again.
    #[test]
    fn the_previous_item_is_migrated_without_losing_a_key() {
        let fake = Arc::new(FakeKeychain::default());
        put(&fake.previous, PREVIOUS);
        put(&fake.legacy, "ts_leftover");
        let secrets = cached(&fake);
        secrets.preload();
        assert_eq!(secrets.get(SECOND).unwrap().as_deref(), Some("ts_prev"));
        assert_eq!(
            secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some("oc_prev")
        );
        assert!(fake.previous.lock().unwrap().is_none());
        assert!(fake.legacy.lock().unwrap().is_none());
        let bundle = stored(&fake);
        assert_eq!(bundle.secrets[SECOND], "ts_prev");
        assert_eq!(bundle.secrets[OPENCODE_GO_KEY], "oc_prev");
        assert!(bundle.legacy_removed);
        assert_eq!(items(&fake), 1);
        assert_eq!(
            count(&fake.writes),
            2,
            "keys with the flag down, then the flag up"
        );
        assert_eq!(count(&fake.old_reads), 1, "the previous item only, once");

        // The next start never looks at the old items.
        *fake.reads.lock().unwrap() = 0;
        let next_run = cached(&fake);
        next_run.preload();
        assert_eq!(next_run.get(SECOND).unwrap().as_deref(), Some("ts_prev"));
        assert_eq!(count(&fake.reads), 2);
        assert_eq!(count(&fake.old_reads), 1);
    }

    /// A key of the retired integration in an item is never loaded and is left out of the item
    /// with the next write; the other key is kept.
    #[test]
    fn a_retired_key_in_the_item_is_dropped_at_the_next_write() {
        let fake = Arc::new(FakeKeychain::default());
        put(
            &fake.slot_a,
            r#"{"secrets":{"typesafe-api-key":"ts_old","opencode-api-key":"oc_keep"},"generation":3}"#,
        );
        let secrets = cached(&fake);
        secrets.preload();
        assert_eq!(secrets.unreadable(), None);
        assert_eq!(secrets.get(RETIRED_KEY).unwrap(), None);
        assert_eq!(
            secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some("oc_keep")
        );
        assert_eq!(count(&fake.writes), 0, "loading never writes");
        secrets.set(SECOND, "other").unwrap();
        let bundle = stored(&fake);
        assert!(!bundle.secrets.contains_key(RETIRED_KEY));
        assert_eq!(bundle.secrets[OPENCODE_GO_KEY], "oc_keep");
        assert_eq!(bundle.secrets[SECOND], "other");
        assert_eq!(bundle.generation, 4);
    }

    /// The previous combined item migrates the other key and leaves the retired one behind.
    #[test]
    fn a_retired_key_is_not_carried_over_from_the_previous_item() {
        let fake = Arc::new(FakeKeychain::default());
        put(
            &fake.previous,
            r#"{"secrets":{"typesafe-api-key":"ts_prev","opencode-api-key":"oc_prev"}}"#,
        );
        let secrets = cached(&fake);
        secrets.preload();
        assert_eq!(secrets.get(RETIRED_KEY).unwrap(), None);
        assert_eq!(
            secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some("oc_prev")
        );
        let bundle = stored(&fake);
        assert_eq!(bundle.secrets.len(), 1);
        assert_eq!(bundle.secrets[OPENCODE_GO_KEY], "oc_prev");
        assert!(bundle.legacy_removed);
        assert!(fake.previous.lock().unwrap().is_none());
    }

    /// A previous item with nothing but a retired key has nothing to keep: the old items go and
    /// no item of this version appears.
    #[test]
    fn a_previous_item_with_only_a_retired_key_is_just_removed() {
        let fake = Arc::new(FakeKeychain::default());
        put(
            &fake.previous,
            r#"{"secrets":{"typesafe-api-key":"ts_prev"}}"#,
        );
        let secrets = cached(&fake);
        secrets.preload();
        assert_eq!(secrets.get(OPENCODE_GO_KEY).unwrap(), None);
        assert_eq!(count(&fake.writes), 0);
        assert_eq!(items(&fake), 0);
        assert!(fake.previous.lock().unwrap().is_none());
    }

    /// The separate item of a retired key of still older versions is not read (no dialog).
    #[test]
    fn the_separate_retired_item_is_not_read() {
        let fake = Arc::new(FakeKeychain::default());
        put(&fake.legacy, "ts_old");
        let secrets = cached(&fake);
        secrets.preload();
        assert_eq!(secrets.get(OPENCODE_GO_KEY).unwrap(), None);
        assert_eq!(count(&fake.writes), 0);
        assert_eq!(items(&fake), 0);
    }

    /// Interrupted before the new item is stored: nothing is removed, the keys are used in this
    /// run, and the next start migrates again.
    #[test]
    fn a_failed_first_write_leaves_the_old_items_alone() {
        let fake = Arc::new(FakeKeychain::default());
        put(&fake.previous, PREVIOUS);
        *fake.failing_writes.lock().unwrap() = vec![1];
        let secrets = cached(&fake);
        assert_eq!(secrets.get(SECOND).unwrap().as_deref(), Some("ts_prev"));
        assert_eq!(fake.previous.lock().unwrap().as_deref(), Some(PREVIOUS));
        assert_eq!(count(&fake.old_deletes), 0);
        assert_eq!(items(&fake), 0);

        let next_run = cached(&fake);
        next_run.preload();
        assert_eq!(
            next_run.get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some("oc_prev")
        );
        assert!(fake.previous.lock().unwrap().is_none());
        assert!(stored(&fake).legacy_removed);
    }

    /// Interrupted after the new item was stored, before the old items were removed (removing
    /// failed, or the process ended): startup uses the new item and never touches the old ones;
    /// the next write removes them.
    #[test]
    fn a_leftover_old_item_is_removed_with_the_next_write_not_at_startup() {
        let fake = Arc::new(FakeKeychain::default());
        put(&fake.previous, PREVIOUS);
        put(&fake.legacy, "ts_leftover");
        *fake.fail_old_deletes.lock().unwrap() = true;
        let secrets = cached(&fake);
        secrets.preload();
        assert_eq!(secrets.get(SECOND).unwrap().as_deref(), Some("ts_prev"));
        assert!(!stored(&fake).legacy_removed);
        assert!(fake.previous.lock().unwrap().is_some());

        // Next start (still failing): the new item alone is read.
        *fake.reads.lock().unwrap() = 0;
        *fake.old_reads.lock().unwrap() = 0;
        *fake.old_deletes.lock().unwrap() = 0;
        let next_run = cached(&fake);
        next_run.preload();
        assert_eq!(count(&fake.reads), 2);
        assert_eq!(count(&fake.old_reads), 0);
        assert_eq!(count(&fake.old_deletes), 0);

        // A save while removing still fails keeps the flag down, and keeps trying.
        next_run.set(OPENCODE_GO_KEY, "oc_new").unwrap();
        assert!(!stored(&fake).legacy_removed);
        assert_eq!(count(&fake.old_deletes), 1);
        // Once removing works, the next write removes them and raises the flag.
        *fake.fail_old_deletes.lock().unwrap() = false;
        next_run.set(OPENCODE_GO_KEY, "oc_newer").unwrap();
        assert!(fake.previous.lock().unwrap().is_none());
        assert!(fake.legacy.lock().unwrap().is_none());
        assert!(stored(&fake).legacy_removed);
        // From then on a write removes nothing.
        next_run.set(OPENCODE_GO_KEY, "oc_last").unwrap();
        assert_eq!(count(&fake.old_deletes), 2);
    }

    /// Interrupted after the old items were removed, before the flag was raised: the keys are in
    /// the new item, the next write finds nothing left to remove and raises it.
    #[test]
    fn an_interruption_after_removing_the_old_items_loses_nothing() {
        let fake = Arc::new(FakeKeychain::default());
        put(&fake.previous, PREVIOUS);
        *fake.failing_writes.lock().unwrap() = vec![2];
        let secrets = cached(&fake);
        secrets.preload();
        assert!(fake.previous.lock().unwrap().is_none());
        assert!(!stored(&fake).legacy_removed);
        assert_eq!(
            secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some("oc_prev")
        );

        let next_run = cached(&fake);
        next_run.preload();
        assert_eq!(
            next_run.get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some("oc_prev")
        );
        next_run.set(OPENCODE_GO_KEY, "oc_new").unwrap();
        assert!(stored(&fake).legacy_removed);
        assert_eq!(stored(&fake).secrets[SECOND], "ts_prev");
    }

    /// The last key is removed while old items could not be: the item stays, empty, so the next
    /// start does not bring the removed key back from an old item.
    #[test]
    fn a_removed_key_does_not_come_back_from_an_old_item() {
        let fake = Arc::new(FakeKeychain::default());
        put(
            &fake.previous,
            r#"{"secrets":{"opencode-api-key":"oc_prev"}}"#,
        );
        *fake.fail_old_deletes.lock().unwrap() = true;
        let secrets = cached(&fake);
        secrets.preload();
        secrets.delete(OPENCODE_GO_KEY).unwrap();
        assert!(stored(&fake).secrets.is_empty());
        assert!(!stored(&fake).legacy_removed);

        let next_run = cached(&fake);
        next_run.preload();
        assert_eq!(next_run.get(OPENCODE_GO_KEY).unwrap(), None);
        assert!(
            fake.previous.lock().unwrap().is_some(),
            "never touched at startup"
        );
        // Once the old items can go, the item goes with the last write.
        *fake.fail_old_deletes.lock().unwrap() = false;
        next_run.set(SECOND, "ts").unwrap();
        next_run.delete(SECOND).unwrap();
        assert_eq!(items(&fake), 0);
        assert!(fake.previous.lock().unwrap().is_none());
    }

    /// Startup with this version's item and a leftover old one reads the new item once and
    /// never touches the old one: no dialog.
    #[test]
    fn startup_with_a_leftover_old_item_reads_only_the_new_item() {
        let fake = Arc::new(FakeKeychain::default());
        put(
            &fake.slot_a,
            r#"{"secrets":{"second-api-key":"ts_key_1234","opencode-api-key":"oc_sk_5678"}}"#,
        );
        put(&fake.previous, PREVIOUS);
        put(&fake.legacy, "ts_old");
        let secrets = cached(&fake);
        secrets.preload();
        assert_eq!(secrets.get(SECOND).unwrap().as_deref(), Some("ts_key_1234"));
        assert_eq!(
            secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some("oc_sk_5678")
        );
        assert_eq!(count(&fake.reads), 2);
        assert_eq!(count(&fake.old_reads), 0);
        assert_eq!(count(&fake.old_deletes), 0);
        assert_eq!(fake.legacy.lock().unwrap().as_deref(), Some("ts_old"));
    }

    /// A denied dialog of the migration read, or a locked Keychain: VidAI behaves as if no key is
    /// saved, never asks again by itself, refuses to overwrite what it could not read, changes
    /// nothing, and reads again only on Try Again.
    #[test]
    fn a_denied_read_is_not_retried_until_try_again() {
        let fake = Arc::new(FakeKeychain::default());
        put(&fake.previous, PREVIOUS);
        *fake.deny_old_reads.lock().unwrap() = 1;
        let secrets = cached(&fake);
        secrets.preload();
        assert_eq!(secrets.unreadable().as_deref(), Some(UNREADABLE_MESSAGE));
        for _ in 0..3 {
            let err = secrets.get(SECOND).unwrap_err();
            assert_eq!(err.code, crate::error::ErrorCode::SecretsUnavailable);
        }
        assert_eq!(
            secrets.set(OPENCODE_GO_KEY, "k").unwrap_err().code,
            crate::error::ErrorCode::SecretsUnavailable
        );
        assert_eq!(count(&fake.old_reads), 1);
        assert_eq!(count(&fake.writes), 0);
        assert_eq!(count(&fake.old_deletes), 0);
        assert_eq!(fake.previous.lock().unwrap().as_deref(), Some(PREVIOUS));

        secrets.retry().unwrap();
        assert_eq!(count(&fake.old_reads), 2);
        assert_eq!(secrets.unreadable(), None);
        assert_eq!(secrets.get(SECOND).unwrap().as_deref(), Some("ts_prev"));
        assert!(stored(&fake).legacy_removed);
        // Once read, Try Again does not read again.
        let reads = count(&fake.reads);
        secrets.retry().unwrap();
        assert_eq!(count(&fake.reads), reads);

        // A locked keychain for this version's item behaves the same.
        let fake = Arc::new(FakeKeychain::default());
        put(&fake.slot_a, r#"{"secrets":{"second-api-key":"ts_key"}}"#);
        *fake.deny_reads.lock().unwrap() = 1;
        let secrets = cached(&fake);
        secrets.preload();
        assert_eq!(secrets.unreadable().as_deref(), Some(UNREADABLE_MESSAGE));
        assert_eq!(
            count(&fake.old_reads),
            0,
            "an old item is not a way around a lock"
        );
        secrets.retry().unwrap();
        assert_eq!(secrets.get(SECOND).unwrap().as_deref(), Some("ts_key"));
    }

    /// Text that is not a bundle is unreadable, never overwritten or migrated away, also when it
    /// is in the slot that could be the newer one.
    #[test]
    fn an_unparseable_item_is_unreadable_and_kept() {
        for slot in [Slot::A, Slot::B] {
            let fake = Arc::new(FakeKeychain::default());
            put(fake.slot(slot), "not json");
            put(fake.slot(slot.other()), r#"{"secrets":{},"generation":1}"#);
            let secrets = cached(&fake);
            secrets.preload();
            assert_eq!(secrets.unreadable().as_deref(), Some(UNREADABLE_MESSAGE));
            assert_eq!(count(&fake.writes), 0);
            assert_eq!(count(&fake.slot_deletes), 0);
        }

        let fake = Arc::new(FakeKeychain::default());
        put(&fake.previous, "[1,2]");
        let secrets = cached(&fake);
        secrets.preload();
        assert_eq!(secrets.unreadable().as_deref(), Some(UNREADABLE_MESSAGE));
        assert_eq!(count(&fake.writes), 0);
        assert_eq!(count(&fake.old_deletes), 0);
    }

    /// The owner's report: the Keychain must be read once per run, not at every job launch. One
    /// run with a key saved: the startup read, then what every later moment asks for, with the
    /// functions those moments use (job launches and renders read the key through
    /// `opencode::saved_key`, Settings shows its status, the quota refresh and the model list read
    /// it), and saving a key. One read in all (of
    /// the two slots, which no dialog can come from).
    #[test]
    fn a_whole_run_reads_the_keychain_once() {
        const GO: crate::model::ApiOption = crate::model::ApiOption::OpencodeGo;
        let fake = Arc::new(FakeKeychain::default());
        put(
            &fake.slot_a,
            r#"{"secrets":{"opencode-api-key":"oc_sk_5678"}}"#,
        );
        let secrets = cached(&fake);
        secrets.preload();
        for _launch in 0..5 {
            assert!(crate::opencode::saved_key(&secrets, GO).unwrap().is_some());
        }
        for _status_check in 0..3 {
            assert!(
                crate::opencode::key_status(&secrets, GO)
                    .unwrap()
                    .configured
            );
        }
        let _quota_refresh = crate::opencode::saved_key(&secrets, GO).unwrap();
        crate::opencode::save_key(&secrets, GO, "oc_sk_new_9999").unwrap();
        assert_eq!(
            crate::opencode::saved_key(&secrets, GO).unwrap().as_deref(),
            Some("oc_sk_new_9999")
        );
        assert_eq!(count(&fake.reads), 2, "the startup read of the two slots");
        assert_eq!(count(&fake.old_reads), 0);
        assert_eq!(count(&fake.writes), 1);
    }

    /// The preload thread and the first `get` of a job can race: they share one read.
    #[test]
    fn racing_threads_share_the_one_read() {
        let fake = Arc::new(FakeKeychain::default());
        put(&fake.previous, PREVIOUS);
        let secrets = cached(&fake);
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let secrets = secrets.clone();
                std::thread::spawn(move || {
                    if i % 2 == 0 {
                        secrets.preload();
                    }
                    secrets.get(OPENCODE_GO_KEY).unwrap()
                })
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap().as_deref(), Some("oc_prev"));
        }
        assert_eq!(
            count(&fake.old_reads),
            1,
            "one read of the old item, not one per thread"
        );
        assert_eq!(count(&fake.reads), 3);
    }

    #[test]
    fn the_first_get_reads_when_it_comes_before_the_startup_read() {
        let fake = Arc::new(FakeKeychain::default());
        put(&fake.slot_b, r#"{"secrets":{"opencode-api-key":"oc"}}"#);
        let secrets = cached(&fake);
        assert_eq!(secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(), Some("oc"));
        secrets.preload();
        assert_eq!(count(&fake.reads), 2);
    }

    /// The text of the item is printable ASCII (so `security -w` prints it as it is) and means
    /// the same.
    #[test]
    fn the_item_text_is_ascii_and_round_trips() {
        let bundle = Bundle {
            secrets: BTreeMap::from([
                (
                    SECOND.to_owned(),
                    "caf\u{e9} \"q\" \\ \u{20ac} \u{1f600}".to_owned(),
                ),
                (OPENCODE_GO_KEY.to_owned(), "line\nbreak\ttab".to_owned()),
            ]),
            legacy_removed: true,
            generation: 3,
        };
        let text = bundle.to_text().unwrap();
        assert!(text.bytes().all(|b| (0x20..0x7f).contains(&b)), "{text}");
        assert_eq!(Bundle::parse(&text).unwrap(), bundle);
    }

    #[test]
    fn the_key_of_0_2_4_is_the_go_key_and_the_next_write_drops_its_old_name() {
        let fake = Arc::new(FakeKeychain::default());
        put(
            &fake.slot_a,
            r#"{"secrets":{"opencode-api-key":"oc_old","anthropic-api-key":"ant"},"generation":2}"#,
        );
        let secrets = cached(&fake);
        secrets.preload();
        assert_eq!(
            secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some("oc_old")
        );
        assert_eq!(secrets.get(ANTHROPIC_KEY).unwrap().as_deref(), Some("ant"));
        assert_eq!(secrets.get(OPENAI_KEY).unwrap(), None);
        // The old name is not a name of this version.
        assert_eq!(secrets.get(LEGACY_OPENCODE_KEY).unwrap(), None);
        secrets.set(OPENAI_KEY, "oa").unwrap();
        let bundle = stored(&fake);
        assert!(!bundle.secrets.contains_key(LEGACY_OPENCODE_KEY));
        assert_eq!(bundle.secrets[OPENCODE_GO_KEY], "oc_old");
        assert_eq!(bundle.secrets[OPENAI_KEY], "oa");
        // A key saved under the new name wins over one still under the old name.
        let fake = Arc::new(FakeKeychain::default());
        put(
            &fake.slot_a,
            r#"{"secrets":{"opencode-api-key":"old","opencode-go-api-key":"new"},"generation":1}"#,
        );
        let secrets = cached(&fake);
        secrets.preload();
        assert_eq!(
            secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some("new")
        );
    }

    /// A store at version 8 that chose Claude Code on OpenCode, with its file in a temp folder.
    fn pending_store() -> (tempfile::TempDir, crate::store::Store) {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"schemaVersion":8,"provider":"opencode","opencode":{"model":"glm-5.3","harness":"claudeCode"}}"#,
        )
        .unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        assert!(store.api_key_migration_pending());
        (dir, store)
    }

    #[test]
    fn the_old_key_is_copied_to_the_anthropic_field_before_settings_are_written() {
        let (dir, store) = pending_store();
        let secrets = Secrets::new(Arc::new(MemorySecretStore::default()));
        secrets.set(OPENCODE_GO_KEY, "oc_sk_old").unwrap();
        finish_key_migration(&store, &secrets).unwrap();
        assert_eq!(
            secrets.get(ANTHROPIC_KEY).unwrap().as_deref(),
            Some("oc_sk_old")
        );
        // The Go key stays: both options keep working.
        assert_eq!(
            secrets.get(OPENCODE_GO_KEY).unwrap().as_deref(),
            Some("oc_sk_old")
        );
        assert!(!store.api_key_migration_pending());
        let text = std::fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert!(text.contains(r#""schemaVersion": 9"#) || text.contains(r#""schemaVersion":9"#));
        assert!(text.contains("anthropicApi"));
        // Nothing is pending any more: a second call changes nothing.
        secrets.set(ANTHROPIC_KEY, "changed").unwrap();
        finish_key_migration(&store, &secrets).unwrap();
        assert_eq!(
            secrets.get(ANTHROPIC_KEY).unwrap().as_deref(),
            Some("changed")
        );
    }

    #[test]
    fn a_key_already_saved_for_the_anthropic_api_is_not_overwritten() {
        let (_dir, store) = pending_store();
        let secrets = Secrets::new(Arc::new(MemorySecretStore::default()));
        secrets.set(OPENCODE_GO_KEY, "oc_sk_old").unwrap();
        secrets.set(ANTHROPIC_KEY, "sk-ant-mine").unwrap();
        finish_key_migration(&store, &secrets).unwrap();
        assert_eq!(
            secrets.get(ANTHROPIC_KEY).unwrap().as_deref(),
            Some("sk-ant-mine")
        );
        assert!(!store.api_key_migration_pending());
    }

    #[test]
    fn without_an_old_key_the_migration_still_finishes() {
        let (_dir, store) = pending_store();
        let secrets = Secrets::new(Arc::new(MemorySecretStore::default()));
        finish_key_migration(&store, &secrets).unwrap();
        assert_eq!(secrets.get(ANTHROPIC_KEY).unwrap(), None);
        assert!(!store.api_key_migration_pending());
    }

    #[test]
    fn an_unreadable_keychain_leaves_the_migration_pending_until_try_again() {
        let (dir, store) = pending_store();
        let fake = Arc::new(FakeKeychain::default());
        put(
            &fake.slot_a,
            r#"{"secrets":{"opencode-api-key":"oc_sk_old"},"generation":1}"#,
        );
        *fake.deny_reads.lock().unwrap() = 1;
        let secrets = cached(&fake);
        secrets.preload();
        assert!(secrets.unreadable().is_some());
        let before = std::fs::read(dir.path().join("settings.json")).unwrap();
        assert!(finish_key_migration(&store, &secrets).is_err());
        assert!(store.api_key_migration_pending());
        assert_eq!(
            std::fs::read(dir.path().join("settings.json")).unwrap(),
            before
        );
        // Try Again reads the keychain; then the step completes.
        secrets.retry().unwrap();
        finish_key_migration(&store, &secrets).unwrap();
        assert_eq!(
            secrets.get(ANTHROPIC_KEY).unwrap().as_deref(),
            Some("oc_sk_old")
        );
        assert!(!store.api_key_migration_pending());
        assert_ne!(
            std::fs::read(dir.path().join("settings.json")).unwrap(),
            before
        );
    }

    #[test]
    fn env_override_selects_memory_store() {
        // Only the choice is tested: constructing the keychain store is not allowed in tests.
        assert_eq!(
            choose_store(Some(OsStr::new("memory"))),
            StoreChoice::Memory
        );
        assert_eq!(
            choose_store(Some(OsStr::new("MEMORY"))),
            StoreChoice::Memory
        );
        assert_eq!(choose_store(Some(OsStr::new(""))), StoreChoice::Platform);
        assert_eq!(
            choose_store(Some(OsStr::new("keychain"))),
            StoreChoice::Platform
        );
        assert_eq!(choose_store(None), StoreChoice::Platform);
    }
}

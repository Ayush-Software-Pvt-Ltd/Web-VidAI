//! Toolkit seeding and selection (SPEC section 7).
//!
//! Responsibility:
//! - Seed what is missing in the Editing Folder from the bundled `resources/toolkit.tar.gz`
//!   (path from `resources::toolkit_archive`): the `CLAUDE_VE_ALL` folder, `MEMORY.md` and
//!   `CLAUDE.md`, each only when it does not exist. Existing files are never changed and
//!   symlinks in the archive are restored as symlinks (on Windows, where creating symlinks
//!   needs a privilege most users do not have, as copies of what they point to, see below).
//! - Create `CLAUDE_VE_ALL_OWN` with a short `README.md` on request.
//! - Report `ToolkitStatus` and switch `Settings::active_toolkit` (`own` only once it exists).
//!
//! Crash safety: everything is first built in a hidden temporary sibling directory
//! (`<Editing Folder>/.vidai-seed-<uuid>`, reserved because it starts with a dot), with every
//! file synced to disk, and only then moved into place with one rename per item. A crash can
//! therefore never leave a half-extracted `CLAUDE_VE_ALL` that later counts as existing. Leftover
//! temporary directories from a crash are removed by the next seeding.
//!
//! The archive is checked while it is extracted: absolute paths, `..` components, links that
//! point outside their toolkit folder, hard links and special files are rejected, and nothing is
//! ever written through a symlink. Names that Windows cannot store (reserved device names such
//! as `CON` or `NUL`, the characters `<>:"|?*\`, a trailing dot or space) and names that differ
//! only in letter case are rejected on every platform, so one archive works on macOS and
//! Windows alike.
//!
//! Windows: the links of the archive (the toolkit's `gfx/templates/*/shared` folders) are
//! materialized once everything else is extracted, as real copies of their targets, still inside
//! the temporary folder. This works for every user and on every file system (also exFAT and
//! FAT32 drives) and survives moving or renaming the Editing Folder. A link whose target is not
//! in the archive is left out. Paths longer than 260 characters work because the Rust standard
//! library uses extended-length paths for them.
//!
//! [`on_startup`] is called once from `lib.rs` after the store is managed.

use std::fs::{self, File};
use std::io::{self, ErrorKind};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::model::{
    OWN_TOOLKIT_FOLDER, STANDARD_TOOLKIT_FOLDER, Settings, ToolkitFolder, ToolkitKind,
    ToolkitStatus,
};
use crate::platform;
use crate::resources;
use crate::store::Store;

/// The top-level items of the archive that are seeded, each only when missing.
pub const SEED_ITEMS: [&str; 3] = [STANDARD_TOOLKIT_FOLDER, "MEMORY.md", "CLAUDE.md"];
/// Prefix of the temporary directories used while seeding.
const TEMP_PREFIX: &str = ".vidai-seed-";
/// Content of `CLAUDE_VE_ALL_OWN/README.md`.
pub const OWN_README: &str = "# CLAUDE_VE_ALL_OWN\n\n\
This is your own toolkit.\n\
Claude builds its tools here during edits, instead of using the standard toolkit in CLAUDE_VE_ALL.\n\
VidAI created this folder and never changes, moves or deletes anything in it.\n";

/// Serializes every write into an Editing Folder done by this module.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Startup hook: seed the toolkit into the current Editing Folder, if one is set.
pub fn on_startup(app: &AppHandle) -> AppResult<()> {
    let Some(folder) = app.state::<Store>().settings().editing_folder else {
        return Ok(());
    };
    let folder = PathBuf::from(folder);
    if !folder.is_dir() {
        return Ok(());
    }
    seed_from_bundle(app, &folder).map(|_| ())
}

/// Seeds `editing_folder` from the bundled archive. Returns the names of the items created.
pub fn seed_from_bundle(app: &AppHandle, editing_folder: &Path) -> AppResult<Vec<String>> {
    if missing_items(editing_folder).is_empty() {
        return Ok(Vec::new());
    }
    let archive = resources::toolkit_archive(app)?;
    seed(editing_folder, &archive)
}

/// True when something (file, folder or symlink, even a dangling one) exists at `path`.
fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn missing_items(editing_folder: &Path) -> Vec<&'static str> {
    SEED_ITEMS
        .into_iter()
        .filter(|name| !exists(&editing_folder.join(name)))
        .collect()
}

/// Seeds what is missing of [`SEED_ITEMS`] into `editing_folder` from the `.tar.gz` at
/// `archive`. Existing items are never touched. Returns the names of the items created.
pub fn seed(editing_folder: &Path, archive: &Path) -> AppResult<Vec<String>> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    if !editing_folder.is_dir() {
        return Err(AppError::not_found(format!(
            "The Editing Folder {} does not exist.",
            editing_folder.display()
        )));
    }
    remove_stale_temp_dirs(editing_folder);
    let missing = missing_items(editing_folder);
    if missing.is_empty() {
        return Ok(Vec::new());
    }
    let temp = TempDir::create(editing_folder)?;
    extract(archive, temp.path(), &missing)?;

    let mut created = Vec::new();
    for name in missing {
        let staged = temp.path().join(name);
        if !exists(&staged) {
            continue; // not in this archive
        }
        if place(&staged, &editing_folder.join(name))? {
            created.push(name.to_owned());
        }
    }
    sync_dir(editing_folder);
    Ok(created)
}

/// Moves a staged item into place unless something appeared there meanwhile. Returns whether it
/// was placed.
fn place(staged: &Path, target: &Path) -> AppResult<bool> {
    let is_dir = fs::symlink_metadata(staged)
        .map_err(|e| AppError::io_at("Could not read", staged, e))?
        .is_dir();
    if is_dir {
        // `rename` would replace an empty directory created in the meantime, so check right
        // before. Nothing else in VidAI writes these names.
        if exists(target) {
            return Ok(false);
        }
        platform::rename(staged, target)
            .map_err(|e| AppError::io_at("Could not create", target, e))?;
        return Ok(true);
    }
    // A hard link never replaces an existing file, so files are placed without any race.
    match fs::hard_link(staged, target) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(false),
        // File systems without hard links (exFAT, FAT32): a new file, which never replaces one
        // either.
        Err(_) => copy_new(staged, target),
    }
}

/// Copies `staged` to the new file `target`; `false` when `target` exists.
fn copy_new(staged: &Path, target: &Path) -> AppResult<bool> {
    let mut file = match File::options().write(true).create_new(true).open(target) {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(AppError::io_at("Could not create", target, e)),
    };
    let copied = File::open(staged)
        .and_then(|mut source| io::copy(&mut source, &mut file))
        .and_then(|_| file.sync_all());
    if let Err(e) = copied {
        drop(file);
        let _ = fs::remove_file(target);
        return Err(AppError::io_at("Could not write", target, e));
    }
    Ok(true)
}

/// Removes temporary directories left behind by a crash during an earlier seeding.
fn remove_stale_temp_dirs(editing_folder: &Path) {
    let Ok(entries) = fs::read_dir(editing_folder) else {
        return;
    };
    for entry in entries.flatten() {
        let is_temp = entry.file_name().to_string_lossy().starts_with(TEMP_PREFIX);
        let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
        if is_temp && is_dir {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// A temporary directory inside the Editing Folder, removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn create(parent: &Path) -> AppResult<Self> {
        let path = parent.join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir(&path).map_err(|e| AppError::io_at("Could not create", &path, e))?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(dir) = File::open(dir) {
        let _ = dir.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

// ---------------------------------------------------------------------------------------------
// Archive extraction
// ---------------------------------------------------------------------------------------------

fn invalid_archive(reason: impl std::fmt::Display) -> AppError {
    AppError::internal(format!("The bundled toolkit archive is invalid: {reason}"))
}

/// The entry path as plain names, without `.` components. Rejects absolute paths and `..`.
fn safe_components(path: &Path) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => {
                let name = name
                    .to_str()
                    .ok_or_else(|| invalid_archive(format!("{} is not UTF-8", path.display())))?;
                if let Some(problem) = platform::windows_name_problem(name) {
                    return Err(invalid_archive(format!("{}: {problem}", path.display())));
                }
                out.push(name.to_owned());
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(invalid_archive(format!(
                    "{} points outside the toolkit",
                    path.display()
                )));
            }
        }
    }
    Ok(out)
}

/// Checks that a symlink at `link` (components relative to the staging root) pointing at
/// `target` stays inside the same top-level folder.
fn check_link_target(link: &[String], target: &Path) -> AppResult<Vec<String>> {
    let outside = || {
        invalid_archive(format!(
            "the link {} points outside the toolkit ({})",
            link.join("/"),
            target.display()
        ))
    };
    let mut resolved: Vec<String> = link[..link.len() - 1].to_vec();
    for component in target.components() {
        match component {
            Component::Normal(name) => resolved.push(name.to_str().ok_or_else(outside)?.to_owned()),
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
                if resolved.is_empty() {
                    return Err(outside());
                }
            }
            Component::RootDir | Component::Prefix(_) => return Err(outside()),
        }
    }
    if target.as_os_str().is_empty() {
        return Err(outside());
    }
    Ok(resolved)
}

/// Fails when any existing prefix of `relative` inside `root` is a symlink, so nothing is ever
/// created through a link.
fn check_no_symlink_on_path(root: &Path, relative: &[String]) -> AppResult<()> {
    let mut path = root.to_path_buf();
    for name in relative {
        path.push(name);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(invalid_archive(format!(
                    "{} would be written through a link",
                    relative.join("/")
                )));
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    Ok(())
}

/// Extracts the entries whose top-level name is in `wanted` into `dest`. Every entry of the
/// archive is validated, wanted or not.
fn extract(archive: &Path, dest: &Path, wanted: &[&str]) -> AppResult<()> {
    let file = File::open(archive).map_err(|e| AppError::io_at("Could not open", archive, e))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(io::BufReader::new(file)));
    let entries = tar.entries().map_err(invalid_archive)?;
    // Every entry path in lowercase with its original spelling, to find names that differ only
    // in letter case (one file on macOS and Windows).
    let mut spellings: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    // Windows: links found so far (path, resolved target), materialized after the loop.
    #[cfg(windows)]
    let mut links: Vec<(Vec<String>, Vec<String>)> = Vec::new();
    for entry in entries {
        let mut entry = entry.map_err(invalid_archive)?;
        let kind = entry.header().entry_type();
        if kind.is_pax_global_extensions() || kind.is_pax_local_extensions() {
            continue;
        }
        let raw_path = entry.path().map_err(invalid_archive)?.into_owned();
        let parts = safe_components(&raw_path)?;
        let Some(top) = parts.first() else {
            continue; // the archive root itself (`./`)
        };
        let joined = parts.join("/");
        if let Some(other) = spellings.insert(joined.to_lowercase(), joined.clone())
            && other != joined
        {
            return Err(invalid_archive(format!(
                "{joined} and {other} differ only in letter case"
            )));
        }
        let link_target = if kind.is_symlink() {
            let target = entry
                .link_name()
                .map_err(invalid_archive)?
                .ok_or_else(|| invalid_archive(format!("the link {top} has no target")))?
                .into_owned();
            let resolved = check_link_target(&parts, &target)?;
            Some((target, resolved))
        } else {
            None
        };
        if !(kind.is_file() || kind.is_dir() || kind.is_symlink()) {
            return Err(invalid_archive(format!(
                "{} is not a file, folder or symlink",
                parts.join("/")
            )));
        }
        if !wanted.contains(&top.as_str()) {
            continue;
        }
        if top != STANDARD_TOOLKIT_FOLDER && (parts.len() > 1 || !kind.is_file()) {
            return Err(invalid_archive(format!("{top} must be a single file")));
        }

        check_no_symlink_on_path(dest, &parts)?;
        #[cfg(windows)]
        if links.iter().any(|(link, _)| parts.starts_with(link)) {
            return Err(invalid_archive(format!(
                "{} would be written through a link",
                parts.join("/")
            )));
        }
        let path = parts.iter().fold(dest.to_path_buf(), |p, n| p.join(n));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| AppError::io_at("Could not create", parent, e))?;
        }
        if kind.is_dir() {
            fs::create_dir_all(&path).map_err(|e| AppError::io_at("Could not create", &path, e))?;
        } else if let Some((target, resolved)) = link_target {
            #[cfg(windows)]
            {
                let _ = target;
                links.push((parts, resolved));
            }
            #[cfg(not(windows))]
            {
                let _ = resolved;
                make_symlink(&target, &path)?;
            }
        } else {
            write_file(&mut entry, &path)?;
        }
    }
    #[cfg(windows)]
    materialize_links(dest, links)?;
    Ok(())
}

/// Windows: replaces every link of the archive by a copy of what it points to (see the module
/// documentation). A link is copied once its target holds no link that still waits; links that
/// only wait for each other make the archive invalid, and a link into its own target as well.
#[cfg(windows)]
fn materialize_links(dest: &Path, mut links: Vec<(Vec<String>, Vec<String>)>) -> AppResult<()> {
    let join = |parts: &[String]| parts.iter().fold(dest.to_path_buf(), |p, n| p.join(n));
    while !links.is_empty() {
        // Ready: no other waiting link is the target, lies inside it, or lies on the way to it.
        let ready = (0..links.len()).find(|&i| {
            let target = &links[i].1;
            !links.iter().enumerate().any(|(j, (other, _))| {
                j != i && (other.starts_with(target) || target.starts_with(other))
            })
        });
        let Some(index) = ready else {
            return Err(invalid_archive("its links point at each other"));
        };
        let (link, target) = links.remove(index);
        if link.starts_with(&target) {
            return Err(invalid_archive(format!(
                "the link {} points into itself",
                link.join("/")
            )));
        }
        let (from, to) = (join(&target), join(&link));
        if !exists(&from) {
            eprintln!(
                "vidai: the toolkit link {} points at nothing and was left out",
                link.join("/")
            );
            continue;
        }
        copy_tree(&from, &to)?;
    }
    Ok(())
}

/// Copies the file or folder `from` to the new path `to`, syncing every file to disk.
#[cfg(windows)]
fn copy_tree(from: &Path, to: &Path) -> AppResult<()> {
    let meta = fs::metadata(from).map_err(|e| AppError::io_at("Could not read", from, e))?;
    if meta.is_dir() {
        fs::create_dir(to).map_err(|e| AppError::io_at("Could not create", to, e))?;
        let entries = fs::read_dir(from).map_err(|e| AppError::io_at("Could not read", from, e))?;
        for entry in entries {
            let entry = entry.map_err(|e| AppError::io_at("Could not read", from, e))?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }
    let copy = || -> io::Result<()> {
        let mut source = File::open(from)?;
        let mut file = File::options().write(true).create_new(true).open(to)?;
        io::copy(&mut source, &mut file)?;
        file.sync_all()
    };
    copy().map_err(|e| AppError::io_at("Could not write", to, e))
}

fn write_file(entry: &mut tar::Entry<'_, impl io::Read>, path: &Path) -> AppResult<()> {
    let mode = entry.header().mode().unwrap_or(0o644);
    let result = (|| {
        let mut file = File::options().write(true).create_new(true).open(path)?;
        io::copy(entry, &mut file)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Keep the executable bits, never setuid, setgid or sticky.
            file.set_permissions(fs::Permissions::from_mode((mode & 0o777) | 0o600))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
        file.sync_all()
    })();
    result.map_err(|e| AppError::io_at("Could not write", path, e))
}

#[cfg(unix)]
fn make_symlink(target: &Path, path: &Path) -> AppResult<()> {
    std::os::unix::fs::symlink(target, path)
        .map_err(|e| AppError::io_at("Could not create the link", path, e))
}

#[cfg(not(any(unix, windows)))]
fn make_symlink(_target: &Path, path: &Path) -> AppResult<()> {
    Err(AppError::internal(format!(
        "Links in the toolkit are not supported on this platform yet ({}).",
        path.display()
    )))
}

// ---------------------------------------------------------------------------------------------
// Own toolkit, status and selection
// ---------------------------------------------------------------------------------------------

/// Creates `<editing_folder>/CLAUDE_VE_ALL_OWN` containing only [`OWN_README`]. An existing
/// folder is left exactly as it is.
pub fn create_own(editing_folder: &Path) -> AppResult<()> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    if !editing_folder.is_dir() {
        return Err(AppError::not_found(format!(
            "The Editing Folder {} does not exist.",
            editing_folder.display()
        )));
    }
    let target = editing_folder.join(OWN_TOOLKIT_FOLDER);
    if exists(&target) {
        return Ok(());
    }
    let temp = TempDir::create(editing_folder)?;
    let staged = temp.path().join(OWN_TOOLKIT_FOLDER);
    fs::create_dir(&staged).map_err(|e| AppError::io_at("Could not create", &staged, e))?;
    let readme = staged.join("README.md");
    let write = || -> io::Result<()> {
        let mut file = File::create(&readme)?;
        io::Write::write_all(&mut file, OWN_README.as_bytes())?;
        file.sync_all()
    };
    write().map_err(|e| AppError::io_at("Could not write", &readme, e))?;
    place(&staged, &target)?;
    sync_dir(editing_folder);
    Ok(())
}

fn folder_status(editing_folder: Option<&Path>, kind: ToolkitKind) -> ToolkitFolder {
    let path = editing_folder.map(|f| f.join(kind.folder_name()));
    ToolkitFolder {
        folder_name: kind.folder_name().to_owned(),
        exists: path.as_deref().is_some_and(Path::is_dir),
        path: path.map(|p| p.to_string_lossy().into_owned()),
    }
}

/// The toolkit status for these settings, read from disk.
pub fn status(settings: &Settings) -> ToolkitStatus {
    let folder = settings.editing_folder.as_deref().map(Path::new);
    ToolkitStatus {
        active: settings.active_toolkit,
        standard: folder_status(folder, ToolkitKind::Standard),
        own: folder_status(folder, ToolkitKind::Own),
    }
}

/// Selects the toolkit new jobs use. `standard` is always allowed (it is seeded whenever it is
/// missing); `own` only once `CLAUDE_VE_ALL_OWN` exists. Nothing on disk changes.
pub fn set_active(store: &Store, kind: ToolkitKind) -> AppResult<ToolkitStatus> {
    let settings = store.update_settings(|s| {
        if kind == ToolkitKind::Own {
            let folder = s
                .editing_folder
                .as_deref()
                .ok_or_else(AppError::no_editing_folder)?;
            if !Path::new(folder).join(OWN_TOOLKIT_FOLDER).is_dir() {
                return Err(AppError::invalid_input(
                    "Create your own toolkit first, then choose it.",
                ));
            }
        }
        s.active_toolkit = kind;
        Ok(s.clone())
    })?;
    Ok(status(&settings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir as TestDir;

    /// One archive entry for [`build_archive`].
    enum Item<'a> {
        Dir(&'a str),
        File(&'a str, &'a str),
        Exec(&'a str, &'a str),
        Link(&'a str, &'a str),
        HardLink(&'a str, &'a str),
    }

    /// Writes a `.tar.gz` with raw header paths, so invalid paths can be built too.
    fn build_archive(dir: &Path, items: &[Item<'_>]) -> PathBuf {
        let path = dir.join(format!("toolkit-{}.tar.gz", uuid::Uuid::new_v4().simple()));
        let gz = flate2::write::GzEncoder::new(
            File::create(&path).unwrap(),
            flate2::Compression::fast(),
        );
        let mut builder = tar::Builder::new(gz);
        for item in items {
            let mut header = tar::Header::new_gnu();
            let (name, kind, mode, data, link) = match item {
                Item::Dir(n) => (*n, tar::EntryType::Directory, 0o755, "", None),
                Item::File(n, d) => (*n, tar::EntryType::Regular, 0o644, *d, None),
                Item::Exec(n, d) => (*n, tar::EntryType::Regular, 0o755, *d, None),
                Item::Link(n, t) => (*n, tar::EntryType::Symlink, 0o777, "", Some(*t)),
                Item::HardLink(n, t) => (*n, tar::EntryType::Link, 0o644, "", Some(*t)),
            };
            // Bypass the builder's path checks so traversal can be tested.
            let bytes = name.as_bytes();
            header.as_old_mut().name[..bytes.len()].copy_from_slice(bytes);
            header.set_entry_type(kind);
            header.set_mode(mode);
            header.set_size(data.len() as u64);
            if let Some(link) = link {
                let bytes = link.as_bytes();
                header.as_old_mut().linkname[..bytes.len()].copy_from_slice(bytes);
            }
            header.set_cksum();
            builder.append(&header, data.as_bytes()).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
        path
    }

    fn standard_archive(dir: &Path) -> PathBuf {
        build_archive(
            dir,
            &[
                Item::Dir("./"),
                Item::Dir("CLAUDE_VE_ALL/"),
                Item::Exec("CLAUDE_VE_ALL/ve.py", "print('ve')\n"),
                Item::Dir("CLAUDE_VE_ALL/gfx/_shared/"),
                Item::File("CLAUDE_VE_ALL/gfx/_shared/sj.css", "body{}\n"),
                Item::Dir("CLAUDE_VE_ALL/gfx/templates/hit/"),
                Item::Link("CLAUDE_VE_ALL/gfx/templates/hit/shared", "../../_shared"),
                Item::File("MEMORY.md", "memory\n"),
                Item::File("CLAUDE.md", "claude\n"),
            ],
        )
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut out: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        out.sort();
        out
    }

    fn setup() -> (TestDir, PathBuf, PathBuf) {
        let root = TestDir::new().unwrap();
        let editing = root.path().join("Editing");
        fs::create_dir(&editing).unwrap();
        let archive = standard_archive(root.path());
        (root, editing, archive)
    }

    #[test]
    fn seeds_all_three_into_an_empty_folder() {
        let (_root, editing, archive) = setup();
        let created = seed(&editing, &archive).unwrap();
        assert_eq!(created, vec!["CLAUDE_VE_ALL", "MEMORY.md", "CLAUDE.md"]);
        assert_eq!(
            names(&editing),
            vec!["CLAUDE.md", "CLAUDE_VE_ALL", "MEMORY.md"]
        );
        assert_eq!(
            fs::read_to_string(editing.join("MEMORY.md")).unwrap(),
            "memory\n"
        );
        assert_eq!(
            fs::read_to_string(editing.join("CLAUDE_VE_ALL/gfx/_shared/sj.css")).unwrap(),
            "body{}\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(editing.join("CLAUDE_VE_ALL/ve.py"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        // Seeding again changes nothing.
        assert!(seed(&editing, &archive).unwrap().is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn symlinks_are_restored_as_symlinks() {
        let (_root, editing, archive) = setup();
        seed(&editing, &archive).unwrap();
        let link = editing.join("CLAUDE_VE_ALL/gfx/templates/hit/shared");
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read_link(&link).unwrap(), Path::new("../../_shared"));
        assert_eq!(fs::read_to_string(link.join("sj.css")).unwrap(), "body{}\n");
    }

    #[cfg(windows)]
    #[test]
    fn links_become_copies_on_windows() {
        let (_root, editing, archive) = setup();
        seed(&editing, &archive).unwrap();
        let link = editing.join("CLAUDE_VE_ALL/gfx/templates/hit/shared");
        let meta = fs::symlink_metadata(&link).unwrap();
        assert!(meta.is_dir() && !meta.file_type().is_symlink());
        assert_eq!(fs::read_to_string(link.join("sj.css")).unwrap(), "body{}\n");
        // A copy: the original stays as it was when the copy changes.
        fs::write(link.join("sj.css"), "changed").unwrap();
        assert_eq!(
            fs::read_to_string(editing.join("CLAUDE_VE_ALL/gfx/_shared/sj.css")).unwrap(),
            "body{}\n"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_links_to_links_dangling_links_and_loops() {
        let root = TestDir::new().unwrap();
        let editing = root.path().join("Editing");
        fs::create_dir(&editing).unwrap();
        // A link to a folder that holds a link (listed before its target), and a dangling one.
        let archive = build_archive(
            root.path(),
            &[
                Item::Dir("CLAUDE_VE_ALL/"),
                Item::Link("CLAUDE_VE_ALL/b", "a"),
                Item::Dir("CLAUDE_VE_ALL/a/"),
                Item::Link("CLAUDE_VE_ALL/a/fonts", "../f"),
                Item::Dir("CLAUDE_VE_ALL/f/"),
                Item::File("CLAUDE_VE_ALL/f/x.ttf", "font"),
                Item::Link("CLAUDE_VE_ALL/gone", "missing"),
            ],
        );
        assert_eq!(seed(&editing, &archive).unwrap(), vec!["CLAUDE_VE_ALL"]);
        let toolkit = editing.join("CLAUDE_VE_ALL");
        assert_eq!(
            fs::read_to_string(toolkit.join("b/fonts/x.ttf")).unwrap(),
            "font"
        );
        assert_eq!(names(&toolkit), vec!["a", "b", "f"]);

        for bad in [
            vec![
                Item::Dir("CLAUDE_VE_ALL/a/"),
                Item::Link("CLAUDE_VE_ALL/a/self", ".."),
            ],
            vec![
                Item::Link("CLAUDE_VE_ALL/x", "y"),
                Item::Link("CLAUDE_VE_ALL/y", "x"),
            ],
        ] {
            let editing = root
                .path()
                .join(format!("E{}", uuid::Uuid::new_v4().simple()));
            fs::create_dir(&editing).unwrap();
            let archive = build_archive(root.path(), &bad);
            let err = seed(&editing, &archive).unwrap_err();
            assert!(err.message.contains("invalid"), "{}", err.message);
            assert!(names(&editing).is_empty());
        }
    }

    #[cfg(windows)]
    #[test]
    fn long_devanagari_paths_work_on_windows() {
        let root = TestDir::new().unwrap();
        // Far beyond the classic 260 character limit once the toolkit is inside it.
        let mut editing = root.path().to_path_buf();
        for _ in 0..6 {
            editing.push("हिंदी चैनल का बहुत लंबा फ़ोल्डर नाम");
        }
        fs::create_dir_all(&editing).unwrap();
        assert!(editing.to_string_lossy().chars().count() > 200);
        let archive = standard_archive(root.path());
        seed(&editing, &archive).unwrap();
        assert_eq!(
            fs::read_to_string(editing.join("CLAUDE_VE_ALL/gfx/templates/hit/shared/sj.css"))
                .unwrap(),
            "body{}\n"
        );
    }

    #[test]
    fn rejects_names_windows_cannot_store() {
        for bad in [
            "CLAUDE_VE_ALL/CON",
            "CLAUDE_VE_ALL/nul.txt",
            "CLAUDE_VE_ALL/Com1.py",
            "CLAUDE_VE_ALL/a:b.py",
            "CLAUDE_VE_ALL/what?.py",
            "CLAUDE_VE_ALL/trailing.",
            "CLAUDE_VE_ALL/trailing ",
        ] {
            assert!(
                platform::windows_name_problem(bad.rsplit('/').next().unwrap()).is_some(),
                "{bad}"
            );
        }
        for good in [
            "console.py",
            "CONFIG",
            "nul_check.py",
            "हिंदी.txt",
            ".venv",
            "a b.c",
        ] {
            assert_eq!(platform::windows_name_problem(good), None, "{good}");
        }
        let root = TestDir::new().unwrap();
        let editing = root.path().join("Editing");
        fs::create_dir(&editing).unwrap();
        for bad in [
            vec![Item::File("CLAUDE_VE_ALL/aux.py", "x")],
            vec![
                Item::File("CLAUDE_VE_ALL/Tool.py", "x"),
                Item::File("CLAUDE_VE_ALL/tool.py", "y"),
            ],
        ] {
            let archive = build_archive(root.path(), &bad);
            let err = seed(&editing, &archive).unwrap_err();
            assert!(err.message.contains("invalid"), "{}", err.message);
            assert!(names(&editing).is_empty());
        }
    }

    #[test]
    fn files_are_copied_where_hard_links_are_not_possible() {
        let root = TestDir::new().unwrap();
        let staged = root.path().join("staged.md");
        fs::write(&staged, "seed").unwrap();
        let target = root.path().join("MEMORY.md");
        assert!(copy_new(&staged, &target).unwrap());
        assert_eq!(fs::read_to_string(&target).unwrap(), "seed");
        // Never replaces an existing file.
        fs::write(&staged, "other").unwrap();
        assert!(!copy_new(&staged, &target).unwrap());
        assert_eq!(fs::read_to_string(&target).unwrap(), "seed");
    }

    #[test]
    fn never_overwrites_existing_items() {
        let (_root, editing, archive) = setup();
        fs::write(editing.join("MEMORY.md"), "mine").unwrap();
        fs::create_dir(editing.join("CLAUDE_VE_ALL")).unwrap();
        fs::write(editing.join("CLAUDE_VE_ALL/custom.py"), "custom").unwrap();

        let created = seed(&editing, &archive).unwrap();
        assert_eq!(created, vec!["CLAUDE.md"]);
        assert_eq!(
            fs::read_to_string(editing.join("MEMORY.md")).unwrap(),
            "mine"
        );
        assert_eq!(names(&editing.join("CLAUDE_VE_ALL")), vec!["custom.py"]);
        assert_eq!(
            fs::read_to_string(editing.join("CLAUDE.md")).unwrap(),
            "claude\n"
        );
    }

    #[test]
    fn an_empty_existing_folder_and_a_dangling_link_count_as_existing() {
        let (_root, editing, archive) = setup();
        fs::create_dir(editing.join("CLAUDE_VE_ALL")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("nowhere", editing.join("CLAUDE.md")).unwrap();
        let created = seed(&editing, &archive).unwrap();
        assert!(names(&editing.join("CLAUDE_VE_ALL")).is_empty());
        assert!(!created.contains(&"CLAUDE_VE_ALL".to_owned()));
        #[cfg(unix)]
        assert_eq!(created, vec!["MEMORY.md"]);
    }

    #[test]
    fn rejects_path_traversal_and_absolute_paths() {
        let root = TestDir::new().unwrap();
        let editing = root.path().join("Editing");
        fs::create_dir(&editing).unwrap();
        for bad in [
            vec![Item::File("CLAUDE_VE_ALL/../../escaped.txt", "x")],
            vec![Item::File("/tmp/vidai-absolute.txt", "x")],
            vec![Item::Link("CLAUDE_VE_ALL/up", "../../outside")],
            vec![Item::Link("CLAUDE_VE_ALL/abs", "/etc")],
            vec![
                Item::Link("CLAUDE_VE_ALL/inside", "sub"),
                Item::Dir("CLAUDE_VE_ALL/sub/"),
                Item::File("CLAUDE_VE_ALL/inside/x.txt", "through a link"),
            ],
            vec![Item::HardLink("CLAUDE_VE_ALL/hard", "/etc/passwd")],
            vec![Item::Dir("MEMORY.md/")],
        ] {
            let archive = build_archive(root.path(), &bad);
            let err = seed(&editing, &archive).unwrap_err();
            assert!(err.message.contains("invalid"), "{}", err.message);
            assert!(names(&editing).is_empty(), "{:?}", names(&editing));
        }
        assert!(!root.path().join("escaped.txt").exists());
        assert!(!Path::new("/tmp/vidai-absolute.txt").exists());
    }

    #[test]
    fn a_failed_extraction_leaves_nothing_behind() {
        let (_root, editing, _) = setup();
        let root = editing.parent().unwrap();
        // A valid start, then a broken entry: nothing may be placed.
        let archive = build_archive(
            root,
            &[
                Item::Dir("CLAUDE_VE_ALL/"),
                Item::File("CLAUDE_VE_ALL/a.py", "a"),
                Item::File("MEMORY.md", "m"),
                Item::File("CLAUDE_VE_ALL/../x", "x"),
            ],
        );
        assert!(seed(&editing, &archive).is_err());
        assert!(names(&editing).is_empty());

        // A truncated archive behaves the same.
        let good = standard_archive(root);
        let bytes = fs::read(&good).unwrap();
        let truncated = root.join("truncated.tar.gz");
        fs::write(&truncated, &bytes[..bytes.len() / 2]).unwrap();
        assert!(seed(&editing, &truncated).is_err());
        assert!(names(&editing).is_empty());
    }

    #[test]
    fn leftovers_of_a_crashed_seeding_are_ignored_and_cleaned() {
        let (_root, editing, archive) = setup();
        // A crash mid-extraction leaves a partial temp dir, never a partial CLAUDE_VE_ALL.
        let stale = editing.join(format!("{TEMP_PREFIX}deadbeef/CLAUDE_VE_ALL"));
        fs::create_dir_all(&stale).unwrap();
        fs::File::create(stale.join("half.py"))
            .unwrap()
            .write_all(b"x")
            .unwrap();
        let created = seed(&editing, &archive).unwrap();
        assert_eq!(created.len(), 3);
        assert_eq!(
            names(&editing),
            vec!["CLAUDE.md", "CLAUDE_VE_ALL", "MEMORY.md"]
        );
        assert!(!editing.join("CLAUDE_VE_ALL/half.py").exists());
    }

    #[test]
    fn missing_editing_folder_is_an_error() {
        let (root, _editing, archive) = setup();
        let err = seed(&root.path().join("nope"), &archive).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::NotFound);
    }

    #[test]
    fn the_bundled_archive_is_valid_and_has_all_three_items() {
        let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/toolkit.tar.gz");
        let root = TestDir::new().unwrap();
        let created = seed(root.path(), &bundled).unwrap();
        assert_eq!(created, vec!["CLAUDE_VE_ALL", "MEMORY.md", "CLAUDE.md"]);
        let link = root.path().join("CLAUDE_VE_ALL/gfx/templates/hit/shared");
        #[cfg(not(windows))]
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        #[cfg(windows)]
        {
            // Every one of the toolkit's links is a real folder with the shared files.
            let templates = root.path().join("CLAUDE_VE_ALL/gfx/templates");
            let shared: Vec<String> = names(&templates)
                .into_iter()
                .filter(|t| templates.join(t).join("shared").is_dir())
                .collect();
            assert_eq!(shared.len(), 9, "{shared:?}");
            assert!(link.join("sj.css").is_file());
        }
        assert!(!root.path().join("CLAUDE_VE_ALL/.env").exists());
        assert!(!root.path().join("CLAUDE_VE_ALL/.venv").exists());
    }

    #[test]
    fn own_toolkit_is_created_once_with_a_readme() {
        let root = TestDir::new().unwrap();
        create_own(root.path()).unwrap();
        let own = root.path().join(OWN_TOOLKIT_FOLDER);
        assert_eq!(names(&own), vec!["README.md"]);
        assert_eq!(
            fs::read_to_string(own.join("README.md")).unwrap(),
            OWN_README
        );
        assert_eq!(names(root.path()), vec![OWN_TOOLKIT_FOLDER]);

        // An existing own toolkit is never changed.
        fs::write(own.join("README.md"), "mine").unwrap();
        fs::write(own.join("tool.py"), "t").unwrap();
        create_own(root.path()).unwrap();
        assert_eq!(fs::read_to_string(own.join("README.md")).unwrap(), "mine");
        assert_eq!(names(&own), vec!["README.md", "tool.py"]);
    }

    #[test]
    fn status_and_active_toolkit_rule() {
        let root = TestDir::new().unwrap();
        let store = Store::open(root.path().join("data")).unwrap();
        let editing = root.path().join("Editing");
        fs::create_dir(&editing).unwrap();

        let none = status(&store.settings());
        assert!(none.standard.path.is_none() && !none.standard.exists);
        assert_eq!(none.own.folder_name, OWN_TOOLKIT_FOLDER);

        let err = set_active(&store, ToolkitKind::Own).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::NoEditingFolder);

        store
            .update_settings(|s| {
                s.editing_folder = Some(editing.to_string_lossy().into_owned());
                Ok(())
            })
            .unwrap();
        let err = set_active(&store, ToolkitKind::Own).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::InvalidInput);
        assert_eq!(store.settings().active_toolkit, ToolkitKind::Standard);

        create_own(&editing).unwrap();
        let st = set_active(&store, ToolkitKind::Own).unwrap();
        assert_eq!(st.active, ToolkitKind::Own);
        assert!(st.own.exists);
        assert!(!st.standard.exists);
        assert_eq!(
            st.own.path.as_deref(),
            Some(editing.join(OWN_TOOLKIT_FOLDER).to_string_lossy().as_ref())
        );
        let st = set_active(&store, ToolkitKind::Standard).unwrap();
        assert_eq!(st.active, ToolkitKind::Standard);
        // Switching moved nothing.
        assert!(editing.join(OWN_TOOLKIT_FOLDER).is_dir());
    }
}

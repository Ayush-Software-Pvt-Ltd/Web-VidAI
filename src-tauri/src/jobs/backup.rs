//! The backup a re-edit takes before it starts (SPEC section 2, "backup-output-N"): a copy of
//! `<video>/output/` in `<video>/backup-output-N/`. Nothing is moved or deleted.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const OUTPUT_DIR: &str = "output";
const BACKUP_PREFIX: &str = "backup-output-";

/// Copies `<video_dir>/output` to `<video_dir>/backup-output-N`, N being the smallest number from
/// 1 whose folder does not exist yet. Returns the new folder, or `None` when there is no output
/// or it is empty. The copy is made under a hidden name and renamed when complete, so a failed
/// copy never leaves something that looks like a backup (its leftovers are removed).
pub fn backup_output(video_dir: &Path) -> io::Result<Option<PathBuf>> {
    let output = video_dir.join(OUTPUT_DIR);
    match fs::read_dir(&output) {
        Ok(mut entries) => {
            if entries.next().is_none() {
                return Ok(None);
            }
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    }
    let number = (1u32..)
        .find(|n| fs::symlink_metadata(video_dir.join(format!("{BACKUP_PREFIX}{n}"))).is_err())
        .unwrap_or(u32::MAX);
    let target = video_dir.join(format!("{BACKUP_PREFIX}{number}"));
    let partial = video_dir.join(format!(".{BACKUP_PREFIX}{number}.partial"));
    // Left by a crash; it is this function's own temporary folder.
    if partial.exists() {
        fs::remove_dir_all(&partial)?;
    }
    let done = copy_dir(&output, &partial).and_then(|()| fs::rename(&partial, &target));
    if let Err(err) = done {
        let _ = fs::remove_dir_all(&partial);
        return Err(err);
    }
    Ok(Some(target))
}

/// Copies `from` into the new folder `to`, bundle directories (`.fcpxmld`) included.
/// shortcut: a symbolic link to a folder is skipped (the output folder has none in practice),
/// a link to a file is copied as the file.
fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let (path, dest) = (entry.path(), to.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&path, &dest)?;
        } else if kind.is_file() || (kind.is_symlink() && path.is_file()) {
            fs::copy(&path, &dest)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn copies_the_output_to_the_next_free_number() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path();
        write(&video.join("output/Video_v1.fcpxml"), "one");
        write(&video.join("output/Video_v2.fcpxmld/Info.fcpxml"), "bundle");
        write(&video.join("output/thumbnail-1.png"), "png");
        write(&video.join("Raw.mov"), "aroll");

        let first = backup_output(video).unwrap().unwrap();
        assert_eq!(first, video.join("backup-output-1"));
        assert_eq!(
            fs::read_to_string(first.join("Video_v2.fcpxmld/Info.fcpxml")).unwrap(),
            "bundle"
        );
        assert_eq!(
            fs::read_to_string(first.join("Video_v1.fcpxml")).unwrap(),
            "one"
        );
        // A copy: the output is untouched.
        assert!(video.join("output/Video_v1.fcpxml").is_file());

        // The next number is the smallest one that is free, also when there is a gap.
        fs::create_dir(video.join("backup-output-3")).unwrap();
        write(&video.join("output/Video_v3.fcpxml"), "three");
        assert_eq!(
            backup_output(video).unwrap().unwrap(),
            video.join("backup-output-2")
        );
        assert_eq!(
            backup_output(video).unwrap().unwrap(),
            video.join("backup-output-4")
        );
        // An earlier backup is never touched.
        assert!(!first.join("Video_v3.fcpxml").exists());
        // No leftovers of the temporary copy.
        assert!(!video.join(".backup-output-4.partial").exists());
    }

    #[test]
    fn a_missing_or_empty_output_needs_no_backup() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(backup_output(dir.path()).unwrap(), None);
        fs::create_dir(dir.path().join("output")).unwrap();
        assert_eq!(backup_output(dir.path()).unwrap(), None);
        assert!(!dir.path().join("backup-output-1").exists());
    }

    #[test]
    fn the_backup_is_neither_output_nor_a_roll() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path();
        write(&video.join("output/Video_v1.fcpxml"), "one");
        write(&video.join("output/final.mp4"), "render");
        backup_output(video).unwrap();
        let output = crate::scanner::scan_output(video);
        assert_eq!(output.review_files.len(), 1);
        assert_eq!(output.final_files.len(), 1);
        assert!(output.dir.ends_with("output"));
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_copy_leaves_no_backup_behind() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path();
        write(&video.join("output/a.fcpxml"), "a");
        let secret = video.join("output/b.fcpxml");
        write(&secret, "b");
        fs::set_permissions(&secret, fs::Permissions::from_mode(0o000)).unwrap();
        // Running as root reads it anyway; the test is only meaningful otherwise.
        if fs::read(&secret).is_err() {
            assert!(backup_output(video).is_err());
            assert!(!video.join("backup-output-1").exists());
            assert!(!video.join(".backup-output-1.partial").exists());
        }
        fs::set_permissions(&secret, fs::Permissions::from_mode(0o644)).unwrap();
    }
}

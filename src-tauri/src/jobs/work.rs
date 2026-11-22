//! Evidence in the working folder of a video (SPEC section 6, "Progress", evidence 2).
//!
//! A model may never write its progress markers while it works (the OpenCode models of the
//! owner's real edits wrote all of them in their last message), and a model without sub-agents
//! gives the stream no milestone to see. What an edit leaves on disk does not depend on the
//! program or the model: the audio that was extracted, the transcript, the plan or timeline file,
//! the graphics sources and renders, the quality-check output. This module looks at the video
//! folder (`CLAUDE_VE/` and the rest, `output/` aside, which `jobs::progress` reads through the
//! scanner) and says which kinds of files appeared since the job started.
//!
//! The kinds come from what the real edits wrote and when (the bundled toolkit and the owner's
//! edits; see the calibration notes in `jobs::progress`), by folder and file *names* only, never
//! from content, and not tied to one toolkit's exact names:
//!
//! | Kind | Looks like | First seen in the real edits |
//! |---|---|---|
//! | audio | an audio file (`wav`, `mp3`, `m4a`, ...) | with the footage check, 1 to 2 minutes |
//! | transcript | a text file in a folder or with a name that says transcript, or any `srt` / `vtt` | when transcription ends, 2 to 8 minutes |
//! | plan | a text or script file named plan, timeline, spec, cue sheet, EDL, storyboard | 4 to 20 minutes |
//! | graphics | any file in a folder named `gfx...`, `graphic...`, `hyperframes`, `remotion`, `compositions`, `cards`, `overlays` | the sources one to two minutes after the plan, the renders later |
//! | quality check | any file or folder named `qa`, `qa_...`, `...-qa` | the last 2 to 3 minutes before the review project |
//!
//! Everything here is pure except [`scan`], which reads the folder, bounded in depth, entries and
//! time so a folder with ten thousands of frames stays cheap, and never follows a link.

use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

/// Folders that are never looked into: tool caches and dependencies that hold thousands of files
/// and say nothing about the edit.
const SKIPPED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    ".hyperframes",
    ".cache",
    ".whisper",
];
/// Folders that belong to the toolkit, not to the video (a link normally; never read).
const TOOLKIT_DIRS: &[&str] = &["claude_ve_all", "claude_ve_all_own"];
/// The folder of the video where the edit keeps its working files.
const WORK_DIR: &str = "claude_ve";

const MAX_DEPTH: usize = 8;
const MAX_ENTRIES: usize = 20_000;
const MAX_SCAN: Duration = Duration::from_millis(300);

const AUDIO_EXT: &[&str] = &[
    "wav", "mp3", "m4a", "aac", "flac", "aif", "aiff", "ogg", "opus",
];
const TRANSCRIPT_EXT: &[&str] = &["json", "txt", "md", "srt", "vtt", "tsv", "csv"];
const PLAN_EXT: &[&str] = &[
    "md", "txt", "json", "py", "yaml", "yml", "toml", "csv", "tsv", "js", "ts",
];

/// A file of the video folder, as the scan found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkFile {
    /// Relative to the video folder, lower case, `/` as separator.
    pub path: String,
    pub modified: SystemTime,
}

/// The kinds of files a path belongs to (usually none or one).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Kinds {
    pub audio: bool,
    pub transcript: bool,
    pub plan: bool,
    pub graphics: bool,
    pub quality_check: bool,
}

impl Kinds {
    pub fn any(self) -> bool {
        self.audio || self.transcript || self.plan || self.graphics || self.quality_check
    }
}

/// Which kinds appeared since the job started, and how many files did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WorkEvidence {
    pub audio: bool,
    pub transcript: bool,
    pub plan: bool,
    pub graphics: bool,
    pub quality_check: bool,
    /// Files in the video folder written since the job started, `output/` included: how much
    /// the job has done, whatever it is (the stuck-model rule of `jobs::keepgoing` counts it).
    pub files: usize,
}

/// The path components after the working folder (`CLAUDE_VE`) when the path is inside one, else
/// all of them for a relative path; lower case. An absolute path of the stream with no working
/// folder in it is judged by its file name alone (and the folder it is in, when that is
/// `output`), so a video named "Best plan for graphics" never changes the kind of its files.
pub fn components_in_work(path: &str) -> Vec<String> {
    let parts: Vec<String> = path
        .split(['/', '\\'])
        .filter(|c| !c.is_empty() && *c != ".")
        .map(str::to_lowercase)
        .collect();
    if let Some(i) = parts.iter().rposition(|c| c == WORK_DIR) {
        return parts[i + 1..].to_vec();
    }
    let absolute = path.starts_with(['/', '\\']) || path.as_bytes().get(1) == Some(&b':');
    if !absolute {
        return parts;
    }
    let keep = if parts.len() >= 2 && parts[parts.len() - 2] == "output" {
        2
    } else {
        1
    };
    parts[parts.len().saturating_sub(keep)..].to_vec()
}

/// Whether a name (a folder, or a file without its extension) says it belongs to a quality check:
/// `qa`, `qa_sheet_1`, `qa-frames`, `transcripts_qa`.
fn is_quality_check(name: &str) -> bool {
    let boundary = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric());
    if name.starts_with("qa") && boundary(name.chars().nth(2)) {
        return true;
    }
    name.ends_with("_qa") || name.ends_with("-qa") || name.contains("_qa_") || name.contains("-qa-")
}

/// The words of a file name, split at everything that is not a letter or digit.
fn words(stem: &str) -> Vec<&str> {
    stem.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect()
}

fn is_graphics_dir(name: &str) -> bool {
    name.starts_with("gfx")
        || name.starts_with("graphic")
        || matches!(
            name,
            "hyperframes" | "remotion" | "compositions" | "cards" | "overlays"
        )
}

fn is_plan_name(stem: &str) -> bool {
    let words = words(stem);
    let starts = |w: &str, p: &str| w.starts_with(p);
    words.iter().any(|w| {
        [
            "plan",
            "timeline",
            "spec",
            "cue",
            "edl",
            "storyboard",
            "shotlist",
        ]
        .iter()
        .any(|p| starts(w, p))
    }) || words.windows(2).any(|w| w[0] == "shot" && w[1] == "list")
}

/// The kinds of a path given as components (see [`components_in_work`]); the last one is the
/// file name. A path in `output/` has none: the review project and the thumbnails are the
/// scanner's business.
pub fn kinds_of(components: &[String]) -> Kinds {
    let Some((file, dirs)) = components.split_last() else {
        return Kinds::default();
    };
    if dirs.first().is_some_and(|d| d == "output") {
        return Kinds::default();
    }
    let (stem, ext) = file.rsplit_once('.').unwrap_or((file.as_str(), ""));
    if dirs.iter().any(|d| TOOLKIT_DIRS.contains(&d.as_str())) {
        return Kinds::default();
    }
    if dirs.iter().any(|d| is_quality_check(d)) || is_quality_check(stem) {
        return Kinds {
            quality_check: true,
            ..Kinds::default()
        };
    }
    if dirs.iter().any(|d| is_graphics_dir(d)) {
        return Kinds {
            graphics: true,
            ..Kinds::default()
        };
    }
    let transcripty = dirs.iter().any(|d| d.contains("transcri")) || stem.contains("transcri");
    if matches!(ext, "srt" | "vtt") || (transcripty && TRANSCRIPT_EXT.contains(&ext)) {
        return Kinds {
            transcript: true,
            ..Kinds::default()
        };
    }
    if AUDIO_EXT.contains(&ext) {
        return Kinds {
            audio: true,
            ..Kinds::default()
        };
    }
    if PLAN_EXT.contains(&ext) && is_plan_name(stem) {
        return Kinds {
            plan: true,
            ..Kinds::default()
        };
    }
    Kinds::default()
}

/// The kinds of a path of the tool stream (absolute or relative).
pub fn kinds_of_path(path: &str) -> Kinds {
    kinds_of(&components_in_work(path))
}

/// What the files written at or after `since` say (with a second of tolerance for file systems
/// that store whole seconds).
pub fn evidence(files: &[WorkFile], since: SystemTime) -> WorkEvidence {
    let since = since - Duration::from_secs(1);
    let mut out = WorkEvidence::default();
    for file in files.iter().filter(|f| f.modified >= since) {
        out.files += 1;
        let components = components_in_work(&file.path);
        let kinds = kinds_of(&components);
        out.audio |= kinds.audio;
        out.transcript |= kinds.transcript;
        out.plan |= kinds.plan;
        out.graphics |= kinds.graphics;
        out.quality_check |= kinds.quality_check;
    }
    out
}

/// Every regular file of the video folder (links are not followed and not listed), within the
/// limits above; what the limits cut off is simply not seen.
pub fn scan(video_dir: &Path) -> Vec<WorkFile> {
    let started = Instant::now();
    let mut out = Vec::new();
    let mut stack = vec![(video_dir.to_path_buf(), String::new(), 0usize)];
    while let Some((dir, prefix, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if out.len() >= MAX_ENTRIES || started.elapsed() > MAX_SCAN {
                return out;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().to_lowercase();
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if kind.is_dir() {
                if depth < MAX_DEPTH && !SKIPPED_DIRS.contains(&name.as_str()) {
                    stack.push((entry.path(), path, depth + 1));
                }
            } else if kind.is_file()
                && let Ok(modified) = entry.metadata().and_then(|m| m.modified())
            {
                out.push(WorkFile { path, modified });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(path: &str) -> Kinds {
        kinds_of_path(path)
    }

    fn only(f: impl Fn(&mut Kinds)) -> Kinds {
        let mut k = Kinds::default();
        f(&mut k);
        k
    }

    #[test]
    fn the_files_a_real_edit_writes_are_told_apart() {
        for (path, want) in [
            // The footage check.
            ("CLAUDE_VE/audio/a1_48k.wav", only(|k| k.audio = true)),
            ("CLAUDE_VE/build/recon.json", Kinds::default()),
            ("CLAUDE_VE/build/contact_001.jpg", Kinds::default()),
            // Transcription.
            (
                "CLAUDE_VE/transcripts/a1.full.json",
                only(|k| k.transcript = true),
            ),
            (
                "CLAUDE_VE/transcripts/a1/a1.chunks.json",
                only(|k| k.transcript = true),
            ),
            ("CLAUDE_VE/TRANSCRIPT.md", only(|k| k.transcript = true)),
            ("subs/take1.SRT", only(|k| k.transcript = true)),
            // The plan.
            ("CLAUDE_VE/timeline.py", only(|k| k.plan = true)),
            ("CLAUDE_VE/build/timeline.json", only(|k| k.plan = true)),
            ("CLAUDE_VE/PLAN.md", only(|k| k.plan = true)),
            ("CLAUDE_VE/GFX_SPEC.md", only(|k| k.plan = true)),
            ("CLAUDE_VE/scripts_cues.py", only(|k| k.plan = true)),
            ("CLAUDE_VE/build/cues.json", only(|k| k.plan = true)),
            ("CLAUDE_VE/shot_list.txt", only(|k| k.plan = true)),
            // Graphics, sources and renders.
            (
                "CLAUDE_VE/gfx_src/hook/index.html",
                only(|k| k.graphics = true),
            ),
            ("CLAUDE_VE/gfx/1080/hook.mov", only(|k| k.graphics = true)),
            ("CLAUDE_VE/graphics/title.png", only(|k| k.graphics = true)),
            (
                "CLAUDE_VE/gfx_src/price/timeline.json",
                only(|k| k.graphics = true),
            ),
            // Quality checks.
            (
                "CLAUDE_VE/build/720/qa_sheet_1.jpg",
                only(|k| k.quality_check = true),
            ),
            (
                "CLAUDE_VE/build/720/qa_frames/shot_000.jpg",
                only(|k| k.quality_check = true),
            ),
            (
                "CLAUDE_VE/transcripts_qa/mix_win.json",
                only(|k| k.quality_check = true),
            ),
            ("CLAUDE_VE/qa.chunks.json", only(|k| k.quality_check = true)),
            // Nothing to say.
            ("CLAUDE_VE/project.json", Kinds::default()),
            ("CLAUDE_VE/hits.json", Kinds::default()),
            ("CLAUDE_VE/broll/mezz/clip.mov", Kinds::default()),
            ("CLAUDE_VE/assets/products/phone.png", Kinds::default()),
            ("CLAUDE_VE/build/720/mix_raw.mov", Kinds::default()),
            ("CLAUDE_VE/inspect_report.json", Kinds::default()),
            (
                "CLAUDE_VE/gfx_src/hook/.hyperframes/x.json",
                only(|k| k.graphics = true),
            ),
            ("info.txt", Kinds::default()),
            ("Main.MP4", Kinds::default()),
            ("CLAUDE_VE/build/720/mix.wav", only(|k| k.audio = true)),
        ] {
            assert_eq!(kinds(path), want, "{path}");
        }
        // The review project, thumbnails and meta.txt belong to the scanner of the output folder.
        for path in [
            "output/timeline_review_v1.fcpxml",
            "output/meta.txt",
            "output/plan.txt",
        ] {
            assert_eq!(kinds(path), Kinds::default(), "{path}");
        }
        // The toolkit's own files are not the video's.
        assert_eq!(
            kinds_of(&["claude_ve_all".into(), "gfx".into(), "t.html".into()]),
            Kinds::default()
        );
    }

    #[test]
    fn the_name_of_the_video_never_changes_the_kind_of_its_files() {
        // Absolute paths of the stream: only what follows the working folder counts.
        let video = "/Edits/Chan/Best Plan for graphics and QA";
        assert_eq!(
            kinds(&format!("{video}/CLAUDE_VE/notes.md")),
            Kinds::default()
        );
        assert_eq!(
            kinds(&format!("{video}/CLAUDE_VE/timeline.py")),
            only(|k| k.plan = true)
        );
        // Without a working folder, only the file name is looked at.
        assert_eq!(kinds(&format!("{video}/notes.md")), Kinds::default());
        assert_eq!(kinds(&format!("{video}/plan.md")), only(|k| k.plan = true));
        // Windows separators.
        assert_eq!(
            kinds("C:\\Edits\\Chan\\Video\\CLAUDE_VE\\gfx_src\\a\\index.html"),
            only(|k| k.graphics = true)
        );
    }

    #[test]
    fn words_not_substrings_name_a_plan() {
        for plan in [
            "plan",
            "edit_plan",
            "PLAN-v2",
            "planning notes",
            "timeline2",
            "cues",
        ] {
            assert!(is_plan_name(&plan.to_lowercase()), "{plan}");
        }
        for other in ["inspect", "explanation", "template", "specimen_x"] {
            // "specimen" starts with "spec": a known and harmless over-match, kept honest here.
            assert_eq!(is_plan_name(other), other == "specimen_x", "{other}");
        }
    }

    #[test]
    fn evidence_counts_only_files_written_since_the_start() {
        let start = SystemTime::now();
        let file = |path: &str, after: i64| WorkFile {
            path: path.to_owned(),
            modified: if after >= 0 {
                start + Duration::from_secs(after as u64)
            } else {
                start - Duration::from_secs(after.unsigned_abs())
            },
        };
        let files = [
            file("claude_ve/transcripts/old.json", -3600),
            file("claude_ve/audio/a1.wav", 5),
            file("claude_ve/timeline.py", 6),
            file("claude_ve/gfx_src/a/index.html", 7),
            file("output/meta.txt", 8),
        ];
        let seen = evidence(&files, start);
        assert_eq!(
            seen,
            WorkEvidence {
                audio: true,
                plan: true,
                graphics: true,
                files: 4,
                ..WorkEvidence::default()
            }
        );
        // A file written half a second before the start (whole-second file systems) still counts.
        let edge = [file("claude_ve/qa_sheet.jpg", 0)];
        assert!(evidence(&edge, start + Duration::from_millis(900)).quality_check);
        assert_eq!(evidence(&[], start), WorkEvidence::default());
    }

    #[test]
    fn scan_lists_files_relative_and_lower_case_and_skips_links_and_caches() {
        let dir = tempfile::TempDir::new().unwrap();
        let make = |rel: &str| {
            let p = dir.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "x").unwrap();
        };
        make("CLAUDE_VE/Transcripts/A1.full.json");
        make("CLAUDE_VE/gfx_src/hook/node_modules/pkg/index.js");
        make("CLAUDE_VE/gfx_src/hook/.hyperframes/state.json");
        make("CLAUDE_VE/__pycache__/x.pyc");
        make("output/Meta.txt");
        #[cfg(unix)]
        {
            let target = tempfile::TempDir::new().unwrap();
            std::fs::write(target.path().join("secret.wav"), "x").unwrap();
            std::os::unix::fs::symlink(target.path(), dir.path().join("CLAUDE_VE/link")).unwrap();
            std::os::unix::fs::symlink(
                target.path().join("secret.wav"),
                dir.path().join("CLAUDE_VE/link.wav"),
            )
            .unwrap();
        }
        let mut paths: Vec<String> = scan(dir.path()).into_iter().map(|f| f.path).collect();
        paths.sort();
        assert_eq!(
            paths,
            ["claude_ve/transcripts/a1.full.json", "output/meta.txt"]
        );
    }
}

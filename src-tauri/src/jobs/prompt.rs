//! Prompt composition (SPEC section 6, "Prompt composition", and section 7a).
//!
//! Builds the first message of a new `edit` session from the video, channel, toolkit, review
//! software, product links, notes, the channel's prompt and style for the video type, the fixed
//! VidAI paragraph and the progress markers (`jobs::progress`), and the follow-up messages for
//! continue, re-edit and render final, including the fallback when a session cannot be resumed.
//! On a machine that is not an Apple Silicon Mac, the first message also states the machine facts
//! (`platform::machine`) and how to adapt the toolkit, which was written on an Apple Silicon Mac.
//! Pure functions, tested on exact text.

use crate::jobs::keepgoing::Nudge;
use crate::jobs::progress;
use crate::model::{Harness, JobKind, ReviewSoftware, Setup, ToolkitKind, VideoType};
use crate::platform::machine::{GpuVendor, MachineFacts, Os};

/// Everything the first message of an `edit` session is made of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditPrompt<'a> {
    pub video_folder: &'a str,
    pub channel_folder: &'a str,
    pub video_type: VideoType,
    pub broll_folder: &'a str,
    pub toolkit: ToolkitKind,
    pub review_software: ReviewSoftware,
    /// As entered, one link per line (blank lines are dropped).
    pub product_links: &'a str,
    pub notes: &'a str,
    /// The channel's prompt for `video_type`, exactly as the user wrote it.
    pub channel_prompt: &'a str,
    /// The channel's style for `video_type`.
    pub channel_style: &'a str,
    /// Set when the main A-roll is stored sideways or upside down with no rotation flag.
    pub sideways_aroll: Option<SidewaysAroll<'a>>,
    /// The computer the edit runs on. Nothing is added on an Apple Silicon Mac or when `None`.
    pub machine: Option<&'a MachineFacts>,
    /// What the session runs on. On OpenCode the message also gets [`KEEP_WORKING`]; on the
    /// Claude subscription it is exactly as before.
    pub setup: Setup,
    /// The program the session runs in. In the OpenCode 2 program the message also gets
    /// [`OPENCODE2_PROGRAM`]; in Claude Code it is exactly as before.
    pub harness: Harness,
}

/// The main A-roll is stored sideways or upside down with no rotation flag, as the picture check
/// of the type detection found (SPEC section 8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SidewaysAroll<'a> {
    /// File name of the main A-roll.
    pub file_name: &'a str,
    /// 90, 180 or 270: the clockwise turn that makes it upright.
    pub rotation: u32,
}

/// The header line about a main A-roll stored sideways or upside down.
fn sideways_aroll_line(aroll: &SidewaysAroll<'_>) -> String {
    let stored = if aroll.rotation == 180 {
        "upside down"
    } else {
        "sideways"
    };
    format!(
        "MAIN_AROLL_ROTATION = The main A-roll file \"{file}\" is stored {stored} with no rotation flag. Rotate it {degrees} degrees clockwise to make it upright.",
        file = aroll.file_name,
        degrees = aroll.rotation,
    )
}

/// The header lines with the machine facts (a missing fact leaves its line out).
fn machine_lines(m: &MachineFacts) -> String {
    let mut machine = m.kind().to_owned();
    if let Some(arch) = m.arch {
        machine.push_str(&format!(" ({})", arch.label()));
    }
    if let Some(version) = &m.os_version {
        machine.push_str(&format!(", {version}"));
    }
    let mut lines = vec![format!("MACHINE = {machine}")];
    let cpu: Vec<String> = m.cpu.iter().cloned().chain(m.cores_text()).collect();
    if !cpu.is_empty() {
        lines.push(format!("MACHINE_CPU = {}", cpu.join(", ")));
    }
    if let Some(gb) = m.memory_gb() {
        lines.push(format!("MACHINE_MEMORY = {gb} GB"));
    }
    if let Some(gpus) = &m.gpus {
        let names: Vec<String> = gpus.iter().map(|g| g.describe()).collect();
        let names = if names.is_empty() {
            "none found".to_owned()
        } else {
            names.join("; ")
        };
        lines.push(format!("MACHINE_GPU = {names}"));
    }
    lines.join("\n")
}

/// What replaces VideoToolbox on a machine that is not a Mac, from the graphics vendors found.
fn hardware_codec(m: &MachineFacts) -> String {
    let choices: Vec<&str> = m
        .gpu_vendors()
        .into_iter()
        .filter_map(|vendor| match vendor {
            GpuVendor::Nvidia => Some("NVENC / NVDEC on the NVIDIA GPU"),
            GpuVendor::Intel => Some("Quick Sync on the Intel GPU"),
            GpuVendor::Amd => Some("AMF on the AMD GPU"),
            GpuVendor::Apple | GpuVendor::Other => None,
        })
        .collect();
    if choices.is_empty() {
        "find a hardware encoder that ffmpeg can use here".to_owned()
    } else {
        format!("use {}", choices.join(" or "))
    }
}

/// The paragraph that tells Claude to adapt the toolkit to this machine (SPEC section 6, Machine
/// facts). How slow commands are kept in view depends on the program: Claude Code has background
/// tasks, the OpenCode 2 program runs a command as long as its timeout allows (its own block
/// says how).
fn machine_paragraph(m: &MachineFacts, toolkit: ToolkitKind, harness: Harness) -> String {
    let written = match toolkit {
        ToolkitKind::Standard => {
            "the toolkit in TOOLKIT_FOLDER and its notes in MEMORY.md were written on an Apple Silicon Mac"
        }
        ToolkitKind::Own => {
            "the notes in MEMORY.md were written on an Apple Silicon Mac, and tools in TOOLKIT_FOLDER may have been too"
        }
    };
    let pieces = if m.os == Os::MacOs {
        let memory = m.memory_gb().map_or("this Mac's memory".to_owned(), |gb| {
            format!("the {gb} GB this Mac has")
        });
        let slow = match harness {
            Harness::ClaudeCode => {
                "so start them in the background with progress lines in a log file and check on them, and never leave a command waiting silently"
            }
            Harness::Opencode2 => {
                "so give these commands a timeout that is long enough for that and have them write progress lines to a log file"
            }
        };
        format!(
            "Replace the pieces that need Apple Silicon with equivalents that work on this machine: the mlx-whisper transcriber (for example faster-whisper or whisper.cpp) and any VideoToolbox encoder that fails here. VideoToolbox runs on this Mac's Intel or AMD graphics, but some encoders (such as ProRes) may be missing or slow, so test each one once. Homebrew on an Intel Mac lives in /usr/local, not in /opt/homebrew. If pip cannot install faster-whisper (no matching version, or a build from source that fails), the Python is newer than the Intel Mac builds of its parts: make the venv with an older Python (3.9 to 3.12, for example /usr/bin/python3) instead. The Whisper gate (vekit/whisper_gate.py) waits with no time limit until 12 GB of memory is free, which this Mac may never have: if it waits for more than a minute, lower its MIN_FREE_GB to a third of {memory}. Transcription and encoding on the CPU are several times slower than on Apple Silicon, {slow}."
        )
    } else {
        format!(
            "Replace the Apple-only pieces with equivalents that work on this machine: the mlx-whisper transcriber (for example faster-whisper), VideoToolbox decoding and encoding ({codec}), the aac_at audio encoder, the Swift / Apple Vision scripts, the fcntl.flock file locks and vm_stat of the Whisper gate, and symlinks (copy instead).{shell}",
            codec = hardware_codec(m),
            shell = if m.os == Os::Windows {
                " Bash commands run in Git Bash, and a venv's Python is .venv/Scripts/python.exe."
            } else {
                ""
            },
        )
    };
    format!(
        "THIS MACHINE:\n\
         This is {article} {kind}, but {written}. Before you rely on a tool, check that it works here. {pieces} Keep the same outputs and quality checks. Save every fix inside TOOLKIT_FOLDER in a way that keeps working on other machines: choose by platform at run time and never remove the Apple Silicon path. Note each fix in MEMORY.md so later edits reuse it.",
        article = if m.kind().starts_with(['A', 'E', 'I', 'O', 'U']) {
            "an"
        } else {
            "a"
        },
        kind = m.kind(),
    )
}

/// Follows the product links when there are any: without it the model reads them as plain data
/// and ignores them (SPEC section 6, Prompt composition).
/// The style rule of the VidAI paragraph when the channel has a style for this video type.
const STYLE_GIVEN: &str = "The channel style lives only in CHANNEL_STYLE above. Never create a Style folder, a Details folder or a STYLE.md, and never write the channel style into any file in CHANNEL_FOLDER; older notes and the toolkit's design kits that mention <channel>/Style/STYLE.md do not apply.";

/// The style rule when it has none (SPEC section 6).
const STYLE_EMPTY: &str = "CHANNEL_STYLE above is empty, so design a fitting style yourself, use it for this video, and save it in CHANNEL_FOLDER/Style/STYLE.md (create the Style folder when it is missing) so it can be used for future videos.";

const PRODUCT_LINKS_STEP: &str = "PRODUCT_LINKS STEP (required):\nFor every link in PRODUCT_LINKS, fetch the page (the WebFetch tool if you have it, otherwise curl in the shell) and find the product images: the og:image and JSON-LD \"image\" entries and the images of the product gallery, at full resolution, never icons, logos or sprites. Download them into CLAUDE_VE/product_images/ inside MAIN_FOLDER, never into CHANNEL_FOLDER or anywhere else. Use them as b-roll where the video talks about that product, and take product names and facts from the page text. If a page cannot be fetched (for example the shop blocks bots), say so in info.txt and carry on without it.";

fn type_word(video_type: VideoType) -> &'static str {
    match video_type {
        VideoType::Long => "Long",
        VideoType::Short => "Short",
    }
}

fn style_label(video_type: VideoType) -> &'static str {
    match video_type {
        VideoType::Long => "Long 16:9",
        VideoType::Short => "Short 9:16",
    }
}

/// Removes blank lines around a user text without touching anything inside it.
fn trim_block(text: &str) -> &str {
    text.trim_start_matches(['\n', '\r']).trim_end()
}

/// The message of a new `edit` session.
pub fn compose_edit(p: &EditPrompt<'_>) -> String {
    let mut parts: Vec<String> = Vec::new();
    let machine = p.machine.filter(|m| !m.is_apple_silicon_mac());
    let machine_header = machine
        .map(|m| format!("\n{}", machine_lines(m)))
        .unwrap_or_default();
    let rotation = p
        .sideways_aroll
        .map(|aroll| format!("\n{}", sideways_aroll_line(&aroll)))
        .unwrap_or_default();
    parts.push(format!(
        "MAIN_FOLDER = {video}\n\
         CHANNEL_FOLDER = {channel}\n\
         Channel Name: {channel}\n\
         VIDEO_TYPE = {kind}{rotation}\n\
         BROLL_FOLDER = {broll}\n\
         TOOLKIT_FOLDER = {toolkit}\n\
         REVIEW_OUTPUT_SOFTWARE = {software}{machine_header}",
        video = p.video_folder,
        channel = p.channel_folder,
        kind = type_word(p.video_type),
        broll = p.broll_folder,
        toolkit = p.toolkit.folder_name(),
        software = p.review_software.display_name(),
    ));
    if let Some(m) = machine {
        parts.push(machine_paragraph(m, p.toolkit, p.harness));
    }
    let links: Vec<&str> = p
        .product_links
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if links.is_empty() {
        parts.push("PRODUCT_LINKS =".to_owned());
    } else {
        parts.push(format!("PRODUCT_LINKS =\n{}", links.join("\n")));
        parts.push(PRODUCT_LINKS_STEP.to_owned());
    }
    let notes = trim_block(p.notes);
    if !notes.trim().is_empty() {
        parts.push(format!("NOTES FOR THIS VIDEO:\n{notes}"));
    }
    parts.push(trim_block(p.channel_prompt).to_owned());
    let style = trim_block(p.channel_style);
    let has_style = !style.trim().is_empty();
    let style = if !has_style { "(empty)" } else { style };
    parts.push(format!(
        "CHANNEL_STYLE ({}):\n{style}",
        style_label(p.video_type)
    ));
    parts.push(format!(
        "VidAI:\n\
         This edit was started from the VidAI app. There is no terminal and nobody can answer questions, so make your best guess and never wait for input.\n\
         The shared toolkit folder for this edit is TOOLKIT_FOLDER. Where older notes (for example MEMORY.md) say CLAUDE_VE_ALL, use TOOLKIT_FOLDER instead, and do not read from, write to or depend on any other toolkit folder.\n\
         {style_rule}\n\
         VidAI marks this video as edited when a Final Cut Pro (.fcpxml) or Premiere Pro (.xml / .prproj) project file exists in the \"output\" folder in MAIN_FOLDER, so save the review project there.\n\
         When the REVIEW_OUTPUT_SOFTWARE output is fully done, clearly write \"[OUTPUT COMPLETED]\" in your last message.",
        style_rule = if has_style { STYLE_GIVEN } else { STYLE_EMPTY },
    ));
    match p.harness {
        Harness::Opencode2 => parts.push(OPENCODE2_PROGRAM.to_owned()),
        Harness::ClaudeCode => {}
    }
    if p.setup != Setup::ClaudeSubscription {
        parts.push(KEEP_WORKING.to_owned());
    }
    parts.push(progress::marker_instructions(JobKind::Edit));
    parts.join("\n\n")
}

const CONTINUE: &str = "Continue the video edit from where it was paused. Background tasks that were running were stopped, so check what finished and redo what did not. Work until the review output is complete.";

/// [`CONTINUE`] for a session in the OpenCode 2 program, which has no background tasks: what a
/// pause stopped are the running commands and sub-agents.
const CONTINUE_OPENCODE: &str = "Continue the video edit from where it was paused. The commands and sub-agents that were running were stopped, so check what finished and redo what did not. Work until the review output is complete.";

/// What the first message of a session in the OpenCode 2 program adds (SPEC section 6, Prompt
/// composition): the editing instructions and MEMORY.md were written for Claude Code, so it names
/// OpenCode's own tools where they differ. Sessions in Claude Code never carry it. `shell` runs
/// commands and moves one that outlives its timeout to the background, `subagent` always runs in
/// the background, and both report back with a message that wakes the session.
pub const OPENCODE2_PROGRAM: &str = "OPENCODE:\nThis edit runs in the OpenCode 2 program, not in Claude Code. Where the instructions or MEMORY.md name Claude Code's tools, use OpenCode's: the shell tool for commands, the read, write and edit tools for files, and the subagent tool for sub-agents (agent general; start several in one step when their work can run in parallel). Sub-agents always run in the background and report back with a <subagent> message when they finish. The shell tool moves a command that is still running after its timeout (2 minutes unless you give a longer one) to the background, where it goes on and reports back with a <shell> message when it ends; so give long commands such as transcription, renders and downloads a timeout in milliseconds that is long enough (for example 3600000 for an hour), and never start a command again while it still runs. When nothing is left to do but wait for sub-agents or background commands, end your turn: their reports wake you, and the edit goes on from there.";

/// The progress reminder of a continue message (the markers were listed in the session's first
/// message of the job).
const CONTINUE_MARKERS: &str = "Keep writing the [VIDAI_PROGRESS <name>] marker lines as steps finish, also for steps that finished before the pause and were not marked yet.";

/// The sentence that names what was missing when a job of `kind` failed.
pub fn missing_output_sentence(kind: JobKind) -> &'static str {
    match kind {
        JobKind::Edit => {
            "The last attempt ended without a review project file in the output folder."
        }
        JobKind::ReEdit => {
            "The last attempt ended without saving a new review project version in the output folder."
        }
        JobKind::Render => "The last attempt ended without a final render in the output folder.",
    }
}

/// Body of the continue message: after a pause, or after a failure of a job of that kind.
pub fn continue_body(after_failure: Option<JobKind>) -> String {
    continue_body_in(after_failure, Harness::ClaudeCode)
}

/// [`continue_body`] for a session in `harness`.
pub fn continue_body_in(after_failure: Option<JobKind>, harness: Harness) -> String {
    let start = match harness {
        Harness::ClaudeCode => CONTINUE,
        Harness::Opencode2 => CONTINUE_OPENCODE,
    };
    match after_failure {
        None => format!("{start}\n\n{CONTINUE_MARKERS}"),
        Some(kind) => format!(
            "{start} {}\n\n{CONTINUE_MARKERS}",
            missing_output_sentence(kind)
        ),
    }
}

/// Body of the re-edit message.
pub fn re_edit_body(changes: &str) -> String {
    format!(
        "RE-EDIT REQUEST. I reviewed the edit and want these changes:\n\n{}\n\n\
         Apply these changes and keep everything else as it is. Save a new review project version for REVIEW_OUTPUT_SOFTWARE in the output folder (next _vN number, keep the older versions), update the thumbnails and meta.txt only if the changes affect them, add the re-edit to info.txt, and write [OUTPUT COMPLETED] when done.\n\n{}",
        trim_block(changes),
        progress::marker_instructions(JobKind::ReEdit)
    )
}

/// Body of the render final message.
pub fn render_body(timeline_export_path: Option<&str>, notes: &str) -> String {
    let mut parts = vec![
        "I reviewed and approved the review project. Create the final output render now as described in the Final Output section, and save it in the output folder.".to_owned(),
    ];
    if let Some(path) = timeline_export_path
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        parts.push(format!(
            "I changed the timeline in REVIEW_OUTPUT_SOFTWARE and exported it to: {path}. Use that export as the source of truth for the final render."
        ));
    }
    let notes = trim_block(notes);
    if !notes.trim().is_empty() {
        parts.push(notes.to_owned());
    }
    parts.push("Write [OUTPUT COMPLETED] when the final render is done.".to_owned());
    parts.push(progress::marker_instructions(JobKind::Render));
    parts.join("\n\n")
}

/// A complete follow-up message sent to a resumed session on `setup`: on the Claude
/// subscription the body as it is; on OpenCode the body followed by [`KEEP_WORKING`].
pub fn follow_up_on(body: &str, setup: Setup) -> String {
    match setup {
        Setup::ClaudeSubscription => body.to_owned(),
        _ => format!("{body}\n\n{KEEP_WORKING}"),
    }
}

/// The paragraph that asks a model on OpenCode not to stop before the work is done (SPEC section
/// 6, "Keeping a job going"). Messages of a session on the Claude subscription never carry it.
pub const KEEP_WORKING: &str = "Keep working until the job is done: VidAI cannot answer and only sees your tool calls and files, so do not end your turn until the work is complete and [OUTPUT COMPLETED] is written. Never end a turn with only a sentence about what you will do next: do that step with tool calls in the same turn, then go on to the next one. Write each [VIDAI_PROGRESS <name>] marker as soon as its step is finished, in the message right after it, never several together at the end.";

/// The message VidAI sends when the model ended its turn while its own commands are still busy
/// on the computer (a transcription or render started in the background of a shell, which is
/// slow on an older Mac). It asks the model to wait for them in one blocking command instead of
/// polling, and says what to do when one looks stuck.
pub const WAIT_FOR_WORK: &str = "Your commands are still running and the computer is busy with them. Do not end your turn and do not poll in short loops: wait with one command that blocks until they finish (for example `wait`, or a loop that sleeps 30 seconds and checks the output, for up to 10 minutes), then go on with the next step. If a command shows no new output for 10 minutes, find out why and restart it.";

/// The message VidAI sends by itself when a turn of a job of `kind` ended before the work was
/// done (`jobs::keepgoing`). It goes to the live session of the same process, whose environment
/// cannot have changed.
pub fn continuation_body(kind: JobKind, nudge: &Nudge) -> String {
    continuation_body_on(kind, nudge, Setup::ClaudeSubscription)
}

/// [`continuation_body`] for a job on `setup`: on an API option the marker reminder is stronger,
/// because those models wrote all their markers in the last message; on the Claude subscription
/// it is exactly [`continuation_body`].
pub fn continuation_body_on(kind: JobKind, nudge: &Nudge, setup: Setup) -> String {
    const GO_ON_OPENCODE: &str = "Keep working now: do the next step with tool calls, and go on step by step until everything is done. Never end your turn after only announcing a step; do it in the same turn. Write each [VIDAI_PROGRESS <name>] marker as soon as its step is finished, in the message right after it, not several together at the end, and write [OUTPUT COMPLETED] in your last message once everything is done.";
    const GO_ON: &str = "Keep working now: do the next step with tool calls, and go on step by step until everything is done. Never end your turn after only announcing a step; do it in the same turn. Keep writing the [VIDAI_PROGRESS <name>] marker lines as steps finish, and write [OUTPUT COMPLETED] in your last message once everything is done.";
    match nudge {
        Nudge::KeepWorking => {
            let missing = match kind {
                JobKind::Edit => {
                    "The edit is not finished yet: there is no review project in the output folder."
                }
                JobKind::ReEdit => {
                    "The re-edit is not finished yet: there is no new review project version in the output folder."
                }
                JobKind::Render => {
                    "The final render is not finished yet: there is no new final render in the output folder."
                }
            };
            let go_on = match setup {
                Setup::ClaudeSubscription => GO_ON,
                _ => GO_ON_OPENCODE,
            };
            format!("{missing} {go_on}")
        }
        Nudge::Finish {
            file,
            extras_missing,
        } => match kind {
            JobKind::Edit if *extras_missing => format!(
                "The review project output/{file} is saved, but [OUTPUT COMPLETED] is not written yet, and the thumbnails and meta.txt are missing. Finish every remaining step now with tool calls (the thumbnails, meta.txt and info.txt), then write [OUTPUT COMPLETED] in your last message."
            ),
            JobKind::Edit => format!(
                "The review project output/{file} is saved, but [OUTPUT COMPLETED] is not written yet. Finish any remaining step now with tool calls, then write [OUTPUT COMPLETED] in your last message."
            ),
            JobKind::ReEdit => format!(
                "The new review project version output/{file} is saved, but [OUTPUT COMPLETED] is not written yet. Finish any remaining step now with tool calls (info.txt, and the thumbnails and meta.txt if the changes affect them), then write [OUTPUT COMPLETED] in your last message."
            ),
            JobKind::Render => format!(
                "The final render output/{file} is in the output folder, but [OUTPUT COMPLETED] is not written yet. Finish any remaining step now with tool calls (check the file and update info.txt), then write [OUTPUT COMPLETED] in your last message."
            ),
        },
        Nudge::WaitForWork => WAIT_FOR_WORK.to_owned(),
        Nudge::SaveOutput => match kind {
            JobKind::Edit => "You wrote [OUTPUT COMPLETED], but there is no review project in the output folder in MAIN_FOLDER. Save the REVIEW_OUTPUT_SOFTWARE review project there now with tool calls (a .fcpxml file for Final Cut Pro, a .xml or .prproj file for Premiere Pro), then write [OUTPUT COMPLETED] again.",
            JobKind::ReEdit => "You wrote [OUTPUT COMPLETED], but there is no new review project version in the output folder in MAIN_FOLDER. Save it there now with tool calls (the next _vN number), then write [OUTPUT COMPLETED] again.",
            JobKind::Render => "You wrote [OUTPUT COMPLETED], but there is no new final render in the output folder in MAIN_FOLDER. Save the final render there now with tool calls, then write [OUTPUT COMPLETED] again.",
        }
        .to_owned(),
    }
}

/// The paragraph that tells a new session about the earlier work, when the old session could not
/// be resumed. `newest_review_file` is the file name of the newest review project, if any.
pub fn earlier_work_paragraph(newest_review_file: Option<&str>) -> String {
    match newest_review_file {
        Some(name) => format!(
            "This video was already edited in an earlier Claude Code session that can no longer be resumed. The working files are in the CLAUDE_VE folder in MAIN_FOLDER, and the current review project is output/{name}. Build on that work instead of starting over."
        ),
        None => "This video was already worked on in an earlier Claude Code session that can no longer be resumed. The working files are in the CLAUDE_VE folder in MAIN_FOLDER, but there is no review project yet. Reuse the work that is there instead of starting over.".to_owned(),
    }
}

/// The message of a new session that replaces a session that is gone: the full `edit`
/// composition, the paragraph about the earlier work, then the follow-up body.
pub fn compose_fallback(
    edit: &EditPrompt<'_>,
    newest_review_file: Option<&str>,
    follow_up_body: &str,
) -> String {
    format!(
        "{}\n\n{}\n\n{}",
        compose_edit(edit),
        earlier_work_paragraph(newest_review_file),
        follow_up_body
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::machine::{Arch, Gpu};

    fn edit<'a>(links: &'a str, notes: &'a str, style: &'a str) -> EditPrompt<'a> {
        EditPrompt {
            video_folder: "2026-11-01 Unboxing",
            channel_folder: "Tech Reviews",
            video_type: VideoType::Long,
            broll_folder: "B-Roll",
            toolkit: ToolkitKind::Standard,
            review_software: ReviewSoftware::Fcp,
            product_links: links,
            notes,
            channel_prompt: "\nEdit this video tightly.\n\nKeep jokes.\n",
            channel_style: style,
            sideways_aroll: None,
            machine: None,
            setup: Setup::ClaudeSubscription,
            harness: Harness::ClaudeCode,
        }
    }

    const VIDAI_UNAVAILABLE: &str = "VidAI:
This edit was started from the VidAI app. There is no terminal and nobody can answer questions, so make your best guess and never wait for input.
The shared toolkit folder for this edit is TOOLKIT_FOLDER. Where older notes (for example MEMORY.md) say CLAUDE_VE_ALL, use TOOLKIT_FOLDER instead, and do not read from, write to or depend on any other toolkit folder.
The channel style lives only in CHANNEL_STYLE above. Never create a Style folder, a Details folder or a STYLE.md, and never write the channel style into any file in CHANNEL_FOLDER; older notes and the toolkit's design kits that mention <channel>/Style/STYLE.md do not apply.
VidAI marks this video as edited when a Final Cut Pro (.fcpxml) or Premiere Pro (.xml / .prproj) project file exists in the \"output\" folder in MAIN_FOLDER, so save the review project there.
When the REVIEW_OUTPUT_SOFTWARE output is fully done, clearly write \"[OUTPUT COMPLETED]\" in your last message.";

    /// The progress markers paragraph that ends the first message of an edit.
    const PROGRESS_EDIT: &str = "Progress markers: VidAI shows a progress bar for this job. Each time one of these steps is finished, write its marker on a line by itself in a normal message of the main session (never in sub-agents). Steps may finish in any order; skip a step that does not apply.
[VIDAI_PROGRESS inspected] - the footage, MEMORY.md and the inputs are checked
[VIDAI_PROGRESS transcribed] - the A-roll transcript is ready
[VIDAI_PROGRESS planned] - the written edit plan is ready
[VIDAI_PROGRESS graphics_built] - every programmatic graphic and b-roll is built
[VIDAI_PROGRESS broll_ready] - the b-roll footage is conformed and the product images are prepared
[VIDAI_PROGRESS assembled] - the timeline is assembled and the audio is normalized
[VIDAI_PROGRESS checked] - the quality checks are done
[VIDAI_PROGRESS review_saved] - the review project is saved in the output folder
[VIDAI_PROGRESS extras_written] - the thumbnails, meta.txt and info.txt are written";

    const CONTINUE_MARKERS_TEXT: &str = "Keep writing the [VIDAI_PROGRESS <name>] marker lines as steps finish, also for steps that finished before the pause and were not marked yet.";

    #[test]
    fn edit_composition_exact_text() {
        let text = compose_edit(&edit(
            "https://a.example/1\n\n  https://b.example/2  \n",
            "Use the red mug shot.\n",
            "Bold yellow captions.",
        ));
        let expected = format!(
            "MAIN_FOLDER = 2026-11-01 Unboxing
CHANNEL_FOLDER = Tech Reviews
Channel Name: Tech Reviews
VIDEO_TYPE = Long
BROLL_FOLDER = B-Roll
TOOLKIT_FOLDER = CLAUDE_VE_ALL
REVIEW_OUTPUT_SOFTWARE = Final Cut Pro

PRODUCT_LINKS =
https://a.example/1
https://b.example/2

{PRODUCT_LINKS_STEP}

NOTES FOR THIS VIDEO:
Use the red mug shot.

Edit this video tightly.

Keep jokes.

CHANNEL_STYLE (Long 16:9):
Bold yellow captions.

{VIDAI_UNAVAILABLE}

{PROGRESS_EDIT}"
        );
        assert_eq!(text, expected);
    }

    #[test]
    fn edit_composition_without_links_notes_and_style() {
        let mut p = edit("", "  \n", "");
        p.video_type = VideoType::Short;
        p.toolkit = ToolkitKind::Own;
        p.review_software = ReviewSoftware::Premiere;
        let text = compose_edit(&p);
        let expected = "MAIN_FOLDER = 2026-11-01 Unboxing
CHANNEL_FOLDER = Tech Reviews
Channel Name: Tech Reviews
VIDEO_TYPE = Short
BROLL_FOLDER = B-Roll
TOOLKIT_FOLDER = CLAUDE_VE_ALL_OWN
REVIEW_OUTPUT_SOFTWARE = Premiere Pro

PRODUCT_LINKS =

Edit this video tightly.

Keep jokes.

CHANNEL_STYLE (Short 9:16):
(empty)

VidAI:
This edit was started from the VidAI app. There is no terminal and nobody can answer questions, so make your best guess and never wait for input.
The shared toolkit folder for this edit is TOOLKIT_FOLDER. Where older notes (for example MEMORY.md) say CLAUDE_VE_ALL, use TOOLKIT_FOLDER instead, and do not read from, write to or depend on any other toolkit folder.
CHANNEL_STYLE above is empty, so design a fitting style yourself, use it for this video, and save it in CHANNEL_FOLDER/Style/STYLE.md (create the Style folder when it is missing) so it can be used for future videos.
VidAI marks this video as edited when a Final Cut Pro (.fcpxml) or Premiere Pro (.xml / .prproj) project file exists in the \"output\" folder in MAIN_FOLDER, so save the review project there.
When the REVIEW_OUTPUT_SOFTWARE output is fully done, clearly write \"[OUTPUT COMPLETED]\" in your last message.";
        assert_eq!(text, format!("{expected}\n\n{PROGRESS_EDIT}"));
    }

    #[test]
    fn edit_composition_names_a_sideways_main_aroll() {
        let plain = edit("", "", "");
        let mut sideways = plain.clone();
        sideways.video_type = VideoType::Short;
        sideways.sideways_aroll = Some(SidewaysAroll {
            file_name: "DSC_2078.MOV",
            rotation: 270,
        });
        let text = compose_edit(&sideways);
        let (header, rest) = text.split_once("\n\n").unwrap();
        assert_eq!(
            header,
            "MAIN_FOLDER = 2026-11-01 Unboxing
CHANNEL_FOLDER = Tech Reviews
Channel Name: Tech Reviews
VIDEO_TYPE = Short
MAIN_AROLL_ROTATION = The main A-roll file \"DSC_2078.MOV\" is stored sideways with no rotation flag. Rotate it 270 degrees clockwise to make it upright.
BROLL_FOLDER = B-Roll
TOOLKIT_FOLDER = CLAUDE_VE_ALL
REVIEW_OUTPUT_SOFTWARE = Final Cut Pro"
        );
        // Everything after the header is the same as without the line.
        let mut short = plain.clone();
        short.video_type = VideoType::Short;
        let without = compose_edit(&short);
        assert_eq!(rest, without.split_once("\n\n").unwrap().1);

        let mut other_way = plain.clone();
        other_way.sideways_aroll = Some(SidewaysAroll {
            file_name: "clip one.mp4",
            rotation: 90,
        });
        assert!(compose_edit(&other_way).contains(
            "\nVIDEO_TYPE = Long\nMAIN_AROLL_ROTATION = The main A-roll file \"clip one.mp4\" is stored sideways with no rotation flag. Rotate it 90 degrees clockwise to make it upright.\nBROLL_FOLDER = B-Roll\n"
        ));

        let mut upside_down = plain;
        upside_down.sideways_aroll = Some(SidewaysAroll {
            file_name: "C0001.MP4",
            rotation: 180,
        });
        assert!(compose_edit(&upside_down).contains(
            "\nVIDEO_TYPE = Long\nMAIN_AROLL_ROTATION = The main A-roll file \"C0001.MP4\" is stored upside down with no rotation flag. Rotate it 180 degrees clockwise to make it upright.\nBROLL_FOLDER = B-Roll\n"
        ));
    }

    fn machine(
        os: Os,
        arch: Arch,
        version: &str,
        cpu: &str,
        gpus: Option<Vec<Gpu>>,
    ) -> MachineFacts {
        MachineFacts {
            os,
            os_version: Some(version.to_owned()),
            arch: Some(arch),
            cpu: Some(cpu.to_owned()),
            physical_cores: Some(8),
            logical_cores: Some(16),
            memory_bytes: Some(17_179_869_184),
            gpus,
        }
    }

    fn gpu(name: &str, vendor: GpuVendor) -> Gpu {
        Gpu {
            name: name.to_owned(),
            vendor,
        }
    }

    /// Everything after the header of the plain composition (`edit("", "", "")`).
    fn after_header(text: &str) -> &str {
        text.split_once("\n\n").unwrap().1
    }

    const HEADER: &str = "MAIN_FOLDER = 2026-11-01 Unboxing
CHANNEL_FOLDER = Tech Reviews
Channel Name: Tech Reviews
VIDEO_TYPE = Long
BROLL_FOLDER = B-Roll
TOOLKIT_FOLDER = CLAUDE_VE_ALL
REVIEW_OUTPUT_SOFTWARE = Final Cut Pro";

    const MACHINE_CLOSING: &str = "Keep the same outputs and quality checks. Save every fix inside TOOLKIT_FOLDER in a way that keeps working on other machines: choose by platform at run time and never remove the Apple Silicon path. Note each fix in MEMORY.md so later edits reuse it.";

    #[test]
    fn apple_silicon_mac_adds_nothing() {
        let plain = edit("https://a.example/1", "Notes.", "Style.");
        let facts = machine(
            Os::MacOs,
            Arch::Arm64,
            "macOS 26.6.2",
            "Apple M3 Max",
            Some(vec![gpu("Apple M3 Max", GpuVendor::Apple)]),
        );
        let with = EditPrompt {
            machine: Some(&facts),
            ..plain.clone()
        };
        assert_eq!(compose_edit(&with), compose_edit(&plain));
        assert_eq!(
            compose_fallback(&with, None, "Cut 2s."),
            compose_fallback(&plain, None, "Cut 2s.")
        );
    }

    #[test]
    fn intel_mac_exact_text() {
        let facts = machine(
            Os::MacOs,
            Arch::X64,
            "macOS 15.4.1",
            "Intel Core i9-9880H",
            Some(vec![
                gpu("Intel UHD Graphics 630", GpuVendor::Intel),
                gpu("AMD Radeon Pro 5500M", GpuVendor::Amd),
            ]),
        );
        let plain = edit("", "", "");
        let text = compose_edit(&EditPrompt {
            machine: Some(&facts),
            ..plain.clone()
        });
        let expected = format!(
            "{HEADER}
MACHINE = Intel Mac (x64), macOS 15.4.1
MACHINE_CPU = Intel Core i9-9880H, 8 cores, 16 threads
MACHINE_MEMORY = 16 GB
MACHINE_GPU = Intel UHD Graphics 630; AMD Radeon Pro 5500M

THIS MACHINE:
This is an Intel Mac, but the toolkit in TOOLKIT_FOLDER and its notes in MEMORY.md were written on an Apple Silicon Mac. Before you rely on a tool, check that it works here. Replace the pieces that need Apple Silicon with equivalents that work on this machine: the mlx-whisper transcriber (for example faster-whisper or whisper.cpp) and any VideoToolbox encoder that fails here. VideoToolbox runs on this Mac's Intel or AMD graphics, but some encoders (such as ProRes) may be missing or slow, so test each one once. Homebrew on an Intel Mac lives in /usr/local, not in /opt/homebrew. If pip cannot install faster-whisper (no matching version, or a build from source that fails), the Python is newer than the Intel Mac builds of its parts: make the venv with an older Python (3.9 to 3.12, for example /usr/bin/python3) instead. The Whisper gate (vekit/whisper_gate.py) waits with no time limit until 12 GB of memory is free, which this Mac may never have: if it waits for more than a minute, lower its MIN_FREE_GB to a third of the 16 GB this Mac has. Transcription and encoding on the CPU are several times slower than on Apple Silicon, so start them in the background with progress lines in a log file and check on them, and never leave a command waiting silently. {MACHINE_CLOSING}

{}",
            after_header(&compose_edit(&plain))
        );
        assert_eq!(text, expected);
    }

    /// In the OpenCode 2 program, which has no background tasks of Claude Code's kind, the Intel
    /// Mac paragraph asks for long enough timeouts instead (as their own block does); everything
    /// else of the block is the same, and it comes before their OPENCODE block.
    #[test]
    fn intel_mac_in_the_opencode2_program() {
        let facts = machine(
            Os::MacOs,
            Arch::X64,
            "macOS 15.7.2",
            "Intel Core i7-9750H",
            None,
        );
        let claude_code = compose_edit(&EditPrompt {
            machine: Some(&facts),
            ..edit("", "", "")
        });
        {
            let (harness, block) = (Harness::Opencode2, OPENCODE2_PROGRAM);
            let text = compose_edit(&EditPrompt {
                machine: Some(&facts),
                setup: Setup::OpencodeGo,
                harness,
                ..edit("", "", "")
            });
            assert!(text.contains("\nMACHINE = Intel Mac (x64), macOS 15.7.2\n"));
            let paragraph = text
                .split("\n\n")
                .find(|part| part.starts_with("THIS MACHINE:"))
                .unwrap();
            assert!(paragraph.ends_with(&format!(
                "Transcription and encoding on the CPU are several times slower than on Apple Silicon, so give these commands a timeout that is long enough for that and have them write progress lines to a log file. {MACHINE_CLOSING}"
            )));
            assert!(!paragraph.contains("background"));
            assert_eq!(
                paragraph.replace(
                    "so give these commands a timeout that is long enough for that and have them write progress lines to a log file",
                    "so start them in the background with progress lines in a log file and check on them, and never leave a command waiting silently"
                ),
                claude_code
                    .split("\n\n")
                    .find(|part| part.starts_with("THIS MACHINE:"))
                    .unwrap()
            );
            assert!(text.find("THIS MACHINE:").unwrap() < text.find(block).unwrap());
        }
    }

    #[test]
    fn windows_pc_exact_text() {
        let facts = machine(
            Os::Windows,
            Arch::X64,
            "Windows 11 24H2",
            "12th Gen Intel Core i7-12700",
            Some(vec![
                gpu("NVIDIA GeForce RTX 3060", GpuVendor::Nvidia),
                gpu("Intel UHD Graphics 770", GpuVendor::Intel),
            ]),
        );
        let mut plain = edit("https://a.example/1", "", "");
        plain.review_software = ReviewSoftware::Premiere;
        let text = compose_edit(&EditPrompt {
            machine: Some(&facts),
            ..plain.clone()
        });
        let expected = format!(
            "{}
MACHINE = Windows PC (x64), Windows 11 24H2
MACHINE_CPU = 12th Gen Intel Core i7-12700, 8 cores, 16 threads
MACHINE_MEMORY = 16 GB
MACHINE_GPU = NVIDIA GeForce RTX 3060; Intel UHD Graphics 770

THIS MACHINE:
This is a Windows PC, but the toolkit in TOOLKIT_FOLDER and its notes in MEMORY.md were written on an Apple Silicon Mac. Before you rely on a tool, check that it works here. Replace the Apple-only pieces with equivalents that work on this machine: the mlx-whisper transcriber (for example faster-whisper), VideoToolbox decoding and encoding (use NVENC / NVDEC on the NVIDIA GPU or Quick Sync on the Intel GPU), the aac_at audio encoder, the Swift / Apple Vision scripts, the fcntl.flock file locks and vm_stat of the Whisper gate, and symlinks (copy instead). Bash commands run in Git Bash, and a venv's Python is .venv/Scripts/python.exe. {MACHINE_CLOSING}

{}",
            HEADER.replace("Final Cut Pro", "Premiere Pro"),
            after_header(&compose_edit(&plain))
        );
        assert_eq!(text, expected);
        assert!(text.contains("\n\nPRODUCT_LINKS =\nhttps://a.example/1\n\n"));
    }

    #[test]
    fn product_step_only_with_links() {
        let with = compose_edit(&edit("https://a.example/1", "", ""));
        let without = compose_edit(&edit("", "", ""));
        assert!(with.contains("PRODUCT_LINKS STEP (required):"));
        assert!(with.contains("CLAUDE_VE/product_images/"));
        assert!(!without.contains("PRODUCT_LINKS STEP"));
    }

    #[test]
    fn style_folder_only_without_a_channel_style() {
        let given = compose_edit(&edit("", "", "Bold captions."));
        let empty = compose_edit(&edit("", "", " \n"));
        assert!(given.contains("Never create a Style folder"));
        assert!(!given.contains("CHANNEL_FOLDER/Style/STYLE.md"));
        assert!(empty.contains("save it in CHANNEL_FOLDER/Style/STYLE.md"));
        assert!(!empty.contains("Never create a Style folder"));
    }

    #[test]
    fn windows_pc_without_a_known_gpu_and_missing_facts() {
        let mut facts = machine(
            Os::Windows,
            Arch::X64,
            "Windows 10 22H2",
            "AMD Ryzen 7 5800X 8-Core Processor",
            Some(vec![gpu(
                "Microsoft Basic Display Adapter",
                GpuVendor::Other,
            )]),
        );
        let plain = edit("", "", "");
        let with = |facts: &MachineFacts| {
            compose_edit(&EditPrompt {
                machine: Some(facts),
                ..plain.clone()
            })
        };
        let text = with(&facts);
        let (header, rest) = text.split_once("\n\n").unwrap();
        assert_eq!(
            header,
            format!(
                "{HEADER}
MACHINE = Windows PC (x64), Windows 10 22H2
MACHINE_CPU = AMD Ryzen 7 5800X 8-Core Processor, 8 cores, 16 threads
MACHINE_MEMORY = 16 GB
MACHINE_GPU = Microsoft Basic Display Adapter"
            )
        );
        assert!(rest.starts_with("THIS MACHINE:\nThis is a Windows PC, but the toolkit in TOOLKIT_FOLDER and its notes in MEMORY.md were written on an Apple Silicon Mac. Before you rely on a tool, check that it works here. Replace the Apple-only pieces with equivalents that work on this machine: the mlx-whisper transcriber (for example faster-whisper), VideoToolbox decoding and encoding (find a hardware encoder that ffmpeg can use here), the aac_at audio encoder,"));
        assert!(rest.ends_with(after_header(&compose_edit(&plain))));

        // An AMD GPU, and no adapter found at all.
        facts.gpus = Some(vec![gpu("Radeon RX 580 Series", GpuVendor::Amd)]);
        let amd = with(&facts);
        assert!(amd.contains("\nMACHINE_GPU = Radeon RX 580 Series (AMD)\n\n"));
        assert!(amd.contains("(use AMF on the AMD GPU)"));
        facts.gpus = Some(Vec::new());
        let none = with(&facts);
        assert!(none.contains("\nMACHINE_GPU = none found\n\n"));
        assert!(none.contains("(find a hardware encoder that ffmpeg can use here)"));

        // Facts that could not be read leave their lines out; the paragraph stays.
        let unknown = MachineFacts::unknown(Os::Windows);
        let text = with(&unknown);
        assert_eq!(
            text.split_once("\n\n").unwrap().0,
            format!("{HEADER}\nMACHINE = Windows PC")
        );
        assert!(text.contains("\n\nTHIS MACHINE:\nThis is a Windows PC, but "));
    }

    #[test]
    fn own_toolkit_and_fallback_carry_the_block() {
        let facts = machine(Os::Windows, Arch::X64, "Windows 11 24H2", "CPU", None);
        let mut own = edit("", "", "");
        own.toolkit = ToolkitKind::Own;
        own.machine = Some(&facts);
        let text = compose_edit(&own);
        assert!(text.contains("\nTOOLKIT_FOLDER = CLAUDE_VE_ALL_OWN\n"));
        assert!(text.contains("\nTHIS MACHINE:\nThis is a Windows PC, but the notes in MEMORY.md were written on an Apple Silicon Mac, and tools in TOOLKIT_FOLDER may have been too. Before you rely on a tool,"));
        assert!(!text.contains("MACHINE_GPU"));

        // A new session that replaces a lost one reads the block once; resumed sessions already
        // have it from their first message.
        let fallback = compose_fallback(&own, None, &continue_body(None));
        assert!(fallback.starts_with(&text));
        assert_eq!(fallback.matches("THIS MACHINE:").count(), 1);
        assert!(!continue_body(None).contains("THIS MACHINE"));
    }

    #[test]
    fn continue_messages_exact_text() {
        assert_eq!(
            continue_body(None),
            format!(
                "Continue the video edit from where it was paused. Background tasks that were running were stopped, so check what finished and redo what did not. Work until the review output is complete.\n\n{CONTINUE_MARKERS_TEXT}"
            )
        );
        assert_eq!(
            continue_body(Some(JobKind::Edit)),
            format!(
                "Continue the video edit from where it was paused. Background tasks that were running were stopped, so check what finished and redo what did not. Work until the review output is complete. The last attempt ended without a review project file in the output folder.\n\n{CONTINUE_MARKERS_TEXT}"
            )
        );
        assert!(continue_body(Some(JobKind::Render)).ends_with(&format!(
            "The last attempt ended without a final render in the output folder.\n\n{CONTINUE_MARKERS_TEXT}"
        )));
        assert!(continue_body(Some(JobKind::ReEdit)).ends_with(&format!(
            "The last attempt ended without saving a new review project version in the output folder.\n\n{CONTINUE_MARKERS_TEXT}"
        )));
    }

    #[test]
    fn re_edit_message_exact_text() {
        assert_eq!(
            re_edit_body("\nMake the intro shorter.\nRemove the cat.\n"),
            "RE-EDIT REQUEST. I reviewed the edit and want these changes:

Make the intro shorter.
Remove the cat.

Apply these changes and keep everything else as it is. Save a new review project version for REVIEW_OUTPUT_SOFTWARE in the output folder (next _vN number, keep the older versions), update the thumbnails and meta.txt only if the changes affect them, add the re-edit to info.txt, and write [OUTPUT COMPLETED] when done.

Progress markers: VidAI shows a progress bar for this job. Each time one of these steps is finished, write its marker on a line by itself in a normal message of the main session (never in sub-agents). Steps may finish in any order; skip a step that does not apply.
[VIDAI_PROGRESS changes_applied] - the requested changes are made
[VIDAI_PROGRESS review_saved] - the review project is saved in the output folder"
        );
    }

    #[test]
    fn render_message_exact_text() {
        assert_eq!(
            render_body(None, ""),
            "I reviewed and approved the review project. Create the final output render now as described in the Final Output section, and save it in the output folder.

Write [OUTPUT COMPLETED] when the final render is done.

Progress markers: VidAI shows a progress bar for this job. Each time one of these steps is finished, write its marker on a line by itself in a normal message of the main session (never in sub-agents). Steps may finish in any order; skip a step that does not apply.
[VIDAI_PROGRESS render_started] - the final render is running
[VIDAI_PROGRESS rendered] - the final render file is complete"
        );
        assert_eq!(
            render_body(Some(" /Users/e/Export/final.fcpxml "), "Louder music.\n"),
            "I reviewed and approved the review project. Create the final output render now as described in the Final Output section, and save it in the output folder.

I changed the timeline in REVIEW_OUTPUT_SOFTWARE and exported it to: /Users/e/Export/final.fcpxml. Use that export as the source of truth for the final render.

Louder music.

Write [OUTPUT COMPLETED] when the final render is done.

Progress markers: VidAI shows a progress bar for this job. Each time one of these steps is finished, write its marker on a line by itself in a normal message of the main session (never in sub-agents). Steps may finish in any order; skip a step that does not apply.
[VIDAI_PROGRESS render_started] - the final render is running
[VIDAI_PROGRESS rendered] - the final render file is complete"
        );
    }

    #[test]
    fn fallback_message_exact_text() {
        let p = edit("", "", "");
        let text = compose_fallback(&p, Some("Unboxing_v2.fcpxml"), &re_edit_body("Cut 2s."));
        let expected = format!(
            "{}\n\nThis video was already edited in an earlier Claude Code session that can no longer be resumed. The working files are in the CLAUDE_VE folder in MAIN_FOLDER, and the current review project is output/Unboxing_v2.fcpxml. Build on that work instead of starting over.\n\n{}",
            compose_edit(&p),
            re_edit_body("Cut 2s.")
        );
        assert_eq!(text, expected);
        assert_eq!(
            earlier_work_paragraph(None),
            "This video was already worked on in an earlier Claude Code session that can no longer be resumed. The working files are in the CLAUDE_VE folder in MAIN_FOLDER, but there is no review project yet. Reuse the work that is there instead of starting over."
        );
    }

    const KEEP_WORKING_TEXT: &str = "Keep working until the job is done: VidAI cannot answer and only sees your tool calls and files, so do not end your turn until the work is complete and [OUTPUT COMPLETED] is written. Never end a turn with only a sentence about what you will do next: do that step with tool calls in the same turn, then go on to the next one. Write each [VIDAI_PROGRESS <name>] marker as soon as its step is finished, in the message right after it, never several together at the end.";

    #[test]
    fn a_session_in_the_opencode2_program_gets_its_own_block() {
        let claude_code = EditPrompt {
            setup: Setup::OpencodeGo,
            ..edit("", "", "")
        };
        // The block sits right before the keep-working paragraph; nothing else changes.
        let program2 = EditPrompt {
            harness: Harness::Opencode2,
            ..claude_code.clone()
        };
        assert_eq!(
            compose_edit(&program2),
            compose_edit(&claude_code).replace(
                &format!("\n\n{KEEP_WORKING_TEXT}"),
                &format!("\n\n{OPENCODE2_PROGRAM}\n\n{KEEP_WORKING_TEXT}")
            )
        );
        assert_eq!(
            OPENCODE2_PROGRAM,
            "OPENCODE:\nThis edit runs in the OpenCode 2 program, not in Claude Code. Where the instructions or MEMORY.md name Claude Code's tools, use OpenCode's: the shell tool for commands, the read, write and edit tools for files, and the subagent tool for sub-agents (agent general; start several in one step when their work can run in parallel). Sub-agents always run in the background and report back with a <subagent> message when they finish. The shell tool moves a command that is still running after its timeout (2 minutes unless you give a longer one) to the background, where it goes on and reports back with a <shell> message when it ends; so give long commands such as transcription, renders and downloads a timeout in milliseconds that is long enough (for example 3600000 for an hour), and never start a command again while it still runs. When nothing is left to do but wait for sub-agents or background commands, end your turn: their reports wake you, and the edit goes on from there."
        );
        // Continue names what a pause stops there; in Claude Code it is unchanged.
        assert_eq!(
            continue_body_in(Some(JobKind::Edit), Harness::Opencode2),
            "Continue the video edit from where it was paused. The commands and sub-agents that were running were stopped, so check what finished and redo what did not. Work until the review output is complete. The last attempt ended without a review project file in the output folder.\n\nKeep writing the [VIDAI_PROGRESS <name>] marker lines as steps finish, also for steps that finished before the pause and were not marked yet."
        );
        assert_eq!(
            continue_body_in(None, Harness::ClaudeCode),
            continue_body(None)
        );
    }

    #[test]
    fn a_session_on_opencode_is_asked_to_keep_working() {
        let claude = edit("", "", "Style.");
        let opencode = EditPrompt {
            setup: Setup::OpencodeGo,
            ..claude.clone()
        };
        // The paragraph sits between the VidAI paragraph and the progress markers.
        let text = compose_edit(&opencode);
        assert_eq!(
            text,
            compose_edit(&claude).replace(
                &format!("\n\n{PROGRESS_EDIT}"),
                &format!("\n\n{KEEP_WORKING_TEXT}\n\n{PROGRESS_EDIT}")
            )
        );
        assert!(text.contains(&format!("{VIDAI_UNAVAILABLE}\n\n{KEEP_WORKING_TEXT}\n\n")));
        // The fallback carries it once, inside its composition.
        let fallback = compose_fallback(&opencode, None, &continue_body(None));
        assert_eq!(fallback.matches(KEEP_WORKING_TEXT).count(), 1);
        assert!(!compose_fallback(&claude, None, &continue_body(None)).contains(KEEP_WORKING_TEXT));
        // A follow-up to a resumed session on OpenCode ends with the paragraph.
        assert_eq!(
            follow_up_on("Cut 2s.", Setup::OpencodeGo),
            format!("Cut 2s.\n\n{KEEP_WORKING_TEXT}")
        );
        // The Claude subscription keeps its exact text.
        assert_eq!(
            follow_up_on("Cut 2s.", Setup::ClaudeSubscription),
            "Cut 2s."
        );
    }

    const GO_ON_TEXT: &str = "Keep working now: do the next step with tool calls, and go on step by step until everything is done. Never end your turn after only announcing a step; do it in the same turn. Keep writing the [VIDAI_PROGRESS <name>] marker lines as steps finish, and write [OUTPUT COMPLETED] in your last message once everything is done.";

    #[test]
    fn continuation_messages_on_opencode_ask_for_each_marker_when_its_step_is_done() {
        let keep = Nudge::KeepWorking;
        // The Claude subscription keeps its text; OpenCode gets the stronger marker reminder.
        assert_eq!(
            continuation_body_on(JobKind::Edit, &keep, Setup::ClaudeSubscription),
            continuation_body(JobKind::Edit, &keep)
        );
        assert_eq!(
            continuation_body_on(JobKind::Edit, &keep, Setup::OpencodeGo),
            "The edit is not finished yet: there is no review project in the output folder. Keep working now: do the next step with tool calls, and go on step by step until everything is done. Never end your turn after only announcing a step; do it in the same turn. Write each [VIDAI_PROGRESS <name>] marker as soon as its step is finished, in the message right after it, not several together at the end, and write [OUTPUT COMPLETED] in your last message once everything is done."
        );
        // The other messages are the same on both.
        for nudge in [Nudge::SaveOutput, Nudge::WaitForWork] {
            assert_eq!(
                continuation_body_on(JobKind::Edit, &nudge, Setup::OpencodeGo),
                continuation_body(JobKind::Edit, &nudge)
            );
        }
        assert_eq!(
            continuation_body(JobKind::Edit, &Nudge::WaitForWork),
            "Your commands are still running and the computer is busy with them. Do not end your turn and do not poll in short loops: wait with one command that blocks until they finish (for example `wait`, or a loop that sleeps 30 seconds and checks the output, for up to 10 minutes), then go on with the next step. If a command shows no new output for 10 minutes, find out why and restart it."
        );
    }

    #[test]
    fn continuation_messages_exact_text() {
        assert_eq!(
            continuation_body(JobKind::Edit, &Nudge::KeepWorking),
            format!(
                "The edit is not finished yet: there is no review project in the output folder. {GO_ON_TEXT}"
            )
        );
        assert_eq!(
            continuation_body(JobKind::ReEdit, &Nudge::KeepWorking),
            format!(
                "The re-edit is not finished yet: there is no new review project version in the output folder. {GO_ON_TEXT}"
            )
        );
        assert_eq!(
            continuation_body(JobKind::Render, &Nudge::KeepWorking),
            format!(
                "The final render is not finished yet: there is no new final render in the output folder. {GO_ON_TEXT}"
            )
        );
        let finish = |extras_missing| Nudge::Finish {
            file: "Unboxing_v1.fcpxml".into(),
            extras_missing,
        };
        assert_eq!(
            continuation_body(JobKind::Edit, &finish(true)),
            "The review project output/Unboxing_v1.fcpxml is saved, but [OUTPUT COMPLETED] is not written yet, and the thumbnails and meta.txt are missing. Finish every remaining step now with tool calls (the thumbnails, meta.txt and info.txt), then write [OUTPUT COMPLETED] in your last message."
        );
        assert_eq!(
            continuation_body(JobKind::Edit, &finish(false)),
            "The review project output/Unboxing_v1.fcpxml is saved, but [OUTPUT COMPLETED] is not written yet. Finish any remaining step now with tool calls, then write [OUTPUT COMPLETED] in your last message."
        );
        assert_eq!(
            continuation_body(JobKind::ReEdit, &finish(false)),
            "The new review project version output/Unboxing_v1.fcpxml is saved, but [OUTPUT COMPLETED] is not written yet. Finish any remaining step now with tool calls (info.txt, and the thumbnails and meta.txt if the changes affect them), then write [OUTPUT COMPLETED] in your last message."
        );
        assert_eq!(
            continuation_body(
                JobKind::Render,
                &Nudge::Finish {
                    file: "final.mp4".into(),
                    extras_missing: false
                }
            ),
            "The final render output/final.mp4 is in the output folder, but [OUTPUT COMPLETED] is not written yet. Finish any remaining step now with tool calls (check the file and update info.txt), then write [OUTPUT COMPLETED] in your last message."
        );
        assert_eq!(
            continuation_body(JobKind::Edit, &Nudge::SaveOutput),
            "You wrote [OUTPUT COMPLETED], but there is no review project in the output folder in MAIN_FOLDER. Save the REVIEW_OUTPUT_SOFTWARE review project there now with tool calls (a .fcpxml file for Final Cut Pro, a .xml or .prproj file for Premiere Pro), then write [OUTPUT COMPLETED] again."
        );
        assert_eq!(
            continuation_body(JobKind::ReEdit, &Nudge::SaveOutput),
            "You wrote [OUTPUT COMPLETED], but there is no new review project version in the output folder in MAIN_FOLDER. Save it there now with tool calls (the next _vN number), then write [OUTPUT COMPLETED] again."
        );
        assert_eq!(
            continuation_body(JobKind::Render, &Nudge::SaveOutput),
            "You wrote [OUTPUT COMPLETED], but there is no new final render in the output folder in MAIN_FOLDER. Save the final render there now with tool calls, then write [OUTPUT COMPLETED] again."
        );
    }
}

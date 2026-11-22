//! The picture check on Windows (SPEC sections 8 and 11).
//!
//! The app binary is its own helper: `main` calls [`app_entry`] first, and when the binary was
//! started with [`HELPER_FLAG`] it measures one video ([`serve`]) and exits before anything of the
//! app starts. Otherwise [`app_entry`] registers the running binary as the helper, and every
//! check starts it again as a child process (no console window, in a kill-on-close job object, see
//! `platform::process`). A crash or hang in a video decoder therefore ends only that child, and
//! the time limit is hard: the child ends itself after [`TIME_LIMIT`] and is killed after
//! [`KILL_AFTER`]. The child speaks the protocol of `vidai-orient` (`super::sidecar`), so the
//! decision logic of `crate::orientation` is shared with macOS.
//!
//! What the child does (the WinRT calls are in `super::winrt`):
//! - Frames come from `Windows.Media.Editing` (`MediaComposition::GetThumbnailAsync`, nearest key
//!   frame, as players show the picture), scaled to at most [`MAX_FRAME_SIDE`] pixels.
//! - Faces come from `Windows.Media.FaceAnalysis.FaceDetector`. It reports a box only, with no
//!   roll angle and no score, and it is made for upright faces. So each frame is searched turned
//!   each way ([`TURNS`]), and the turn that shows the face becomes the faces' roll
//!   ([`roll_degrees`]): a face that is upright once the frame is turned 90 degrees clockwise has
//!   a roll of 90, exactly what Apple Vision reports for it. The detector has its own fixed
//!   acceptance threshold, so every face it reports gets a confidence of 1.
//! - The detector sometimes also accepts a face lying on its side (measured on the test clips:
//!   a sideways or upside-down portrait was also found a quarter turn off, with a looser box). So
//!   when more than one turn shows a face, each of those turns is searched again tilted a further
//!   [`TILT_DEGREES`] either way: an upright face is still found with a slight tilt, a face found
//!   at the edge of what the detector accepts mostly is not. The turn found most often wins
//!   ([`pick_turn`]); a tie leaves the frame without a face, which keeps the check conservative.
//! - A file the platform cannot open or decode is unreadable (final for that file version),
//!   except when it is in a format that needs a decoder Windows does not ship (HEVC, AV1, VP9, see
//!   [`needs_optional_decoder`]) or Media Foundation says a decoder is missing: that is a failure
//!   that may pass once the decoder is installed (for HEVC the "HEVC Video Extensions" from the
//!   Microsoft Store), so nothing is cached and the check runs again after the next start.
//!
//! Everything here that does not call Windows is pure and tested on every platform.

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

use crate::orientation::{FaceObservation, MIN_FACE_AREA, Rotation};

/// The first argument that makes the app binary run as the picture check helper.
pub const HELPER_FLAG: &str = "--vidai-picture-check";

/// The helper's name in messages.
pub const NAME: &str = "the picture check helper";

/// The helper's own time limit. On the CI runner (Windows Server 2025, 4 cores, five checks at
/// once) a 720p clip took about 3 seconds and a 4K clip under 9; the margin is for slow disks and
/// a busy machine.
pub const TIME_LIMIT: Duration = Duration::from_secs(30);

/// The hard limit from outside, in case the helper hangs before its own timer runs.
pub const KILL_AFTER: Duration = Duration::from_secs(45);

/// Frames are scaled to at most this many pixels on their longer side (as on macOS).
pub const MAX_FRAME_SIDE: u32 = 960;

/// At most this many faces are reported per frame, largest first (as on macOS).
pub const MAX_FACES_PER_FRAME: usize = 3;

/// The clockwise turns tried on each frame.
pub const TURNS: [Rotation; 4] = [
    Rotation::Upright,
    Rotation::Cw90,
    Rotation::Cw180,
    Rotation::Cw270,
];

/// The extra tilt, either way, that tells apart turns that all show a face (see the module docs).
/// Within the head tilt every talking-head frame has (Apple Vision measured up to 13 degrees on
/// the owner's footage) plus a margin, and well short of the 45 degrees halfway to the next turn.
pub const TILT_DEGREES: f64 = 20.0;

/// The turn that shows the face, from how often each candidate turn found one (`(turn, hits)`):
/// the one with the most hits, or `None` when the best is shared or nothing was found.
pub fn pick_turn(hits: &[(Rotation, u32)]) -> Option<Rotation> {
    let best = hits.iter().map(|&(_, n)| n).max().filter(|&n| n > 0)?;
    let mut winners = hits.iter().filter(|&&(_, n)| n == best);
    let (turn, _) = *winners.next()?;
    winners.next().is_none().then_some(turn)
}

/// `gray` (`width` x `height`, one byte per pixel) turned clockwise by `degrees` around its
/// center, with bilinear sampling, at the same size: corners that come from outside the picture
/// are mid gray.
pub fn tilt_gray(gray: &[u8], width: u32, height: u32, degrees: f64) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    debug_assert_eq!(gray.len(), w * h);
    let (sin, cos) = degrees.to_radians().sin_cos();
    let (cx, cy) = ((w as f64 - 1.0) / 2.0, (h as f64 - 1.0) / 2.0);
    let at = |x: i64, y: i64| -> f64 {
        if x < 0 || y < 0 || x >= w as i64 || y >= h as i64 {
            128.0
        } else {
            f64::from(gray[y as usize * w + x as usize])
        }
    };
    let mut out = Vec::with_capacity(gray.len());
    for y in 0..h {
        for x in 0..w {
            // The source of an output pixel: turned back (counterclockwise) around the center.
            let (dx, dy) = (x as f64 - cx, y as f64 - cy);
            let sx = cx + dx * cos + dy * sin;
            let sy = cy - dx * sin + dy * cos;
            let (x0, y0) = (sx.floor(), sy.floor());
            let (fx, fy) = (sx - x0, sy - y0);
            let (x0, y0) = (x0 as i64, y0 as i64);
            let top = at(x0, y0) * (1.0 - fx) + at(x0 + 1, y0) * fx;
            let bottom = at(x0, y0 + 1) * (1.0 - fx) + at(x0 + 1, y0 + 1) * fx;
            out.push((top * (1.0 - fy) + bottom * fy).round() as u8);
        }
    }
    out
}

/// Exit codes of the helper protocol (`super::sidecar`).
pub mod exit {
    pub const OK: i32 = 0;
    pub const USAGE: i32 = 2;
    pub const UNREADABLE: i32 = 3;
    pub const TIMED_OUT: i32 = 4;
    pub const FAILURE: i32 = 5;
}

/// Why the helper has no observations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    /// The file cannot be read as a video (exit code 3, final for this file version).
    Unreadable(String),
    /// Anything that may pass (exit code 5).
    Failed(String),
}

/// What the helper was asked to do.
#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    pub frames: u32,
    pub time_limit: Duration,
    pub path: PathBuf,
}

/// Parses the helper's arguments (after [`HELPER_FLAG`]):
/// `[--frames N] [--time-limit SECONDS] [--] <video path>`, with the same rules as `vidai-orient`.
pub fn parse_options(args: &[OsString]) -> Result<Options, String> {
    let mut options = Options {
        frames: 7,
        time_limit: TIME_LIMIT,
        path: PathBuf::new(),
    };
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let flag = arg.to_string_lossy();
        match flag.as_ref() {
            "--" => {
                paths.extend(rest.by_ref().map(PathBuf::from));
                break;
            }
            "--frames" => {
                let value = rest.next().ok_or("--frames needs a value")?;
                options.frames = value
                    .to_str()
                    .and_then(|v| v.parse::<u32>().ok())
                    .filter(|n| (1..=30).contains(n))
                    .ok_or("--frames must be a whole number from 1 to 30")?;
            }
            "--time-limit" => {
                let value = rest.next().ok_or("--time-limit needs a value")?;
                let seconds = value
                    .to_str()
                    .and_then(|v| v.parse::<f64>().ok())
                    .filter(|s| *s > 0.0 && *s <= 300.0)
                    .ok_or("--time-limit must be a number of seconds above 0 and up to 300")?;
                options.time_limit = Duration::from_secs_f64(seconds);
            }
            other if other.starts_with("--") => return Err(format!("unknown option {other}")),
            _ => paths.push(PathBuf::from(arg)),
        }
    }
    match <[PathBuf; 1]>::try_from(paths) {
        Ok([path]) if !path.as_os_str().is_empty() => options.path = path,
        _ => {
            return Err(format!(
                "usage: {HELPER_FLAG} [--frames N] [--time-limit SECONDS] <video path>"
            ));
        }
    }
    Ok(options)
}

/// The sample times in seconds: `count` times evenly between 5 % and 95 % of `duration`, or the
/// middle for a single frame (as `vidai-orient` does).
pub fn sample_times(duration: f64, count: u32) -> Vec<f64> {
    (0..count)
        .map(|i| {
            let fraction = if count == 1 {
                0.5
            } else {
                0.05 + 0.90 * f64::from(i) / f64::from(count - 1)
            };
            duration * fraction
        })
        .collect()
}

/// `width` x `height` scaled down to at most `max_side` on the longer side, keeping the aspect
/// ratio; never scaled up, never below one pixel.
pub fn scaled_size(width: u32, height: u32, max_side: u32) -> (u32, u32) {
    let longer = width.max(height);
    if longer <= max_side || longer == 0 {
        return (width.max(1), height.max(1));
    }
    let scale = |side: u32| {
        ((f64::from(side) * f64::from(max_side) / f64::from(longer)).round() as u32).max(1)
    };
    (scale(width), scale(height))
}

/// The thumbnail width to ask the platform for, the height following the picture's aspect ratio:
/// the displayed width scaled to at most [`MAX_FRAME_SIDE`] on the longer side. Thumbnails show
/// the picture with the rotation flag applied, so a flag of 90 or 270 degrees
/// (`MF_MT_VIDEO_ROTATION`, `rotation`) swaps the coded sides. 0 (the platform's own size) when
/// the coded size is not known.
pub fn thumbnail_width(coded_width: u32, coded_height: u32, rotation: Option<u32>) -> u32 {
    if coded_width == 0 || coded_height == 0 {
        return 0;
    }
    let (width, height) = match rotation {
        Some(90 | 270) => (coded_height, coded_width),
        _ => (coded_width, coded_height),
    };
    scaled_size(width, height, MAX_FRAME_SIDE).0
}

/// 8-bit luma (BT.601) of BGRA pixels, as `FaceDetector`'s `Gray8` format wants it.
pub fn bgra_to_gray(bgra: &[u8]) -> Vec<u8> {
    bgra.as_chunks::<4>()
        .0
        .iter()
        .map(|p| {
            let (b, g, r) = (u32::from(p[0]), u32::from(p[1]), u32::from(p[2]));
            ((299 * r + 587 * g + 114 * b + 500) / 1000) as u8
        })
        .collect()
}

/// `pixels` (`width` x `height`, `bytes_per_pixel` each, rows without padding) turned clockwise
/// by `turn`, with the new width and height.
pub fn rotate_pixels(
    pixels: &[u8],
    width: u32,
    height: u32,
    bytes_per_pixel: usize,
    turn: Rotation,
) -> (Vec<u8>, u32, u32) {
    let (w, h, bpp) = (width as usize, height as usize, bytes_per_pixel);
    debug_assert_eq!(pixels.len(), w * h * bpp);
    if turn == Rotation::Upright {
        return (pixels.to_vec(), width, height);
    }
    let (new_w, new_h) = if turn.swaps_sides() { (h, w) } else { (w, h) };
    let mut out = vec![0u8; pixels.len()];
    for y in 0..h {
        for x in 0..w {
            // Where the source pixel (x, y) lands after the clockwise turn.
            let (nx, ny) = match turn {
                Rotation::Upright => (x, y),
                Rotation::Cw90 => (h - 1 - y, x),
                Rotation::Cw180 => (w - 1 - x, h - 1 - y),
                Rotation::Cw270 => (y, w - 1 - x),
            };
            let from = (y * w + x) * bpp;
            let to = (ny * new_w + nx) * bpp;
            out[to..to + bpp].copy_from_slice(&pixels[from..from + bpp]);
        }
    }
    (out, new_w as u32, new_h as u32)
}

/// The roll, in Apple Vision's terms, of a face that is upright once the frame is turned
/// clockwise by `turn`: 0, 90, 180 or -90 degrees (negative = the face is turned clockwise).
pub fn roll_degrees(turn: Rotation) -> f64 {
    match turn {
        Rotation::Upright => 0.0,
        Rotation::Cw90 => 90.0,
        Rotation::Cw180 => 180.0,
        Rotation::Cw270 => -90.0,
    }
}

/// The smallest face side worth finding in a `width` x `height` frame: a square of the decision's
/// minimum face area ([`MIN_FACE_AREA`]). Smaller faces would be ignored anyway, and a tiny false
/// face found upright must not hide a real one found turned.
pub fn min_face_side(width: u32, height: u32) -> u32 {
    let area = f64::from(width) * f64::from(height) * MIN_FACE_AREA;
    (area.sqrt().floor() as u32).max(1)
}

/// One face the detector found in a `frame_width` x `frame_height` frame turned by `turn`.
pub fn face(
    box_width: u32,
    box_height: u32,
    frame_width: u32,
    frame_height: u32,
    turn: Rotation,
) -> FaceObservation {
    let frame_area = f64::from(frame_width) * f64::from(frame_height);
    let area = if frame_area > 0.0 {
        f64::from(box_width) * f64::from(box_height) / frame_area
    } else {
        0.0
    };
    FaceObservation {
        roll_degrees: roll_degrees(turn),
        confidence: 1.0,
        area: round(area, 4),
    }
}

/// `faces` largest first, at most [`MAX_FACES_PER_FRAME`].
pub fn largest_faces(mut faces: Vec<FaceObservation>) -> Vec<FaceObservation> {
    faces.sort_by(|a, b| b.area.total_cmp(&a.area));
    faces.truncate(MAX_FACES_PER_FRAME);
    faces
}

/// Rounds to `places` decimals, so the output stays short and stable.
pub fn round(value: f64, places: i32) -> f64 {
    let scale = 10f64.powi(places);
    (value * scale).round() / scale
}

/// True for a video format whose decoder Windows does not ship but the user can install: HEVC
/// (HEVC Video Extensions), AV1 (AV1 Video Extension) and VP9 (VP9 Video Extensions). `codec` is
/// an MP4 / MOV sample entry code (`hvc1`) or a Media Foundation subtype name (`HEVC`).
pub fn needs_optional_decoder(codec: &str) -> bool {
    const OPTIONAL: [&str; 11] = [
        "hvc1", "hev1", "dvh1", "dvhe", "hevc", "h265", "av01", "av1", "vp09", "vp9", "vp90",
    ];
    OPTIONAL
        .iter()
        .any(|c| c.eq_ignore_ascii_case(codec.trim()))
}

/// Media Foundation's "no decoder for this format" (`MF_E_TOPO_CODEC_NOT_FOUND`).
pub const MF_E_TOPO_CODEC_NOT_FOUND: u32 = 0xC00D_5212;

/// What a failure to open or decode the video means: a missing optional decoder may pass once it
/// is installed, anything else means the file cannot be read as a video. `codecs` are what is
/// known about the video's format (sample entry code, subtype), `hresult` and `message` describe
/// the error.
pub fn decode_problem(codecs: &[String], hresult: u32, message: &str) -> Problem {
    let missing = codecs.iter().find(|c| needs_optional_decoder(c));
    let detail = format!("{} ({hresult:#010X})", message.trim());
    match missing {
        Some(codec) => Problem::Failed(format!(
            "this PC has no decoder for {codec} video; {}: {detail}",
            install_hint(codec)
        )),
        None if hresult == MF_E_TOPO_CODEC_NOT_FOUND => {
            Problem::Failed(format!("this PC has no decoder for this video: {detail}"))
        }
        None => Problem::Unreadable(format!("the file cannot be read as a video: {detail}")),
    }
}

fn install_hint(codec: &str) -> &'static str {
    let lower = codec.to_ascii_lowercase();
    if lower.starts_with("av") {
        "install the AV1 Video Extension from the Microsoft Store"
    } else if lower.starts_with("vp") {
        "install the VP9 Video Extensions from the Microsoft Store"
    } else {
        "install the HEVC Video Extensions from the Microsoft Store"
    }
}

#[cfg(windows)]
pub use process::*;

/// The app side (registering and starting the helper) and the helper side ([`serve`]).
#[cfg(windows)]
mod process {
    use std::ffi::OsString;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::OnceLock;
    use std::time::Duration;

    use super::{HELPER_FLAG, KILL_AFTER, NAME, Problem, TIME_LIMIT, exit, parse_options};
    use crate::orientation::{Observations, PictureCheckError};
    use crate::platform::orientation::{sidecar, winrt};

    const _: () = assert!(exit::UNREADABLE == sidecar::EXIT_UNREADABLE);

    static HELPER: OnceLock<PathBuf> = OnceLock::new();

    /// Called first thing in `main`. Started as the helper, it runs the check and exits; otherwise
    /// it registers the running app binary as the helper.
    pub fn app_entry() {
        let args: Vec<OsString> = std::env::args_os().skip(1).collect();
        if args.first().is_some_and(|first| first == HELPER_FLAG) {
            std::process::exit(serve(&args[1..]));
        }
        match std::env::current_exe() {
            Ok(exe) => use_helper(exe),
            Err(err) => eprintln!(
                "vidai: the app binary was not found ({err}), so Long / Short detection uses the file's metadata only"
            ),
        }
    }

    /// Uses `exe` (a VidAI app binary) as the picture check helper. The app registers itself in
    /// [`app_entry`]; tests register the app binary cargo built. The first registration wins.
    pub fn use_helper(exe: PathBuf) {
        let _ = HELPER.set(exe);
    }

    /// True when a helper is registered and this Windows can find faces (not, for example, an
    /// N edition without the Media Feature Pack). Asked once.
    pub fn available() -> bool {
        static SUPPORTED: OnceLock<bool> = OnceLock::new();
        HELPER.get().is_some()
            && *SUPPORTED.get_or_init(|| {
                let supported = winrt::face_detection_supported();
                if !supported {
                    eprintln!(
                        "vidai: face detection is not available on this PC, so Long / Short detection uses the file's metadata only"
                    );
                }
                supported
            })
    }

    /// Runs the registered helper on `video`.
    pub fn observe_faces(video: &Path, frames: u32) -> Result<Observations, PictureCheckError> {
        let helper = HELPER.get().ok_or(PictureCheckError::NotAvailable)?;
        run(helper, video, frames)
    }

    /// Runs the app binary `exe` as the helper on `video`.
    pub fn run(exe: &Path, video: &Path, frames: u32) -> Result<Observations, PictureCheckError> {
        run_with_limits(exe, video, frames, TIME_LIMIT, KILL_AFTER)
    }

    /// [`run`] with the given time limits.
    pub fn run_with_limits(
        exe: &Path,
        video: &Path,
        frames: u32,
        time_limit: Duration,
        kill_after: Duration,
    ) -> Result<Observations, PictureCheckError> {
        let mut cmd = Command::new(exe);
        cmd.arg(HELPER_FLAG);
        sidecar::run(NAME, cmd, video, frames, time_limit, kill_after)
    }

    /// The helper: measures one video as `args` say and returns the exit code. Prints one JSON
    /// line of observations on stdout, or one `{"error": "..."}` line on stderr.
    pub fn serve(args: &[OsString]) -> i32 {
        let options = match parse_options(args) {
            Ok(options) => options,
            Err(message) => return report(exit::USAGE, &message),
        };
        // The hard time limit: whatever Media Foundation is doing, the process ends.
        let limit = options.time_limit;
        let _ = std::thread::Builder::new()
            .name("time-limit".into())
            .spawn(move || {
                std::thread::sleep(limit);
                std::process::exit(report(
                    exit::TIMED_OUT,
                    &format!(
                        "the time limit of {} seconds was reached",
                        limit.as_secs_f64()
                    ),
                ));
            });
        match winrt::observe(&options.path, options.frames) {
            Ok(observations) => match serde_json::to_string(&observations) {
                Ok(line) => {
                    let mut out = std::io::stdout().lock();
                    if writeln!(out, "{line}").and_then(|()| out.flush()).is_err() {
                        return exit::FAILURE;
                    }
                    exit::OK
                }
                Err(err) => report(exit::FAILURE, &format!("could not write the result: {err}")),
            },
            Err(Problem::Unreadable(message)) => report(exit::UNREADABLE, &message),
            Err(Problem::Failed(message)) => report(exit::FAILURE, &message),
        }
    }

    /// Writes `{"error": message}` on stderr and returns `code`.
    fn report(code: i32, message: &str) -> i32 {
        let line = serde_json::json!({ "error": message });
        let mut err = std::io::stderr().lock();
        let _ = writeln!(err, "{line}").and_then(|()| err.flush());
        code
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_the_arguments_like_vidai_orient() {
        let options = parse_options(&args(&[
            "--frames",
            "7",
            "--time-limit",
            "20",
            "--",
            "C:\\a b.mp4",
        ]))
        .unwrap();
        assert_eq!(
            options,
            Options {
                frames: 7,
                time_limit: Duration::from_secs(20),
                path: PathBuf::from("C:\\a b.mp4"),
            }
        );
        // A path that starts with dashes after `--`, defaults without options.
        assert_eq!(
            parse_options(&args(&["--", "--odd.mov"])).unwrap().path,
            PathBuf::from("--odd.mov")
        );
        let defaults = parse_options(&args(&["clip.mov"])).unwrap();
        assert_eq!((defaults.frames, defaults.time_limit), (7, TIME_LIMIT));
        assert_eq!(
            parse_options(&args(&["--time-limit", "0.5", "x"]))
                .unwrap()
                .time_limit,
            Duration::from_millis(500)
        );
        for bad in [
            &["--frames", "0", "x"][..],
            &["--frames", "31", "x"],
            &["--frames", "seven", "x"],
            &["--frames"],
            &["--time-limit", "0", "x"],
            &["--time-limit", "301", "x"],
            &["--time-limit", "NaN", "x"],
            &["--wat", "x"],
            &[],
            &["a", "b"],
            &["--", ""],
        ] {
            assert!(parse_options(&args(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn samples_between_5_and_95_percent() {
        let times = sample_times(100.0, 7);
        assert_eq!(times.len(), 7);
        assert!((times[0] - 5.0).abs() < 1e-9);
        assert!((times[3] - 50.0).abs() < 1e-9);
        assert!((times[6] - 95.0).abs() < 1e-9);
        assert_eq!(sample_times(10.0, 1), vec![5.0]);
    }

    #[test]
    fn scales_down_only() {
        assert_eq!(scaled_size(3840, 2160, 960), (960, 540));
        assert_eq!(scaled_size(1080, 1920, 960), (540, 960));
        assert_eq!(scaled_size(64, 36, 960), (64, 36));
        assert_eq!(scaled_size(5000, 1, 960), (960, 1));
        assert_eq!(scaled_size(0, 0, 960), (1, 1));
        assert_eq!(thumbnail_width(3840, 2160, None), 960);
        assert_eq!(thumbnail_width(3840, 2160, Some(0)), 960);
        assert_eq!(thumbnail_width(3840, 2160, Some(180)), 960);
        assert_eq!(thumbnail_width(3840, 2160, Some(90)), 540);
        assert_eq!(thumbnail_width(3840, 2160, Some(270)), 540);
        assert_eq!(thumbnail_width(1080, 1920, None), 540);
        assert_eq!(thumbnail_width(64, 36, None), 64);
        assert_eq!(thumbnail_width(64, 36, Some(90)), 36);
        assert_eq!(thumbnail_width(0, 0, None), 0);
    }

    #[test]
    fn converts_bgra_to_gray() {
        // Blue, green, red, white, black (alpha ignored).
        let bgra = [
            255, 0, 0, 9, 0, 255, 0, 9, 0, 0, 255, 9, 255, 255, 255, 0, 0, 0, 0, 255,
        ];
        assert_eq!(bgra_to_gray(&bgra), vec![29, 150, 76, 255, 0]);
    }

    #[test]
    fn rotates_clockwise() {
        // 3 x 2:   a b c
        //          d e f
        let pixels = b"abcdef";
        let turned = |turn| rotate_pixels(pixels, 3, 2, 1, turn);
        assert_eq!(turned(Rotation::Upright), (b"abcdef".to_vec(), 3, 2));
        // Clockwise 90: d a / e b / f c.
        assert_eq!(turned(Rotation::Cw90), (b"daebfc".to_vec(), 2, 3));
        assert_eq!(turned(Rotation::Cw180), (b"fedcba".to_vec(), 3, 2));
        // Clockwise 270: c f / b e / a d.
        assert_eq!(turned(Rotation::Cw270), (b"cfbead".to_vec(), 2, 3));
        // Whole pixels move together.
        let two = b"aAbB";
        assert_eq!(
            rotate_pixels(two, 2, 1, 2, Rotation::Cw90),
            (b"aAbB".to_vec(), 1, 2)
        );
        assert_eq!(
            rotate_pixels(two, 2, 1, 2, Rotation::Cw180),
            (b"bBaA".to_vec(), 2, 1)
        );
    }

    #[test]
    fn a_turn_and_its_undo_restore_the_picture() {
        let pixels: Vec<u8> = (0..20).collect();
        for (turn, undo) in [
            (Rotation::Cw90, Rotation::Cw270),
            (Rotation::Cw180, Rotation::Cw180),
            (Rotation::Cw270, Rotation::Cw90),
        ] {
            let (once, w, h) = rotate_pixels(&pixels, 5, 4, 1, turn);
            assert_eq!(rotate_pixels(&once, w, h, 1, undo), (pixels.clone(), 5, 4));
        }
    }

    /// A face found with the frame turned votes, through the shared decision, for that turn.
    #[test]
    fn rolls_vote_for_the_turn_that_found_the_face() {
        use crate::orientation::{FrameObservation, Observations, PROTOCOL, decide_rotation};
        for turn in TURNS {
            let frame = FrameObservation {
                time: 1.0,
                decoded: true,
                faces: vec![face(120, 150, 960, 540, turn)],
            };
            let observations = Observations {
                protocol: PROTOCOL,
                duration_seconds: 10.0,
                frame_width: 960,
                frame_height: 540,
                frames: vec![frame; 7],
            };
            assert_eq!(decide_rotation(&observations), turn);
        }
    }

    #[test]
    fn picks_the_turn_found_most_often() {
        use Rotation::{Cw90, Cw180, Cw270, Upright};
        assert_eq!(pick_turn(&[(Cw90, 3)]), Some(Cw90));
        assert_eq!(pick_turn(&[(Upright, 1), (Cw90, 3)]), Some(Cw90));
        assert_eq!(pick_turn(&[(Cw180, 2), (Cw270, 1)]), Some(Cw180));
        // A shared best is ambiguous, nothing found is no face.
        assert_eq!(pick_turn(&[(Upright, 2), (Cw90, 2)]), None);
        assert_eq!(pick_turn(&[(Upright, 0)]), None);
        assert_eq!(pick_turn(&[]), None);
    }

    #[test]
    fn tilts_around_the_center() {
        let gray: Vec<u8> = (0..25).map(|v| v * 10).collect();
        // No tilt and a full turn keep the picture.
        assert_eq!(tilt_gray(&gray, 5, 5, 0.0), gray);
        assert_eq!(tilt_gray(&gray, 5, 5, 360.0), gray);
        // A quarter turn of a square equals the exact quarter turn, clockwise.
        assert_eq!(
            tilt_gray(&gray, 5, 5, 90.0),
            rotate_pixels(&gray, 5, 5, 1, Rotation::Cw90).0
        );
        // The center stays, a small tilt brings mid gray into the corners of a non-square frame.
        let tilted = tilt_gray(&[200; 12], 4, 3, TILT_DEGREES);
        assert_eq!(tilted.len(), 12);
        assert_eq!(tilted[5], 200);
        assert!(tilted[0] < 200);
    }

    #[test]
    fn describes_faces() {
        let f = face(96, 54, 960, 540, Rotation::Cw270);
        assert_eq!(f.roll_degrees, -90.0);
        assert_eq!(f.confidence, 1.0);
        assert_eq!(f.area, 0.01);
        assert_eq!(face(1, 1, 0, 0, Rotation::Upright).area, 0.0);
        let sorted = largest_faces(vec![
            face(10, 10, 100, 100, Rotation::Upright),
            face(30, 30, 100, 100, Rotation::Upright),
            face(20, 20, 100, 100, Rotation::Upright),
            face(5, 5, 100, 100, Rotation::Upright),
        ]);
        assert_eq!(
            sorted.iter().map(|f| f.area).collect::<Vec<_>>(),
            [0.09, 0.04, 0.01]
        );
        // The smallest face worth finding covers the decision's minimum area.
        let side = min_face_side(960, 540);
        assert_eq!(side, 32);
        assert!(f64::from(side * side) / (960.0 * 540.0) <= MIN_FACE_AREA);
        assert_eq!(min_face_side(0, 0), 1);
        assert_eq!(round(0.123_456, 4), 0.1235);
    }

    #[test]
    fn a_missing_decoder_may_pass_a_broken_file_is_final() {
        let hevc = vec!["hvc1".to_owned()];
        assert!(matches!(
            decode_problem(&hevc, 0xC00D_36B4, "The data specified for the media type is invalid"),
            Problem::Failed(m) if m.contains("HEVC Video Extensions") && m.contains("0xC00D36B4")
        ));
        assert!(matches!(
            decode_problem(&["AV1".to_owned()], 1, "x"),
            Problem::Failed(m) if m.contains("AV1 Video Extension")
        ));
        assert!(matches!(
            decode_problem(&["vp09".to_owned()], 1, "x"),
            Problem::Failed(m) if m.contains("VP9")
        ));
        assert!(matches!(
            decode_problem(&["apcn".to_owned()], MF_E_TOPO_CODEC_NOT_FOUND, "no codec"),
            Problem::Failed(m) if m.contains("no decoder")
        ));
        assert!(matches!(
            decode_problem(&["avc1".to_owned()], 0xC00D_36C4, "unsupported byte stream"),
            Problem::Unreadable(m) if m.contains("0xC00D36C4")
        ));
        assert!(matches!(
            decode_problem(&[], 0x8000_4005, "x"),
            Problem::Unreadable(_)
        ));
        assert!(needs_optional_decoder(" HEVC "));
        assert!(!needs_optional_decoder("avc1"));
        assert!(!needs_optional_decoder("H264"));
    }
}

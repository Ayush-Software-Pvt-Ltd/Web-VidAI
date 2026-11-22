//! The picture check of the Long / Short detection on real Windows (SPEC sections 8 and 11): the
//! app binary cargo built runs as the helper, on video clips made here from a public domain
//! portrait (tests/fixtures/faces/portrait.txt) with what every Windows has (WIC for the image,
//! `Windows.Media.Editing` with the built-in H.264 encoder for the clip), so no encoder has to be
//! installed and no footage is stored. Each clip shows the face upright, sideways either way,
//! upside down or not at all, in several aspect ratios, with and without a rotation flag.
//!
//! Every case is checked and printed before anything is asserted, so one run shows them all.

#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use vidai_lib::media::probe_display_size;
use vidai_lib::orientation::{self, Observations, PictureCheckError, Rotation, decide_rotation};
use vidai_lib::platform::orientation::windows_helper::{self, rotate_pixels};
use windows::Foundation::TimeSpan;
use windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapDecoder, BitmapEncoder, BitmapPixelFormat, BitmapTransform,
    ColorManagementMode, ExifOrientationMode,
};
use windows::Media::Editing::{MediaClip, MediaComposition, MediaTrimmingPreference};
use windows::Media::MediaProperties::{MediaEncodingProfile, VideoEncodingQuality};
use windows::Media::Transcoding::TranscodeFailureReason;
use windows::Storage::{FileAccessMode, StorageFile};
use windows::core::HSTRING;

/// A line in the test log even when the test passes (the test harness captures only `print!` and
/// `eprint!`), so every CI run shows the measurements.
macro_rules! report {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let _ = writeln!(std::io::stderr(), $($arg)*);
    }};
}

/// The app binary, which is also the helper.
fn app() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_vidai"))
}

/// A fixture file, with `\` separators only (WinRT file APIs reject `/`).
fn fixture(path: &str) -> PathBuf {
    ["tests", "fixtures"]
        .into_iter()
        .chain(path.split('/'))
        .fold(PathBuf::from(env!("CARGO_MANIFEST_DIR")), |dir, part| {
            dir.join(part)
        })
}

/// Runs the helper with limits far above what a check takes, so a slow runner never fails a
/// case by time (a real hang still ends).
fn check(video: &Path, frames: u32) -> Result<Observations, PictureCheckError> {
    windows_helper::run_with_limits(
        &app(),
        video,
        frames,
        Duration::from_secs(120),
        Duration::from_secs(180),
    )
}

/// A picture in BGRA, rows without padding.
#[derive(Clone)]
struct Image {
    bgra: Vec<u8>,
    width: u32,
    height: u32,
}

fn load_portrait() -> Image {
    let path = fixture("faces/portrait.jpg");
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.as_path()))
        .and_then(|op| op.join())
        .expect("open the portrait");
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .and_then(|op| op.join())
        .expect("read the portrait");
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .and_then(|op| op.join())
        .expect("decode the portrait");
    let pixels = decoder
        .GetPixelDataTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &BitmapTransform::new().unwrap(),
            ExifOrientationMode::IgnoreExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )
        .and_then(|op| op.join())
        .and_then(|data| data.DetachPixelData())
        .expect("portrait pixels");
    Image {
        bgra: pixels.to_vec(),
        width: decoder.PixelWidth().unwrap(),
        height: decoder.PixelHeight().unwrap(),
    }
}

/// An upright `width` x `height` picture: a soft gradient, with the portrait in the middle (as
/// large as fits in 90 % of the width and 75 % of the height, like a talking head) when `face`.
fn picture(width: u32, height: u32, face: Option<&Image>) -> Image {
    let mut bgra = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let shade = (70 + 80 * x / width + 40 * y / height) as u8;
            bgra.extend_from_slice(&[shade.saturating_add(20), shade, shade, 255]);
        }
    }
    let mut image = Image {
        bgra,
        width,
        height,
    };
    if let Some(face) = face {
        paste_scaled(&mut image, face);
    }
    image
}

/// Draws `face` centered on `onto`, scaled with bilinear sampling.
fn paste_scaled(onto: &mut Image, face: &Image) {
    let scale = (0.9 * f64::from(onto.width) / f64::from(face.width))
        .min(0.75 * f64::from(onto.height) / f64::from(face.height));
    let (w, h) = (
        (f64::from(face.width) * scale) as u32,
        (f64::from(face.height) * scale) as u32,
    );
    let (left, top) = ((onto.width - w) / 2, (onto.height - h) / 2);
    let sample =
        |x: u32, y: u32, c: usize| f64::from(face.bgra[((y * face.width + x) * 4) as usize + c]);
    for y in 0..h {
        let sy = ((f64::from(y) + 0.5) / scale - 0.5).clamp(0.0, f64::from(face.height - 1));
        let (y0, fy) = (sy.floor() as u32, sy.fract());
        let y1 = (y0 + 1).min(face.height - 1);
        for x in 0..w {
            let sx = ((f64::from(x) + 0.5) / scale - 0.5).clamp(0.0, f64::from(face.width - 1));
            let (x0, fx) = (sx.floor() as u32, sx.fract());
            let x1 = (x0 + 1).min(face.width - 1);
            let at = (((top + y) * onto.width + left + x) * 4) as usize;
            for c in 0..3 {
                let top_row = sample(x0, y0, c) * (1.0 - fx) + sample(x1, y0, c) * fx;
                let bottom_row = sample(x0, y1, c) * (1.0 - fx) + sample(x1, y1, c) * fx;
                onto.bgra[at + c] = (top_row * (1.0 - fy) + bottom_row * fy).round() as u8;
            }
        }
    }
}

fn turned(image: &Image, turn: Rotation) -> Image {
    let (bgra, width, height) = rotate_pixels(&image.bgra, image.width, image.height, 4, turn);
    Image {
        bgra,
        width,
        height,
    }
}

/// A new empty file at `path`, opened as a `StorageFile`.
fn new_storage_file(path: &Path) -> StorageFile {
    fs::write(path, b"").unwrap();
    StorageFile::GetFileFromPathAsync(&HSTRING::from(path))
        .and_then(|op| op.join())
        .expect("open the new file")
}

fn write_png(path: &Path, image: &Image) {
    let file = new_storage_file(path);
    let stream = file
        .OpenAsync(FileAccessMode::ReadWrite)
        .and_then(|op| op.join())
        .expect("open the PNG");
    let encoder = BitmapEncoder::CreateAsync(BitmapEncoder::PngEncoderId().unwrap(), &stream)
        .and_then(|op| op.join())
        .expect("PNG encoder");
    encoder
        .SetPixelData(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Ignore,
            image.width,
            image.height,
            96.0,
            96.0,
            &image.bgra,
        )
        .expect("PNG pixels");
    encoder
        .FlushAsync()
        .and_then(|op| op.join())
        .expect("write the PNG");
}

/// Renders a 3 second H.264 MP4 of the still `image` at its own size.
fn render_clip(dir: &Path, name: &str, image: &Image) -> PathBuf {
    let png = dir.join(format!("{name}.png"));
    write_png(&png, image);
    let still = StorageFile::GetFileFromPathAsync(&HSTRING::from(png.as_path()))
        .and_then(|op| op.join())
        .expect("open the still");
    let clip = MediaClip::CreateFromImageFileAsync(
        &still,
        TimeSpan {
            Duration: 30_000_000,
        },
    )
    .and_then(|op| op.join())
    .expect("clip from the still");
    let composition = MediaComposition::new().unwrap();
    composition.Clips().unwrap().Append(&clip).unwrap();
    let profile = MediaEncodingProfile::CreateMp4(VideoEncodingQuality::HD720p).unwrap();
    let video = profile.Video().unwrap();
    video.SetWidth(image.width).unwrap();
    video.SetHeight(image.height).unwrap();
    let out = dir.join(format!("{name}.mp4"));
    let file = new_storage_file(&out);
    let reason = composition
        .RenderToFileWithProfileAsync(&file, MediaTrimmingPreference::Precise, &profile)
        .and_then(|op| op.join())
        .expect("render the clip");
    assert_eq!(reason, TranscodeFailureReason::None, "rendering {name}");
    out
}

/// Box payload ranges `(kind, start, end)` directly inside `data[from..to]`.
fn boxes(data: &[u8], from: usize, to: usize) -> Vec<([u8; 4], usize, usize)> {
    let mut out = Vec::new();
    let mut at = from;
    while at + 8 <= to {
        let size32 = u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
        let kind: [u8; 4] = data[at + 4..at + 8].try_into().unwrap();
        let (header, size) = match size32 {
            0 => (8, to - at),
            1 => (
                16,
                u64::from_be_bytes(data[at + 8..at + 16].try_into().unwrap()) as usize,
            ),
            n => (8, n),
        };
        if size < header || at + size > to {
            break;
        }
        out.push((kind, at + header, at + size));
        at += size;
    }
    out
}

/// Writes a display matrix into the video track header of the MP4 at `path`, so players show the
/// picture turned clockwise by `turn` (the rotation flag of a phone or a Sony camera).
fn set_rotation_flag(path: &Path, turn: Rotation, coded_width: u32, coded_height: u32) {
    let mut data = fs::read(path).unwrap();
    let one = 0x10000;
    let (w, h) = ((coded_width << 16) as i32, (coded_height << 16) as i32);
    let matrix: [i32; 9] = match turn {
        Rotation::Upright => [one, 0, 0, 0, one, 0, 0, 0, 0x4000_0000],
        Rotation::Cw90 => [0, one, 0, -one, 0, 0, h, 0, 0x4000_0000],
        Rotation::Cw180 => [-one, 0, 0, 0, -one, 0, w, h, 0x4000_0000],
        Rotation::Cw270 => [0, -one, 0, one, 0, 0, 0, w, 0x4000_0000],
    };
    let (_, moov_start, moov_end) = boxes(&data, 0, data.len())
        .into_iter()
        .find(|(kind, _, _)| kind == b"moov")
        .expect("moov");
    let mut written = false;
    for (_, trak_start, trak_end) in boxes(&data, moov_start, moov_end)
        .into_iter()
        .filter(|(kind, _, _)| kind == b"trak")
    {
        let children = boxes(&data, trak_start, trak_end);
        let is_video = children
            .iter()
            .filter(|(kind, _, _)| kind == b"mdia")
            .flat_map(|&(_, s, e)| boxes(&data, s, e))
            .any(|(kind, s, _)| kind == *b"hdlr" && &data[s + 8..s + 12] == b"vide");
        let tkhd = children.iter().find(|(kind, _, _)| kind == b"tkhd");
        if let (true, Some(&(_, start, _))) = (is_video, tkhd) {
            let version = data[start];
            let matrix_at = start + 4 + if version == 1 { 32 } else { 20 } + 16;
            for (i, value) in matrix.iter().enumerate() {
                data[matrix_at + i * 4..matrix_at + i * 4 + 4]
                    .copy_from_slice(&value.to_be_bytes());
            }
            written = true;
        }
    }
    assert!(written, "no video track header in {}", path.display());
    fs::write(path, data).unwrap();
}

/// One clip: an upright picture of `width` x `height` (with or without the face), stored turned
/// clockwise by `stored`, optionally with a rotation flag, and the turn the check must find.
struct Case {
    name: &'static str,
    width: u32,
    height: u32,
    face: bool,
    stored: Rotation,
    flag: Option<Rotation>,
    expected: Rotation,
}

const fn case(
    name: &'static str,
    (width, height): (u32, u32),
    face: bool,
    stored: Rotation,
    flag: Option<Rotation>,
    expected: Rotation,
) -> Case {
    Case {
        name,
        width,
        height,
        face,
        stored,
        flag,
        expected,
    }
}

use Rotation::{Cw90, Cw180, Cw270, Upright};

const CASES: [Case; 12] = [
    case("upright-16x9", (1280, 720), true, Upright, None, Upright),
    // A camera turned sideways with no rotation flag (the Nikon case): a vertical picture
    // stored as a landscape frame.
    case("sideways-cw-9x16", (720, 1280), true, Cw90, None, Cw270),
    case("sideways-ccw-9x16", (720, 1280), true, Cw270, None, Cw90),
    case("upside-down-16x9", (1280, 720), true, Cw180, None, Cw180),
    case("no-face-16x9", (1280, 720), false, Upright, None, Upright),
    case("no-face-sideways", (720, 1280), false, Cw90, None, Upright),
    case("upright-9x16", (720, 1280), true, Upright, None, Upright),
    case("sideways-square", (720, 720), true, Cw90, None, Cw270),
    case("upside-down-4x3", (960, 720), true, Cw180, None, Cw180),
    case("sideways-ccw-3x4", (720, 960), true, Cw270, None, Cw90),
    // A correct rotation flag (phones, Sony): the check sees the picture as players show it.
    case(
        "flagged-9x16",
        (720, 1280),
        true,
        Cw270,
        Some(Cw90),
        Upright,
    ),
    case(
        "flagged-upside-down",
        (1280, 720),
        true,
        Cw180,
        Some(Cw180),
        Upright,
    ),
];

/// The roll of the largest face of each frame, `-` for none, `x` for an undecoded frame.
fn frame_summary(observations: &Observations) -> String {
    observations
        .frames
        .iter()
        .map(|f| match (f.decoded, f.faces.first()) {
            (false, _) => "x".to_owned(),
            (true, None) => "-".to_owned(),
            (true, Some(face)) => format!("{}@{:.3}", face.roll_degrees, face.area),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn finds_the_turn_of_generated_clips() {
    let dir = tempfile::tempdir().unwrap();
    let portrait = load_portrait();
    let mut failures = Vec::new();
    report!("case | stored | flag | frame | decided | expected | render s | check s | frames");
    for case in &CASES {
        let failed_before = failures.len();
        let started = Instant::now();
        let upright = picture(case.width, case.height, case.face.then_some(&portrait));
        let stored = turned(&upright, case.stored);
        let clip = render_clip(dir.path(), case.name, &stored);
        if let Some(flag) = case.flag {
            set_rotation_flag(&clip, flag, stored.width, stored.height);
            let display = probe_display_size(&clip).expect("the flagged clip's display size");
            assert_eq!(
                (display.width, display.height),
                (case.width, case.height),
                "{}: the flag shows the picture upright",
                case.name
            );
        }
        let rendered = started.elapsed();
        let started = Instant::now();
        let result = check(&clip, 7);
        let checked = started.elapsed();
        match result {
            Ok(observations) => {
                let decided = decide_rotation(&observations);
                report!(
                    "{} | {} | {:?} | {}x{} | {} | {} | {:.2} | {:.2} | {}",
                    case.name,
                    case.stored.degrees(),
                    case.flag.map(Rotation::degrees),
                    observations.frame_width,
                    observations.frame_height,
                    decided.degrees(),
                    case.expected.degrees(),
                    rendered.as_secs_f64(),
                    checked.as_secs_f64(),
                    frame_summary(&observations)
                );
                if decided != case.expected {
                    failures.push(format!(
                        "{}: decided {} instead of {}",
                        case.name,
                        decided.degrees(),
                        case.expected.degrees()
                    ));
                }
                if observations.frames.len() != 7 || !observations.frames.iter().all(|f| f.decoded)
                {
                    failures.push(format!("{}: not every frame was decoded", case.name));
                }
                // The frames are the picture as players show it, at most 960 pixels.
                let shown = if case.flag.is_some() {
                    (case.width, case.height)
                } else {
                    (stored.width, stored.height)
                };
                let landscape = shown.0 >= shown.1;
                if (observations.frame_width >= observations.frame_height) != landscape
                    || observations.frame_width.max(observations.frame_height) > 960
                {
                    failures.push(format!(
                        "{}: frames of {}x{} for a picture shown at {}x{}",
                        case.name,
                        observations.frame_width,
                        observations.frame_height,
                        shown.0,
                        shown.1
                    ));
                }
                if !case.face && observations.frames.iter().any(|f| !f.faces.is_empty()) {
                    failures.push(format!("{}: found a face where there is none", case.name));
                }
            }
            Err(err) => {
                report!("{} | error: {err}", case.name);
                failures.push(format!("{}: {err}", case.name));
            }
        }
        if failures.len() > failed_before {
            report!("notes of {}:\n{}", case.name, notes(&clip));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// A large sideways clip: 4K frames are scaled down before looking, and the check stays quick.
#[test]
fn finds_the_turn_of_a_4k_clip_through_the_app_api() {
    let dir = tempfile::tempdir().unwrap();
    let upright = picture(2160, 3840, Some(&load_portrait()));
    let clip = render_clip(dir.path(), "sideways-4k", &turned(&upright, Cw90));
    windows_helper::use_helper(app());
    assert!(orientation::available(), "face detection on this Windows");
    let started = Instant::now();
    let result = orientation::check_picture(&clip);
    report!(
        "4K sideways: {result:?} in {:.2} s",
        started.elapsed().as_secs_f64()
    );
    assert_eq!(result, Ok(Cw270));
}

/// The small fixtures of the media tests: one frame, no face, with and without a rotation flag.
#[test]
fn reads_the_media_fixtures() {
    let landscape = check(&fixture("media/landscape.mp4"), 7).expect("landscape.mp4");
    assert_eq!(
        (landscape.frame_width, landscape.frame_height),
        (64, 36),
        "{landscape:?}"
    );
    assert_eq!(landscape.frames.len(), 7);
    assert!(landscape.frames.iter().all(|f| f.faces.is_empty()));
    // The rotation flag is applied before looking.
    let rotated = check(&fixture("media/rotated-90.mov"), 3).expect("rotated-90.mov");
    assert_eq!(
        (rotated.frame_width, rotated.frame_height),
        (36, 64),
        "{rotated:?}"
    );
}

#[test]
fn reports_unreadable_files_bad_arguments_and_missing_decoders() {
    let dir = tempfile::tempdir().unwrap();
    let junk = dir.path().join("junk.mov");
    fs::write(&junk, b"definitely not a movie").unwrap();
    let result = check(&junk, 7);
    report!("junk: {result:?}");
    assert!(matches!(result, Err(PictureCheckError::Unreadable(_))));
    let result = check(&dir.path().join("missing.mov"), 7);
    assert!(
        matches!(result, Err(PictureCheckError::Unreadable(_))),
        "{result:?}"
    );
    let result = check(&junk, 0);
    assert!(
        matches!(&result, Err(PictureCheckError::Failed(m)) if m.contains("code 2")),
        "{result:?}"
    );
    // HEVC needs a decoder from the Microsoft Store: without it the check may pass later, so it
    // is a failure, never "unreadable".
    let result = check(&fixture("media/hevc.mp4"), 3);
    report!("hevc: {result:?}");
    match result {
        Ok(observations) => report!("this Windows decodes HEVC: {observations:?}"),
        Err(PictureCheckError::Failed(m)) => {
            assert!(m.contains("HEVC Video Extensions"), "{m}")
        }
        Err(other) => panic!("HEVC without a decoder must be a failure: {other:?}"),
    }
}

#[test]
fn ends_itself_at_its_time_limit() {
    let started = Instant::now();
    let result = windows_helper::run_with_limits(
        &app(),
        &fixture("media/landscape.mp4"),
        7,
        Duration::from_millis(1),
        Duration::from_secs(120),
    );
    report!(
        "time limit: {result:?} after {:.2} s",
        started.elapsed().as_secs_f64()
    );
    assert!(
        matches!(&result, Err(PictureCheckError::Failed(m)) if m.contains("code 4")),
        "{result:?}"
    );
}

/// What the helper notes about `clip` with `VIDAI_PICTURE_CHECK_DEBUG` (every turn that shows a
/// face, and its tilts), to explain a failing case in the log.
fn notes(clip: &Path) -> String {
    let output = std::process::Command::new(app())
        .args([windows_helper::HELPER_FLAG, "--frames", "7", "--"])
        .arg(clip)
        .env("VIDAI_PICTURE_CHECK_DEBUG", "1")
        .output()
        .unwrap();
    format!(
        "status {:?}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    )
}

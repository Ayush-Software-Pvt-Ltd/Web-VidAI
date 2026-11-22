//! The WinRT calls of the Windows picture check, run only inside the helper process (see
//! `windows_helper`). All of them are safe Rust through the `windows` crate. Blocking: every
//! asynchronous operation is waited for on the calling thread, which the `windows` crate joins to
//! the multithreaded apartment on first use.

use std::path::Path;

use ::windows::Foundation::TimeSpan;
use ::windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapDecoder, BitmapInterpolationMode, BitmapPixelFormat, BitmapSize,
    BitmapTransform, ColorManagementMode, ExifOrientationMode, SoftwareBitmap,
};
use ::windows::Media::Editing::{MediaClip, MediaComposition, VideoFramePrecision};
use ::windows::Media::FaceAnalysis::FaceDetector;
use ::windows::Security::Cryptography::CryptographicBuffer;
use ::windows::Storage::StorageFile;
use ::windows::core::{Error, HSTRING};

use super::windows_helper::{
    MAX_FRAME_SIDE, Problem, TILT_DEGREES, TURNS, bgra_to_gray, decode_problem, face,
    largest_faces, min_face_side, pick_turn, rotate_pixels, round, sample_times, scaled_size,
    thumbnail_width, tilt_gray,
};
use crate::orientation::{FaceObservation, FrameObservation, Observations, PROTOCOL, Rotation};

/// True when this Windows has a face detector.
pub fn face_detection_supported() -> bool {
    FaceDetector::IsSupported().unwrap_or(false)
}

/// One sampled frame in 8-bit gray.
struct GrayFrame {
    pixels: Vec<u8>,
    width: u32,
    height: u32,
}

/// Samples `frames` frames of the video at `path` and finds the faces in them.
pub fn observe(path: &Path, frames: u32) -> Result<Observations, Problem> {
    if std::fs::File::open(path).is_err() || !path.is_file() {
        return Err(Problem::Unreadable(
            "the file does not exist or cannot be read".into(),
        ));
    }
    let absolute = std::path::absolute(path)
        .map_err(|e| Problem::Failed(format!("could not resolve the path: {e}")))?;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(absolute.as_path()))
        .and_then(|op| op.join())
        .map_err(failed("could not open the file"))?;
    // What is known about the format, to tell a missing decoder from a broken file.
    let mut codecs: Vec<String> = crate::media::video_codec(path).into_iter().collect();
    let clip = MediaClip::CreateFromFileAsync(&file)
        .and_then(|op| op.join())
        .map_err(|e| decode_problem(&codecs, e.code().0 as u32, &e.message()))?;
    let width = match clip.GetVideoEncodingProperties() {
        Ok(props) => {
            if let Ok(subtype) = props.Subtype() {
                codecs.push(subtype.to_string());
            }
            let (coded_width, coded_height) =
                (props.Width().unwrap_or(0), props.Height().unwrap_or(0));
            let rotation = rotation_property(&props);
            note(&format!(
                "coded {coded_width}x{coded_height}, codecs {codecs:?}, rotation {rotation:?}"
            ));
            thumbnail_width(coded_width, coded_height, rotation)
        }
        Err(_) => 0,
    };
    let duration = clip
        .OriginalDuration()
        .map_err(failed("could not read the duration"))?
        .Duration as f64
        / 10_000_000.0;
    if !(duration.is_finite() && duration > 0.0) {
        return Err(Problem::Unreadable("the video has no duration".into()));
    }
    let composition = MediaComposition::new().map_err(failed("could not start the editor"))?;
    composition
        .Clips()
        .and_then(|clips| clips.Append(&clip))
        .map_err(failed("could not load the video"))?;
    let detector = FaceDetector::CreateAsync()
        .and_then(|op| op.join())
        .map_err(failed("could not start face detection"))?;

    let mut sampled = Vec::new();
    let mut size = (0, 0);
    let mut last_error: Option<Error> = None;
    for time in sample_times(duration, frames) {
        let faces = frame_at(&composition, time, width).and_then(|frame| {
            size = (frame.width, frame.height);
            faces_in(&detector, &frame)
        });
        sampled.push(match faces {
            Ok(faces) => FrameObservation {
                time: round(time, 2),
                decoded: true,
                faces,
            },
            Err(err) => {
                note(&format!("frame at {time:.2} s: {}", describe(&err)));
                last_error = Some(err);
                FrameObservation {
                    time: round(time, 2),
                    decoded: false,
                    faces: Vec::new(),
                }
            }
        });
    }
    if !sampled.iter().any(|f| f.decoded) {
        return Err(match last_error {
            Some(err) => decode_problem(&codecs, err.code().0 as u32, &err.message()),
            None => Problem::Unreadable("no frame could be decoded".into()),
        });
    }
    Ok(Observations {
        protocol: PROTOCOL,
        duration_seconds: round(duration, 2),
        frame_width: size.0,
        frame_height: size.1,
        frames: sampled,
    })
}

/// The frame nearest to `seconds` (its key frame) as players show it, scaled to at most
/// `MAX_FRAME_SIDE`, in gray.
fn frame_at(composition: &MediaComposition, seconds: f64, width: u32) -> Result<GrayFrame, Error> {
    let at = TimeSpan {
        Duration: (seconds * 10_000_000.0).round() as i64,
    };
    let stream = composition
        .GetThumbnailAsync(at, width as i32, 0, VideoFramePrecision::NearestKeyFrame)?
        .join()?;
    let decoder = BitmapDecoder::CreateAsync(&stream)?.join()?;
    let (source_width, source_height) = (decoder.PixelWidth()?, decoder.PixelHeight()?);
    let (width, height) = scaled_size(source_width, source_height, MAX_FRAME_SIDE);
    note(&format!(
        "thumbnail {source_width}x{source_height} at {seconds:.2} s, scanned at {width}x{height}"
    ));
    let transform = BitmapTransform::new()?;
    transform.SetScaledWidth(width)?;
    transform.SetScaledHeight(height)?;
    transform.SetInterpolationMode(BitmapInterpolationMode::Fant)?;
    let bgra = decoder
        .GetPixelDataTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &transform,
            ExifOrientationMode::IgnoreExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )?
        .join()?
        .DetachPixelData()?;
    Ok(GrayFrame {
        pixels: bgra_to_gray(&bgra),
        width,
        height,
    })
}

/// The faces of `frame`, from the turn that shows them (see `windows_helper`).
fn faces_in(detector: &FaceDetector, frame: &GrayFrame) -> Result<Vec<FaceObservation>, Error> {
    set_face_sizes(detector, frame);
    let mut candidates = Vec::new();
    for turn in TURNS {
        let (pixels, width, height) =
            rotate_pixels(&frame.pixels, frame.width, frame.height, 1, turn);
        let faces = detect(detector, &pixels, width, height, turn)?;
        if !faces.is_empty() {
            candidates.push((turn, faces, pixels, width, height));
        }
    }
    if candidates.len() <= 1 && !debugging() {
        return Ok(candidates
            .pop()
            .map(|(_, faces, ..)| largest_faces(faces))
            .unwrap_or_default());
    }
    let mut hits = Vec::new();
    for (turn, faces, pixels, width, height) in &candidates {
        let mut found = 1;
        for tilt in [-TILT_DEGREES, TILT_DEGREES] {
            let tilted = tilt_gray(pixels, *width, *height, tilt);
            if !detect(detector, &tilted, *width, *height, *turn)?.is_empty() {
                found += 1;
            }
        }
        note(&format!(
            "turned {}: {found} of 3 tilts show a face, {faces:?}",
            turn.degrees()
        ));
        hits.push((*turn, found));
    }
    if candidates.len() == 1 {
        return Ok(candidates
            .pop()
            .map(|(_, faces, ..)| largest_faces(faces))
            .unwrap_or_default());
    }
    let picked = pick_turn(&hits);
    note(&format!("picked {:?}", picked.map(Rotation::degrees)));
    Ok(candidates
        .into_iter()
        .find(|(turn, ..)| Some(*turn) == picked)
        .map(|(_, faces, ..)| largest_faces(faces))
        .unwrap_or_default())
}

/// The faces the detector finds in the gray `pixels`, measured as found with the frame turned by
/// `turn`.
fn detect(
    detector: &FaceDetector,
    pixels: &[u8],
    width: u32,
    height: u32,
    turn: Rotation,
) -> Result<Vec<FaceObservation>, Error> {
    let buffer = CryptographicBuffer::CreateFromByteArray(pixels)?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Gray8,
        width as i32,
        height as i32,
    )?;
    let found = detector.DetectFacesAsync(&bitmap)?.join()?;
    let mut faces = Vec::new();
    for i in 0..found.Size()? {
        let face_box = found.GetAt(i)?.FaceBox()?;
        faces.push(face(face_box.Width, face_box.Height, width, height, turn));
    }
    Ok(faces)
}

/// Faces from the decision's minimum size up to the frame's shorter side.
fn set_face_sizes(detector: &FaceDetector, frame: &GrayFrame) {
    let side = min_face_side(frame.width, frame.height);
    let shorter = frame.width.min(frame.height);
    if let Err(err) = detector.SetMinDetectableFaceSize(BitmapSize {
        Width: side,
        Height: side,
    }) {
        note(&format!("minimum face size {side}: {}", describe(&err)));
    }
    if let Err(err) = detector.SetMaxDetectableFaceSize(BitmapSize {
        Width: shorter,
        Height: shorter,
    }) {
        note(&format!("maximum face size {shorter}: {}", describe(&err)));
    }
}

/// The rotation Media Foundation reports for the video (`MF_MT_VIDEO_ROTATION`, degrees
/// counterclockwise), when it reports one.
fn rotation_property(
    props: &::windows::Media::MediaProperties::VideoEncodingProperties,
) -> Option<u32> {
    use ::windows::Foundation::IReference;
    use ::windows::core::{GUID, Interface};
    const MF_MT_VIDEO_ROTATION: GUID = GUID::from_u128(0xc380465d_2271_428c_9b83_ecea3b4a85c1);
    let set = props.Properties().ok()?;
    if !set.HasKey(MF_MT_VIDEO_ROTATION).ok()? {
        return None;
    }
    set.Lookup(MF_MT_VIDEO_ROTATION)
        .ok()?
        .cast::<IReference<u32>>()
        .ok()?
        .Value()
        .ok()
}

/// Maps a WinRT error of the step `what` to a failure that may pass.
fn failed(what: &'static str) -> impl Fn(Error) -> Problem {
    move |e| Problem::Failed(format!("{what}: {}", describe(&e)))
}

/// A WinRT error as text: its message and code.
fn describe(err: &Error) -> String {
    format!("{} ({:#010X})", err.message().trim(), err.code().0 as u32)
}

/// A diagnostic note on stderr, written only when `VIDAI_PICTURE_CHECK_DEBUG` is set (stderr is
/// read only when the helper fails, so notes never change a result).
fn note(text: &str) {
    if debugging() {
        eprintln!("note: {text}");
    }
}

/// True when `VIDAI_PICTURE_CHECK_DEBUG` asks for notes, which also measures every turn that
/// shows a face. Asked once.
fn debugging() -> bool {
    static DEBUG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *DEBUG.get_or_init(|| std::env::var_os("VIDAI_PICTURE_CHECK_DEBUG").is_some())
}

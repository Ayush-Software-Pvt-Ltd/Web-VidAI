//! The picture check of the Long / Short detection (SPEC section 8).
//!
//! Some cameras (a Nikon Z 6 turned sideways, for example) write files with no rotation
//! information at all, so the metadata says landscape while the picture is vertical. The picture
//! check looks at the picture instead: faces are found in a few sampled frames
//! (`platform::orientation`: on macOS the bundled `vidai-orient` helper with Apple Vision, on
//! Windows the app binary as a helper with `Windows.Media.FaceAnalysis`), and
//! [`decide_rotation`] turns their roll angles into the clockwise rotation that makes the picture
//! upright. It is conservative: without enough clear, agreeing faces the answer is "no rotation"
//! and the metadata result stands.
//!
//! Pure except for [`check_picture`] and [`available`], which go through the platform boundary.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::platform;

/// The clockwise turn that makes a picture upright.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rotation {
    Upright,
    Cw90,
    Cw180,
    Cw270,
}

impl Rotation {
    /// Clockwise degrees: 0, 90, 180 or 270.
    pub fn degrees(self) -> u32 {
        match self {
            Self::Upright => 0,
            Self::Cw90 => 90,
            Self::Cw180 => 180,
            Self::Cw270 => 270,
        }
    }

    /// From clockwise degrees; `None` for anything but 0, 90, 180 and 270.
    pub fn from_degrees(degrees: u32) -> Option<Self> {
        match degrees {
            0 => Some(Self::Upright),
            90 => Some(Self::Cw90),
            180 => Some(Self::Cw180),
            270 => Some(Self::Cw270),
            _ => None,
        }
    }

    /// True for a quarter turn, which swaps the displayed width and height.
    pub fn swaps_sides(self) -> bool {
        matches!(self, Self::Cw90 | Self::Cw270)
    }

    /// The rotation that undoes a face roll of `roll_degrees`, when the roll is clearly close to
    /// a multiple of 90 degrees; `None` for a roll in between.
    ///
    /// Vision reports roll as the face's own turn, negative for clockwise: a face rolled -90
    /// degrees lies on its side with the top of the head to the left, and the picture becomes
    /// upright after a 270 degree clockwise turn.
    fn undoing_roll(roll_degrees: f64) -> Option<Self> {
        if !roll_degrees.is_finite() {
            return None;
        }
        let quarters = (roll_degrees / 90.0).round();
        if (roll_degrees - quarters * 90.0).abs() > MAX_TILT_DEGREES {
            return None;
        }
        Some(match (quarters as i64).rem_euclid(4) {
            0 => Self::Upright,
            1 => Self::Cw90,
            2 => Self::Cw180,
            _ => Self::Cw270,
        })
    }
}

/// What the platform saw in the sampled frames of one video (the `vidai-orient` protocol 1
/// output, see src-tauri/helpers/orient/main.swift; on Windows the same JSON is written by
/// `platform::orientation::windows`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observations {
    pub protocol: u32,
    pub duration_seconds: f64,
    /// Size of the sampled frames as displayed (rotation flag applied), scaled down.
    pub frame_width: u32,
    pub frame_height: u32,
    pub frames: Vec<FrameObservation>,
}

/// One sampled frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameObservation {
    /// Seconds from the start.
    pub time: f64,
    /// False when the frame could not be decoded (it then has no faces).
    pub decoded: bool,
    /// Largest first.
    pub faces: Vec<FaceObservation>,
}

/// One face in a frame.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceObservation {
    /// 0 = upright, negative = turned clockwise.
    pub roll_degrees: f64,
    /// 0 to 1.
    pub confidence: f64,
    /// The face's bounding box as a fraction of the frame.
    pub area: f64,
}

/// The helper protocol this build understands.
pub const PROTOCOL: u32 = 1;

/// Frames sampled per video, evenly spread between 5 % and 95 % of the duration (the helper
/// skips the very start and end, where a clip often shows the camera being set up).
pub const SAMPLED_FRAMES: u32 = 7;

// Decision thresholds, tuned on the owner's footage (November 2026): 7 Nikon Z 6 A-rolls filmed
// sideways without a rotation flag, 3 Sony / phone A-rolls with a correct flag, 52 b-roll clips
// of the same shoots (hands, bowls, products, faces close up), and short test clips cut from a
// sideways A-roll and turned every way (including a speaker framed small in a wide shot).
// - A-roll faces had a confidence of 0.78 to 0.91 and covered 3.9 % to 9.8 % of the frame (1.2 %
//   in the wide test shot). The floors below only drop junk: the one false positive Vision found
//   in all the b-roll (a powder being poured) had a confidence of 0.59 and was a single frame,
//   which the frame count rule already rejects.
// - Every A-roll frame was within 13 degrees of a quarter turn (head tilt). Frames of people
//   moving (washing hair, applying oil) went up to 52 degrees off; counting only rolls within
//   30 degrees keeps most of those from voting while every steady talking-head frame still votes.
// - All 7 sampled frames of every A-roll had a face, all agreeing. Requiring at least 3 face
//   frames and 70 % agreement leaves room for a speaker who steps away or turns around, and
//   still needs a clear majority (3 of 4, 4 of 5, 5 of 7) before overriding the metadata.
/// Faces with a lower confidence are ignored.
const MIN_CONFIDENCE: f64 = 0.5;
/// Faces smaller than this fraction of the frame are ignored (far away or false positives).
pub const MIN_FACE_AREA: f64 = 0.002;
/// A roll further than this from a quarter turn is ambiguous and does not vote.
const MAX_TILT_DEGREES: f64 = 30.0;
/// At least this many frames must show a face.
const MIN_FACE_FRAMES: usize = 3;
/// At least this share of the frames with a face must agree on one rotation.
const MIN_AGREEMENT: f64 = 0.7;

/// The clockwise rotation that makes the picture upright, decided from the largest face of each
/// sampled frame. [`Rotation::Upright`] unless the faces clearly agree on something else.
pub fn decide_rotation(observations: &Observations) -> Rotation {
    let largest_faces: Vec<&FaceObservation> = observations
        .frames
        .iter()
        .filter(|f| f.decoded)
        .filter_map(|f| {
            f.faces
                .iter()
                .filter(|face| face.confidence >= MIN_CONFIDENCE && face.area >= MIN_FACE_AREA)
                .max_by(|a, b| a.area.total_cmp(&b.area))
        })
        .collect();
    if largest_faces.len() < MIN_FACE_FRAMES {
        return Rotation::Upright;
    }
    let mut votes = [0usize; 4];
    for face in &largest_faces {
        if let Some(rotation) = Rotation::undoing_roll(face.roll_degrees) {
            votes[(rotation.degrees() / 90) as usize] += 1;
        }
    }
    let (winner, count) = votes
        .iter()
        .enumerate()
        .max_by_key(|(_, count)| **count)
        .map(|(index, count)| (index, *count))
        .unwrap_or((0, 0));
    if (count as f64) < MIN_AGREEMENT * largest_faces.len() as f64 {
        return Rotation::Upright;
    }
    Rotation::from_degrees(winner as u32 * 90).unwrap_or(Rotation::Upright)
}

/// Why the picture check gave no answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PictureCheckError {
    /// This platform or installation has no picture check (no helper). Worth trying again when
    /// it becomes available, never a fact about the file.
    NotAvailable,
    /// The file was examined and cannot be read as a video by the platform. Final for this file
    /// version.
    Unreadable(String),
    /// The check failed for a reason that may pass (time limit, crash, unexpected output).
    Failed(String),
}

impl std::fmt::Display for PictureCheckError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAvailable => f.write_str("the picture check is not available"),
            Self::Unreadable(why) => write!(f, "the picture cannot be read: {why}"),
            Self::Failed(why) => write!(f, "the picture check failed: {why}"),
        }
    }
}

/// True when this platform and installation can run the picture check.
pub fn available() -> bool {
    platform::orientation::available()
}

/// Looks at the picture of `path` and decides the rotation that makes it upright. Blocking,
/// bounded by the platform's time limit.
pub fn check_picture(path: &Path) -> Result<Rotation, PictureCheckError> {
    let observations = platform::orientation::observe_faces(path, SAMPLED_FRAMES)?;
    Ok(decide_rotation(&observations))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Observations from a list of frames, each the (roll, confidence, area) of its faces.
    fn observations(frames: &[&[(f64, f64, f64)]]) -> Observations {
        Observations {
            protocol: PROTOCOL,
            duration_seconds: 100.0,
            frame_width: 960,
            frame_height: 540,
            frames: frames
                .iter()
                .enumerate()
                .map(|(i, faces)| FrameObservation {
                    time: i as f64,
                    decoded: true,
                    faces: faces
                        .iter()
                        .map(|&(roll_degrees, confidence, area)| FaceObservation {
                            roll_degrees,
                            confidence,
                            area,
                        })
                        .collect(),
                })
                .collect(),
        }
    }

    /// Recorded `vidai-orient` output (numbers only) of a Nikon Z 6 A-roll filmed sideways with
    /// no rotation flag ("Kudrat Care", DSC_2078.MOV).
    const NIKON_SIDEWAYS: &str = r#"{"durationSeconds":100.2,"frameHeight":540,"frameWidth":960,"frames":[{"decoded":true,"faces":[{"area":0.0486,"confidence":0.84,"rollDegrees":-101}],"time":5.01},{"decoded":true,"faces":[{"area":0.0465,"confidence":0.858,"rollDegrees":-97.7}],"time":20.04},{"decoded":true,"faces":[{"area":0.0407,"confidence":0.813,"rollDegrees":-101.7}],"time":35.07},{"decoded":true,"faces":[{"area":0.0486,"confidence":0.851,"rollDegrees":-100.3}],"time":50.1},{"decoded":true,"faces":[{"area":0.0459,"confidence":0.86,"rollDegrees":-98.2}],"time":65.13},{"decoded":true,"faces":[{"area":0.0391,"confidence":0.779,"rollDegrees":-101.6}],"time":80.16},{"decoded":true,"faces":[{"area":0.0503,"confidence":0.847,"rollDegrees":-82.8}],"time":95.19}],"protocol":1}"#;

    /// Recorded output of a Sony A-roll whose rotation flag already makes it vertical
    /// ("My Motor Talk", C9982.MP4): the frames are taken with the flag applied.
    const SONY_FLAGGED: &str = r#"{"durationSeconds":231.73,"frameHeight":960,"frameWidth":540,"frames":[{"decoded":true,"faces":[{"area":0.0654,"confidence":0.819,"rollDegrees":4.4}],"time":11.59},{"decoded":true,"faces":[{"area":0.0606,"confidence":0.849,"rollDegrees":-4.4}],"time":46.35},{"decoded":true,"faces":[{"area":0.0541,"confidence":0.885,"rollDegrees":4.2}],"time":81.11},{"decoded":true,"faces":[{"area":0.0554,"confidence":0.857,"rollDegrees":12.5}],"time":115.87},{"decoded":true,"faces":[{"area":0.0622,"confidence":0.87,"rollDegrees":4.9}],"time":150.63},{"decoded":true,"faces":[{"area":0.0747,"confidence":0.871,"rollDegrees":10.4}],"time":185.39},{"decoded":true,"faces":[{"area":0.0574,"confidence":0.851,"rollDegrees":4.6}],"time":220.14}],"protocol":1}"#;

    /// Recorded output of a b-roll of a bowl of curd: no faces at all.
    const BOWL: &str = r#"{"durationSeconds":6.96,"frameHeight":540,"frameWidth":960,"frames":[{"decoded":true,"faces":[],"time":0.35},{"decoded":true,"faces":[],"time":1.39},{"decoded":true,"faces":[],"time":2.44},{"decoded":true,"faces":[],"time":3.48},{"decoded":true,"faces":[],"time":4.52},{"decoded":true,"faces":[],"time":5.57},{"decoded":true,"faces":[],"time":6.61}],"protocol":1}"#;

    /// Recorded output of a b-roll of someone washing their hair: faces in 4 frames, at
    /// in-between angles while the head moves.
    const MOVING_HEAD: &str = r#"{"durationSeconds":22.32,"frameHeight":540,"frameWidth":960,"frames":[{"decoded":true,"faces":[{"area":0.0153,"confidence":0.591,"rollDegrees":-0.9}],"time":1.12},{"decoded":true,"faces":[{"area":0.0169,"confidence":0.726,"rollDegrees":-52.2}],"time":4.46},{"decoded":true,"faces":[{"area":0.0202,"confidence":0.766,"rollDegrees":-42.2}],"time":7.81},{"decoded":true,"faces":[],"time":11.16},{"decoded":true,"faces":[],"time":14.51},{"decoded":true,"faces":[],"time":17.86},{"decoded":true,"faces":[{"area":0.0177,"confidence":0.707,"rollDegrees":-34.4}],"time":21.2}],"protocol":1}"#;

    fn parse(json: &str) -> Observations {
        serde_json::from_str(json).expect("recorded observations parse")
    }

    #[test]
    fn recorded_clips() {
        assert_eq!(decide_rotation(&parse(NIKON_SIDEWAYS)), Rotation::Cw270);
        assert_eq!(decide_rotation(&parse(SONY_FLAGGED)), Rotation::Upright);
        assert_eq!(decide_rotation(&parse(BOWL)), Rotation::Upright);
        assert_eq!(decide_rotation(&parse(MOVING_HEAD)), Rotation::Upright);
    }

    #[test]
    fn every_direction() {
        let all = |roll: f64| {
            let face = [(roll, 0.9, 0.04)];
            observations(&[&face[..]; 7])
        };
        assert_eq!(decide_rotation(&all(-7.0)), Rotation::Upright);
        assert_eq!(decide_rotation(&all(84.0)), Rotation::Cw90);
        assert_eq!(decide_rotation(&all(176.0)), Rotation::Cw180);
        assert_eq!(decide_rotation(&all(-178.0)), Rotation::Cw180);
        assert_eq!(decide_rotation(&all(-97.0)), Rotation::Cw270);
        assert_eq!(decide_rotation(&all(263.0)), Rotation::Cw270);
    }

    #[test]
    fn needs_enough_frames_with_a_face() {
        let face = &[(-90.0, 0.9, 0.04)][..];
        let none = &[][..];
        assert_eq!(
            decide_rotation(&observations(&[face, face, none, none, none, none, none])),
            Rotation::Upright
        );
        assert_eq!(
            decide_rotation(&observations(&[face, face, face, none, none, none, none])),
            Rotation::Cw270
        );
    }

    #[test]
    fn needs_a_clear_majority() {
        let side = &[(-90.0, 0.9, 0.04)][..];
        let up = &[(3.0, 0.9, 0.04)][..];
        let between = &[(-45.0, 0.9, 0.04)][..];
        // 5 of 7 agree (71 %): sideways.
        assert_eq!(
            decide_rotation(&observations(&[side, side, side, side, side, up, up])),
            Rotation::Cw270
        );
        // 4 of 7 (57 %): not enough, the metadata stands.
        assert_eq!(
            decide_rotation(&observations(&[side, side, side, side, up, up, up])),
            Rotation::Upright
        );
        // Ambiguous rolls count as faces but do not vote: 4 of 6 (67 %) is not enough.
        assert_eq!(
            decide_rotation(&observations(&[side, side, side, side, between, between])),
            Rotation::Upright
        );
        // 3 of 4 (75 %).
        assert_eq!(
            decide_rotation(&observations(&[side, side, side, between])),
            Rotation::Cw270
        );
    }

    #[test]
    fn uses_the_largest_usable_face_of_each_frame() {
        // A big sideways face and a small upright one (a poster in the background).
        let frame = &[(-92.0, 0.85, 0.05), (2.0, 0.95, 0.01)][..];
        assert_eq!(decide_rotation(&observations(&[frame; 5])), Rotation::Cw270);
        // Faces below the confidence or size floor are ignored, so the frame has no face.
        let weak = &[(-90.0, 0.3, 0.05)][..];
        let tiny = &[(-90.0, 0.9, 0.001)][..];
        assert_eq!(
            decide_rotation(&observations(&[weak, weak, tiny, tiny, tiny])),
            Rotation::Upright
        );
        // Undecoded frames do not count.
        let mut obs = observations(&[&[(-90.0, 0.9, 0.04)][..]; 3]);
        obs.frames[0].decoded = false;
        assert_eq!(decide_rotation(&obs), Rotation::Upright);
    }

    #[test]
    fn ambiguous_rolls_are_not_votes() {
        assert_eq!(Rotation::undoing_roll(29.0), Some(Rotation::Upright));
        assert_eq!(Rotation::undoing_roll(31.0), None);
        assert_eq!(Rotation::undoing_roll(-61.0), Some(Rotation::Cw270));
        assert_eq!(Rotation::undoing_roll(-59.0), None);
        assert_eq!(Rotation::undoing_roll(-45.0), None);
        assert_eq!(Rotation::undoing_roll(f64::NAN), None);
    }

    #[test]
    fn degrees_round_trip() {
        for rotation in [
            Rotation::Upright,
            Rotation::Cw90,
            Rotation::Cw180,
            Rotation::Cw270,
        ] {
            assert_eq!(Rotation::from_degrees(rotation.degrees()), Some(rotation));
        }
        assert_eq!(Rotation::from_degrees(45), None);
        assert!(Rotation::Cw90.swaps_sides() && Rotation::Cw270.swaps_sides());
        assert!(!Rotation::Upright.swaps_sides() && !Rotation::Cw180.swaps_sides());
    }

    #[test]
    fn empty_observations_mean_upright() {
        assert_eq!(decide_rotation(&observations(&[])), Rotation::Upright);
    }
}

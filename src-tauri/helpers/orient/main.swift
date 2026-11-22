// vidai-orient: samples frames of one video and reports the faces Apple Vision finds in them.
//
// VidAI uses the face roll angles to tell whether a picture is stored sideways or upside down
// without a rotation flag (SPEC section 8). This tool only measures; the decision is made in Rust
// (src-tauri/src/orientation.rs). It is built by src-tauri/build.rs and bundled as a sidecar.
//
// Usage: vidai-orient [--frames N] [--time-limit SECONDS] <video path>
//
// On success it prints exactly one JSON line on stdout and exits 0:
//   {"protocol":1,"durationSeconds":61.2,"frameWidth":540,"frameHeight":960,
//    "frames":[{"time":3.06,"decoded":true,"faces":[{"rollDegrees":-90,"confidence":0.98,"area":0.031}]}]}
// - Frames are taken with the track's preferred transform applied (the picture as players show
//   it), scaled to at most 960 px, evenly spread between 5 % and 95 % of the duration.
// - `faces` holds up to 3 faces per frame, largest first. `rollDegrees` is the face's roll as
//   Vision reports it (0 = upright, about -90 = the face is turned a quarter turn clockwise),
//   `confidence` is 0...1 and `area` is the face's bounding box as a fraction of the frame.
// - Nothing else about the file's content is reported. No network access.
//
// Exit codes (with one JSON line {"error": "..."} on stderr for every non-zero code):
//   2  usage error
//   3  the file cannot be read as a video (missing, no video track, no decodable frame)
//   4  the internal time limit was reached
//   5  any other failure

import AVFoundation
import Foundation
import Vision

let protocolVersion = 1
let maxFacesPerFrame = 3
let maxFrameSide: CGFloat = 960

enum ExitCode: Int32 {
    case ok = 0
    case usage = 2
    case unreadable = 3
    case timedOut = 4
    case failure = 5
}

struct Face: Encodable {
    let rollDegrees: Double
    let confidence: Double
    let area: Double
}

struct Frame: Encodable {
    let time: Double
    let decoded: Bool
    let faces: [Face]
}

struct Report: Encodable {
    let `protocol`: Int
    let durationSeconds: Double
    let frameWidth: Int
    let frameHeight: Int
    let frames: [Frame]
}

/// Rounds to `places` decimals, so the output stays short and stable.
func rounded(_ value: Double, _ places: Double) -> Double {
    let scale = pow(10, places)
    return (value * scale).rounded() / scale
}

/// Writes `value` as one JSON line to `handle`.
func writeLine<T: Encodable>(_ value: T, to handle: FileHandle) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard var data = try? encoder.encode(value) else { return }
    data.append(0x0A)
    handle.write(data)
}

/// Ends the process with `code`, reporting `message` on stderr.
func finish(_ code: ExitCode, _ message: String? = nil) -> Never {
    if let message {
        writeLine(["error": message], to: FileHandle.standardError)
    }
    exit(code.rawValue)
}

struct Options {
    var frames = 7
    var timeLimit: Double = 20
    var path = ""
}

func parseOptions(_ arguments: [String]) -> Options {
    var options = Options()
    var paths: [String] = []
    var index = 0
    func value(after flag: String) -> String {
        index += 1
        guard index < arguments.count else { finish(.usage, "\(flag) needs a value") }
        return arguments[index]
    }
    while index < arguments.count {
        let argument = arguments[index]
        if argument == "--" {
            paths.append(contentsOf: arguments[(index + 1)...])
            break
        }
        switch argument {
        case "--frames":
            guard let n = Int(value(after: argument)), (1...30).contains(n) else {
                finish(.usage, "--frames must be a whole number from 1 to 30")
            }
            options.frames = n
        case "--time-limit":
            guard let s = Double(value(after: argument)), s > 0, s <= 300 else {
                finish(.usage, "--time-limit must be a number of seconds above 0 and up to 300")
            }
            options.timeLimit = s
        default:
            if argument.hasPrefix("--") { finish(.usage, "unknown option \(argument)") }
            paths.append(argument)
        }
        index += 1
    }
    guard paths.count == 1, !paths[0].isEmpty else {
        finish(.usage, "usage: vidai-orient [--frames N] [--time-limit SECONDS] <video path>")
    }
    options.path = paths[0]
    return options
}

/// Up to `maxFacesPerFrame` faces in `image`, largest first.
func detectFaces(in image: CGImage) -> [Face] {
    let request = VNDetectFaceRectanglesRequest()
    // Revision 3 reports the roll of faces at any angle; pinning it keeps results stable across
    // macOS versions.
    request.revision = VNDetectFaceRectanglesRequestRevision3
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return []
    }
    return (request.results ?? [])
        .map { face in
            Face(
                rollDegrees: rounded((face.roll?.doubleValue ?? 0) * 180 / .pi, 1),
                confidence: rounded(Double(face.confidence), 3),
                area: rounded(Double(face.boundingBox.width * face.boundingBox.height), 4)
            )
        }
        .sorted { $0.area > $1.area }
        .prefix(maxFacesPerFrame)
        .map { $0 }
}

/// Collects the frames from the generator's callbacks, which arrive on arbitrary threads.
final class FrameCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [Frame] = []
    private var size = (width: 0, height: 0)
    private let expected: Int
    private var continuation: CheckedContinuation<Void, Never>?
    private var complete = false

    init(expected: Int) { self.expected = expected }

    func add(_ frame: Frame, image: CGImage?) {
        lock.lock()
        frames.append(frame)
        if let image { size = (image.width, image.height) }
        complete = frames.count == expected
        let resume = complete ? continuation : nil
        if resume != nil { continuation = nil }
        lock.unlock()
        resume?.resume()
    }

    /// Waits until every requested frame was reported.
    func all() async -> (frames: [Frame], width: Int, height: Int) {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            if complete {
                lock.unlock()
                continuation.resume()
            } else {
                self.continuation = continuation
                lock.unlock()
            }
        }
        return snapshot()
    }

    private func snapshot() -> (frames: [Frame], width: Int, height: Int) {
        lock.lock()
        defer { lock.unlock() }
        return (frames.sorted { $0.time < $1.time }, size.width, size.height)
    }
}

func run(_ options: Options) async -> Never {
    let url = URL(fileURLWithPath: options.path)
    guard FileManager.default.isReadableFile(atPath: url.path) else {
        finish(.unreadable, "the file does not exist or cannot be read")
    }
    let asset = AVURLAsset(url: url)
    let duration: CMTime
    let tracks: [AVAssetTrack]
    do {
        duration = try await asset.load(.duration)
        tracks = try await asset.loadTracks(withMediaType: .video)
    } catch {
        finish(.unreadable, "the file cannot be opened as a video")
    }
    let seconds = CMTimeGetSeconds(duration)
    guard !tracks.isEmpty else { finish(.unreadable, "no video track") }
    guard seconds.isFinite, seconds > 0 else { finish(.unreadable, "the video has no duration") }

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: maxFrameSide, height: maxFrameSide)
    // Any frame near the requested time will do, and snapping to a nearby sync frame is much
    // faster than decoding up to an exact time.
    let tolerance = CMTime(seconds: min(2, seconds / 20), preferredTimescale: 600)
    generator.requestedTimeToleranceBefore = tolerance
    generator.requestedTimeToleranceAfter = tolerance

    let count = options.frames
    let times: [CMTime] = (0..<count).map { i in
        let fraction = count == 1 ? 0.5 : 0.05 + 0.90 * Double(i) / Double(count - 1)
        return CMTime(seconds: seconds * fraction, preferredTimescale: 600)
    }
    let collector = FrameCollector(expected: count)
    generator.generateCGImagesAsynchronously(forTimes: times.map { NSValue(time: $0) }) {
        requested, image, _, result, _ in
        let time = rounded(CMTimeGetSeconds(requested), 2)
        if result == .succeeded, let image {
            collector.add(Frame(time: time, decoded: true, faces: detectFaces(in: image)), image: image)
        } else {
            collector.add(Frame(time: time, decoded: false, faces: []), image: nil)
        }
    }
    let (frames, width, height) = await collector.all()
    guard frames.contains(where: { $0.decoded }) else {
        finish(.unreadable, "no frame could be decoded")
    }
    writeLine(
        Report(
            protocol: protocolVersion,
            durationSeconds: rounded(seconds, 2),
            frameWidth: width,
            frameHeight: height,
            frames: frames
        ),
        to: FileHandle.standardOutput
    )
    finish(.ok)
}

let options = parseOptions(Array(CommandLine.arguments.dropFirst()))

// The hard time limit: whatever AVFoundation or Vision is doing, the process ends.
let watchdog = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
watchdog.schedule(deadline: .now() + options.timeLimit)
watchdog.setEventHandler {
    finish(.timedOut, "the time limit of \(options.timeLimit) seconds was reached")
}
watchdog.resume()

Task.detached { await run(options) }
dispatchMain()

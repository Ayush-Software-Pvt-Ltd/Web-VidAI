// Prints the window number and bounds (points) of the main window of one process:
// "<id> <x> <y> <width> <height>", or nothing when it has no window on screen.
// Used by scripts/e2e.mjs to capture only that window with `screencapture -l<id>`.
// With --any it also finds the window when it is not on screen (for example on another Space).
//
//   winid <pid> [--any]
import CoreGraphics
import Foundation

guard CommandLine.arguments.count > 1, let pid = Int(CommandLine.arguments[1]) else {
    FileHandle.standardError.write("usage: winid <pid> [--any]\n".data(using: .utf8)!)
    exit(2)
}
let any = CommandLine.arguments.dropFirst(2).contains("--any")
let options: CGWindowListOption =
    any ? [.optionAll] : [.optionOnScreenOnly, .excludeDesktopElements]
let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
for window in windows {
    guard let owner = window[kCGWindowOwnerPID as String] as? Int, owner == pid,
          let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
          let id = window[kCGWindowNumber as String] as? Int,
          let bounds = window[kCGWindowBounds as String] as? [String: Double],
          let width = bounds["Width"], let height = bounds["Height"], height > 200
    else { continue }
    print(id, Int(bounds["X"] ?? 0), Int(bounds["Y"] ?? 0), Int(width), Int(height))
    break
}

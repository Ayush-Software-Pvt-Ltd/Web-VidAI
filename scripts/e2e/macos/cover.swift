// Covers the main window of one process with an opaque window of its own, as the person's other
// windows do while the tests run (the test app never takes the focus). Prints
// "covered <x> <y> <width> <height>" (points, from the top left of the main screen) once the
// cover is on screen, and ends when its stdin closes.
//
//   cover <pid>
import AppKit
import CoreGraphics

guard CommandLine.arguments.count > 1, let pid = Int(CommandLine.arguments[1]) else {
    FileHandle.standardError.write("usage: cover <pid>\n".data(using: .utf8)!)
    exit(2)
}

let windows =
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
var target: CGRect?
for window in windows {
    guard let owner = window[kCGWindowOwnerPID as String] as? Int, owner == pid,
          let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
          let bounds = window[kCGWindowBounds as String] as? [String: Double],
          let width = bounds["Width"], let height = bounds["Height"], height > 200
    else { continue }
    target = CGRect(x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0, width: width, height: height)
    break
}
guard let covered = target else {
    FileHandle.standardError.write("the process has no window on screen\n".data(using: .utf8)!)
    exit(1)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// AppKit's screen coordinates start at the bottom left of the main screen; a margin makes sure
// no edge of the window shows.
let mainHeight = NSScreen.screens.first?.frame.height ?? covered.maxY
let margin: CGFloat = 24
let frame = NSRect(
    x: covered.minX - margin, y: mainHeight - covered.maxY - margin,
    width: covered.width + 2 * margin, height: covered.height + 2 * margin)
let cover = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
cover.isOpaque = true
cover.backgroundColor = .windowBackgroundColor
cover.hasShadow = false
cover.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
cover.orderFrontRegardless()

FileHandle.standardInput.readabilityHandler = { handle in
    if handle.availableData.isEmpty { exit(0) }
}
DispatchQueue.main.async {
    print("covered", Int(covered.minX), Int(covered.minY), Int(covered.width), Int(covered.height))
    fflush(stdout)
}
app.run()

// Saves and restores the general pasteboard exactly (every item, every type), so the
// end-to-end copy checks never lose what the user had copied. Used by scripts/e2e.mjs.
//
//   clipboard save <file>      write every item and type to a property list
//   clipboard restore <file>   put them back
//   clipboard text             print the plain text on the pasteboard
import AppKit

let args = CommandLine.arguments
let pasteboard = NSPasteboard.general
guard args.count >= 2 else { exit(2) }
switch args[1] {
case "save" where args.count == 3:
    var items: [[String: Data]] = []
    for item in pasteboard.pasteboardItems ?? [] {
        var flavors: [String: Data] = [:]
        for type in item.types {
            if let data = item.data(forType: type) { flavors[type.rawValue] = data }
        }
        items.append(flavors)
    }
    let data = try PropertyListSerialization.data(fromPropertyList: items, format: .binary, options: 0)
    try data.write(to: URL(fileURLWithPath: args[2]))
case "restore" where args.count == 3:
    let data = try Data(contentsOf: URL(fileURLWithPath: args[2]))
    let items = try PropertyListSerialization.propertyList(from: data, format: nil) as? [[String: Data]] ?? []
    pasteboard.clearContents()
    let restored = items.map { flavors -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in flavors { item.setData(data, forType: NSPasteboard.PasteboardType(type)) }
        return item
    }
    if !restored.isEmpty { pasteboard.writeObjects(restored) }
case "text":
    print(pasteboard.string(forType: .string) ?? "", terminator: "")
default:
    exit(2)
}

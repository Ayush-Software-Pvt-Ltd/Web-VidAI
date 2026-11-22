import { describe, expect, it } from "vitest";
import { baseName, joinPath, parentName, pathSegments } from "./paths";

describe("paths", () => {
  it("names and joins macOS and Windows paths", () => {
    expect(baseName("/Users/me/Desktop/Timeline Export.fcpxml")).toBe("Timeline Export.fcpxml");
    expect(baseName("/Users/me/Bundle.fcpxmld/")).toBe("Bundle.fcpxmld");
    expect(baseName("C:\\Users\\me\\Desktop\\Timeline.xml")).toBe("Timeline.xml");
    expect(baseName("C:\\Users\\me\\Folder\\")).toBe("Folder");
    expect(joinPath("C:\\Editing", "Tech")).toBe("C:\\Editing\\Tech");
    expect(joinPath("C:\\Editing\\", "Tech")).toBe("C:\\Editing\\Tech");
    expect(joinPath("/Users/me/Editing", "Tech")).toBe("/Users/me/Editing/Tech");
    expect(parentName("C:\\Editing\\Tech\\001 Video")).toBe("Tech");
    expect(parentName("/Editing/Tech/001 Video")).toBe("Tech");
  });

  it("cuts paths after their separators only, on both platforms", () => {
    expect(
      pathSegments("C:\\Users\\editor\\AppData\\Local\\Programs\\Python\\python3.exe"),
    ).toEqual([
      "C:\\",
      "Users\\",
      "editor\\",
      "AppData\\",
      "Local\\",
      "Programs\\",
      "Python\\",
      "python3.exe",
    ]);
    expect(pathSegments("/Users/editor/Movies/Editing Folder")).toEqual([
      "/Users/",
      "editor/",
      "Movies/",
      "Editing Folder",
    ]);
    // A root stays with the first name, a trailing separator with the last.
    expect(pathSegments("\\\\server\\share\\Editing\\")).toEqual([
      "\\\\server\\",
      "share\\",
      "Editing\\",
    ]);
    expect(pathSegments("/")).toEqual(["/"]);
    expect(pathSegments("Timeline v2.fcpxml")).toEqual(["Timeline v2.fcpxml"]);
    expect(pathSegments("")).toEqual([]);
    // Devanagari names stay whole.
    expect(pathSegments("/Editing/हिंदी चैनल/001 वीडियो")).toEqual([
      "/Editing/",
      "हिंदी चैनल/",
      "001 वीडियो",
    ]);
    for (const path of ["C:\\a\\b", "/a/b/", "\\\\s\\x", "name"]) {
      expect(pathSegments(path).join("")).toBe(path);
    }
  });
});

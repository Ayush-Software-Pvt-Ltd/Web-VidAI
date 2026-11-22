import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldName,
  hasDotDot,
  isCaseInsensitive,
  isFullPath,
  nameProblem,
  pathSegments,
  segmentProblem,
  withoutNamespacePrefix,
} from "../../src/platform/fsnames.js";
import { isInside, isSame, safeName } from "../../src/storage/paths.js";

test("isCaseInsensitive and foldName follow the platform", () => {
  assert.equal(isCaseInsensitive("darwin"), true);
  assert.equal(isCaseInsensitive("win32"), true);
  assert.equal(isCaseInsensitive("linux"), false);
  assert.equal(foldName("ABC", "linux"), "ABC");
  assert.equal(foldName("ABC", "darwin"), "abc");
  // "e" + combining accent and the single letter are one name on macOS and Windows.
  assert.equal(foldName("e\u0301", "darwin"), foldName("\u00e9", "darwin"));
  assert.notEqual(foldName("e\u0301", "linux"), foldName("\u00e9", "linux"));
});

test("isFullPath", () => {
  assert.equal(isFullPath("/a/b", "darwin"), true);
  assert.equal(isFullPath("a/b", "darwin"), false);
  assert.equal(isFullPath("", "darwin"), false);
  assert.equal(isFullPath("C:\\a", "win32"), true);
  assert.equal(isFullPath("c:/a", "win32"), true);
  assert.equal(isFullPath("C:a", "win32"), false);
  assert.equal(isFullPath("\\a", "win32"), false);
  assert.equal(isFullPath("\\\\server\\share\\a", "win32"), true);
  assert.equal(isFullPath("\\\\?\\C:\\a", "win32"), true);
  assert.equal(isFullPath("\\\\?\\UNC\\server\\share\\a", "win32"), true);
  assert.equal(isFullPath("\\\\.\\C:\\a", "win32"), false);
  assert.equal(isFullPath("\\\\?\\GLOBALROOT\\a", "win32"), false);
  assert.equal(isFullPath("/a", "win32"), false);
});

test("withoutNamespacePrefix and pathSegments", () => {
  assert.equal(withoutNamespacePrefix("\\\\?\\C:\\a", "win32"), "C:\\a");
  assert.equal(withoutNamespacePrefix("\\\\?\\UNC\\s\\h\\a", "win32"), "\\\\s\\h\\a");
  assert.equal(withoutNamespacePrefix("\\\\?\\C:\\a", "darwin"), "\\\\?\\C:\\a");
  assert.deepEqual(pathSegments("/a//b/", "darwin"), ["a", "b"]);
  assert.deepEqual(pathSegments("C:\\a/b", "win32"), ["C:", "a", "b"]);
});

test("hasDotDot finds every spelling of a parent step", () => {
  assert.equal(hasDotDot("/a/../b", "darwin"), true);
  assert.equal(hasDotDot("/a/b/..", "darwin"), true);
  assert.equal(hasDotDot("/a/..b/c...", "darwin"), false);
  assert.equal(hasDotDot("/a/./b", "darwin"), false);
  assert.equal(hasDotDot("C:\\a\\..\\b", "win32"), true);
  assert.equal(hasDotDot("C:/a/../b", "win32"), true);
  // Windows reads these as the same thing or as nothing.
  assert.equal(hasDotDot("C:\\a\\...\\b", "win32"), true);
  assert.equal(hasDotDot("C:\\a\\. .\\b", "win32"), true);
  assert.equal(hasDotDot("C:\\a\\.\\b", "win32"), false);
});

test("segmentProblem: the names no step of a path may be", () => {
  for (const bad of ["", ".", "..", "a/b", "a\\b", "a\u0000b", "a\nb", "a\u007fb"]) {
    assert.ok(segmentProblem(bad, "darwin"), JSON.stringify(bad));
  }
  assert.equal(segmentProblem("..hidden", "darwin"), null);
  assert.equal(segmentProblem("trailing.", "darwin"), null);
  assert.equal(segmentProblem("trailing ", "darwin"), null);
});

test("segmentProblem on Windows", () => {
  for (const bad of [
    "a<b",
    "a>b",
    "a:b",
    'a"b',
    "a|b",
    "a?b",
    "a*b",
    "a.",
    "a ",
    "CON",
    "con",
    "NUL.txt",
    "Aux.tar.gz",
    "COM1",
    "lpt9.txt",
    "COM\u00b9",
  ]) {
    assert.ok(segmentProblem(bad, "win32"), JSON.stringify(bad));
  }
  for (const good of ["CONSOLE", "COM10", "nul-x", "a b", "a.b"]) {
    assert.equal(segmentProblem(good, "win32"), null, good);
  }
});

test("nameProblem: the stricter rule of names VidAI makes", () => {
  assert.equal(nameProblem("Clip 1.mp4", { platform: "darwin" }), null);
  assert.ok(nameProblem(".hidden", { platform: "darwin" }));
  assert.ok(nameProblem(" lead", { platform: "darwin" }));
  assert.ok(nameProblem("trail ", { platform: "darwin" }));
  assert.ok(nameProblem("evil\u202Efdp.mp4", { platform: "darwin" }));
  assert.ok(nameProblem("a".repeat(201), { platform: "darwin" }));
  assert.equal(nameProblem("a".repeat(200), { platform: "darwin" }), null);
  // Bytes count too: 100 characters of 3 bytes are 300 bytes.
  assert.ok(nameProblem("\u3042".repeat(100), { platform: "darwin" }));
  assert.ok(nameProblem("abcd", { platform: "darwin", maxChars: 3 }));
});

test("safeName returns the name or says invalidInput", () => {
  assert.equal(safeName("Video 1", { platform: "darwin" }), "Video 1");
  for (const bad of ["../x", "a/b", "", "CON", 5, null, undefined, {}]) {
    assert.throws(
      () => safeName(bad, { platform: "win32" }),
      (error) => /** @type {{ code?: string }} */ (error).code === "invalidInput",
      String(bad),
    );
  }
  assert.throws(() => safeName("a".repeat(130), { platform: "darwin", maxChars: 120 }));
});

test("isInside on macOS and Linux", () => {
  assert.equal(isInside("/data/media", "/data/media", "linux"), true);
  assert.equal(isInside("/data/media", "/data/media/a/b", "linux"), true);
  assert.equal(isInside("/data/media/", "/data/media", "linux"), true);
  assert.equal(isInside("/data/media", "/data/media/", "linux"), true);
  // A name that only starts like the folder is a different folder.
  assert.equal(isInside("/data/media", "/data/media2", "linux"), false);
  assert.equal(isInside("/data/media", "/data/media2/x", "linux"), false);
  assert.equal(isInside("/data/media", "/data", "linux"), false);
  assert.equal(isInside("/data/media", "/data/other", "linux"), false);
  // `..` is resolved lexically.
  assert.equal(isInside("/data/media", "/data/media/../other", "linux"), false);
  assert.equal(isInside("/data/media", "/data/media/a/../b", "linux"), true);
  // Case matters on Linux, not on macOS.
  assert.equal(isInside("/data/media", "/DATA/Media/x", "linux"), false);
  assert.equal(isInside("/data/media", "/DATA/Media/x", "darwin"), true);
  assert.equal(isInside("/data/media", "/data/MEDIA2", "darwin"), false);
  // Relative, empty and NUL are never inside.
  assert.equal(isInside("/data/media", "media/x", "linux"), false);
  assert.equal(isInside("/data/media", "", "linux"), false);
  assert.equal(isInside("/data/media", "/data/media/a\u0000/..", "linux"), false);
  assert.equal(isInside("/", "/anything", "linux"), true);
  assert.equal(isInside("/data/media", /** @type {never} */ (5), "linux"), false);
});

test("isInside on Windows", () => {
  assert.equal(isInside("C:\\Media", "C:\\Media\\a", "win32"), true);
  assert.equal(isInside("C:\\Media", "c:/media/A/b", "win32"), true);
  assert.equal(isInside("C:\\Media\\", "C:\\Media", "win32"), true);
  assert.equal(isInside("C:\\Media", "C:\\Media2", "win32"), false);
  assert.equal(isInside("C:\\Media", "D:\\Media\\a", "win32"), false);
  assert.equal(isInside("C:\\Media", "C:\\Media\\..\\Other", "win32"), false);
  assert.equal(isInside("C:\\Media", "\\\\?\\C:\\Media\\a", "win32"), true);
  assert.equal(isInside("\\\\srv\\share\\m", "\\\\SRV\\Share\\m\\a", "win32"), true);
  assert.equal(isInside("\\\\srv\\share\\m", "\\\\srv\\other\\m\\a", "win32"), false);
  assert.equal(isInside("\\\\?\\UNC\\srv\\share\\m", "\\\\srv\\share\\m\\a", "win32"), true);
  assert.equal(isInside("C:\\Media", "Media\\a", "win32"), false);
  assert.equal(isInside("C:\\Media", "\\Media\\a", "win32"), false);
  assert.equal(isInside("C:\\Media", "C:Media\\a", "win32"), false);
});

test("isSame", () => {
  assert.equal(isSame("/a/b", "/a/b/", "linux"), true);
  assert.equal(isSame("/a/b", "/a/b/c", "linux"), false);
  assert.equal(isSame("/a/b", "/A/B", "darwin"), true);
  assert.equal(isSame("/a/b", "/A/B", "linux"), false);
});

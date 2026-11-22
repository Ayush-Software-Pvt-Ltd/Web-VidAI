import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findFfmpeg, findFfprobe } from "../../src/platform/tools.js";

describe("findFfmpeg", () => {
  it("uses VIDAI_FFMPEG_BIN as the only candidate", () => {
    const seen = ["/fake/ffmpeg"];
    const isFile = (/** @type {string} */ f) => seen.includes(f);
    assert.equal(
      findFfmpeg({ VIDAI_FFMPEG_BIN: "/fake/ffmpeg" }, { platform: "linux", isFile }),
      "/fake/ffmpeg",
    );
    assert.equal(findFfmpeg({ VIDAI_FFMPEG_BIN: "/nope" }, { platform: "linux", isFile }), null);
  });

  it("looks in PATH, then in the usual folders", () => {
    const has = new Set(["/opt/homebrew/bin/ffmpeg", "/usr/local/sbin/ffmpeg"]);
    const isFile = (/** @type {string} */ f) => has.has(f);
    assert.equal(
      findFfmpeg({ PATH: "/usr/local/sbin:/bin" }, { platform: "darwin", isFile }),
      "/usr/local/sbin/ffmpeg",
    );
    assert.equal(
      findFfmpeg({ PATH: "/bin" }, { platform: "darwin", isFile }),
      "/opt/homebrew/bin/ffmpeg",
    );
    assert.equal(findFfmpeg({ PATH: "/bin" }, { platform: "linux", isFile }), null);
  });

  it("finds ffmpeg.exe through PATHEXT on Windows", () => {
    const has = new Set(["C:\\tools\\ffmpeg.exe", "C:\\ProgramData\\chocolatey\\bin\\ffprobe.exe"]);
    const isFile = (/** @type {string} */ f) => has.has(f);
    const env = {
      PATH: "C:\\Windows;C:\\tools",
      PATHEXT: ".COM;.EXE",
      ProgramData: "C:\\ProgramData",
    };
    assert.equal(findFfmpeg(env, { platform: "win32", isFile }), "C:\\tools\\ffmpeg.exe");
    assert.equal(
      findFfprobe(env, { platform: "win32", isFile }),
      "C:\\ProgramData\\chocolatey\\bin\\ffprobe.exe",
    );
  });

  it("keeps ffprobe's own variable separate", () => {
    const isFile = () => true;
    assert.equal(
      findFfprobe(
        { VIDAI_FFPROBE_BIN: "/p/ffprobe", VIDAI_FFMPEG_BIN: "/p/ffmpeg" },
        { platform: "linux", isFile },
      ),
      "/p/ffprobe",
    );
    assert.equal(
      findFfmpeg(
        { VIDAI_FFPROBE_BIN: "/p/ffprobe", VIDAI_FFMPEG_BIN: "/p/ffmpeg" },
        { platform: "linux", isFile },
      ),
      "/p/ffmpeg",
    );
  });
});

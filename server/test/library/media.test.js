import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  createMedia,
  parseFfprobeJson,
  resolveVideoType,
  videoTypeOfSize,
} from "../../src/library/media.js";
import { copyFixture, fakeFfprobe, tempFolder, touch, write } from "./support.js";

const skipOnWindows = process.platform === "win32" ? { skip: "needs a POSIX shell" } : {};

test("videoTypeOfSize: taller than wide is Short, a square and degenerate sizes are handled", () => {
  assert.equal(videoTypeOfSize({ width: 1080, height: 1920 }), "short");
  assert.equal(videoTypeOfSize({ width: 1920, height: 1080 }), "long");
  assert.equal(videoTypeOfSize({ width: 1000, height: 1000 }), "long");
  assert.equal(videoTypeOfSize({ width: 0, height: 1000 }), null);
  assert.equal(videoTypeOfSize({ width: 100, height: 0 }), null);
  assert.equal(videoTypeOfSize({ width: Number.NaN, height: 5 }), null);
});

test("resolveVideoType: override, channel, detected, assumed", () => {
  /** @type {[any, any, any, string, string][]} */
  const table = [
    ["short", "long", "long", "short", "override"],
    ["long", "short", "short", "long", "override"],
    [null, "long", "short", "long", "channel"],
    [null, "short", "long", "short", "channel"],
    [null, "auto", "short", "short", "detected"],
    [null, "auto", "long", "long", "detected"],
    [null, "auto", null, "long", "assumed"],
  ];
  for (const [override, channel, detected, videoType, typeSource] of table) {
    assert.deepEqual(resolveVideoType(override, channel, detected), { videoType, typeSource });
  }
});

test("parseFfprobeJson reads width and height and applies the rotation", () => {
  const stream = (/** @type {object} */ extra) =>
    JSON.stringify({ streams: [{ width: 1920, height: 1080, ...extra }] });
  assert.deepEqual(parseFfprobeJson(stream({})), { width: 1920, height: 1080 });
  assert.deepEqual(parseFfprobeJson(stream({ side_data_list: [{ rotation: -90 }] })), {
    width: 1080,
    height: 1920,
  });
  assert.deepEqual(parseFfprobeJson(stream({ side_data_list: [{ rotation: 90 }] })), {
    width: 1080,
    height: 1920,
  });
  assert.deepEqual(parseFfprobeJson(stream({ side_data_list: [{ rotation: 180 }] })), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(parseFfprobeJson(stream({ tags: { rotate: "270" } })), {
    width: 1080,
    height: 1920,
  });
  assert.deepEqual(parseFfprobeJson(stream({ tags: { rotate: "" } })), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(parseFfprobeJson(stream({ tags: { rotate: "nope" } })), {
    width: 1920,
    height: 1080,
  });
  // Zero passes through, like the Rust u32; videoTypeOfSize refuses it later.
  assert.deepEqual(parseFfprobeJson('{"streams":[{"width":0,"height":10}]}'), {
    width: 0,
    height: 10,
  });
  // The side data wins over the tag.
  assert.deepEqual(
    parseFfprobeJson(stream({ side_data_list: [{ rotation: 0 }], tags: { rotate: "90" } })),
    { width: 1920, height: 1080 },
  );
});

test("parseFfprobeJson refuses what has no usable video stream", () => {
  for (const text of [
    "",
    "garbage",
    "null",
    "[]",
    "{}",
    '{"streams":[]}',
    '{"streams":[{}]}',
    '{"streams":[{"width":"1","height":10}]}',
    '{"streams":[{"width":-5,"height":10}]}',
  ]) {
    assert.equal(parseFfprobeJson(text), null, text);
  }
});

test("detectType reads MP4 family files in process, without ffprobe", async () => {
  const dir = tempFolder();
  try {
    const media = createMedia({ env: { PATH: "" }, locate: () => null });
    const landscape = copyFixture("landscape.mp4", path.join(dir.dir, "l.mp4"));
    const portrait = copyFixture("rotated-90.mov", path.join(dir.dir, "p.mov"));
    /** @param {string} file */
    const detect = (file) => {
      const stat = fs.statSync(file);
      return media.detectType({ path: file, size: stat.size, modifiedMs: stat.mtimeMs });
    };
    assert.equal(await detect(landscape), "long");
    assert.equal(await detect(portrait), "short");
  } finally {
    dir.cleanup();
  }
});

test("a file nothing can read is detected as null, also when ffprobe is missing", async () => {
  const dir = tempFolder();
  try {
    const media = createMedia({ env: { PATH: "" }, locate: () => null });
    const broken = write(path.join(dir.dir, "broken.mp4"), "not a video");
    const mkv = copyFixture("portrait.mkv", path.join(dir.dir, "p.mkv"));
    for (const file of [broken, mkv]) {
      const stat = fs.statSync(file);
      assert.equal(
        await media.detectType({ path: file, size: stat.size, modifiedMs: stat.mtimeMs }),
        null,
      );
    }
    // The unreadable MP4 is final (the parser's verdict); the mkv waits for a tool to appear.
    assert.equal(media.cacheSize(), 1);
  } finally {
    dir.cleanup();
  }
});

test("ffprobe fallback: a vertical result through the fake program", skipOnWindows, async () => {
  const dir = tempFolder();
  try {
    const fake = fakeFfprobe(dir.dir);
    const media = createMedia({ env: fake.env("ok") });
    const mkv = copyFixture("portrait.mkv", path.join(dir.dir, "p.mkv"));
    const stat = fs.statSync(mkv);
    const file = { path: mkv, size: stat.size, modifiedMs: stat.mtimeMs };
    // 1920x1080 with a -90 degree rotation is Short.
    assert.equal(await media.detectType(file), "short");
    const call = fs.readFileSync(fake.log, "utf8").trim();
    assert.equal(
      call,
      `-v error -select_streams V:0 -show_entries stream=width,height:stream_tags=rotate:stream_side_data=rotation -of json ${mkv}`,
    );
  } finally {
    dir.cleanup();
  }
});

test("ffprobe fallback is used for an MP4 the parser cannot read", skipOnWindows, async () => {
  const dir = tempFolder();
  try {
    const fake = fakeFfprobe(dir.dir);
    const media = createMedia({ env: fake.env("ok") });
    const file = write(path.join(dir.dir, "odd.mp4"), "xxxxxxxxxxxxxxxxxxxxxxxx");
    const stat = fs.statSync(file);
    assert.equal(
      await media.detectType({ path: file, size: stat.size, modifiedMs: stat.mtimeMs }),
      "short",
    );
    assert.equal(fake.calls(), 1);
  } finally {
    dir.cleanup();
  }
});

test("ffprobe garbage output is a null type and is remembered", skipOnWindows, async () => {
  const dir = tempFolder();
  try {
    const fake = fakeFfprobe(dir.dir);
    const media = createMedia({ env: fake.env("garbage") });
    const mkv = copyFixture("portrait.mkv", path.join(dir.dir, "p.mkv"));
    const stat = fs.statSync(mkv);
    const file = { path: mkv, size: stat.size, modifiedMs: stat.mtimeMs };
    assert.equal(await media.detectType(file), null);
    assert.equal(await media.detectType(file), null);
    assert.equal(fake.calls(), 1);
    assert.equal(media.cacheSize(), 1);
  } finally {
    dir.cleanup();
  }
});

test("ffprobe timeout is a null type (shortened limit)", skipOnWindows, async () => {
  const dir = tempFolder();
  try {
    const fake = fakeFfprobe(dir.dir);
    const media = createMedia({ env: fake.env("hang"), ffprobeTimeoutMs: 150 });
    const mkv = copyFixture("portrait.mkv", path.join(dir.dir, "p.mkv"));
    const stat = fs.statSync(mkv);
    const started = Date.now();
    assert.equal(
      await media.detectType({ path: mkv, size: stat.size, modifiedMs: stat.mtimeMs }),
      null,
    );
    assert.ok(Date.now() - started < 10_000, "the hanging program was ended");
  } finally {
    dir.cleanup();
  }
});

test("a missing ffprobe is not cached, so installing it later works", skipOnWindows, async () => {
  const dir = tempFolder();
  try {
    const fake = fakeFfprobe(dir.dir);
    /** @type {string | null} */
    let located = null;
    const media = createMedia({ env: fake.env("ok"), locate: () => located });
    const mkv = copyFixture("portrait.mkv", path.join(dir.dir, "p.mkv"));
    const stat = fs.statSync(mkv);
    const file = { path: mkv, size: stat.size, modifiedMs: stat.mtimeMs };
    assert.equal(await media.detectType(file), null);
    assert.equal(media.cacheSize(), 0);
    located = fake.bin;
    assert.equal(await media.detectType(file), "short");
    assert.equal(media.cacheSize(), 1);
  } finally {
    dir.cleanup();
  }
});

test(
  "the same file is not probed twice; a changed size or time probes again",
  skipOnWindows,
  async () => {
    const dir = tempFolder();
    try {
      const fake = fakeFfprobe(dir.dir);
      const media = createMedia({ env: fake.env("ok") });
      const mkv = copyFixture("portrait.mkv", path.join(dir.dir, "p.mkv"));
      touch(mkv, 1_000_000);
      const stat = fs.statSync(mkv);
      const file = { path: mkv, size: stat.size, modifiedMs: stat.mtimeMs };
      await media.detectType(file);
      await media.detectType(file);
      assert.equal(fake.calls(), 1);
      await media.detectType({ ...file, size: file.size + 1 });
      assert.equal(fake.calls(), 2);
      await media.detectType({ ...file, modifiedMs: file.modifiedMs + 1000 });
      assert.equal(fake.calls(), 3);
      await media.detectType(file);
      assert.equal(fake.calls(), 3, "the first result is still remembered");
    } finally {
      dir.cleanup();
    }
  },
);

test("concurrent calls for one file share one probe", skipOnWindows, async () => {
  const dir = tempFolder();
  try {
    const fake = fakeFfprobe(dir.dir);
    const media = createMedia({ env: fake.env("ok") });
    const mkv = copyFixture("portrait.mkv", path.join(dir.dir, "p.mkv"));
    const stat = fs.statSync(mkv);
    const file = { path: mkv, size: stat.size, modifiedMs: stat.mtimeMs };
    const results = await Promise.all([media.detectType(file), media.detectType(file)]);
    assert.deepEqual(results, ["short", "short"]);
    assert.equal(fake.calls(), 1);
  } finally {
    dir.cleanup();
  }
});

test("the cache is bounded", async () => {
  const dir = tempFolder();
  try {
    const media = createMedia({ env: { PATH: "" }, locate: () => null, cacheLimit: 2 });
    const file = copyFixture("landscape.mp4", path.join(dir.dir, "a.mp4"));
    for (let i = 0; i < 5; i += 1) {
      await media.detectType({ path: file, size: 1, modifiedMs: i });
    }
    assert.equal(media.cacheSize(), 2);
  } finally {
    dir.cleanup();
  }
});

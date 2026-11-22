// Path safety (SPEC section 6, "Folders on the server"): every path the admin gives is resolved to
// its real path, links followed, and the data directory is told apart. Each test tries to break the
// rule with a real file system.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createWorld, rejectsCode, treeOf } from "./support.js";

describe("the path guard", () => {
  /** @type {ReturnType<typeof createWorld>} */
  let world;
  /** @type {string} */
  let area;
  /** @type {string} */
  let elsewhere;

  before(() => {
    world = createWorld();
    area = world.mkdir("area");
    elsewhere = world.mkdir("elsewhere");
  });
  after(() => world.cleanup());

  const guard = () => world.mod.api.guard;

  test("a folder resolves to its real path, anywhere on the disk", async () => {
    fs.mkdirSync(path.join(area, "a", "b"), { recursive: true });
    assert.equal(await guard().resolve(path.join(area, "a", "b")), path.join(area, "a", "b"));
    assert.equal(await guard().resolve(elsewhere), elsewhere);
    // Trailing and doubled separators change nothing.
    assert.equal(await guard().resolve(`${area}//a/`), path.join(area, "a"));
  });

  test("a path that does not exist yet resolves under its deepest existing folder", async () => {
    const real = await guard().resolve(path.join(area, "a", "new", "deeper"));
    assert.equal(real, path.join(area, "a", "new", "deeper"));
    assert.deepEqual(
      treeOf(area).filter((entry) => entry.includes("new")),
      [],
    );
  });

  test("a path with .. is refused, even when it stays inside", async () => {
    await rejectsCode(guard().resolve(`${area}/a/../a`), "forbidden");
    await rejectsCode(guard().resolve(`${area}/../elsewhere`), "forbidden");
    await rejectsCode(guard().resolve(`${area}/..`), "forbidden");
  });

  test("text that is not a full path is invalidInput", async () => {
    for (const bad of ["", "relative/path", "a", "./x", "~", "C:\\x", 5, null, undefined, {}]) {
      await rejectsCode(guard().resolve(bad), "invalidInput");
    }
  });

  test("a NUL byte is refused", async () => {
    await rejectsCode(guard().resolve(`${area}/a\0/../../elsewhere`), "invalidInput");
    await rejectsCode(guard().resolve(`${area}\0`), "invalidInput");
  });

  test("a control character in a name that does not exist is refused", async () => {
    await rejectsCode(guard().resolve(`${area}/new\nfolder`), "invalidInput");
  });

  test("a very long name is refused and nothing is made", async () => {
    const before = treeOf(area);
    await rejectsCode(guard().resolve(path.join(area, "x".repeat(5000))), "invalidInput");
    await rejectsCode(guard().resolve(path.join(area, "x".repeat(300), "y")), "invalidInput");
    assert.deepEqual(treeOf(area), before);
    assert.throws(() => guard().safeName("n".repeat(300)));
  });

  test("a link is followed: the real path is what is checked and stored", async () => {
    fs.mkdirSync(path.join(area, "real-dir"));
    fs.symlinkSync(path.join(area, "real-dir"), path.join(area, "inner-link"));
    assert.equal(await guard().resolve(path.join(area, "inner-link")), path.join(area, "real-dir"));
    fs.symlinkSync(elsewhere, path.join(area, "to-elsewhere"));
    assert.equal(await guard().resolve(path.join(area, "to-elsewhere")), elsewhere);
  });

  test("a dangling link is refused, so nothing is created through it", async () => {
    const target = path.join(elsewhere, "not-yet");
    fs.symlinkSync(target, path.join(area, "dangling"));
    await rejectsCode(guard().resolve(path.join(area, "dangling")), "forbidden");
    await rejectsCode(guard().resolve(path.join(area, "dangling", "sub")), "forbidden");
    assert.equal(fs.existsSync(target), false);
  });

  test("a link loop is refused", async () => {
    fs.symlinkSync(path.join(area, "loop-b"), path.join(area, "loop-a"));
    fs.symlinkSync(path.join(area, "loop-a"), path.join(area, "loop-b"));
    await rejectsCode(guard().resolve(path.join(area, "loop-a")), "forbidden");
  });

  test("the data directory is told apart, links included", async () => {
    const data = world.dataDir;
    assert.equal(await guard().dataPath(), data);
    assert.equal(await guard().insideData(data), true);
    assert.equal(await guard().insideData(path.join(data, "projects", "x")), true);
    assert.equal(await guard().insideData(world.root), false);
    assert.equal(await guard().touchesData(world.root), true, "a folder around the data dir");
    assert.equal(await guard().touchesData(path.join(data, "projects")), true);
    assert.equal(await guard().touchesData(area), false);
    fs.symlinkSync(data, path.join(area, "data-link"));
    const real = await guard().resolve(path.join(area, "data-link"));
    assert.equal(await guard().insideData(real), true);
  });
});

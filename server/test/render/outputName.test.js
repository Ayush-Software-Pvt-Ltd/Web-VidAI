import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { finalName, publishFinal, realFileOps } from "../../src/render/outputName.js";

/** @type {string[]} */
const dirs = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-name-"));
  dirs.push(dir);
  const file = path.join(dir, "work.mp4");
  fs.writeFileSync(file, "data");
  return { dir, file, out: path.join(dir, "output") };
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const eexist = () => Object.assign(new Error("exists"), { code: "EEXIST" });

describe("publishFinal", () => {
  it("names files <folder>_final_v<n>.mp4", () => {
    assert.equal(finalName("My Video", 3), "My Video_final_v3.mp4");
  });

  it("uses v1 in an empty or missing output folder and moves the file", async () => {
    const { file, out } = temp();
    const target = await publishFinal({ file, outputDir: out, folderName: "V" });
    assert.equal(target, path.join(out, "V_final_v1.mp4"));
    assert.equal(fs.readFileSync(target, "utf8"), "data");
    assert.equal(fs.existsSync(file), false);
  });

  it("takes the smallest free number, filling gaps, and keeps existing files", async () => {
    const { file, out } = temp();
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "V_final_v1.mp4"), "one");
    fs.writeFileSync(path.join(out, "V_final_v3.mp4"), "three");
    const target = await publishFinal({ file, outputDir: out, folderName: "V" });
    assert.equal(path.basename(target), "V_final_v2.mp4");
    assert.equal(fs.readFileSync(path.join(out, "V_final_v1.mp4"), "utf8"), "one");
    assert.equal(fs.readFileSync(path.join(out, "V_final_v3.mp4"), "utf8"), "three");
  });

  it("loses a race gracefully: a file that appears between the check and the link moves us on", async () => {
    const { file, out } = temp();
    fs.mkdirSync(out);
    let first = true;
    const target = await publishFinal({
      file,
      outputDir: out,
      folderName: "V",
      ops: {
        ...realFileOps,
        link: async (from, to) => {
          if (first) {
            first = false;
            fs.writeFileSync(to, "someone else"); // another render took v1 just now
          }
          return realFileOps.link(from, to);
        },
      },
    });
    assert.equal(path.basename(target), "V_final_v2.mp4");
    assert.equal(fs.readFileSync(path.join(out, "V_final_v1.mp4"), "utf8"), "someone else");
    assert.equal(fs.readFileSync(target, "utf8"), "data");
  });

  it("copies through a temporary name when a link is not possible (another disk)", async () => {
    const { file, out } = temp();
    /** @type {string[]} */
    const steps = [];
    const target = await publishFinal({
      file,
      outputDir: out,
      folderName: "V",
      unique: () => "u1",
      ops: {
        ...realFileOps,
        link: async (from, to) => {
          steps.push(`link:${path.basename(from)}>${path.basename(to)}`);
          if (path.basename(from) === "work.mp4") {
            throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
          }
          return realFileOps.link(from, to);
        },
        copy: async (from, to, exclusive) => {
          steps.push(`copy:${path.basename(to)}:${exclusive}`);
          return realFileOps.copy(from, to, exclusive);
        },
      },
    });
    assert.equal(fs.readFileSync(target, "utf8"), "data");
    assert.ok(steps.includes("copy:.V_final.partial-u1.mp4:true"));
    assert.deepEqual(fs.readdirSync(out), ["V_final_v1.mp4"]);
    assert.equal(fs.existsSync(file), false);
  });

  it("falls back to an exclusive copy when links never work, and still never overwrites", async () => {
    const { file, out } = temp();
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "V_final_v1.mp4"), "one");
    const target = await publishFinal({
      file,
      outputDir: out,
      folderName: "V",
      ops: {
        ...realFileOps,
        link: async () => {
          throw Object.assign(new Error("no links here"), { code: "EPERM" });
        },
      },
    });
    assert.equal(path.basename(target), "V_final_v2.mp4");
    assert.equal(fs.readFileSync(path.join(out, "V_final_v1.mp4"), "utf8"), "one");
    assert.deepEqual(fs.readdirSync(out).sort(), ["V_final_v1.mp4", "V_final_v2.mp4"]);
  });

  it("gives up with a sentence when every number is taken, and deletes its temporary copy", async () => {
    const { file, out } = temp();
    /** @type {string[]} */
    const unlinked = [];
    await assert.rejects(
      publishFinal({
        file,
        outputDir: out,
        folderName: "V",
        ops: {
          mkdir: async () => {},
          link: async () => {
            throw eexist();
          },
          copy: async () => {},
          unlink: async (f) => void unlinked.push(f),
        },
      }),
      /already 9999 rendered versions/u,
    );
    assert.deepEqual(unlinked, []);
  });

  it("propagates a copy error and removes the partial file", async () => {
    const { file, out } = temp();
    /** @type {string[]} */
    const unlinked = [];
    await assert.rejects(
      publishFinal({
        file,
        outputDir: out,
        folderName: "V",
        unique: () => "u",
        ops: {
          mkdir: async () => {},
          link: async () => {
            throw Object.assign(new Error("x"), { code: "EXDEV" });
          },
          copy: async () => {
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          },
          unlink: async (f) => void unlinked.push(f),
        },
      }),
      /disk full/u,
    );
    assert.deepEqual(
      unlinked.map((f) => path.basename(f)),
      [".V_final.partial-u.mp4"],
    );
  });
});

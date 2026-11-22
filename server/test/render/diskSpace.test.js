import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BASE_BYTES,
  clockText,
  diskRefusal,
  gigabytes,
  PER_MINUTE_BYTES,
  requiredBytes,
  ROOM,
} from "../../src/render/diskSpace.js";

const GB = 1024 ** 3;

describe("disk space", () => {
  it("needs 1 GB per minute plus 5 GB", () => {
    assert.equal(BASE_BYTES, 5 * GB);
    assert.equal(PER_MINUTE_BYTES, GB);
    assert.equal(requiredBytes(0), 5 * GB);
    assert.equal(requiredBytes(900), 20 * GB);
    assert.equal(requiredBytes(30), 5.5 * GB);
  });

  it("needs 5 GB per minute plus 8 GB at 2160", () => {
    assert.deepEqual(ROOM[2160], { baseBytes: 8 * GB, perMinuteBytes: 5 * GB });
    assert.equal(requiredBytes(0, 2160), 8 * GB);
    assert.equal(requiredBytes(60, 2160), 13 * GB);
    assert.equal(requiredBytes(900, 2160), 83 * GB);
    assert.equal(requiredBytes(900, 1080), 20 * GB);
  });

  it("is happy with exactly enough at 2160 and refuses a disk that is enough for 1080", () => {
    assert.equal(diskRefusal({ seconds: 60, freeBytes: 13 * GB, resolution: 2160 }), null);
    assert.equal(diskRefusal({ seconds: 900, freeBytes: 20 * GB, resolution: 1080 }), null);
    assert.notEqual(diskRefusal({ seconds: 900, freeBytes: 20 * GB, resolution: 2160 }), null);
    assert.notEqual(diskRefusal({ seconds: 60, freeBytes: 12.9 * GB, resolution: 2160 }), null);
  });

  it("is happy with exactly enough", () => {
    assert.equal(diskRefusal({ seconds: 60, freeBytes: 6 * GB }), null);
    assert.equal(diskRefusal({ seconds: 60, freeBytes: 100 * GB }), null);
  });

  it("names both numbers in a sentence when there is too little", () => {
    const text = diskRefusal({ seconds: 900, freeBytes: 12.34 * GB });
    assert.equal(
      text,
      "There is not enough free disk space to render this video at 1080p: it needs 20.0 GB " +
        "(1 GB for each minute of its 15:00 plus 5 GB) and only 12.3 GB are free. " +
        "Free some space on the server and try again.",
    );
  });

  it("names the resolution and its numbers at 2160", () => {
    const text = diskRefusal({ seconds: 900, freeBytes: 12.34 * GB, resolution: 2160 });
    assert.equal(
      text,
      "There is not enough free disk space to render this video at 2160p: it needs 83.0 GB " +
        "(5 GB for each minute of its 15:00 plus 8 GB) and only 12.3 GB are free. " +
        "Free some space on the server and try again.",
    );
  });

  it("formats lengths and sizes", () => {
    assert.equal(clockText(65), "1:05");
    assert.equal(clockText(3723), "1:02:03");
    assert.equal(gigabytes(1.25 * GB), "1.3 GB");
  });
});

// Shared set-up for the tests of the jobs table and the queue: an in-memory database with two
// users, one channel each and a few videos. Not a test file itself.

import { openDatabase } from "../../src/db/open.js";

/** A clock the test moves by hand. @param {number} [start] */
export function createClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    /** @param {number} ms */
    advance(ms) {
      current += ms;
    },
    /** @param {number} at */
    set(at) {
      current = at;
    },
  };
}

/**
 * @param {{ clock?: { now(): number }, videos?: number }} [options]
 */
export function createJobsDb({ clock = createClock(), videos = 6 } = {}) {
  const db = openDatabase(":memory:", { clock });
  for (const [id, email] of [
    ["u1", "ann@example.com"],
    ["u2", "bob@example.com"],
    ["u3", "cy@example.com"],
  ]) {
    db.run(
      "INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES (?, ?, 'h', 'user', 1, 1)",
      id,
      email,
    );
    db.run(
      "INSERT INTO channels (id, user_id, name, dir, video_type, profiles, position, created_at) VALUES (?, ?, ?, ?, 'auto', '{}', 0, 1)",
      `c-${id}`,
      id,
      `Channel of ${id}`,
      `/media/${id}`,
    );
  }
  for (let n = 1; n <= videos; n += 1) {
    const owner = n % 3 === 1 ? "u1" : n % 3 === 2 ? "u2" : "u3";
    db.run(
      "INSERT INTO videos (id, channel_id, folder_name, created_at) VALUES (?, ?, ?, 1)",
      `v${n}`,
      `c-${owner}`,
      `video ${n}`,
    );
  }
  return { db, clock };
}

/** The user that owns video `vN` in `createJobsDb`. @param {string} videoKey */
export function ownerOf(videoKey) {
  const n = Number(videoKey.slice(1));
  return n % 3 === 1 ? "u1" : n % 3 === 2 ? "u2" : "u3";
}

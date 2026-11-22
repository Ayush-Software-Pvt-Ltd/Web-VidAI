/**
 * Seed of the storage area: the folders of the mock server's disk that the folder picker shows.
 *
 * `world.fs` lists the folders that exist (path and how many video files lie directly in each);
 * the folders above them exist too, and so do the directories of the channels (the storage area
 * derives both). A storage folder of the admin's list is reachable while `world.fs` has a record
 * with exactly its path; a test or scenario makes one unreachable by removing that record
 * (`makeUnreachable`).
 */
import { MEDIA_ROOT } from "../areas/workspace";
import type { World } from "../world";
import { ADMIN_ID, USER_ID } from "./session";

/** The two storage folders the admin added in the seed (`adminSettings.storageRoots`). */
export const FOOTAGE_ROOT = "/srv/footage";
export const SHARE_ROOT = "/mnt/nas/shoots";

function add(world: World, path: string, videoCount = 0): void {
  const name = path.slice(path.lastIndexOf("/") + 1);
  world.fs.push({ path, name, videoCount, children: [] });
}

export function seedStorage(world: World, _now: number): void {
  world.adminSettings.storageRoots = [FOOTAGE_ROOT, SHARE_ROOT];
  add(world, MEDIA_ROOT);
  add(world, `${MEDIA_ROOT}/${ADMIN_ID}`);
  add(world, `${MEDIA_ROOT}/${ADMIN_ID}/Raw footage`, 2);
  add(world, `${MEDIA_ROOT}/${ADMIN_ID}/Raw footage/Day 1`, 7);
  add(world, `${MEDIA_ROOT}/${ADMIN_ID}/Raw footage/Day 2`, 12);
  add(world, `${MEDIA_ROOT}/${ADMIN_ID}/Raw footage/Day 10`, 3);
  add(world, `${MEDIA_ROOT}/${USER_ID}`);
  add(world, `${MEDIA_ROOT}/${USER_ID}/Trips`, 4);

  add(world, FOOTAGE_ROOT);
  add(world, `${FOOTAGE_ROOT}/Campaigns`);
  add(world, `${FOOTAGE_ROOT}/Campaigns/Spring launch`, 9);
  add(world, `${FOOTAGE_ROOT}/Campaigns/Summer sale`, 1);
  add(world, `${FOOTAGE_ROOT}/Interviews`, 5);
  // Hidden folders are never listed.
  add(world, `${FOOTAGE_ROOT}/.cache`);

  add(world, SHARE_ROOT);
  add(world, `${SHARE_ROOT}/Studio A`, 14);
  add(world, `${SHARE_ROOT}/Studio B`);
}

/** Makes a storage folder of the admin's list unreachable, like an unmounted share. */
export function makeUnreachable(world: World, root: string): void {
  world.fs = world.fs.filter((folder) => folder.path !== root);
}

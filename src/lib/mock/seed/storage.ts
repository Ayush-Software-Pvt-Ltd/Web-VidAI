/**
 * Seed of the storage area: the file system of the mock server that the admin's folder picker
 * shows (a Mac): the home folder, the drive "Macintosh HD" at `/`, an external volume
 * "Footage SSD" and a network volume "Backup NAS" that cannot be reached right now.
 *
 * `world.fs` lists folders that exist (path and how many video files lie directly in each); the
 * folders above them exist too, and so do the directories of the channels, their video folders and
 * their `upload` folders (`fsModel.ts` derives these). The channels of the seed lie on the SSD and
 * in the home folder, so the picker shows them as taken.
 */
import type { World } from "../world";

export const HOME = "/Users/vidai";
export const DRIVE_NAME = "Macintosh HD";
export const SSD = "/Volumes/Footage SSD";
export const OFFLINE_VOLUME = "/Volumes/Backup NAS";
/** The server's data directory (it lies inside the home folder, so the home folder is taken). */
export const DATA_DIR = `${HOME}/VidAI Data`;

/** The directories of the seeded channels. */
export const BEAUTY_DIR = `${SSD}/Beauty Channel`;
export const TECH_DIR = `${HOME}/Footage/Tech Reviews`;
export const TRAVEL_DIR = `${HOME}/Footage/Travel Diary`;
/** A copy of the Beauty channel's folders: moving the channel here keeps two of its videos. */
export const BEAUTY_BACKUP_DIR = `${SSD}/Beauty Channel Backup`;

function add(world: World, path: string, videoCount = 0): void {
  world.fs.push({ path, name: path.slice(path.lastIndexOf("/") + 1), videoCount });
}

export function seedStorage(world: World, _now: number): void {
  world.dataDir = DATA_DIR;
  world.fsPlaces = [
    { name: "Home", path: HOME, kind: "home", available: true },
    { name: DRIVE_NAME, path: "/", kind: "drive", available: true },
    { name: "Footage SSD", path: SSD, kind: "volume", available: true },
    { name: "Backup NAS", path: OFFLINE_VOLUME, kind: "volume", available: false },
  ];

  add(world, HOME);
  for (const name of ["Desktop", "Documents", "Downloads", "Movies"]) add(world, `${HOME}/${name}`);
  add(world, `${HOME}/Movies/Holiday clips`, 6);
  add(world, `${HOME}/Footage`);
  add(world, `${HOME}/Footage/Interviews`, 5);
  add(world, `${HOME}/Footage/Archive 2025`);
  add(world, `${HOME}/Footage/Archive 2024`);
  // Hidden folders are never listed.
  add(world, `${HOME}/.cache`);
  add(world, DATA_DIR);
  add(world, `${DATA_DIR}/projects`);

  for (const name of ["Applications", "Library", "System", "Users/Shared"]) add(world, `/${name}`);

  add(world, `${SSD}/Client Shoots`);
  add(world, `${SSD}/Client Shoots/Spring launch`, 9);
  add(world, `${SSD}/Client Shoots/Summer sale`, 1);
  add(world, `${SSD}/Spare`);
  add(world, BEAUTY_BACKUP_DIR);
  add(world, `${BEAUTY_BACKUP_DIR}/Hair Oil Review`, 1);
  add(world, `${BEAUTY_BACKUP_DIR}/Night Cream`, 1);
  add(world, `${SSD}/.Trashes`);
}

/** Makes a volume unavailable, like an unplugged drive (its folders cannot be read). */
export function makeVolumeUnavailable(world: World, path: string): void {
  for (const place of world.fsPlaces) if (place.path === path) place.available = false;
}

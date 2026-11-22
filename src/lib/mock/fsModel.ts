/**
 * The mock server's file system as the admin's folder picker and the channel rules see it: the
 * places (`world.fsPlaces`: home, the drive, volumes), the folders of `world.fs`, and what the
 * channels add (their directory, the video folders in it and the `upload` folders). Paths are
 * absolute with `/` separators, as on a Mac.
 *
 * A folder inside an unavailable place (an unplugged drive) does not exist for the picker, as an
 * unreadable folder does not on the server.
 */
import type { FsPlace } from "../types";
import { splitVideoId } from "../videoId";
import type { MockChannel, World } from "./world";

export function dirname(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Whether `child` is `parent` or lies inside it. */
export function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent === "/" ? "/" : `${parent}/`);
}

/** The real path of an absolute path: no `.`, no `..`, one slash between names, none at the end. */
export function realPath(path: string): string {
  const names: string[] = [];
  for (const name of path.split("/")) {
    if (name === "" || name === ".") continue;
    if (name === "..") names.pop();
    else names.push(name);
  }
  return `/${names.join("/")}`;
}

/** The place a path lies in (the deepest one), or `null`. */
export function placeOf(world: World, path: string): FsPlace | null {
  let best: FsPlace | null = null;
  for (const place of world.fsPlaces) {
    if (!isInside(place.path, path)) continue;
    if (best === null || place.path.length > best.path.length) best = place;
  }
  return best;
}

/** The drive or volume a path lies on: its top is where the picker's parent link stops. */
export function driveRootOf(world: World, path: string): string | null {
  let best: string | null = null;
  for (const place of world.fsPlaces) {
    if (place.kind === "home" || !isInside(place.path, path)) continue;
    if (best === null || place.path.length > best.length) best = place.path;
  }
  return best;
}

/** Every folder that exists with the number of video files directly in it. */
export function diskFolders(world: World): Map<string, number> {
  const known = new Map<string, number>();
  const add = (path: string, videoCount: number | null) => {
    for (let at = path; ; at = dirname(at)) {
      if (!known.has(at)) known.set(at, 0);
      if (at === path && videoCount !== null) known.set(at, videoCount);
      if (at === "/") return;
    }
  };
  for (const folder of world.fs) add(folder.path, folder.videoCount);
  for (const place of world.fsPlaces) if (place.available) add(place.path, null);
  for (const channel of world.channels) {
    add(channel.dir, null);
    if (!channel.available) continue;
    for (const video of world.videos) {
      if (video.channelId !== channel.id) continue;
      add(`${channel.dir}/${video.folderName}`, video.arollCount);
    }
    for (const upload of world.uploads) {
      if (upload.channelId !== channel.id || !upload.done) continue;
      const video = upload.videoId === null ? null : splitVideoId(upload.videoId)?.folderName;
      add(video == null ? `${channel.dir}/upload` : `${channel.dir}/${video}/upload`, null);
    }
  }
  // Folders in an unavailable place cannot be read.
  for (const path of [...known.keys()]) {
    const place = placeOf(world, path);
    if (place !== null && !place.available) known.delete(path);
  }
  return known;
}

/**
 * Makes the folders the channel's records stand for real ones in `world.fs`: what a channel's
 * removal or move leaves on the disk (VidAI never deletes a folder of a channel directory).
 */
export function keepOnDisk(world: World, channel: MockChannel): void {
  const known = diskFolders(world);
  for (const [path, videoCount] of known) {
    if (!isInside(channel.dir, path)) continue;
    if (world.fs.some((folder) => folder.path === path)) continue;
    world.fs.push({ path, name: basename(path), videoCount });
  }
}

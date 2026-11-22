/**
 * Seed of the uploads area. `world.uploads` stands for the files of the `upload` folders that
 * came in through the browser: a finished upload is a file that is in the folder now (so its name
 * is taken and `listUploads` lists it), an unfinished one is a part file. The seed has finished
 * files in the `upload` folders of two videos and of two channels; the scenarios `uploading` and
 * `uploads` add an unfinished one into a video.
 */
import { makeVideoId } from "../../videoId";
import { nextId, type MockUpload, type World } from "../world";
import { ADMIN_ID, USER_ID } from "./session";
import { ADMIN_CHANNEL_BEAUTY, USER_CHANNEL_TRAVEL } from "./workspace";

export const HAIR_OIL_ID = makeVideoId(ADMIN_CHANNEL_BEAUTY, "Hair Oil Review");

export interface UploadSpec {
  userId: string;
  channelId: string;
  /** The video whose `upload` folder it goes to, `null` for the channel's. */
  videoId: string | null;
  name: string;
  size: number;
  /** Bytes the server has; the whole size for a finished upload. */
  received: number;
  /** When the file got its name (ms), for a finished upload. */
  modifiedAt?: number;
}

/** Adds an upload (finished when `received` is the whole size) and returns it. */
export function addUpload(world: World, spec: UploadSpec): MockUpload {
  const done = spec.received >= spec.size;
  const upload: MockUpload = {
    id: nextId(world, "upload"),
    userId: spec.userId,
    channelId: spec.channelId,
    videoId: spec.videoId,
    name: spec.name,
    size: spec.size,
    received: spec.received,
    done,
    modifiedAt: done ? (spec.modifiedAt ?? Date.now()) : 0,
  };
  world.uploads.push(upload);
  return upload;
}

export function seedUploads(world: World, now: number): void {
  const DAY = 86_400_000;
  const admin = (videoId: string | null, name: string, size: number, daysAgo: number) =>
    ({ userId: ADMIN_ID, channelId: ADMIN_CHANNEL_BEAUTY, videoId, name, size, daysAgo }) as const;
  const user = (videoId: string | null, name: string, size: number, daysAgo: number) =>
    ({ userId: USER_ID, channelId: USER_CHANNEL_TRAVEL, videoId, name, size, daysAgo }) as const;
  const files = [
    admin(HAIR_OIL_ID, "logo.png", 84_000, 2),
    admin(HAIR_OIL_ID, "background-music.mp3", 4_300_000, 2),
    admin(HAIR_OIL_ID, "script.pdf", 210_000, 1),
    admin(makeVideoId(ADMIN_CHANNEL_BEAUTY, "Night Cream"), "product-shots.zip", 58_000_000, 4),
    admin(null, "brand-kit.zip", 12_500_000, 9),
    admin(null, "intro-jingle.wav", 3_100_000, 8),
    user(makeVideoId(USER_CHANNEL_TRAVEL, "Lisbon Day 1"), "itinerary.txt", 1_800, 3),
    user(null, "map.png", 640_000, 5),
  ];
  for (const { daysAgo, size, ...file } of files) {
    addUpload(world, { ...file, size, received: size, modifiedAt: now - daysAgo * DAY });
  }
}

/** The scenarios `uploading` and `uploads`: "Night Cream" has a file half uploaded. */
export function uploadingPatch(world: World): void {
  addUpload(world, {
    userId: ADMIN_ID,
    channelId: ADMIN_CHANNEL_BEAUTY,
    videoId: makeVideoId(ADMIN_CHANNEL_BEAUTY, "Night Cream"),
    name: "texture-shots.mp4",
    size: 800_000_000,
    received: 340_000_000,
  });
}

/**
 * Seed of the uploads area. `world.uploads` stands for the files of the video folders that came
 * in by upload: a finished upload is a file that is in the folder now (so its name is taken), an
 * unfinished one is a part file. The seed has two finished files; the scenario `uploading` adds an
 * unfinished one.
 */
import { makeVideoId } from "../../videoId";
import { nextId, type MockUpload, type World } from "../world";
import { ADMIN_ID } from "./session";
import { ADMIN_CHANNEL_BEAUTY } from "./workspace";

export const HAIR_OIL_ID = makeVideoId(ADMIN_CHANNEL_BEAUTY, "Hair Oil Review");

export interface UploadSpec {
  userId: string;
  videoId: string;
  folder: "video" | "broll";
  name: string;
  size: number;
  /** Bytes the server has; the whole size for a finished upload. */
  received: number;
}

/** Adds an upload (finished when `received` is the whole size) and returns it. */
export function addUpload(world: World, spec: UploadSpec): MockUpload {
  const upload: MockUpload = {
    id: nextId(world, "upload"),
    userId: spec.userId,
    videoId: spec.videoId,
    folder: spec.folder,
    name: spec.name,
    size: spec.size,
    received: spec.received,
    done: spec.received >= spec.size,
  };
  world.uploads.push(upload);
  return upload;
}

export function seedUploads(world: World, _now: number): void {
  for (const [folder, name, size] of [
    ["video", "hair-oil-main.mp4", 1_240_000_000],
    ["broll", "bottle-closeup.mp4", 310_000_000],
  ] as const) {
    addUpload(world, {
      userId: ADMIN_ID,
      videoId: HAIR_OIL_ID,
      folder,
      name,
      size,
      received: size,
    });
  }
}

/** The scenarios `uploading` and `uploads`: "Night Cream" has a B-roll file half uploaded. */
export function uploadingPatch(world: World): void {
  addUpload(world, {
    userId: ADMIN_ID,
    videoId: makeVideoId(ADMIN_CHANNEL_BEAUTY, "Night Cream"),
    folder: "broll",
    name: "texture-shots.mp4",
    size: 800_000_000,
    received: 340_000_000,
  });
}

/**
 * The uploads area (SPEC section 6, "Uploads"): `createUpload`, `cancelUpload` and the `uploads`
 * object of the `Api` (`send`, `state`).
 *
 * `world.uploads` is the server's table. A finished upload stands for a file in the video folder
 * (so its name is taken), an unfinished one for a part file. The server's refusals are copied
 * with their sentences: a bad name, a kind that is not allowed, an empty or too large file, a name
 * that exists or is being uploaded, and `notFound` for another user's video or upload.
 *
 * `send` moves the bytes by the mock's ticks, not by timers, so a test steps an upload with
 * `app.tick()`: every tick the server "receives" `1 / UPLOAD_TICKS` of the file times the speed
 * factor, reports the progress and, with the last bytes, finishes the upload and sends
 * `library-changed`. Aborting the signal stops it with an `AbortError` and keeps `received`, so
 * calling `send` again continues from there (Pause and Resume), as the real client does.
 */
import type { Api, UploadOptions, Uploads } from "../../api";
import type { UploadState, UploadTicket } from "../../types";
import type { MockCtx } from "../ctx";
import { channelIdOf } from "../../videoId";
import { ensureChannelReachable } from "../rules";
import { nextId, type MockUpload } from "../world";
import { emitLibrary, ownVideo } from "./library";

export const GB = 1024 ** 3;
/** The most bytes one `PUT` may carry (as on the server). */
export const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
/** Ticks a whole file takes at speed 1. */
export const UPLOAD_TICKS = 5;

export const ALLOWED_EXTENSIONS = [
  ...["mp4", "mov", "m4v", "mkv", "mts", "m2ts", "avi", "webm"],
  ...["wav", "mp3", "m4a", "aac", "flac"],
  ...["png", "jpg", "jpeg", "webp", "gif"],
  ...["txt", "md", "srt"],
];

const NOT_FOUND = "That upload was not found.";

/** The server's sentence for a name that cannot be a file name, or `null`. */
function nameProblem(name: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[/\\:\u0000-\u001f\u007f]/.test(name) || name === "." || name === "..") {
    return "A name cannot contain slashes, colons or control characters.";
  }
  if (name.startsWith(".")) return "A name cannot start with a dot.";
  if (name !== name.trim()) return "A name cannot start or end with a space.";
  if (Array.from(name).length > 200) return "A name can have at most 200 characters.";
  return null;
}

function abortError(): Error {
  const error = new Error("The upload was paused.");
  error.name = "AbortError";
  return error;
}

export function uploadsArea(ctx: MockCtx): Partial<Api> {
  const { world } = ctx;

  function own(id: string): MockUpload {
    const user = ctx.requireUser();
    const found = world.uploads.find((u) => u.id === id && u.userId === user.id);
    if (!found) throw ctx.errors.notFound(NOT_FOUND);
    return found;
  }

  /** Uploads with a `send` in flight, so a second writer is refused as on the server. */
  const writing = new Set<string>();

  /** The server finds the video's folder again for the state and for every chunk of an upload. */
  function reachable(upload: MockUpload): void {
    ensureChannelReachable(ctx, channelIdOf(upload.videoId) ?? "");
  }

  const uploads: Uploads = {
    state: (id: string): Promise<UploadState> =>
      ctx.run(() => {
        const upload = own(id);
        reachable(upload);
        return { received: upload.received, size: upload.size, done: upload.done };
      }),

    send(ticket: UploadTicket, _file: Blob, options: UploadOptions = {}): Promise<void> {
      const { onProgress, signal } = options;
      return new Promise<void>((resolve, reject) => {
        let upload: MockUpload;
        try {
          upload = own(ticket.id);
          reachable(upload);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (upload.done) {
          onProgress?.(upload.size, 0);
          resolve();
          return;
        }
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        if (writing.has(upload.id)) {
          reject(ctx.errors.conflict("This upload is already being sent."));
          return;
        }
        writing.add(upload.id);
        const step = Math.max(1, Math.ceil((upload.size / UPLOAD_TICKS) * ctx.clock.speed));
        let lastAt = ctx.clock.now();
        let stop = () => {};
        const finish = (settle: () => void) => {
          stop();
          signal?.removeEventListener("abort", onAbort);
          writing.delete(upload.id);
          settle();
        };
        const onAbort = () => {
          finish(() => {
            reject(abortError());
          });
        };
        signal?.addEventListener("abort", onAbort);
        stop = ctx.ticks.register(`upload:${upload.id}`, (now) => {
          const alive = world.uploads.includes(upload);
          if (!alive) {
            finish(() => {
              reject(ctx.errors.notFound(NOT_FOUND));
            });
            return;
          }
          const before = upload.received;
          upload.received = Math.min(upload.size, upload.received + step);
          const seconds = Math.max(0, now - lastAt) / 1000;
          lastAt = now;
          const speed = seconds > 0 ? (upload.received - before) / seconds : 0;
          onProgress?.(upload.received, speed);
          if (upload.received >= upload.size) {
            upload.done = true;
            finish(() => {
              emitLibrary(ctx, upload.userId);
              resolve();
            });
          }
        });
      });
    },
  };

  return {
    uploads,

    createUpload: ({ videoId, folder, name, size }) =>
      ctx.run((): UploadTicket => {
        const user = ctx.requireUser();
        const problem = nameProblem(name);
        if (problem) throw ctx.errors.invalidInput(problem);
        const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
        if (!ALLOWED_EXTENSIONS.includes(extension.toLowerCase())) {
          throw ctx.errors.invalidInput(
            "This kind of file cannot be uploaded. Videos, audio, pictures and text files (txt, md, srt) can.",
          );
        }
        if (!Number.isSafeInteger(size) || size < 1) {
          throw ctx.errors.invalidInput("That file is empty.");
        }
        const maxGb = world.adminSettings.maxUploadGb;
        if (size > maxGb * GB) throw ctx.errors.tooLarge(`A file can be at most ${maxGb} GB.`);
        ownVideo(ctx, user.id, videoId);
        const same = world.uploads.find(
          (u) =>
            u.videoId === videoId &&
            u.folder === folder &&
            u.name.toLowerCase() === name.toLowerCase(),
        );
        if (same?.done) {
          throw ctx.errors.conflict("A file with this name already exists in this folder.");
        }
        if (same) throw ctx.errors.conflict("A file with this name is already being uploaded.");
        const id = nextId(world, "upload");
        world.uploads.push({
          id,
          userId: user.id,
          videoId,
          folder,
          name,
          size,
          received: 0,
          done: false,
        });
        emitLibrary(ctx, user.id);
        return { id, name, size, maxChunkBytes: MAX_CHUNK_BYTES };
      }),

    cancelUpload: ({ id }) =>
      ctx.run(() => {
        const upload = own(id);
        // A finished upload is a file in the folder: cancelling never removes a finished file.
        if (!upload.done) {
          world.uploads = world.uploads.filter((u) => u !== upload);
          emitLibrary(ctx, upload.userId);
        }
        return null;
      }),
  };
}

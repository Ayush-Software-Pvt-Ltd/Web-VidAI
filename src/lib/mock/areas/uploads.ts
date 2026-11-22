/**
 * The uploads area (SPEC section 6, "Uploads"): `listUploads`, `createUpload`, `cancelUpload` and
 * the `uploads` object of the `Api` (`send`, `state`).
 *
 * An upload goes to the `upload` folder of one of the user's videos or channels
 * (`UploadTarget`); every file type is accepted. `world.uploads` is the server's table: a finished
 * upload stands for a file in that folder (so its name is taken and `listUploads` lists it), an
 * unfinished one for a part file (not listed). The server's refusals are copied with their
 * sentences: a bad name, an empty or too large file, a name that exists or is being uploaded, and
 * `notFound` for another user's video, channel or upload. A video's unfinished upload blocks Start
 * Editing for that video (`VideoView.uploading`); a channel's blocks nothing.
 *
 * `send` moves the bytes by the mock's ticks, not by timers, so a test steps an upload with
 * `app.tick()`: every tick the server "receives" `1 / UPLOAD_TICKS` of the file times the speed
 * factor, reports the progress and, with the last bytes, finishes the upload and sends
 * `library-changed`. Aborting the signal stops it with an `AbortError` and keeps `received`, so
 * calling `send` again continues from there (Pause and Resume), as the real client does.
 */
import type { Api, UploadOptions, Uploads } from "../../api";
import type { UploadedFile, UploadState, UploadTarget, UploadTicket } from "../../types";
import type { MockCtx } from "../ctx";
import { ensureChannelReachable, uploadNameProblem } from "../rules";
import { nextId, type MockUpload } from "../world";
import { emitLibrary, ownVideo } from "./library";
import { naturalCompare } from "./storage";

export const GB = 1024 ** 3;
/** The most bytes one `PUT` may carry (as on the server). */
export const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
/** Ticks a whole file takes at speed 1. */
export const UPLOAD_TICKS = 5;

const NOT_FOUND = "That upload was not found.";

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

  /**
   * The folder an upload goes to, found as the server does: `notFound` for another user's video or
   * channel, `conflict` when the channel's folder cannot be reached.
   */
  function resolveTarget(
    userId: string,
    target: UploadTarget,
  ): { channelId: string; videoId: string | null } {
    if (target.kind === "video") {
      const video = ownVideo(ctx, userId, target.videoId);
      return { channelId: video.channelId, videoId: target.videoId };
    }
    const channel = world.channels.find((c) => c.id === target.channelId && c.userId === userId);
    if (!channel) throw ctx.errors.notFound("That channel was not found.");
    ensureChannelReachable(ctx, channel.id);
    return { channelId: channel.id, videoId: null };
  }

  /** The server finds the video's folder again for the state and for every chunk of an upload. */
  function reachable(upload: MockUpload): void {
    ensureChannelReachable(ctx, upload.channelId);
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
            upload.modifiedAt = now;
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

    listUploads: ({ target }) =>
      ctx.run((): UploadedFile[] => {
        const user = ctx.requireUser();
        const { channelId, videoId } = resolveTarget(user.id, target);
        return world.uploads
          .filter((u) => u.done && u.channelId === channelId && u.videoId === videoId)
          .map((u) => ({ name: u.name, size: u.size, modifiedAt: u.modifiedAt }))
          .sort((a, b) => naturalCompare(a.name, b.name));
      }),

    createUpload: ({ target, name, size }) =>
      ctx.run((): UploadTicket => {
        const user = ctx.requireUser();
        const { channelId, videoId } = resolveTarget(user.id, target);
        const problem = uploadNameProblem(name);
        if (problem) throw ctx.errors.invalidInput(problem);
        if (!Number.isSafeInteger(size) || size < 1) {
          throw ctx.errors.invalidInput("That file is empty.");
        }
        const maxGb = world.adminSettings.maxUploadGb;
        if (size > maxGb * GB) throw ctx.errors.tooLarge(`A file can be at most ${maxGb} GB.`);
        const same = world.uploads.find(
          (u) =>
            u.channelId === channelId &&
            u.videoId === videoId &&
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
          channelId,
          videoId,
          name,
          size,
          received: 0,
          done: false,
          modifiedAt: 0,
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

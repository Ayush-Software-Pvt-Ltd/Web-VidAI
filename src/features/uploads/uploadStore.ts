/**
 * The uploads that are running, paused or finished in this browser tab (SPEC section 6,
 * "Uploads"). They live here and not in a dialog, so closing the dialog or moving around the app
 * never stops them. There is one `UploadsController` per app store (`uploadsFor`), created on first
 * use; `UploadsHost` (mounted once by the main window) is its only owner in the tree.
 *
 * One file is one `UploadItem` with a phase:
 *
 *   preparing    `createUpload` is in flight (the server checks the name, the kind and the size)
 *   waiting      the ticket is there, the file waits for one of the `MAX_PARALLEL` places
 *   sending      the bytes move (`api.uploads.send`)
 *   paused       stopped by the user; Resume calls `send` again with the same ticket and file
 *   interrupted  found again after a reload: the server has part of the file, the browser has
 *                lost the file itself, so the user chooses the same file again to continue
 *   done         the server has the whole file under its name
 *   failed       the server or the network said no; `error` is the sentence to show
 *
 * What a reload can keep is the ticket: tickets of unfinished uploads are saved in local storage
 * (per user) and asked again with `api.uploads.state` when the app starts. The server has no call
 * that lists the unfinished uploads of a video, and a browser cannot keep a file across a reload.
 */
import { createStore, type StoreApi } from "zustand";
import type { Api } from "@/lib/api";
import { isAbortError, toApiError } from "@/lib/errors";
import type { AppStore } from "@/lib/store";
import type { ErrorCode, UploadFolder, UploadTicket, VideoRef } from "@/lib/types";

/**
 * Files that are sent at the same time; the others wait for a place. A browser keeps about six
 * connections per server, and the page's own event stream and calls need some of them; and files
 * that share a slow link finish no sooner than files sent one after another, only later each.
 */
export const MAX_PARALLEL = 3;

/** Cancelling asks first when more than this has been sent (a little is not worth a question). */
export const CANCEL_CONFIRM_BYTES = 16 * 1024 * 1024;

const STORAGE_PREFIX = "vidai.uploads.";

export type UploadPhase =
  "preparing" | "waiting" | "sending" | "paused" | "interrupted" | "done" | "failed";

export interface UploadItem {
  /** A local id, unique in this tab. */
  key: string;
  videoId: string;
  folder: UploadFolder;
  name: string;
  size: number;
  phase: UploadPhase;
  /** Bytes the server has. */
  received: number;
  bytesPerSecond: number;
  /** `null` until `createUpload` answered (and again after the server forgot the upload). */
  ticket: UploadTicket | null;
  /** The file; `null` for an `interrupted` upload until the user chooses it again. */
  file: Blob | null;
  /** The sentence of the failure, for `failed` (and for a wrong file chosen again). */
  error: string | null;
  errorCode: ErrorCode | null;
}

/** The New Video dialog: asked for in a channel (`null`: the user chooses), then the new video. */
export interface NewVideoRequest {
  channelId: string | null;
  created: VideoRef | null;
}

export interface UploadsState {
  items: UploadItem[];
  newVideo: NewVideoRequest | null;
}

export interface UploadsController {
  readonly state: StoreApi<UploadsState>;
  /** Starts the files: each asks the server at once, so a refusal shows before any byte moves. */
  add: (videoId: string, folder: UploadFolder, files: readonly File[]) => void;
  pause: (key: string) => void;
  resume: (key: string) => void;
  /** Tries a failed upload again (it continues from what the server has when it still has it). */
  retry: (key: string) => void;
  /** Stops the upload and deletes what the server received. */
  cancel: (key: string) => void;
  /** Takes a finished or failed entry off the list (a failed one is cancelled on the server). */
  dismiss: (key: string) => void;
  clearFinished: (videoId: string) => void;
  /**
   * Continues an `interrupted` upload with a file the user chose. Returns the sentence why this
   * file is not the one, or `null` when the upload goes on.
   */
  chooseAgain: (key: string, file: File) => string | null;
  openNewVideo: (channelId: string | null) => void;
  closeNewVideo: () => void;
  /** Makes the video folder (the server's refusal is thrown as an `ApiError`). */
  createVideo: (channelId: string, name: string) => Promise<VideoRef>;
  /** Tells whom the tab belongs to: the uploads of the previous user stop, this user's come back. */
  setUser: (userId: string | null) => Promise<void>;
  /** Whether bytes are moving or about to (what the page must ask about before it unloads). */
  hasRunning: () => boolean;
}

const RUNNING: readonly UploadPhase[] = ["preparing", "waiting", "sending"];

export const isRunning = (item: UploadItem) => RUNNING.includes(item.phase);

/** Not finished and not failed: it still counts for the row's progress. */
export const isUnfinished = (item: UploadItem) => item.phase !== "done" && item.phase !== "failed";

/** A failure the same request would meet again (so there is no point in a button for it). */
const FINAL_CODES: readonly ErrorCode[] = [
  "conflict",
  "tooLarge",
  "invalidInput",
  "forbidden",
  "notFound",
];

/** Whether "Try again" can help: a lost connection or a busy server, not a refusal. */
export function canRetry(item: UploadItem): boolean {
  if (item.phase !== "failed") return false;
  return item.errorCode === null || !FINAL_CODES.includes(item.errorCode);
}

export function needsCancelConfirm(item: UploadItem): boolean {
  return item.received > CANCEL_CONFIRM_BYTES;
}

interface Saved {
  ticket: UploadTicket;
  videoId: string;
  folder: UploadFolder;
}

/** What the browser's storage holds is not trusted: a damaged entry is left out, not thrown on. */
function isSaved(value: unknown): value is Saved {
  if (typeof value !== "object" || value === null) return false;
  const { ticket, videoId, folder } = value as Partial<Record<keyof Saved, unknown>>;
  if (typeof ticket !== "object" || ticket === null) return false;
  const { id, name, size } = ticket as Partial<Record<keyof UploadTicket, unknown>>;
  return (
    typeof id === "string" &&
    typeof name === "string" &&
    typeof size === "number" &&
    typeof videoId === "string" &&
    (folder === "video" || folder === "broll")
  );
}

function readSaved(userId: string): Saved[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + userId);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as unknown[]).filter(isSaved) : [];
  } catch {
    return [];
  }
}

function writeSaved(userId: string, saved: Saved[]): void {
  try {
    if (saved.length === 0) window.localStorage.removeItem(STORAGE_PREFIX + userId);
    else window.localStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify(saved));
  } catch {
    // A full or blocked storage only loses the "continue after a reload" help.
  }
}

export function createUploadsController(api: Api, store: AppStore): UploadsController {
  const state = createStore<UploadsState>()(() => ({ items: [], newVideo: null }));
  const controllers = new Map<string, AbortController>();
  let counter = 0;
  let userId: string | null = null;

  const find = (key: string) => state.getState().items.find((item) => item.key === key);

  function patch(key: string, changes: Partial<UploadItem>): void {
    state.setState((s) => ({
      items: s.items.map((item) => (item.key === key ? { ...item, ...changes } : item)),
    }));
  }

  function remove(key: string): void {
    state.setState((s) => ({ items: s.items.filter((item) => item.key !== key) }));
    save();
  }

  /** Keeps the tickets of unfinished uploads for after a reload. */
  function save(): void {
    if (userId === null) return;
    const saved: Saved[] = [];
    for (const item of state.getState().items) {
      if (item.ticket !== null && item.phase !== "done") {
        saved.push({ ticket: item.ticket, videoId: item.videoId, folder: item.folder });
      }
    }
    writeSaved(userId, saved);
  }

  function fail(key: string, error: unknown): void {
    const wire = toApiError(error);
    if (wire.code === "notFound" && find(key)?.ticket) {
      // The server forgot the upload (cancelled elsewhere or too old): Try again starts it over.
      patch(key, {
        phase: "failed",
        error: "The server no longer has this upload. Try again to start it over.",
        errorCode: null,
        bytesPerSecond: 0,
        ticket: null,
        received: 0,
      });
    } else {
      patch(key, { phase: "failed", error: wire.message, errorCode: wire.code, bytesPerSecond: 0 });
    }
    save();
  }

  async function prepare(key: string): Promise<void> {
    const item = find(key);
    if (!item) return;
    try {
      const ticket = await api.createUpload({
        videoId: item.videoId,
        folder: item.folder,
        name: item.name,
        size: item.size,
      });
      // Cancelled while the server was answering: give the upload back at once.
      if (!find(key)) {
        void api.cancelUpload({ id: ticket.id }).catch(() => undefined);
        return;
      }
      patch(key, { ticket, phase: "waiting", error: null, errorCode: null });
      save();
      pump();
    } catch (error) {
      if (find(key)) fail(key, error);
    }
  }

  function pump(): void {
    for (;;) {
      const items = state.getState().items;
      if (items.filter((item) => item.phase === "sending").length >= MAX_PARALLEL) return;
      const next = items.find((item) => item.phase === "waiting");
      if (!next) return;
      start(next);
    }
  }

  function start(item: UploadItem): void {
    const { key, ticket, file } = item;
    if (ticket === null || file === null) return;
    const controller = new AbortController();
    controllers.set(key, controller);
    patch(key, { phase: "sending", error: null, errorCode: null });
    void api.uploads
      .send(ticket, file, {
        signal: controller.signal,
        onProgress: (received, bytesPerSecond) => {
          if (find(key)?.phase === "sending") patch(key, { received, bytesPerSecond });
        },
      })
      .then(() => {
        if (!find(key)) return;
        patch(key, { phase: "done", received: item.size, bytesPerSecond: 0 });
        save();
      })
      .catch((error: unknown) => {
        // Pause and Cancel abort on purpose and have changed the item themselves.
        if (isAbortError(error) || find(key)?.phase !== "sending") return;
        fail(key, error);
      })
      .finally(() => {
        if (controllers.get(key) === controller) controllers.delete(key);
        pump();
      });
  }

  function abort(key: string): void {
    controllers.get(key)?.abort();
    controllers.delete(key);
  }

  function giveBack(item: UploadItem): void {
    if (item.ticket === null) return;
    // Best effort: the server also deletes a part file nobody touched for 24 hours.
    void api.cancelUpload({ id: item.ticket.id }).catch(() => undefined);
  }

  return {
    state,

    add(videoId, folder, files) {
      const items: UploadItem[] = files.map((file) => {
        counter += 1;
        return {
          key: `upload-${counter}`,
          videoId,
          folder,
          name: file.name,
          size: file.size,
          phase: "preparing",
          received: 0,
          bytesPerSecond: 0,
          ticket: null,
          file,
          error: null,
          errorCode: null,
        };
      });
      if (items.length === 0) return;
      state.setState((s) => ({ items: [...s.items, ...items] }));
      for (const item of items) void prepare(item.key);
    },

    pause(key) {
      const item = find(key);
      if (item?.phase !== "sending" && item?.phase !== "waiting") return;
      patch(key, { phase: "paused", bytesPerSecond: 0 });
      abort(key);
      pump();
    },

    resume(key) {
      if (find(key)?.phase !== "paused") return;
      patch(key, { phase: "waiting" });
      pump();
    },

    retry(key) {
      const item = find(key);
      if (!item || !canRetry(item)) return;
      if (item.ticket !== null) {
        patch(key, { phase: "waiting", error: null, errorCode: null });
        pump();
      } else {
        patch(key, { phase: "preparing", error: null, errorCode: null });
        void prepare(key);
      }
    },

    cancel(key) {
      const item = find(key);
      if (!item || item.phase === "done") return;
      abort(key);
      remove(key);
      giveBack(item);
      pump();
    },

    dismiss(key) {
      const item = find(key);
      if (!item) return;
      if (item.phase === "done") remove(key);
      else if (item.phase === "failed") {
        remove(key);
        giveBack(item);
      }
    },

    clearFinished(videoId) {
      state.setState((s) => ({
        items: s.items.filter((item) => !(item.videoId === videoId && item.phase === "done")),
      }));
    },

    chooseAgain(key, file) {
      const item = find(key);
      if (item?.phase !== "interrupted") return null;
      if (file.name !== item.name || file.size !== item.size) {
        return "That is not the same file. Choose the file that was being uploaded.";
      }
      patch(key, { file, phase: "waiting", error: null, errorCode: null });
      pump();
      return null;
    },

    openNewVideo(channelId) {
      state.setState({ newVideo: { channelId, created: null } });
    },

    closeNewVideo() {
      state.setState({ newVideo: null });
    },

    async createVideo(channelId, name) {
      const ref = await store.getState().createVideo(channelId, name);
      state.setState((s) => (s.newVideo ? { newVideo: { ...s.newVideo, created: ref } } : {}));
      return ref;
    },

    async setUser(next) {
      if (next === userId) return;
      for (const key of [...controllers.keys()]) abort(key);
      userId = next;
      state.setState({ items: [], newVideo: null });
      if (next === null) return;
      for (const saved of readSaved(next)) {
        if (userId !== next) return;
        let received = 0;
        try {
          const server = await api.uploads.state(saved.ticket.id);
          if (server.done) continue;
          received = server.received;
        } catch (error) {
          // The server forgot it (cancelled, or too old): it is not listed. Any other failure
          // (the server cannot be reached right now) keeps it listed, with what is not known as 0.
          if (toApiError(error).code === "notFound") continue;
        }
        if (userId !== next) return;
        if (state.getState().items.some((item) => item.ticket?.id === saved.ticket.id)) continue;
        counter += 1;
        const item: UploadItem = {
          key: `upload-${counter}`,
          videoId: saved.videoId,
          folder: saved.folder,
          name: saved.ticket.name,
          size: saved.ticket.size,
          phase: "interrupted",
          received,
          bytesPerSecond: 0,
          ticket: saved.ticket,
          file: null,
          error: null,
          errorCode: null,
        };
        state.setState((s) => ({ items: [...s.items, item] }));
      }
      save();
    },

    hasRunning: () => state.getState().items.some(isRunning),
  };
}

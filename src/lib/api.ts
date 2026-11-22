/**
 * The contract between the UI and the backend. `Api` is derived from `RpcMethods` (`rpc.ts`): one
 * function per RPC function of SPEC section 14, plus the few things that are not an RPC call:
 * file URLs, uploads, the event subscriptions and the state of the link to the server.
 *
 * Two implementations exist: `http.ts` (the real server, production) and `mock/` (in-memory, for
 * development and tests). UI code gets the one in use through `useApi()` (`@/lib/appEnv`).
 * Every call rejects with an `ApiError` (`errors.ts`).
 */
import type { Connection } from "./connection";
import type { EventName, EventMethod, EventPayloads, RpcMethods } from "./rpc";
import type { UploadState, UploadTicket } from "./types";

export type { Connection, ConnectionState } from "./connection";

export type Unsubscribe = () => void;

/** The RPC functions, as methods: `api.startEdit({ videoId, urgent })`. */
export type RpcApi = {
  [K in keyof RpcMethods]: (input: RpcMethods[K]["input"]) => Promise<RpcMethods[K]["output"]>;
};

/**
 * One subscribe function per event, named in camel case (`libraryChanged` for `library-changed`),
 * each with the payload of `EventPayloads`. Only the store subscribes (in `init()`).
 */
export type ApiEvents = {
  [E in EventName as EventMethod<E>]: (handler: (payload: EventPayloads[E]) => void) => Unsubscribe;
};

export interface FileUrlOptions {
  /** Send the file as a download (`download=1`) instead of showing it in the page. */
  download?: boolean;
}

export interface UploadOptions {
  /**
   * Called with the number of bytes the server has received so far and the smoothed speed in bytes
   * per second (0 while it is not known yet), for a progress bar and the time left.
   */
  onProgress?: (received: number, bytesPerSecond: number) => void;
  /** Aborting stops the transfer and rejects with an `AbortError`; the upload stays resumable. */
  signal?: AbortSignal;
}

/**
 * Uploads (SPEC section 6): `createUpload` gives a ticket, `send` moves the bytes in chunks of at
 * most `ticket.maxChunkBytes`. `send` first asks the server how far the upload got and continues
 * from there, so Resume is calling `send` again with the same ticket and file; Pause is aborting
 * the signal; Cancel is aborting and then `cancelUpload`. It resolves when the server says the
 * file is complete.
 */
export interface Uploads {
  send(ticket: UploadTicket, file: Blob, options?: UploadOptions): Promise<void>;
  /** How far an upload got (`GET /api/upload/<id>`). */
  state(id: string): Promise<UploadState>;
}

export interface Api extends RpcApi {
  readonly backend: "http" | "mock";
  /** The state of the link to the server (event stream up, session refused). */
  readonly connection: Connection;
  /**
   * The URL of a file of the user's video folder (`GET /api/file?video=<id>&path=<relative>`) for
   * `<img>`, `<video>` and links; `path` is relative to the video folder, as the wire types give it.
   */
  fileUrl(videoId: string, path: string, options?: FileUrlOptions): string;
  /** The HyperFrames player element's script, served by the server at a fixed address. */
  readonly playerScriptUrl: string;
  readonly uploads: Uploads;
  readonly on: ApiEvents;
}

/** Where the server serves the player's script (the mock serves nothing there). */
export const PLAYER_SCRIPT_URL = "/assets/hyperframes-player.js";

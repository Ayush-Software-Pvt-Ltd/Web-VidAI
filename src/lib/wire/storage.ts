// Wire types of the storage area (docs/SPEC.md section 6, "Storage folders and path safety" and
// "Uploads"): the in-page folder picker and uploads. Pure declarations; every field is always
// present (`null` when empty).

/** Where a place in the folder picker comes from. */
export type FsPlaceKind =
  /** The user's own folder, `<data dir>/media/<user id>/`; always the first place. */
  | "personal"
  /** A storage folder of the admin's list, or the default `<data dir>/media`. */
  | "storage";

/** One entry of the folder picker's sidebar (`fsPlaces`). */
export interface FsPlace {
  /** What the picker shows, e.g. "My folder" or the last part of the storage folder. */
  name: string;
  /** Absolute real path on the server. */
  path: string;
  kind: FsPlaceKind;
  /** False when the folder cannot be reached right now (for example an unmounted share). */
  available: boolean;
}

/** One sub-folder in a listing; files are never listed. */
export interface FsEntry {
  name: string;
  /** Absolute path, ready to send back to `fsList`. */
  path: string;
  /**
   * True when this folder is, contains or lies inside a channel directory (of any user, the
   * answer never says whose), so it cannot become a channel; the picker greys it out.
   */
  taken: boolean;
}

/** What `fsList` answers: the folders inside one folder. */
export interface FsListing {
  /** The folder that was listed (its real path). */
  path: string;
  /** The folder above it, `null` at the top of a storage folder. */
  parent: string | null;
  /** How many video files lie directly in this folder (a hint for choosing the right folder). */
  videoCount: number;
  /** Folders only, hidden ones left out, in natural order. */
  entries: FsEntry[];
}

/** What `fsCreateFolder` answers: the new folder. */
export interface FsCreatedFolder {
  /** Absolute path of the folder that was made. */
  path: string;
}

/** Which folder of a video an upload goes to. */
export type UploadFolder = "video" | "broll";

/** What `createUpload` answers: the id to send the bytes to (`PUT /api/upload/<id>`). */
export interface UploadTicket {
  id: string;
  /** The file name the upload will have. */
  name: string;
  /** The declared size in bytes. */
  size: number;
  /** The most bytes one `PUT` may carry. */
  maxChunkBytes: number;
}

/** What `GET /api/upload/<id>` answers: how far an upload got, so a broken one continues. */
export interface UploadState {
  received: number;
  size: number;
  /** True once the file has its final name in the folder. */
  done: boolean;
}

/** What each `PUT /api/upload/<id>?offset=<n>` answers. */
export interface UploadProgress {
  /** The new offset: the bytes the server has in order. */
  received: number;
  done: boolean;
}

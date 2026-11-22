// Wire types of the storage area (docs/SPEC.md section 6, "Folders on the server" and
// "Uploads"): the admin's folder picker over the server's whole file system, and uploads.
// Pure declarations; every field is always present (`null` when empty).

/** Where a place in the folder picker comes from. */
export type FsPlaceKind =
  /** The home folder of the account the server runs as; always the first place. */
  | "home"
  /** A drive: the file system's root `/` on a Mac, each drive letter (`C:`) on Windows. */
  | "drive"
  /** A mounted volume on a Mac (`/Volumes/<name>`): internal, external and network drives. */
  | "volume";

/** One entry of the admin's folder picker sidebar (`fsPlaces`). */
export interface FsPlace {
  /** What the picker shows, e.g. "Home", "Macintosh HD", "Backup SSD" or "D:". */
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
   * True when this folder is, contains or lies inside a channel directory, or lies inside the
   * server's data directory, so it cannot become a channel; the picker greys it out.
   */
  taken: boolean;
}

/** What `fsList` answers: the folders inside one folder. */
export interface FsListing {
  /** The folder that was listed (its real path). */
  path: string;
  /** The folder above it, `null` at the top of a drive. */
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

/** The folder an upload goes to: `<video folder>/upload/` or `<channel directory>/upload/`. */
export type UploadTarget =
  { kind: "video"; videoId: string } | { kind: "channel"; channelId: string };

/** A file in an `upload` folder (`listUploads`). */
export interface UploadedFile {
  name: string;
  size: number;
  /** Milliseconds since 1970. */
  modifiedAt: number;
}

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

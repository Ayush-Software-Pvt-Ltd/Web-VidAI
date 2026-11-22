import type { CleanResult, DiskUse } from "../types";
import type { SliceContext } from "./ctx";
import { idle, type Resource } from "./resource";

export interface DiskState {
  /** What each video takes on disk (Disk Cleanup); sizes may still be `measuring`. */
  diskUse: Resource<DiskUse>;
}

export interface DiskActions {
  loadDiskUse: () => Promise<void>;
  /** Deletes the working files of one video (SPEC section 13), then reloads the sizes. */
  cleanWorkingFiles: (videoId: string) => Promise<CleanResult>;
}

export type DiskSlice = DiskState & DiskActions;

export function createDiskSlice({ api, get, load, call }: SliceContext): DiskSlice {
  return {
    diskUse: idle(),
    loadDiskUse: () => load("diskUse", () => api.getDiskUse()),
    async cleanWorkingFiles(videoId) {
      const result = await call(() => api.cleanWorkingFiles({ videoId }));
      // The video's actions change (nothing left to clean), and so do the sizes.
      await Promise.all([get().loadDiskUse(), get().refreshLibrary()]);
      return result;
    },
  };
}

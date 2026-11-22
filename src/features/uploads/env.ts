/**
 * What the uploads UI depends on: the backend and the app store (`AppEnvContext`) and the one
 * uploads controller that belongs to that store, so the dialog, the rows and `UploadsHost` all see
 * the same running uploads.
 */
import { useMemo } from "react";
import { useStore } from "zustand";
import type { Api } from "@/lib/api";
import { useAppEnv } from "@/lib/appEnv";
import type { AppStore } from "@/lib/store";
import type { UploadTarget } from "@/lib/types";
import {
  createUploadsController,
  sameTarget,
  type UploadItem,
  type UploadsController,
} from "./uploadStore";

const controllers = new WeakMap<AppStore, UploadsController>();

/** The uploads controller of a store, created on first use. */
export function uploadsFor(api: Api, store: AppStore): UploadsController {
  let controller = controllers.get(store);
  if (!controller) {
    controller = createUploadsController(api);
    controllers.set(store, controller);
  }
  return controller;
}

export function useUploads(): UploadsController {
  const { api, store } = useAppEnv();
  return uploadsFor(api, store);
}

/** The uploads into one folder (in the order they were added). */
export function useTargetUploads(target: UploadTarget): UploadItem[] {
  const controller = useUploads();
  const items = useStore(controller.state, (s) => s.items);
  const kind = target.kind;
  const id = target.kind === "video" ? target.videoId : target.channelId;
  return useMemo(
    () =>
      items.filter((item) =>
        sameTarget(item.target, kind === "video" ? { kind, videoId: id } : { kind, channelId: id }),
      ),
    [items, kind, id],
  );
}

/** The uploads of one video (in the order they were added). */
export function useVideoUploads(videoId: string): UploadItem[] {
  return useTargetUploads({ kind: "video", videoId });
}

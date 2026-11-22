/**
 * What the uploads UI depends on: the backend and the app store (`AppEnvContext`) and the one
 * uploads controller that belongs to that store, so the dialog, the rows and `UploadsHost` all see
 * the same running uploads.
 */
import { useCallback, useMemo } from "react";
import { useStore } from "zustand";
import type { Api } from "@/lib/api";
import { useAppEnv } from "@/lib/appEnv";
import type { AppStore } from "@/lib/store";
import { createUploadsController, type UploadItem, type UploadsController } from "./uploadStore";

const controllers = new WeakMap<AppStore, UploadsController>();

/** The uploads controller of a store, created on first use. */
export function uploadsFor(api: Api, store: AppStore): UploadsController {
  let controller = controllers.get(store);
  if (!controller) {
    controller = createUploadsController(api, store);
    controllers.set(store, controller);
  }
  return controller;
}

export function useUploads(): UploadsController {
  const { api, store } = useAppEnv();
  return uploadsFor(api, store);
}

/** The uploads of one video (in the order they were added). */
export function useVideoUploads(videoId: string): UploadItem[] {
  const controller = useUploads();
  const items = useStore(controller.state, (s) => s.items);
  return useMemo(() => items.filter((item) => item.videoId === videoId), [items, videoId]);
}

/**
 * The handler the main window gives to `NewVideoProvider` of the library: the toolbar's New Video
 * button calls it with the selected channel (`null` for All Channels).
 */
export function useOpenNewVideo(): (channelId: string | null) => void {
  const controller = useUploads();
  return useCallback(
    (channelId: string | null) => {
      controller.openNewVideo(channelId);
    },
    [controller],
  );
}

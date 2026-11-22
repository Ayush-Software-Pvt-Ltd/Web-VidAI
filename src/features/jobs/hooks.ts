import { useStore } from "zustand";
import type { VideoView } from "@/lib/types";
import { findVideo } from "./controller";
import { useJobsEnv } from "./env";

/** The current version of a video from the library, or the given snapshot when it is gone. */
export function useLiveVideo(snapshot: VideoView): VideoView {
  const { store } = useJobsEnv();
  return useStore(store, (s) => findVideo(s.library.data, snapshot.id)) ?? snapshot;
}

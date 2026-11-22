/**
 * The seam to "New Video": the library shows a "New Video" button (the toolbar, and the empty
 * state of a channel without videos) only when a handler is provided here. The uploads task
 * provides it by wrapping the main window in `NewVideoProvider`.
 *
 * `onNewVideo(channelId)` gets the channel selected in the sidebar (`null` for All Channels, where
 * the New Video dialog has to ask for the channel itself). The hook is in `newVideoContext.ts`.
 */
import type { ReactNode } from "react";
import { NewVideoContext, type NewVideoHandler } from "./newVideoContext";

export function NewVideoProvider({
  onNewVideo,
  children,
}: {
  onNewVideo: NewVideoHandler;
  children: ReactNode;
}) {
  return <NewVideoContext value={onNewVideo}>{children}</NewVideoContext>;
}

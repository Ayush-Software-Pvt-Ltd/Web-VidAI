import { createContext, useContext } from "react";

/** Starts a new video; `channelId` is the channel selected in the sidebar (`null`: All Channels). */
export type NewVideoHandler = (channelId: string | null) => void;

export const NewVideoContext = createContext<NewVideoHandler | null>(null);

/** The New Video handler, or `null` while nobody provides one (the button is then hidden). */
export function useNewVideoHandler(): NewVideoHandler | null {
  return useContext(NewVideoContext);
}

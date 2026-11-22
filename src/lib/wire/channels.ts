// Wire types of channels and the workspace (docs/SPEC.md section 6, "Channels"; slot rules from
// docs/SPEC-desktop.md section 4). Pure declarations; every field is always present.
import type { PublicSettings } from "../wire.ts";

/** "Auto-detect", "Always Long" or "Always Short": fixes the type of every video of a channel. */
export type ChannelVideoType = "auto" | "long" | "short";

/** Long is 16:9 (1920x1080), Short is 9:16 (1080x1920); SPEC section 6, Videos. */
export type VideoType = "long" | "short";

/** One named prompt or style. Slot 0 is always named "Default"; other names are 1 to 40 characters. */
export interface ChannelSlot {
  name: string;
  text: string;
}

/** The prompts and styles of one video type: always exactly 5 of each. */
export interface ChannelProfile {
  prompts: ChannelSlot[];
  styles: ChannelSlot[];
}

/** A channel of the signed-in user: a directory with one folder per video. */
export interface Channel {
  /** Random, stable across renames. */
  id: string;
  /** 1 to 60 characters, unique for the user without regard to letter case. */
  name: string;
  /** Absolute real path of the channel directory on the server. */
  dir: string;
  videoType: ChannelVideoType;
  /** The 16:9 profile. */
  long: ChannelProfile;
  /** The 9:16 profile. */
  short: ChannelProfile;
  /** False when the directory cannot be reached right now (for example an unmounted share). */
  available: boolean;
}

/** How `createChannel` gets the channel's directory. */
export type ChannelLocation =
  /** Makes a new folder: `folderName` (`null`: made from the channel name) inside `parent` (`null`: the personal folder). */
  | { kind: "new"; parent: string | null; folderName: string | null }
  /** Uses an existing directory inside a storage folder. */
  | { kind: "link"; dir: string };

/** The input of `createChannel`. */
export interface ChannelCreate {
  name: string;
  videoType: ChannelVideoType;
  location: ChannelLocation;
}

/** The input of `updateChannel`: a `null` field is left as it is; a profile replaces the old one whole. */
export interface ChannelUpdate {
  name: string | null;
  videoType: ChannelVideoType | null;
  long: ChannelProfile | null;
  short: ChannelProfile | null;
}

/** What `getWorkspace` answers: everything the sidebar and the settings screens start from. */
export interface Workspace {
  /** The user's channels in their own order. */
  channels: Channel[];
  settings: PublicSettings;
  /**
   * What new edits need on this computer. Always `null` for now: the agents module (SPEC section 7)
   * fills it with its readiness answer and this type then changes to that answer's type.
   */
  readiness: null;
}

/** The settings file of `exportChannels` and `importChannels`: prompts and styles, never directories. */
export interface ChannelsDocument {
  format: "vidai-channels";
  version: 1;
  /** ISO 8601 UTC. */
  exportedAt: string;
  channels: ChannelsDocumentEntry[];
}

export interface ChannelsDocumentEntry {
  name: string;
  videoType: ChannelVideoType;
  long: ChannelProfile;
  short: ChannelProfile;
}

/** What `importChannels` did. */
export interface ImportResult {
  /** Channels of the same name that got the imported video type, prompts and styles. */
  updated: number;
  /** New channels, each with a new folder in the personal folder. */
  created: number;
}

/** What `createVideo` answers: the new video folder. */
export interface VideoRef {
  /** `<channel id>/<folder name>`. */
  id: string;
  channelId: string;
  folderName: string;
}

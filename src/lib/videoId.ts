/**
 * A video's id is `<channelId>/<folder name>` (SPEC section 6). It contains a slash and the folder
 * name is free text, so never split, join or put it into a URL by hand: use these helpers.
 * A channel id is a hex string and never contains a slash, so the first slash is the separator.
 */

export interface VideoIdParts {
  channelId: string;
  folderName: string;
}

/** The id of the video folder `folderName` in the channel `channelId`. */
export function makeVideoId(channelId: string, folderName: string): string {
  return `${channelId}/${folderName}`;
}

/** The channel and folder of a video id, or `null` when it is not a video id. */
export function splitVideoId(videoId: string): VideoIdParts | null {
  const slash = videoId.indexOf("/");
  if (slash <= 0 || slash === videoId.length - 1) return null;
  return { channelId: videoId.slice(0, slash), folderName: videoId.slice(slash + 1) };
}

/** The folder name of a video id (the whole text when it is not a video id). */
export function folderNameOf(videoId: string): string {
  return splitVideoId(videoId)?.folderName ?? videoId;
}

/** The channel id of a video id, `null` when it is not a video id. */
export function channelIdOf(videoId: string): string | null {
  return splitVideoId(videoId)?.channelId ?? null;
}

/** One URL path segment or query value for a video id (the slash becomes `%2F`). */
export function encodeVideoId(videoId: string): string {
  return encodeURIComponent(videoId);
}

/** The video id of an encoded URL segment, `null` when it is not valid or not a video id. */
export function decodeVideoId(encoded: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  return splitVideoId(decoded) === null ? null : decoded;
}

/**
 * How a video is named for people (the same form the server writes into the edit log): the
 * channel name and the folder name, or just the folder name without a channel name.
 */
export function videoLabel(videoId: string, channelName?: string | null): string {
  const folder = folderNameOf(videoId);
  return channelName ? `${channelName} / ${folder}` : folder;
}

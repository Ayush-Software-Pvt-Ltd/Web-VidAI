/**
 * The name of the folder a new channel gets when the person gives none: the channel name with the
 * characters no folder can have turned into dashes, as the server makes it (`folderNameFor` in
 * `server/src/channels.js`). Only used to show the path that will be made; the server names the
 * folder itself.
 */
import { joinPath } from "@/lib/paths";

/** The longest folder name the server makes, in characters and in bytes. */
const MAX_FOLDER_CHARS = 120;
const MAX_FOLDER_BYTES = 200;

export function folderNameFor(name: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is replaced
  let text = name.replace(/[\u0000-\u001f\u007f-\u009f/\\‪-‮⁦-⁩]/g, "-");
  text = text
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim();
  text = Array.from(text).slice(0, MAX_FOLDER_CHARS).join("");
  if (text === "" || new TextEncoder().encode(text).length > MAX_FOLDER_BYTES) return "Channel";
  return text;
}

/** The path a new folder of a channel gets inside `parent`. */
export function newChannelPath(parent: string, channelName: string): string {
  return joinPath(parent, folderNameFor(channelName));
}

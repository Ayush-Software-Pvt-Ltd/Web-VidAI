/** The channels file of Import and Export (SPEC section 14): its name, its checks, its summary. */
import { ApiError } from "@/lib/errors";
import { pluralize } from "@/lib/format";
import type { ChannelsDocument, ImportResult } from "@/lib/types";
import { localDateStamp, readFileText } from "./download";

/** The server takes at most 1 MB per call; a file this large is refused here with a clear sentence. */
export const MAX_IMPORT_BYTES = 1_000_000;

/** `vidai-channels-2026-11-22.json` */
export function exportFileName(date: Date): string {
  return `vidai-channels-${localDateStamp(date)}.json`;
}

/**
 * What an import did, as sentences: how many channels were updated, then the names in the file
 * that are not among the user's channels ("Not in your channels: A, B."; only an admin makes
 * channels, so an import never does).
 */
export function describeImport({ updated, skipped }: ImportResult): string {
  const sentences: string[] = [];
  if (updated > 0) sentences.push(`${pluralize(updated, "channel")} updated.`);
  else if (skipped.length === 0) sentences.push("The file had no channels, so nothing changed.");
  else sentences.push("No channel was updated.");
  if (skipped.length > 0) sentences.push(`Not in your channels: ${skipped.join(", ")}.`);
  return sentences.join(" ");
}

/** Reads the chosen file into a channels document for `importChannels` (the server checks the rest). */
export async function readDocument(file: File): Promise<ChannelsDocument> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ApiError("tooLarge", "This file is too large to be a channels file.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFileText(file));
  } catch {
    throw new ApiError("invalidInput", "This file is not a VidAI channels file.");
  }
  // The server decides whether it is a valid document; here it only has to be a JSON object.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError("invalidInput", "This file is not a VidAI channels file.");
  }
  return parsed as ChannelsDocument;
}

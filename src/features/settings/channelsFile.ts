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

/** What an import did, as a sentence. */
export function describeImport({ created, updated }: ImportResult): string {
  if (created === 0 && updated === 0) return "The file had no channels, so nothing changed.";
  const parts: string[] = [];
  if (created > 0) parts.push(`${pluralize(created, "channel")} added`);
  if (updated > 0) parts.push(`${pluralize(updated, "channel")} updated`);
  const text = parts.join(" and ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
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

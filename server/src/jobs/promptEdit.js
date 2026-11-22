// The first message of an `edit` (docs/SPEC.md section 8, "Prompt"; the parts and their order are
// those of docs/SPEC-desktop.md section 6, "Prompt composition"): the header, the product links
// and their step, the notes of this video, the channel's prompt and style of the video type and
// slot, the VidAI paragraph about the project, the OpenCode 2 block, the keep-working paragraph
// and the progress markers.

import { invalidInput } from "../errors.js";
import { markerInstructions } from "./progressMarkers.js";
import {
  COMPLETE_EDIT,
  PRODUCT_LINKS_STEP,
  STYLE_EMPTY,
  STYLE_GIVEN,
  VIDAI_INTRO,
  projectSentences,
  toolkitSentences,
} from "./promptTexts.js";
import {
  headerBlock,
  hfCommandLine,
  parentOf,
  programBlocks,
  separatorOf,
  styleLabel,
  trimBlock,
  typeWord,
} from "./promptHeader.js";

/** @typedef {import("./promptHeader.js").PromptContext} PromptContext */
/** @typedef {import("../../../src/lib/wire/channels.ts").ChannelProfile} ChannelProfile */

/** How many prompt slots and style slots a channel profile has. */
const SLOT_COUNT = 5;

/**
 * Everything the first message of an edit is made of.
 * @typedef {object} EditExtras
 * @property {string} productLinks As entered, one link per line (blank lines are dropped).
 * @property {string} notes The notes of this video.
 * @property {ChannelProfile} profile The channel's prompts and styles for the video's type.
 * @property {number} promptSlot Index 0 to 4 of the selected prompt.
 * @property {number} styleSlot Index 0 to 4 of the selected style.
 */

/** @typedef {PromptContext & EditExtras} EditInput */

/**
 * The selected prompt and style, refusing a slot outside 0 to 4 and an empty prompt with
 * `invalidInput`. The prompt text is user data and is returned as written.
 * @param {ChannelProfile} profile
 * @param {number} promptSlot
 * @param {number} styleSlot
 * @param {import("./promptHeader.js").PromptContext["videoType"]} videoType
 * @returns {{ prompt: string, style: string }}
 */
export function selectSlots(profile, promptSlot, styleSlot, videoType) {
  for (const [label, slot] of /** @type {const} */ ([
    ["prompt", promptSlot],
    ["style", styleSlot],
  ])) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
      throw invalidInput(
        `The ${label} slot ${String(slot)} does not exist. A channel has five ${label} slots, numbered 1 to 5.`,
      );
    }
  }
  const prompt = profile.prompts[promptSlot];
  if (prompt === undefined || prompt.text.trim() === "") {
    const name = prompt === undefined ? `slot ${promptSlot + 1}` : `"${prompt.name}"`;
    throw invalidInput(
      `The prompt ${name} for ${typeWord(videoType)} videos of this channel is empty. Write it in the channel's settings or choose another prompt.`,
    );
  }
  return { prompt: prompt.text, style: profile.styles[styleSlot]?.text ?? "" };
}

/**
 * The VidAI paragraph (docs/SPEC.md section 8, "Prompt"): no terminal, the toolkit, the style rule,
 * the project of section 10 and the completion marker.
 * @param {PromptContext} ctx
 * @param {boolean} hasStyle
 * @returns {string}
 */
export function vidaiParagraph(ctx, hasStyle) {
  const hf = hfCommandLine(ctx);
  const sep = separatorOf(ctx.toolkitFolder);
  return [
    "VidAI:",
    VIDAI_INTRO,
    toolkitSentences({
      example: hf,
      home: parentOf(ctx.toolkitFolder),
      sep,
    }),
    hasStyle ? STYLE_GIVEN : STYLE_EMPTY,
    projectSentences({ hfCommand: hf }),
    COMPLETE_EDIT,
  ].join("\n");
}

/**
 * The message of a new `edit` session.
 * @param {EditInput} input
 * @returns {string}
 * @throws {import("../errors.js").AppError} `invalidInput` for an empty selected prompt or a slot
 *   outside 0 to 4.
 */
export function composeEdit(input) {
  const { prompt, style } = selectSlots(
    input.profile,
    input.promptSlot,
    input.styleSlot,
    input.videoType,
  );
  /** @type {string[]} */
  const parts = [headerBlock(input)];
  const links = input.productLinks
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (links.length === 0) {
    parts.push("PRODUCT_LINKS =");
  } else {
    parts.push(`PRODUCT_LINKS =\n${links.join("\n")}`);
    parts.push(PRODUCT_LINKS_STEP);
  }
  const notes = trimBlock(input.notes);
  if (notes.trim() !== "") parts.push(`NOTES FOR THIS VIDEO:\n${notes}`);
  parts.push(trimBlock(prompt));
  const styleText = trimBlock(style);
  const hasStyle = styleText.trim() !== "";
  parts.push(
    `CHANNEL_STYLE (${styleLabel(input.videoType)}):\n${hasStyle ? styleText : "(empty)"}`,
  );
  parts.push(vidaiParagraph(input, hasStyle));
  parts.push(...programBlocks(input.setup, input.harness));
  parts.push(markerInstructions("edit"));
  return parts.join("\n\n");
}

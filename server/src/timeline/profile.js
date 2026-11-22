// VidAI's project rules, "the profile" (docs/SPEC.md section 10), checked on `index.html`, `edit.json`
// and the `compositions/` files. The check never executes project code and never follows a path
// outside the project folder when reading.
//
// ---------------------------------------------------------------------------------------------
// `edit.json` (written by the toolkit, read here for facts the HTML cannot hold):
//
//   {
//     "toolkitVersion": "1.0.0",              // non-empty text
//     "fps": "30000/1001",                    // the project frame rate: 30, "29.97", "30000/1001"
//     "width": 1920, "height": 1080,          // pixels
//     "sources": [                            // every file a video or audio clip plays
//       { "name": "aroll-1.mp4",              // the name the timeline shows (the link name)
//         "path": "assets/media/aroll-1.mp4", // exactly the clips' `src`; unique
//         "originalPath": "/data/x/aroll-1.mp4",  // or null for a file made for this edit
//         "frames": 5400,                     // length in frames at the file's own rate
//         "fps": "30" }                       // the file's own frame rate (may differ from the project's)
//     ],
//     "graphics": [                           // the motion graphics (a host's id is its composition id)
//       { "id": "g-1", "template": "lower-third", "variables": { "text": "Hi" }, "label": "Lower third" }
//     ]
//   }
//
// `validateEditJson(value)` returns `{ facts, errors }`; `facts` is null when `errors` is not empty.
// ---------------------------------------------------------------------------------------------
//
// Decisions the SPEC text leaves open:
// - Rule 4, z-index: only the `style` attribute can be read here. A clip that shows something (video,
//   picture or motion graphic) must have `z-index:<its track>` in its `style` attribute; audio clips
//   have nothing to layer and are exempt; a z-index set only in a stylesheet cannot be seen, so it
//   counts as missing.
// - Rule 9, scripts: besides VidAI's root script, `<script src="shared/...">` with no inline code is
//   allowed, because the GSAP library has to be loaded from the channel's design kit (`shared/`); any
//   other script, and inline event handler attributes (`onclick` ...), are violations.
// - Rule 7, a media clip with no entry in `edit.json` sources has an unknown length and is a
//   violation; `<img>` clips have no length. A `data-playback-rate` other than 1 is read (the clip's
//   out-point is in-point + duration x rate); without the attribute the rate is 1.
// - Rule 11 (the agent never renders a video file of the edit) cannot be checked from the project's
//   text: it is enforced by the job runner, which looks for new video files in the video folder.
// - Rule 5 also says no clip of any track ends after the root's `data-duration`; the sentence names
//   the clip. A-roll clips are exempt from that sentence (the root-equals-A-roll-end sentence covers
//   them). Hand edits never create such clips (the ripple code shortens them).

import fs from "node:fs/promises";
import { describeClip, nodeAttr, parseHtml, parseProject, walkElements } from "./document.js";
import { collectReferences, pathProblem } from "./profilePaths.js";
import { validateEditJson } from "./profileEditJson.js";
import { compositionFileProblem } from "./profileComposition.js";
import { arollSources, innerOfHost } from "./editInner.js";
import { motionFrames, motionOfHost } from "./editMotion.js";
import { listHtmlFiles, readInside, referenceExists } from "./profileDisk.js";
import { hidesTheVideo } from "./profileOpaque.js";
import { isRootScript } from "./rootScript.js";
import {
  MAX_DECIMALS,
  fpsToString,
  framesToSeconds,
  framesToSecondsText,
  sameFps,
  sourceLengthFrames,
} from "./frames.js";

export { validateEditJson } from "./profileEditJson.js";

/** @typedef {import("../../../src/lib/wire/timeline.ts").ProjectViolation} ProjectViolation */
/** @typedef {import("./document.js").ParsedProject} ParsedProject */
/** @typedef {import("./document.js").ParsedClip} ParsedClip */
/** @typedef {import("./profileEditJson.js").EditFacts} EditFacts */
/** @typedef {import("./profileEditJson.js").SourceFact} SourceFact */
/** @typedef {import("./frames.js").Fps} Fps */

/** The kinds of clips (rule 3). */
export const KINDS = ["aroll", "broll", "graphic", "overlay", "hit", "fade", "sfx", "music"];

/** Slack, in frames, when comparing a media out-point with the source length. */
export const MEDIA_TOLERANCE = 0.01;

/** First track of the sound clips (rule 4). */
export const FIRST_SOUND_TRACK = 10;

/**
 * @param {string} kind
 * @param {number} track
 * @returns {boolean} Whether the track table (rule 4) allows the kind on that track.
 */
export function trackFitsKind(kind, track) {
  switch (kind) {
    case "aroll":
      return track === 0;
    case "broll":
    case "graphic":
      return track === 1;
    case "overlay":
      return track === 2;
    case "hit":
      return track === 3;
    case "fade":
      return track === 4;
    case "sfx":
    case "music":
      return track >= FIRST_SOUND_TRACK;
    default:
      return false;
  }
}

/** @param {string} text @returns {number} How many digits follow the decimal point. */
const decimalCount = (text) => text.trim().match(/\.(\d*)/)?.[1]?.length ?? 0;

/** @param {string} noun @returns {string} "a" or "an" in front of the noun. */
const article = (noun) => (/^[aeiou]/i.test(noun) ? "an" : "a");

/** @param {string} text @returns {string} The text with a capital first letter. */
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** @param {string} kind @returns {string} The words for a kind in sentences and revision labels. */
export function kindNoun(kind) {
  const nouns = {
    aroll: "A-roll",
    broll: "B-roll",
    graphic: "graphic",
    overlay: "overlay",
    hit: "hit",
    fade: "fade",
    sfx: "sound effect",
    music: "music",
  };
  return Object.hasOwn(nouns, kind) ? nouns[/** @type {keyof typeof nouns} */ (kind)] : "clip";
}

export { sourceLengthFrames };

/**
 * Declarations of a `style` attribute as a map of lower-case property to value (the last one wins).
 * @param {string} style
 * @returns {Map<string, string>}
 */
export function styleDeclarations(style) {
  const map = new Map();
  let depth = 0;
  let quote = "";
  let start = 0;
  const flush = (/** @type {number} */ end) => {
    const part = style.slice(start, end);
    const colon = part.indexOf(":");
    if (colon > 0)
      map.set(
        part.slice(0, colon).trim().toLowerCase(),
        part
          .slice(colon + 1)
          .replace(/!important\s*$/i, "")
          .trim(),
      );
  };
  for (let i = 0; i < style.length; i++) {
    const c = style[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  flush(style.length);
  return map;
}

/** @param {number} frames @param {Fps} fps */
function secs(frames, fps) {
  return `${Number(framesToSeconds(frames, fps).toFixed(3))} seconds`;
}

const HOST_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Checks `index.html` against rules 1 to 10 and 12 (rule 11 cannot be checked here). Pure: it reads nothing
 * from disk, so a motion graphic's file is checked by `checkProject`.
 * @param {ParsedProject} parsed
 * @param {EditFacts | null} facts What `edit.json` says; null skips the checks that need it.
 * @returns {ProjectViolation[]} In order of rule, then of position in the file.
 */
export function checkDocument(parsed, facts) {
  /** @type {ProjectViolation[][]} */
  const byRule = Array.from({ length: 13 }, () => []);
  /** @param {number} rule @param {string | null} elementId @param {string} message */
  const add = (rule, elementId, message) => void byRule[rule]?.push({ rule, elementId, message });

  for (const p of parsed.problems) add(p.rule, p.elementId, p.message);
  const root = parsed.root;
  const fps = root?.fps ?? null;

  // ---- Rule 1: the root
  if (!root) {
    add(
      1,
      null,
      'index.html has no root element: it must contain <div id="root" data-composition-id="main" data-start="0" data-width data-height data-fps data-duration>.',
    );
  } else {
    if (root.element.tag !== "div")
      add(1, "root", `The root element is a <${root.element.tag}>; it must be a <div>.`);
    if (root.compositionId !== "main")
      add(1, "root", 'The root element needs data-composition-id="main".');
    if (root.startText === null || !/^\s*0+(\.0*)?\s*$/.test(root.startText))
      add(1, "root", 'The root element needs data-start="0".');
    const long = root.width === 1920 && root.height === 1080;
    const short = root.width === 1080 && root.height === 1920;
    if (!long && !short)
      add(
        1,
        "root",
        "The root element's data-width and data-height must be 1920 by 1080 (Long) or 1080 by 1920 (Short).",
      );
    if (!fps)
      add(
        1,
        "root",
        'The root element needs data-fps, the frame rate, such as "30" or "30000/1001".',
      );
    if (!root.durationAttr.present) add(1, "root", "The root element has no data-duration.");
    else if (!root.durationAttr.numeric)
      add(1, "root", "The root element's data-duration is not a number of seconds.");
    else if (fps && !root.durationAttr.onFrame)
      add(
        1,
        "root",
        `The root element's data-duration (${root.durationAttr.text} seconds) does not fall on a frame boundary at ${fpsToString(fps)} fps.`,
      );
    if (facts) {
      if (fps && !sameFps(fps, facts.fps))
        add(
          1,
          "root",
          `The root element says ${fpsToString(fps)} fps but edit.json says ${fpsToString(facts.fps)}.`,
        );
      if (
        root.width !== null &&
        root.height !== null &&
        (root.width !== facts.width || root.height !== facts.height)
      ) {
        add(
          1,
          "root",
          `The root element is ${root.width} by ${root.height} but edit.json says ${facts.width} by ${facts.height}.`,
        );
      }
    }
  }

  const named = (/** @type {ParsedClip} */ c) => describeClip(c);

  // ---- Rules 2 and 3: element types and the attributes every clip has
  for (const clip of parsed.clips) {
    const who = named(clip);
    const media = clip.tag === "video" || clip.tag === "audio" || clip.tag === "img";
    if (!media && !clip.isHost) {
      add(
        2,
        clip.id,
        `${who} is a <${clip.tag}>; a clip must be a <video>, <audio>, <img> or a motion graphic host (a <div> with data-composition-src).`,
      );
    } else if (media && clip.isHost) {
      add(
        2,
        clip.id,
        `${who} is a <${clip.tag}> that also has data-composition-src; a clip is either media or a motion graphic host.`,
      );
    } else if (media && (clip.src === null || clip.src.trim() === "")) {
      add(2, clip.id, `${who} has no src.`);
    } else if (clip.isHost && clip.tag !== "div") {
      add(2, clip.id, `${who} is a <${clip.tag}>; a motion graphic host must be a <div>.`);
    }

    if (clip.id === null) add(3, null, `${who} has no id; every clip needs a unique id.`);
    else if (/\s/.test(clip.id))
      add(3, clip.id, `${who} has an id with a space in it; ids cannot contain spaces.`);
    else if ((parsed.idCounts.get(clip.id) ?? 0) > 1)
      add(
        3,
        clip.id,
        `${who} shares its id with another element in index.html; every clip needs an id of its own.`,
      );
    if (!clip.hasClipClass) add(3, clip.id, `${who} does not have class="clip".`);

    for (const [attr, name] of /** @type {const} */ ([
      [clip.startAttr, "data-start"],
      [clip.durationAttr, "data-duration"],
    ])) {
      if (!attr.present) add(3, clip.id, `${who} has no ${name}.`);
      else if (!attr.numeric) {
        const reference =
          name === "data-start" &&
          /^\s*[A-Za-z_][\w-]*(\s*[+-]\s*\d+(\.\d+)?)?\s*$/.test(attr.text ?? "");
        if (reference)
          add(
            9,
            clip.id,
            `${who} has data-start="${attr.text}", which refers to another clip; every data-start must be a plain number of seconds.`,
          );
        else
          add(3, clip.id, `${who} has ${name}="${attr.text}", which is not a number of seconds.`);
      } else if (decimalCount(attr.text ?? "") > MAX_DECIMALS) {
        add(
          3,
          clip.id,
          `${who} has ${name}="${attr.text}", which has more than ${MAX_DECIMALS} decimals; write seconds with at most ${MAX_DECIMALS}.`,
        );
      } else if (fps && !attr.onFrame && attr.frames !== null) {
        add(
          3,
          clip.id,
          `${who} has ${name}="${attr.text}", which does not fall on a frame boundary at ${fpsToString(fps)} fps; the nearest is ${framesToSecondsText(attr.frames, fps)}.`,
        );
      }
    }
    if (clip.durationAttr.numeric && clip.duration === 0)
      add(3, clip.id, `${who} has a data-duration of 0; a clip must have some length.`);
    if (clip.mediaStartAttr.present && !clip.mediaStartAttr.numeric)
      add(
        3,
        clip.id,
        `${who} has data-media-start="${clip.mediaStartAttr.text}", which is not a number of seconds.`,
      );
    if (clip.trackText === null) add(3, clip.id, `${who} has no data-track-index.`);
    else if (clip.track === null)
      add(
        3,
        clip.id,
        `${who} has data-track-index="${clip.trackText}", which is not a whole number.`,
      );
    if (clip.kind === null) add(3, clip.id, `${who} has no data-vidai-kind.`);
    else if (!KINDS.includes(clip.kind))
      add(
        3,
        clip.id,
        `${who} has data-vidai-kind="${clip.kind}", which is not one of ${KINDS.join(", ")}.`,
      );
    if (clip.label === null || clip.label.trim() === "")
      add(3, clip.id, `${who} has no data-vidai-label, the text the timeline shows.`);

    // ---- Rule 4: the track table and z-index
    if (
      clip.kind !== null &&
      KINDS.includes(clip.kind) &&
      clip.track !== null &&
      !trackFitsKind(clip.kind, clip.track)
    ) {
      add(
        4,
        clip.id,
        `${who} is ${article(kindNoun(clip.kind))} ${kindNoun(clip.kind)} clip on track ${clip.track}, but ${kindNoun(clip.kind)} clips belong on ${trackTableEntry(clip.kind)}.`,
      );
    }
    if (clip.track !== null && clip.tag !== "audio") {
      const z = clip.style === null ? undefined : styleDeclarations(clip.style).get("z-index");
      if (z === undefined)
        add(
          4,
          clip.id,
          `${who} has no z-index in its style attribute; it must be z-index:${clip.track}, the number of its track.`,
        );
      else if (z !== String(clip.track))
        add(
          4,
          clip.id,
          `${who} has z-index:${z} but sits on track ${clip.track}; its z-index must equal its track.`,
        );
    }

    // ---- Rule 8, the host's names
    if (clip.isHost) {
      const id = clip.id ?? "";
      if (clip.id !== null && !HOST_ID.test(id))
        add(
          8,
          clip.id,
          `${who} has an id that is not a safe file name; a motion graphic id may only use letters, digits, "-" and "_".`,
        );
      if (clip.compositionId !== clip.id)
        add(
          8,
          clip.id,
          `${who} has data-composition-id="${clip.compositionId ?? ""}" but its id is "${id}"; they must be equal.`,
        );
      if (clip.id !== null && clip.compositionSrc !== `compositions/${id}.html`) {
        add(
          8,
          clip.id,
          `${who} has data-composition-src="${clip.compositionSrc ?? ""}"; it must be compositions/${id}.html.`,
        );
      }
    }
  }

  // ---- Rule 5: the A-roll
  if (root && fps) {
    const aroll = parsed.clips
      .filter((c) => c.kind === "aroll" && c.start !== null && c.duration !== null)
      .sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.index - b.index);
    if (aroll.length === 0) {
      add(
        5,
        null,
        "The project has no A-roll clip; the A-roll track (track 0) is the spine of the video.",
      );
    } else {
      let expected = 0;
      for (const clip of aroll) {
        const start = clip.start ?? 0;
        if (clip === aroll[0] && start !== 0) {
          add(
            5,
            clip.id,
            `${capital(named(clip))} is the first A-roll clip and starts at frame ${start}; the A-roll must start at frame 0.`,
          );
        } else if (start > expected)
          add(
            5,
            clip.id,
            `${named(clip)} starts at frame ${start} but the A-roll before it ends at frame ${expected}; there is a gap of ${start - expected} frames.`,
          );
        else if (start < expected)
          add(
            5,
            clip.id,
            `${named(clip)} starts at frame ${start} but the A-roll before it ends at frame ${expected}; they overlap by ${expected - start} frames.`,
          );
        expected = start + (clip.duration ?? 0);
      }
      if (root.duration !== null && root.duration !== expected) {
        add(
          5,
          "root",
          `The root element's data-duration is ${root.durationAttr.text} seconds (frame ${root.duration}) but the A-roll ends at frame ${expected} (${secs(expected, fps)}); they must be equal.`,
        );
      }
    }
    // No clip of any track ends after the end of the video. A-roll clips are left out: their end
    // against the root's duration is the equality above.
    if (root.duration !== null) {
      for (const clip of parsed.clips) {
        if (clip.kind === "aroll" || clip.start === null || clip.duration === null) continue;
        const end = clip.start + clip.duration;
        if (end > root.duration) {
          add(
            5,
            clip.id,
            `${capital(named(clip))} ends at frame ${end} (${secs(end, fps)}), after the end of the video at frame ${root.duration} (${secs(root.duration, fps)}); no clip may run past the end of the video.`,
          );
        }
      }
    }
  }

  // ---- Rule 6: no overlaps on a track (A-roll against A-roll is rule 5)
  if (fps) {
    /** @type {Map<number, ParsedClip[]>} */
    const tracks = new Map();
    for (const clip of parsed.clips) {
      if (clip.track === null || clip.start === null || clip.duration === null) continue;
      const list = tracks.get(clip.track) ?? [];
      list.push(clip);
      tracks.set(clip.track, list);
    }
    for (const [track, list] of tracks) {
      list.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.index - b.index);
      let previous = list[0];
      for (const clip of list.slice(1)) {
        if (!previous) break;
        const previousEnd = (previous.start ?? 0) + (previous.duration ?? 0);
        if (
          (clip.start ?? 0) < previousEnd &&
          !(clip.kind === "aroll" && previous.kind === "aroll")
        ) {
          add(
            6,
            clip.id,
            `${named(clip)} starts at frame ${clip.start} on track ${track} while ${named(previous)} runs until frame ${previousEnd}; clips on one track must not overlap.`,
          );
        }
        if ((clip.start ?? 0) + (clip.duration ?? 0) >= previousEnd) previous = clip;
      }
    }
  }

  // ---- Rule 7: media inside its source
  if (fps && facts) {
    for (const clip of parsed.clips) {
      if (
        (clip.tag !== "video" && clip.tag !== "audio") ||
        clip.src === null ||
        clip.duration === null
      )
        continue;
      const who = named(clip);
      const source = facts.sourcesByPath.get(clip.src);
      if (!source) {
        add(
          7,
          clip.id,
          `${who} plays "${clip.src}", which edit.json does not list under sources, so its length is unknown.`,
        );
        continue;
      }
      if (clip.rate === null || clip.rate <= 0) {
        add(
          7,
          clip.id,
          `${who} has data-playback-rate="${clip.rateText}", which is not a positive number.`,
        );
        continue;
      }
      if (clip.mediaStart === null) continue;
      const length = sourceLengthFrames(source, fps);
      const out = clip.mediaStart + clip.duration * clip.rate;
      if (out > length + MEDIA_TOLERANCE) {
        add(
          7,
          clip.id,
          `${who} plays ${source.name} from ${secs(clip.mediaStart, fps)} to ${secs(out, fps)}, but the file is only ${secs(length, fps)} long.`,
        );
      }
    }
  }

  // ---- Rule 7 for a B-roll with motion: its video is in its composition file, so the same checks are
  // made on what that file says (the in-point and the speed) and on the host's length.
  if (fps && facts?.compositions) {
    for (const clip of parsed.clips) {
      if (!clip.isHost || clip.id === null || clip.duration === null) continue;
      const motion = motionOfHost(facts, clip.id);
      if (!motion) continue;
      const who = named(clip);
      const file = `compositions/${clip.id}.html`;
      const source = facts.sourcesByPath.get(motion.src);
      if (!source) {
        add(
          7,
          clip.id,
          `${who} plays "${motion.src}" in ${file}, which edit.json does not list under sources, so its length is unknown.`,
        );
        continue;
      }
      const length = sourceLengthFrames(source, fps);
      const { mediaStart, inner } = motionFrames(motion, fps);
      const out = mediaStart + clip.duration * motion.rate;
      if (out > length + MEDIA_TOLERANCE) {
        add(
          7,
          clip.id,
          `${who} plays ${source.name} from ${secs(mediaStart, fps)} to ${secs(out, fps)} (see ${file}), but the file is only ${secs(length, fps)} long.`,
        );
      } else if (inner + MEDIA_TOLERANCE < clip.duration) {
        add(
          7,
          clip.id,
          `${who} is ${secs(clip.duration, fps)} long, but the video in ${file} lasts only ${secs(inner, fps)}, so its picture would stop early.`,
        );
      }
    }
  }

  // ---- Rule 7 for the media inside any other host's file (a synced B-roll layout: screen and host
  // circle): the in-point plus the host's length stays inside the source (editInner.js says which count; a piece of a medium that follows the A-roll counts for the part it plays).
  if (fps && facts?.compositions) {
    const sources = arollSources(parsed.clips);
    for (const clip of parsed.clips) {
      if (!clip.isHost || clip.id === null || clip.duration === null) continue;
      if (motionOfHost(facts, clip.id)) continue;
      const inner = innerOfHost(facts, clip.id, sources);
      if (!inner) continue;
      const who = named(clip);
      const file = `compositions/${clip.id}.html`;
      for (const m of inner.media) {
        // A piece of a medium that follows the A-roll plays only part of the host.
        const used = m.sync ? Math.min(m.duration, clip.duration - m.start) : clip.duration;
        const out = m.mediaStart + used * m.rate;
        if (out > m.sourceLength + MEDIA_TOLERANCE) {
          const source = facts.sourcesByPath.get(m.src);
          add(
            7,
            clip.id,
            `${who} plays ${source?.name ?? m.src} from ${secs(m.mediaStart, fps)} to ${secs(out, fps)} (see ${file}), but the file is only ${secs(m.sourceLength, fps)} long.`,
          );
        }
      }
    }
  }

  // ---- Rule 9: scripts and references between clips
  let rootScripts = 0;
  for (const script of parsed.scripts) {
    const text = script.text.trim();
    if (script.src !== null) {
      const problem = pathProblem(script.src);
      if (problem === null && /^shared\/[^?#]+\.js$/.test(script.src.trim()) && text === "")
        continue;
      if (problem === null && text === "")
        add(
          9,
          null,
          `index.html loads the script "${script.src}"; only the scripts in shared/ may be loaded.`,
        );
      else if (text !== "")
        add(
          9,
          null,
          `index.html has a <script src="${script.src}"> that also holds code; index.html may hold no script but VidAI's root script.`,
        );
    } else if (isRootScript(script.text)) {
      rootScripts++;
    } else {
      add(
        9,
        null,
        "index.html holds a script other than VidAI's fixed root script; every animation belongs in a file under compositions/.",
      );
    }
  }
  if (rootScripts === 0)
    add(
      9,
      null,
      "index.html does not hold VidAI's fixed root script, which registers the timeline of the root.",
    );
  else if (rootScripts > 1)
    add(
      9,
      null,
      "index.html holds VidAI's root script more than once; it must appear exactly once.",
    );
  walkElements(parsed.tree.document, (node) => {
    for (const attr of node.attrs) {
      if (/^on[a-z]+$/.test(attr.name)) {
        const id = nodeAttr(node, "id");
        add(
          9,
          id,
          `${id ? `The <${node.tagName}> element "${id}"` : `A <${node.tagName}> element`} has the event handler ${attr.name}; index.html may hold no script.`,
        );
      }
    }
  });

  // ---- Rule 10: references
  for (const ref of collectReferences(parsed.tree)) {
    const problem = pathProblem(ref.value);
    if (problem === null) continue;
    const clip = ref.elementId ? parsed.clips.find((c) => c.id === ref.elementId) : undefined;
    const who = clip
      ? named(clip)
      : ref.elementId
        ? `The <${ref.tag}> element "${ref.elementId}"`
        : `A <${ref.tag}> element`;
    add(
      10,
      ref.elementId || null,
      `${who} refers to "${ref.value}" in its ${ref.where}, which ${problem}; every file reference must be a relative path inside the project.`,
    );
  }

  // ---- Rule 12: a full-screen graphic hides the video under it
  if (root?.width && root.height && facts?.compositions) {
    for (const clip of parsed.clips) {
      if (!clip.isHost || clip.id === null || clip.kind !== "graphic") continue;
      const text = facts.compositions.get(clip.id);
      if (text === undefined || hidesTheVideo(text, clip.id, root.width, root.height)) continue;
      add(
        12,
        clip.id,
        `The full-screen graphic "${clip.id}" has no opaque background over the whole frame, so the video shows through it; give its page a background color or image.`,
      );
    }
  }

  // Rule 11 (the agent never renders a video file of the edit) is not a property of the project's
  // text; the job runner enforces it.
  // Two elements sharing an id would otherwise produce the same sentence twice.
  const seen = new Set();
  return byRule.flat().filter((v) => {
    const key = `${v.rule}\0${v.elementId}\0${v.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** @param {string} kind */
function trackTableEntry(kind) {
  switch (kind) {
    case "aroll":
      return "track 0";
    case "broll":
    case "graphic":
      return "track 1";
    case "overlay":
      return "track 2";
    case "hit":
      return "track 3";
    case "fade":
      return "track 4";
    default:
      return `track ${FIRST_SOUND_TRACK} or higher`;
  }
}

/**
 * @typedef {Object} LoadedProject
 * @property {string | null} html `index.html`, or null when it could not be read.
 * @property {ParsedProject | null} parsed
 * @property {EditFacts | null} facts
 * @property {ProjectViolation[]} violations
 */

/**
 * Reads a project folder and checks it: `index.html`, `edit.json`, every host's composition file and
 * the references of all files under `compositions/`. Nothing outside the folder is read.
 * @param {string} projectDir
 * @returns {Promise<LoadedProject>}
 */
export async function loadProject(projectDir) {
  /** @type {ProjectViolation[]} */
  const violations = [];
  let projectReal;
  try {
    projectReal = await fs.realpath(projectDir);
  } catch {
    violations.push({ rule: 1, elementId: null, message: "The project folder does not exist." });
    return { html: null, parsed: null, facts: null, violations };
  }

  const index = await readInside(projectReal, "index.html");
  const edit = await readInside(projectReal, "edit.json");
  /** @type {EditFacts | null} */
  let facts = null;
  if ("problem" in edit) {
    violations.push({
      rule: 1,
      elementId: null,
      message: `edit.json ${edit.problem}, so the frame rate and the source lengths are unknown.`,
    });
  } else {
    let value;
    try {
      value = JSON.parse(edit.text);
    } catch {
      value = undefined;
      violations.push({ rule: 1, elementId: null, message: "edit.json is not valid JSON." });
    }
    if (value !== undefined) {
      const result = validateEditJson(value);
      facts = result.facts;
      for (const message of result.errors) violations.push({ rule: 1, elementId: null, message });
    }
  }
  if ("problem" in index) {
    violations.push({ rule: 1, elementId: null, message: `index.html ${index.problem}.` });
    return { html: null, parsed: null, facts, violations };
  }

  const parsed = parseProject(index.text);
  /** @type {Map<string, string>} */
  const compositions = new Map();
  if (facts) facts.compositions = compositions;
  // The composition files are read first: rule 7 of a B-roll with motion is checked on its file.
  const hostFiles = new Map();
  for (const clip of parsed.clips) {
    if (!clip.isHost || clip.id === null || !HOST_ID.test(clip.id)) continue;
    const read = await readInside(projectReal, `compositions/${clip.id}.html`);
    hostFiles.set(clip.id, read);
    if (!("problem" in read)) compositions.set(clip.id, read.text);
  }
  violations.push(...checkDocument(parsed, facts));

  for (const clip of parsed.clips) {
    if (!clip.isHost || clip.id === null || !HOST_ID.test(clip.id)) continue;
    const file = `compositions/${clip.id}.html`;
    const read = hostFiles.get(clip.id);
    if (!read) continue;
    if ("problem" in read) {
      violations.push({
        rule: 8,
        elementId: clip.id,
        message: `${describeClip(clip)} needs ${file}, which ${read.problem}.`,
      });
      continue;
    }
    const problem = compositionFileProblem(read.text, clip.id);
    if (problem)
      violations.push({
        rule: 8,
        elementId: clip.id,
        message: `${file}, the file of ${describeClip(clip)}, ${problem}.`,
      });
  }

  // Rule 10, files that are not there: index.html's references (a host's file is rule 8's) ...
  for (const ref of collectReferences(parsed.tree)) {
    if (ref.where === "data-composition-src" || !namesAFile(ref.value, false)) continue;
    if (await referenceExists(projectReal, ref.value)) continue;
    const clip = ref.elementId ? parsed.clips.find((c) => c.id === ref.elementId) : undefined;
    const who = clip
      ? describeClip(clip)
      : ref.elementId
        ? `The <${ref.tag}> element "${ref.elementId}"`
        : `A <${ref.tag}> element`;
    violations.push({
      rule: 10,
      elementId: ref.elementId || null,
      message: `${who} refers to "${ref.value}" in its ${ref.where}, which is not in the project; every file reference must name a file of the project.`,
    });
  }

  // ... and every composition file's references, wherever they lead.
  for (const file of await listHtmlFiles(projectReal, "compositions")) {
    const read = await readInside(projectReal, file);
    if ("problem" in read) continue;
    for (const ref of collectReferences(parseHtml(read.text))) {
      const who = ref.elementId
        ? `the <${ref.tag}> element "${ref.elementId}"`
        : `a <${ref.tag}> element`;
      const problem = pathProblem(ref.value, { allowData: true });
      if (problem === null) {
        if (!namesAFile(ref.value, true) || (await referenceExists(projectReal, ref.value)))
          continue;
        violations.push({
          rule: 10,
          elementId: null,
          message: `In ${file}, ${who} refers to "${ref.value}" in its ${ref.where}, which is not in the project; every file reference must name a file of the project.`,
        });
        continue;
      }
      violations.push({
        rule: 10,
        elementId: null,
        message: `In ${file}, ${who} refers to "${ref.value}" in its ${ref.where}, which ${problem}; every file reference must be a relative path inside the project.`,
      });
    }
  }
  violations.sort((a, b) => a.rule - b.rule);
  return { html: index.text, parsed, facts, violations };
}

/**
 * @param {string} value A reference that passed `pathProblem`.
 * @param {boolean} allowData Whether a `data:` URL is a value (composition files) and not a file.
 * @returns {boolean} Whether it names a file of the project (not a fragment or an inline value).
 */
function namesAFile(value, allowData) {
  const v = value.trim();
  return v !== "" && !v.startsWith("#") && !(allowData && /^data:/i.test(v));
}

/**
 * @param {string} projectDir
 * @returns {Promise<ProjectViolation[]>} Every way the project at `projectDir` breaks rules 1 to 12.
 */
export async function checkProject(projectDir) {
  return (await loadProject(projectDir)).violations;
}

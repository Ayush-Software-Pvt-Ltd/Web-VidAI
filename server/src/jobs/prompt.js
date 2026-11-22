// The messages VidAI sends to the editing agent (docs/SPEC.md section 8, "Prompt", and section
// 11, "Change requests"). The parts:
// `promptTexts.js` (every fixed text), `promptHeader.js` (header, machine and limits lines),
// `promptEdit.js` (the first message), `promptFollowUp.js` (Continue, Re-Edit, project fix) and
// `promptTimeline.js` (change requests).

export { composeEdit, selectSlots, vidaiParagraph } from "./promptEdit.js";
export { composeContinue, composeProfileFix, composeReEdit } from "./promptFollowUp.js";
export { composeTimelineEdit } from "./promptTimeline.js";
export { limitsLine, machineLine } from "./promptHeader.js";
export { COMPLETION_MARKER, PROFILE_FIX_ATTEMPTS } from "./promptTexts.js";

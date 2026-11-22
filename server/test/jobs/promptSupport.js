// Shared inputs of the prompt tests (not a test itself).

/** @typedef {import("../../src/jobs/promptEdit.js").EditInput} EditInput */
/** @typedef {import("../../src/jobs/promptTimeline.js").TimelineEditInput} TimelineEditInput */

/** @returns {import("../../../src/lib/wire/channels.ts").ChannelProfile} */
export function profile() {
  const slots = (/** @type {string} */ label, /** @type {string} */ first) =>
    Array.from({ length: 5 }, (_, i) => ({
      name: i === 0 ? "Default" : `${label} ${i + 1}`,
      text: i === 0 ? first : "",
    }));
  return {
    prompts: slots("Prompt", "\nEdit this video tightly.\n\nKeep jokes.\n"),
    styles: slots("Style", "Bold yellow captions."),
  };
}

/** The input of a Long video on the Claude subscription, on macOS. @returns {EditInput} */
export function editInput() {
  return {
    mainFolder: "/Users/e/Editing/Tech Reviews/2026-11-01 Unboxing",
    channelFolder: "/Users/e/Editing/Tech Reviews",
    channelName: "Tech Reviews",
    toolkitFolder: "/srv/vidai/toolkit/CLAUDE_VE_ALL",
    python: "/srv/vidai/toolkit/venv/bin/python",
    videoType: "long",
    brollFolder: "/Users/e/Editing/Tech Reviews/2026-11-01 Unboxing/B-Roll",
    projectFolder:
      "/Users/e/Editing/Tech Reviews/2026-11-01 Unboxing/output/2026-11-01 Unboxing.hf",
    checkCommand:
      'node /srv/vidai/server/src/timeline/checkCli.js "/Users/e/Editing/Tech Reviews/2026-11-01 Unboxing/output/2026-11-01 Unboxing.hf"',
    machine: {
      os: "macOS",
      osVersion: "15.4.1",
      cpu: "Apple M3 Max",
      logicalCores: 16,
      memoryGb: 48,
      gpu: "Apple M3 Max",
    },
    limits: { cpuCores: 6, gpuTasks: 2 },
    setup: "claudeSubscription",
    harness: "claudeCode",
    productLinks: "https://a.example/1\n\n  https://b.example/2  \n",
    notes: "Use the red mug shot.\n",
    profile: profile(),
    promptSlot: 0,
    styleSlot: 0,
  };
}

/** @returns {TimelineEditInput} */
export function timelineInput() {
  return {
    setup: "claudeSubscription",
    harness: "claudeCode",
    newSession: null,
    hasProject: true,
    fps: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    requests: [
      {
        frame: 374,
        shape: { cx: 0.23, cy: 0.31, rx: 0.06, ry: 0.1 },
        elementId: null,
        prompt: "Make the title smaller.\n",
        pictures: {
          frame: "/data/projects/k1/notes/n1/frame.jpg",
          closeup: "/data/projects/k1/notes/n1/area.jpg",
          marked: "/data/projects/k1/notes/n1/marked.jpg",
        },
        clips: [
          {
            id: "g12",
            kind: "graphic",
            label: "Title card",
            track: 2,
            file: "compositions/g12.html",
          },
          { id: "a3", kind: "aroll", label: "A-roll 3", track: 0, file: "assets/media/A001.mp4" },
        ],
        spoken: "so this is the box",
      },
      {
        frame: 3600,
        shape: null,
        elementId: "b7",
        prompt: "Use a calmer clip here.",
        pictures: { frame: "/data/projects/k1/notes/n2/frame.jpg", closeup: null, marked: null },
        clips: [
          { id: "b7", kind: "broll", label: "Desk shot", track: 1, file: "assets/media/B002.mp4" },
        ],
        spoken: null,
      },
    ],
  };
}

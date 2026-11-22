// Port of the describer, path and truncation tests of src-tauri/src/jobs/log.rs.

import assert from "node:assert/strict";
import test from "node:test";
import { parseValue } from "../../src/agents/claude/protocol.js";
import {
  MAX_LOG_DETAIL_CHARS,
  createDescriber,
  createPaths,
  noPaths,
  toolDetail,
  toolLine,
  truncateChars,
} from "../../src/jobs/log.js";
import { fixture } from "../support/claudeFixtures.js";

/** @typedef {import("../../src/jobs/log.js").Draft} Draft */
/** @typedef {import("../../src/jobs/log.js").MarkerRules} MarkerRules */

const EDITING = "/Users/name/Movies/Editing Folder";
const VIDEO = "/Users/name/Movies/Editing Folder/Glow Naturals/018 Hair Oil";
const paths = () => createPaths([VIDEO, EDITING], { windows: false });

/**
 * @param {unknown} value
 * @returns {import("../../src/agents/claude/protocol.js").StreamEvent}
 */
function event(value) {
  const parsed = parseValue(value);
  if (parsed === null) throw new Error("event did not parse");
  return parsed;
}

test("tool lines", () => {
  const none = noPaths();
  assert.equal(
    toolLine("Bash", { command: "ffmpeg -i a.mp4", description: "Render graphics at 1080" }, none),
    "Bash: Render graphics at 1080",
  );
  assert.equal(toolLine("Bash", { command: "ls -la\npwd" }, none), "Bash: ls -la");
  assert.equal(toolLine("Read", { file_path: "/x/info.txt" }, none), "Read: /x/info.txt");
  assert.equal(toolLine("TodoWrite", {}, none), "TodoWrite: Update the task list");
  assert.equal(toolLine("Mystery", { x: 1 }, none), "Mystery");
  assert.equal(toolLine("", {}, none), "Tool");
  assert.equal(toolDetail("Bash", { command: "ls" }), "ls");
  assert.equal(toolDetail("Read", { file_path: "a" }), '{\n  "file_path": "a"\n}');
});

test("windows paths are shortened in every form", () => {
  const p = createPaths(
    [String.raw`C:\Users\Ana\Editing Folder\Glow\018 Oil`, String.raw`C:\Users\Ana\Editing Folder`],
    { windows: true },
  );
  assert.equal(
    p.shorten(String.raw`python C:\Users\Ana\Editing Folder\Glow\018 Oil\CLAUDE_VE\t.py`),
    String.raw`python CLAUDE_VE\t.py`,
  );
  assert.equal(
    p.shorten("Read: c:/users/ana/editing folder/Glow/017 Serum/notes.md"),
    "Read: Glow/017 Serum/notes.md",
  );
  assert.equal(
    p.shorten("ls '/c/Users/Ana/Editing Folder/CLAUDE_VE_ALL/cut.py'"),
    "ls 'CLAUDE_VE_ALL/cut.py'",
  );
  assert.equal(
    p.shorten(String.raw`C:\Users\Ana\Editing Folder\Glow\018 Oil`),
    String.raw`Glow\018 Oil`,
  );
  // Only whole prefixes that start a path, and only when something follows.
  const sibling = String.raw`C:\Users\Ana\Editing Folder 2\x.mp4`;
  assert.equal(p.shorten(sibling), sibling);
  const nested = String.raw`D:\backup\C:\Users\Ana\Editing Folder\x.mp4`;
  assert.equal(p.shorten(nested), nested);
  const bare = String.raw`cd C:\Users\Ana\Editing Folder\ `;
  assert.equal(p.shorten(bare), bare);
  assert.equal(p.shorten("हिंदी C:/x"), "हिंदी C:/x");
  // Verbatim paths are understood; a drive root or a relative path is never a prefix.
  const verbatim = createPaths([String.raw`\\?\D:\Edit`, "relative"], { windows: true });
  assert.equal(verbatim.shorten(String.raw`D:\Edit\a.mp4`), "a.mp4");
  const root = createPaths(["C:\\", "relative"], { windows: true });
  assert.equal(root.shorten(String.raw`C:\a.txt`), String.raw`C:\a.txt`);
});

test("paths are shown relative to the video or the editing folder", () => {
  const p = paths();
  assert.equal(p.shorten(`${VIDEO}/CLAUDE_VE/timeline.py`), "CLAUDE_VE/timeline.py");
  assert.equal(
    p.shorten(`${EDITING}/Glow Naturals/017 Serum/CLAUDE_VE/notes.md`),
    "Glow Naturals/017 Serum/CLAUDE_VE/notes.md",
  );
  assert.equal(p.shorten(`${EDITING}/CLAUDE_VE_ALL/tools/cut.py`), "CLAUDE_VE_ALL/tools/cut.py");
  // The video folder itself, every occurrence, and quoted paths.
  assert.equal(p.shorten(VIDEO), "Glow Naturals/018 Hair Oil");
  assert.equal(
    p.shorten(`python3 '${EDITING}/CLAUDE_VE_ALL/timeline.py' --out "${VIDEO}/output"`),
    "python3 'CLAUDE_VE_ALL/timeline.py' --out \"output\"",
  );
  // A folder alone stays recognizable instead of vanishing.
  assert.equal(p.shorten(`ls ${VIDEO}/`), "ls Glow Naturals/018 Hair Oil/");
  assert.equal(p.shorten(`ls ${EDITING}/`), `ls ${EDITING}/`);
  // Only whole prefixes: other folders and paths that merely contain the prefix stay.
  const sibling = "/Users/name/Movies/Editing Folder 2/x.mp4";
  assert.equal(p.shorten(sibling), sibling);
  const nested = `/private${EDITING}/x.mp4`;
  assert.equal(p.shorten(nested), nested);
  assert.equal(p.shorten("/tmp/a.txt and relative/b.txt"), "/tmp/a.txt and relative/b.txt");
  // Without folders, nothing changes; the root is never treated as a folder.
  assert.equal(noPaths().shorten(VIDEO), VIDEO);
  assert.equal(createPaths(["/", "relative"], { windows: false }).shorten("/Users/a"), "/Users/a");
});

test("tool lines shorten paths and keep the original in detail", () => {
  const p = paths();
  const input = { file_path: `${VIDEO}/CLAUDE_VE/timeline.py` };
  assert.equal(toolLine("Read", input, p), "Read: CLAUDE_VE/timeline.py");
  assert.ok(toolDetail("Read", input).includes(VIDEO));
  assert.equal(
    toolLine("Bash", { command: `python3 ${EDITING}/CLAUDE_VE_ALL/thumbs.py` }, p),
    "Bash: python3 CLAUDE_VE_ALL/thumbs.py",
  );
  assert.equal(toolLine("Glob", { pattern: `${VIDEO}/Broll/**/*.mp4` }, p), "Glob: Broll/**/*.mp4");
  // A long path that fits once shortened is not cut.
  const deep = `${VIDEO}/${"sub/".repeat(30)}file.txt`;
  const line = toolLine("Write", { file_path: deep }, p);
  assert.ok(line.startsWith("Write: sub/sub/") && !line.includes("Editing"));

  const d = createDescriber({ paths: p });
  const out = d.describe(
    event({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Read", input }] },
    }),
  );
  assert.equal(out.entries[0]?.text, "Read: CLAUDE_VE/timeline.py");
  assert.equal(out.activity, "Read: CLAUDE_VE/timeline.py");
  const written = `Wrote ${VIDEO}/output/project_v1.json`;
  const result = d.describe(
    event({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: written }] },
    }),
  );
  assert.equal(result.entries[0]?.text, "Wrote output/project_v1.json");
  assert.equal(result.entries[0]?.detail, written);
});

test("truncation keeps the limit", () => {
  assert.equal(truncateChars("abc", 3), "abc");
  assert.equal(truncateChars("abcdef", 5), "ab...");
  const long = "\u0915".repeat(5000);
  assert.equal(Array.from(truncateChars(long, MAX_LOG_DETAIL_CHARS)).length, 4000);
  // Code points, never half of a surrogate pair.
  const emoji = "\u{1F600}".repeat(10);
  assert.equal(truncateChars(emoji, 5), `${"\u{1F600}".repeat(2)}...`);
});

/**
 * Runs a recording through a describer.
 * @param {string} name
 * @param {Parameters<typeof createDescriber>[0]} [options]
 * @returns {{ entries: Draft[], activity: string[] }}
 */
function describeFixture(name, options) {
  const d = createDescriber(options);
  /** @type {Draft[]} */
  const entries = [];
  /** @type {string[]} */
  const activity = [];
  for (const e of fixture(name)) {
    const out = d.describe(e);
    entries.push(...out.entries);
    if (out.activity !== null) activity.push(out.activity);
  }
  return { entries, activity };
}

test("a background recording reads well", () => {
  const { entries, activity } = describeFixture("01_background_task.jsonl");
  assert.deepEqual(
    entries.map((e) => [e.kind, e.text]),
    [
      ["status", "Claude Code is running (model claude-haiku-5-5)"],
      ["tool", "Bash: Sleep 10 seconds then echo slept"],
      ["status", "Background task started: Sleep 10 seconds then echo slept"],
      [
        "toolResult",
        "Command running in background with ID: byxi50wjd. Output is being written to: /private/tmp/claude-501/-Users-editor-Editing/5de5259b-60f1-4173-9520-d86db7b24...",
      ],
      [
        "assistant",
        "The background command (`sleep 10 && echo slept`) is running as task `byxi50wjd`. I'll wait for its completion notification before writing `out.txt`, without polling.",
      ],
      ["status", "Background task completed: Sleep 10 seconds then echo slept"],
      ["tool", "Bash: Write DONE to out.txt in the working directory and verify"],
      ["toolResult", "DONE"],
      ["assistant", "[OUTPUT COMPLETED]"],
    ],
  );
  assert.equal(entries[1]?.detail, "sleep 10 && echo slept");
  assert.ok(entries.every((e) => !e.nested));
  assert.equal(activity.at(-1), "[OUTPUT COMPLETED]");
});

test("the program in the first line comes from the harness", () => {
  const { entries } = describeFixture("01_background_task.jsonl", { harness: "opencode2" });
  assert.equal(entries[0]?.text, "OpenCode 2 is running (model claude-haiku-5-5)");
});

test("sub-agent output is nested and thinking is dropped", () => {
  const { entries, activity } = describeFixture("02_subagent_interrupt.jsonl");
  assert.ok(entries.some((e) => e.nested && e.kind === "tool"));
  assert.ok(entries.some((e) => e.nested && e.kind === "user"));
  assert.ok(entries.some((e) => e.text === "Sub-agent started: Run sleep, date, and ls"));
  assert.ok(entries.some((e) => e.text === "Sub-agent completed: Run sleep, date, and ls"));
  assert.ok(entries.some((e) => e.text === "[Request interrupted by user]" && !e.nested));
  // The interrupted turn's error result is not an error for the user.
  assert.ok(entries.every((e) => e.kind !== "error"));
  assert.ok(activity.includes("Running Sleep 5 seconds then print date"));
  const missing = describeFixture("04_resume_missing_session.jsonl").entries;
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.kind, "error");
  assert.ok(missing[0]?.text.includes("No conversation found"));
});

/** The marker rules of the progress module, as far as the describer needs them. @type {MarkerRules} */
const markers = {
  split(text) {
    /** @type {string[]} */
    const names = [];
    const kept = text.split("\n").filter((line) => {
      const found = /^`?\[VIDAI_PROGRESS ([a-z_]+)\]`?$/.exec(line.trim());
      if (found === null) return true;
      names.push(found[1] ?? "");
      return false;
    });
    return { text: kept.join("\n").trim(), markers: names };
  },
  logLine: (name) =>
    ({ transcribed: "Transcription done", planned: "Edit plan written" })[name] ??
    `Progress: ${name}`,
};

test("progress markers become compact status entries", () => {
  const d = createDescriber({ markers });
  /**
   * @param {string} text
   * @param {boolean} nested
   */
  const say = (text, nested) =>
    d.describe(
      event({
        type: "assistant",
        ...(nested ? { parent_tool_use_id: "agent1" } : {}),
        message: { content: [{ type: "text", text }] },
      }),
    );
  /** @param {import("../../src/jobs/log.js").Described} out */
  const texts = (out) => out.entries.map((e) => [e.kind, e.text]);

  let out = say("[VIDAI_PROGRESS transcribed]", false);
  assert.deepEqual(texts(out), [["status", "Transcription done"]]);
  assert.equal(out.activity, "Transcription done");

  out = say("The plan is written.\n\n`[VIDAI_PROGRESS planned]`\n[VIDAI_PROGRESS mystery]", false);
  assert.deepEqual(texts(out), [
    ["assistant", "The plan is written."],
    ["status", "Edit plan written"],
    ["status", "Progress: mystery"],
  ]);

  const prose = "I will write [VIDAI_PROGRESS planned] after the plan.";
  assert.deepEqual(texts(say(prose, false)), [["assistant", prose]]);

  // Sub-agents' markers do not count, so they are dropped.
  out = say("[VIDAI_PROGRESS graphics_built]", true);
  assert.ok(out.entries.length === 0 && out.activity === null);
  out = say("Built 6 cards.\n[VIDAI_PROGRESS graphics_built]", true);
  assert.deepEqual(texts(out), [["assistant", "Built 6 cards."]]);
});

test("without marker rules every text stays assistant text", () => {
  const d = createDescriber();
  const out = d.describe(
    event({
      type: "assistant",
      message: { content: [{ type: "text", text: "[VIDAI_PROGRESS planned]" }] },
    }),
  );
  assert.deepEqual(
    out.entries.map((e) => [e.kind, e.text]),
    [["assistant", "[VIDAI_PROGRESS planned]"]],
  );
});

test("a secret is scrubbed from every text the describer reads", () => {
  const key = "sk-secret-1234567890";
  const d = createDescriber({ scrub: (t) => t.replaceAll(key, "[api key]") });
  const out = d.describe(
    event({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: `using ${key}` },
          { type: "tool_use", id: "t", name: "Bash", input: { command: `curl -H ${key}` } },
        ],
      },
    }),
  );
  assert.equal(out.entries[0]?.text, "using [api key]");
  assert.equal(out.entries[1]?.text, "Bash: curl -H [api key]");
  // `detail` is the original input; the sink scrubs it before it is stored (see logSink.test.js).
  assert.equal(out.entries[1]?.detail, `curl -H ${key}`);
});

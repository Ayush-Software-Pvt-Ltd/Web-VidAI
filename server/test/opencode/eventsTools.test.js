import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  claudeTool,
  contentText,
  reportBody,
  snakeCase,
} from "../../src/agents/opencode/eventsTools.js";
import { sessionBody, QUESTION_CANCELLED } from "../../src/agents/opencode/events.js";

describe("tools take Claude Code's names and shapes", () => {
  test("shell is Bash with run_in_background", () => {
    assert.deepEqual(
      claudeTool("shell", { command: "ls", workdir: "/v", timeout: 600000, background: true }),
      {
        name: "Bash",
        input: { command: "ls", workdir: "/v", timeout: 600000, run_in_background: true },
      },
    );
  });

  test("subagent is Agent with subagent_type and session_id", () => {
    assert.deepEqual(
      claudeTool("subagent", {
        agent: "general",
        description: "d",
        prompt: "p",
        sessionID: "ses_x",
      }),
      {
        name: "Agent",
        input: { subagent_type: "general", description: "d", prompt: "p", session_id: "ses_x" },
      },
    );
  });

  test("read, write and edit use file_path", () => {
    assert.deepEqual(claudeTool("read", { path: "a" }), {
      name: "Read",
      input: { file_path: "a" },
    });
    assert.deepEqual(claudeTool("write", { path: "a", content: "c" }), {
      name: "Write",
      input: { file_path: "a", content: "c" },
    });
    assert.deepEqual(claudeTool("edit", { path: "a", oldString: "x", newString: "y" }), {
      name: "Edit",
      input: { file_path: "a", old_string: "x", new_string: "y" },
    });
  });

  test("the other known names", () => {
    const names = [
      ["bash", "Bash"],
      ["multiedit", "MultiEdit"],
      ["apply_patch", "Patch"],
      ["glob", "Glob"],
      ["grep", "Grep"],
      ["list", "LS"],
      ["webfetch", "WebFetch"],
      ["websearch", "WebSearch"],
      ["todowrite", "TodoWrite"],
      ["todoread", "TodoRead"],
      ["task", "Agent"],
    ];
    for (const [from, to] of names) assert.equal(claudeTool(from ?? "", {}).name, to);
  });

  test("skill, patch and unknown tools", () => {
    assert.deepEqual(claudeTool("skill", { id: "x" }), { name: "Skill", input: { skill: "x" } });
    assert.deepEqual(claudeTool("skill", { name: "y" }), { name: "Skill", input: { skill: "y" } });
    assert.deepEqual(claudeTool("patch", { patchText: "p" }), {
      name: "Patch",
      input: { patch_text: "p" },
    });
    assert.deepEqual(claudeTool("execute", null), { name: "execute", input: null });
    assert.deepEqual(claudeTool("mcp_thing", { someKey: 1 }), {
      name: "mcp_thing",
      input: { some_key: 1 },
    });
  });

  test("an input that is not an object is kept as it is", () => {
    assert.deepEqual(claudeTool("read", ["a"]), { name: "Read", input: ["a"] });
    assert.deepEqual(claudeTool("shell", "ls"), { name: "Bash", input: "ls" });
  });

  test("a key such as __proto__ stays a plain key", () => {
    const input = JSON.parse('{"__proto__": {"x": 1}, "path": "a"}');
    const shaped = /** @type {Record<string, unknown>} */ (claudeTool("read", input).input);
    assert.equal(Object.getPrototypeOf(shaped), Object.prototype);
    assert.deepEqual(Object.keys(shaped).sort(), ["__proto__", "file_path"]);
  });

  test("snake_case: capitals become _ plus lowercase, none in front", () => {
    assert.equal(snakeCase("filePath"), "file_path");
    assert.equal(snakeCase("sessionID"), "session_i_d");
    assert.equal(snakeCase("Already"), "already");
    assert.equal(snakeCase("plain"), "plain");
  });
});

describe("text helpers", () => {
  test("a report's body is between its tags", () => {
    assert.equal(reportBody('<shell id="s">\nout\n\n</shell>'), "out");
    assert.equal(reportBody('<subagent id="c">\n2\n\nPINEAPPLE\n</subagent>'), "2\n\nPINEAPPLE");
    assert.equal(reportBody("plain"), "plain");
    assert.equal(reportBody("  plain \n"), "plain");
    assert.equal(reportBody("<shell>\nno closing tag"), "<shell>\nno closing tag");
  });

  test("a tool's content is its texts and the addresses of its files", () => {
    assert.equal(
      contentText([
        { type: "text", text: "a" },
        { type: "file", uri: "file:///x" },
        { type: "image" },
      ]),
      "a\n\nfile:///x",
    );
    assert.equal(contentText(null), "");
    assert.equal(contentText("text"), "");
  });

  test("the body of a new session", () => {
    assert.deepEqual(sessionBody("T", { providerID: "p", id: "m" }, [], "/E"), {
      title: "T",
      model: { providerID: "p", id: "m" },
      permissions: [],
      location: { directory: "/E" },
    });
  });

  test("the question is cancelled with a message that tells the model to go on", () => {
    assert.match(QUESTION_CANCELLED, /nobody can answer questions/);
    assert.match(QUESTION_CANCELLED, /Continue without an answer/);
  });
});

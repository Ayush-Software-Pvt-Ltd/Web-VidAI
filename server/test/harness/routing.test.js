// Where the server's own Claude Code setup points ANTHROPIC_BASE_URL (ported from the tests of
// src-tauri/src/opencode/routing.rs).

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { detectRouting, routingFrom, settingsFile } from "../../src/agents/opencode/routing.js";

describe("routingFrom", () => {
  it("finds a base url in the environment or the settings file", () => {
    assert.equal(routingFrom({}, null), null);
    assert.equal(routingFrom({ ANTHROPIC_BASE_URL: "  " }, "{}"), null);
    assert.deepEqual(routingFrom({ ANTHROPIC_BASE_URL: "https://proxy.example" }, null), {
      baseUrl: "https://proxy.example",
      source: "environment",
    });
  });

  it("lets the settings file win, as Claude Code does", () => {
    const settings =
      '{"model":"opus","env":{"ANTHROPIC_BASE_URL":"https://opencode.ai/inference/anthropic"}}';
    assert.deepEqual(routingFrom({ ANTHROPIC_BASE_URL: "https://proxy.example" }, settings), {
      baseUrl: "https://opencode.ai/inference/anthropic",
      source: "claudeSettings",
    });
  });

  it("ignores a blank setting and a file that is not JSON", () => {
    assert.equal(routingFrom({}, "not json"), null);
    assert.equal(routingFrom({}, '{"env":{"ANTHROPIC_BASE_URL":" "}}'), null);
    assert.equal(routingFrom({}, '{"env":[]}'), null);
    assert.equal(routingFrom({}, "null"), null);
    assert.deepEqual(
      routingFrom({ ANTHROPIC_BASE_URL: "https://p" }, '{"env":{"ANTHROPIC_BASE_URL":" "}}'),
      {
        baseUrl: "https://p",
        source: "environment",
      },
    );
  });
});

describe("settingsFile", () => {
  it("follows CLAUDE_CONFIG_DIR, else the home folder", () => {
    assert.equal(
      settingsFile({ HOME: "/Users/me" }),
      path.join("/Users/me", ".claude", "settings.json"),
    );
    assert.equal(
      settingsFile({ USERPROFILE: "C:\\Users\\me" }),
      path.join("C:\\Users\\me", ".claude", "settings.json"),
    );
    assert.equal(
      settingsFile({ HOME: "/Users/me", CLAUDE_CONFIG_DIR: "/c" }),
      path.join("/c", "settings.json"),
    );
    assert.equal(settingsFile({}), null);
    assert.equal(
      settingsFile({ HOME: "/h", CLAUDE_CONFIG_DIR: "  " }),
      path.join("/h", ".claude", "settings.json"),
    );
  });
});

describe("detectRouting", () => {
  it("reads the settings file it finds and survives a missing one", async () => {
    /** @type {string[]} */
    const asked = [];
    const found = await detectRouting({
      env: { CLAUDE_CONFIG_DIR: "/c" },
      readText: async (file) => {
        asked.push(file);
        return '{"env":{"ANTHROPIC_BASE_URL":"https://gw.example"}}';
      },
    });
    assert.deepEqual(found, { baseUrl: "https://gw.example", source: "claudeSettings" });
    assert.deepEqual(asked, [path.join("/c", "settings.json")]);
    const missing = await detectRouting({
      env: { HOME: "/h", ANTHROPIC_BASE_URL: "https://env.example" },
      readText: async () => {
        throw new Error("ENOENT");
      },
    });
    assert.deepEqual(missing, { baseUrl: "https://env.example", source: "environment" });
  });
});

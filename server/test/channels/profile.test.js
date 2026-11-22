import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHANNEL_SLOTS,
  emptyProfile,
  profileWithDefaults,
  sanitizeProfile,
  validateProfile,
} from "../../src/channelProfile.js";

test("an empty profile has five default-named slots of each kind", () => {
  const profile = emptyProfile();
  assert.equal(profile.prompts.length, CHANNEL_SLOTS);
  assert.equal(profile.styles.length, CHANNEL_SLOTS);
  assert.deepEqual(profile.prompts[0], { name: "Default", text: "" });
  assert.deepEqual(profile.prompts[1], { name: "Prompt 2", text: "" });
  assert.deepEqual(profile.styles[4], { name: "Style 5", text: "" });
});

test("profileWithDefaults fills slot 0 only", () => {
  const profile = profileWithDefaults("the prompt", "the style");
  assert.equal(profile.prompts[0]?.text, "the prompt");
  assert.equal(profile.styles[0]?.text, "the style");
  assert.equal(profile.prompts[1]?.text, "");
});

test("sanitizeProfile never throws and always returns five slots", () => {
  for (const junk of [null, undefined, 5, "x", [], { prompts: "no" }, { prompts: [null, 3] }]) {
    const profile = sanitizeProfile(junk);
    assert.equal(profile.prompts.length, 5);
    assert.equal(profile.styles.length, 5);
    assert.equal(profile.prompts[0]?.name, "Default");
  }
});

test("sanitizeProfile fixes names, drops extras and keeps text", () => {
  const profile = sanitizeProfile({
    prompts: [
      { name: "Renamed zero", text: "zero" },
      { name: "  Trimmed  ", text: "one" },
      { name: "", text: "two" },
      { name: "x".repeat(60), text: "three" },
      { name: 7, text: 8 },
      { name: "sixth", text: "dropped" },
    ],
  });
  assert.deepEqual(profile.prompts[0], { name: "Default", text: "zero" });
  assert.deepEqual(profile.prompts[1], { name: "Trimmed", text: "one" });
  assert.deepEqual(profile.prompts[2], { name: "Prompt 3", text: "two" });
  assert.equal(profile.prompts[3]?.name.length, 40);
  assert.deepEqual(profile.prompts[4], { name: "Prompt 5", text: "" });
  assert.equal(profile.prompts.length, 5);
});

test("sanitizeProfile ignores single prompt and style texts outside the slots", () => {
  const profile = sanitizeProfile({ prompt: "loose prompt", style: "loose style" });
  assert.equal(profile.prompts[0]?.text, "");
  assert.equal(profile.styles[0]?.text, "");
});

/** @param {number} [count] */
const slots = (count = 5) =>
  Array.from({ length: count }, (_, index) => ({ name: `Slot ${index}`, text: `t${index}` }));

test("validateProfile accepts exactly five slots and renames slot 0", () => {
  const profile = validateProfile({ prompts: slots(), styles: slots() });
  assert.equal(profile.prompts[0]?.name, "Default");
  assert.equal(profile.prompts[1]?.name, "Slot 1");
  assert.equal(profile.styles[4]?.text, "t4");
});

test("validateProfile refuses what is not a profile", () => {
  /** @type {unknown[]} */
  const bad = [
    null,
    "x",
    [],
    {},
    { prompts: slots(4), styles: slots() },
    { prompts: slots(), styles: slots(6) },
    { prompts: slots(), styles: "no" },
    { prompts: [...slots(4), null], styles: slots() },
    { prompts: [...slots(4), { name: "x", text: 1 }], styles: slots() },
    { prompts: [...slots(4), { name: "   ", text: "" }], styles: slots() },
    { prompts: [...slots(4), { name: "y".repeat(41), text: "" }], styles: slots() },
    { prompts: [{ name: "Default", text: "z".repeat(200_001) }, ...slots(4)], styles: slots() },
  ];
  for (const value of bad) {
    assert.throws(
      () => validateProfile(value),
      (error) => /** @type {{ code?: string }} */ (error).code === "invalidInput",
      JSON.stringify(value)?.slice(0, 60),
    );
  }
});

import { describe, expect, it } from "vitest";
import { deleteLabel, outcomeText, summaryOf, type CleanOutcome, type DiskRow } from "./model";

const GB = 1024 ** 3;
const row = (working: number | null): DiskRow => ({
  videoId: "v",
  channelId: "c",
  channelName: "C",
  folderName: "F",
  archived: false,
  working,
  total: working,
  measuring: working === null,
  editedAt: null,
  cleanable: true,
  blocked: null,
  outcome: null,
});
const done = (gb: number, leftover = 0): CleanOutcome => ({
  ok: true,
  freedBytes: gb * GB,
  leftover,
});
const failed: CleanOutcome = { ok: false, message: "No." };

describe("deleteLabel", () => {
  it("is plain without a choice and names the count and sum with one", () => {
    expect(deleteLabel([])).toBe("Delete working files");
    expect(deleteLabel([row(2 * GB)])).toBe("Delete working files: 1 video, 2.0 GB");
    expect(deleteLabel([row(2 * GB), row(3 * GB), row(null)])).toBe(
      "Delete working files: 3 videos, 5.0 GB",
    );
  });
});

describe("summaryOf", () => {
  it("is a success when everything was freed", () => {
    expect(summaryOf([done(1), done(2)])).toEqual({
      tone: "success",
      text: "Freed 3.0 GB from 2 videos.",
    });
  });
  it("is a warning when some failed and danger when all failed", () => {
    expect(summaryOf([done(1), failed]).tone).toBe("warning");
    expect(summaryOf([failed]).tone).toBe("danger");
    expect(summaryOf([failed, failed]).text).toContain("No working files were deleted");
  });
});

describe("outcomeText", () => {
  it("shows the freed size, the leftover and the server's sentence", () => {
    expect(outcomeText(done(1))).toBe("Freed 1.0 GB.");
    expect(outcomeText(done(1, 2))).toBe("Freed 1.0 GB. 2 items could not be removed.");
    expect(outcomeText(failed)).toBe("No.");
  });
});

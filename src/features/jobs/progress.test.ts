import { describe, expect, it } from "vitest";
import type { JobView } from "@/lib/types";
import { waitingText } from "./progress";

const NOW = 1_700_000_000_000;

type Job = Pick<JobView, "queue" | "state" | "position" | "urgent" | "startsAt">;

function queued(rest: Partial<Job> = {}): Job {
  return {
    queue: "edits",
    state: "queued",
    position: 3,
    urgent: false,
    startsAt: null,
    ...rest,
  };
}

describe("waitingText", () => {
  it.each([
    ["the position", queued(), {}, "Waiting, position 3", null, null],
    ["no position yet", queued({ position: null }), {}, "Waiting", null, null],
    [
      "an urgent job",
      queued({ position: 1, urgent: true }),
      {},
      "Waiting, position 1",
      "Urgent",
      null,
    ],
    [
      "the start delay under a minute",
      queued({ startsAt: NOW + 40_000 }),
      {},
      "Waiting, position 3",
      null,
      "Starts in 40 s",
    ],
    [
      "the start delay in minutes",
      queued({ startsAt: NOW + 6 * 60_000 }),
      {},
      "Waiting, position 3",
      null,
      "Starts in 6 min",
    ],
    [
      "the start delay and the per-user limit together",
      queued({ startsAt: NOW + 6 * 60_000 }),
      { ownRunningEdits: 2, maxEditsPerUser: 2 },
      "Waiting, position 3",
      null,
      "Earliest start in 6 min",
    ],
    [
      "the per-user limit",
      queued(),
      { ownRunningEdits: 2, maxEditsPerUser: 2 },
      "Waiting, position 3",
      null,
      "You can edit 2 videos at a time. This one starts when another is done.",
    ],
    [
      "a limit of one",
      queued(),
      { ownRunningEdits: 1, maxEditsPerUser: 1 },
      "Waiting, position 3",
      null,
      "You can edit 1 video at a time. This one starts when another is done.",
    ],
    [
      "a start delay that is over",
      queued({ startsAt: NOW - 1000 }),
      {},
      "Waiting, position 3",
      null,
      null,
    ],
    [
      "room under the limit",
      queued(),
      { ownRunningEdits: 1, maxEditsPerUser: 2 },
      "Waiting, position 3",
      null,
      null,
    ],
    [
      "no limit",
      queued(),
      { ownRunningEdits: 9, maxEditsPerUser: 0 },
      "Waiting, position 3",
      null,
      null,
    ],
  ] as const)("says it for %s", (_name, job, context, headline, urgent, reason) => {
    expect(waitingText(job, { now: NOW, ...context })).toMatchObject({ headline, urgent, reason });
  });

  it("marks a job that waits for the limit, but only edits have the limit", () => {
    const context = { now: NOW, ownRunningEdits: 2, maxEditsPerUser: 2 };
    expect(waitingText(queued(), context)?.waitingForLimit).toBe(true);
    expect(waitingText(queued({ queue: "renders" }), context)?.waitingForLimit).toBe(false);
  });

  it("is null for a job that is not waiting", () => {
    for (const state of ["running", "paused", "failed", "completed"] as const) {
      expect(waitingText(queued({ state, position: null }), { now: NOW })).toBeNull();
    }
  });
});

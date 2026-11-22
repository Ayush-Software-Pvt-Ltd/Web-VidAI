import { describe, expect, it } from "vitest";
import { lineOrder, plan, queueOfKind, type Limits, type Waiting } from "./queue";

const job = (id: string, extra: Partial<Waiting> = {}): Waiting => ({
  id,
  userId: "u1",
  urgent: false,
  joinedAt: 1000,
  resume: false,
  startNow: false,
  ...extra,
});
const limits: Limits = { slots: 2, perUser: 0, startDelayMs: 0 };
const base = { queue: "edits" as const, running: [], lastLaunchAt: null, now: 10_000, limits };

describe("queueOfKind", () => {
  it("maps each kind to its queue", () => {
    expect(queueOfKind("edit")).toBe("edits");
    expect(queueOfKind("reEdit")).toBe("edits");
    expect(queueOfKind("timelineEdit")).toBe("timeline");
    expect(queueOfKind("render")).toBe("renders");
  });
});

describe("lineOrder", () => {
  it("puts Urgent first in the edits queue, then who joined first, then the id", () => {
    const waiting = [
      job("c", { joinedAt: 5 }),
      job("b", { joinedAt: 5 }),
      job("a", { joinedAt: 9, urgent: true }),
      job("d", { joinedAt: 1 }),
    ];
    expect(lineOrder("edits", waiting).map((j) => j.id)).toEqual(["a", "d", "b", "c"]);
  });

  it("ignores Urgent in the timeline and renders queues", () => {
    const waiting = [job("late", { joinedAt: 9, urgent: true }), job("early", { joinedAt: 1 })];
    for (const queue of ["timeline", "renders"] as const) {
      expect(lineOrder(queue, waiting).map((j) => j.id)).toEqual(["early", "late"]);
    }
  });
});

describe("plan", () => {
  it("starts as many jobs as there are free slots, in line order", () => {
    const result = plan({
      ...base,
      waiting: [job("a"), job("b", { joinedAt: 2000 }), job("c", { joinedAt: 3000 })],
      running: [{ userId: "x" }],
    });
    expect(result.start).toEqual(["a"]);
    expect([...result.positions]).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
  });

  it("starts nothing when every slot is taken", () => {
    const result = plan({
      ...base,
      waiting: [job("a")],
      running: [{ userId: "x" }, { userId: "y" }],
    });
    expect(result.start).toEqual([]);
    expect(result.startsAt.size).toBe(0);
  });

  it("skips a user at the per-user limit but keeps the position number", () => {
    const result = plan({
      ...base,
      limits: { ...limits, slots: 3, perUser: 1 },
      running: [{ userId: "u1" }],
      waiting: [job("a", { userId: "u1" }), job("b", { userId: "u2", joinedAt: 2000 })],
    });
    expect(result.start).toEqual(["b"]);
    expect(result.positions.get("a")).toBe(1);
    expect(result.positions.get("b")).toBe(2);
  });

  it("counts jobs started in the same pass against the per-user limit", () => {
    const result = plan({
      ...base,
      limits: { ...limits, slots: 5, perUser: 2 },
      waiting: [job("a"), job("b", { joinedAt: 2000 }), job("c", { joinedAt: 3000 })],
    });
    expect(result.start).toEqual(["a", "b"]);
  });

  it("holds the second edit back by the start delay and says when it starts", () => {
    const delayed = { ...limits, startDelayMs: 60_000 };
    const result = plan({
      ...base,
      limits: delayed,
      running: [{ userId: "x" }],
      lastLaunchAt: 9_000,
      waiting: [job("a"), job("b", { joinedAt: 2000 })],
    });
    expect(result.start).toEqual([]);
    expect(result.startsAt.get("a")).toBe(69_000);
    expect(result.startsAt.has("b")).toBe(false);
    expect(result.wakeAt).toBe(69_000);
  });

  it("starts one edit per delay: the first goes at once when nothing runs", () => {
    const delayed = { ...limits, startDelayMs: 60_000 };
    const result = plan({
      ...base,
      limits: delayed,
      lastLaunchAt: 9_000,
      waiting: [job("a"), job("b", { joinedAt: 2000 })],
    });
    expect(result.start).toEqual(["a"]);
    expect(result.startsAt.get("b")).toBe(70_000);
  });

  it("starts after the delay has passed", () => {
    const delayed = { ...limits, startDelayMs: 60_000 };
    const result = plan({
      ...base,
      limits: delayed,
      now: 70_000,
      running: [{ userId: "x" }],
      lastLaunchAt: 9_000,
      waiting: [job("a")],
    });
    expect(result.start).toEqual(["a"]);
  });

  it("lets a continued job and a Start now job skip the delay", () => {
    const delayed = { ...limits, slots: 4, startDelayMs: 60_000 };
    const result = plan({
      ...base,
      limits: delayed,
      running: [{ userId: "x" }],
      lastLaunchAt: 9_000,
      waiting: [
        job("a", { resume: true }),
        job("b", { joinedAt: 2000, startNow: true }),
        job("c", { joinedAt: 3000 }),
      ],
    });
    expect(result.start).toEqual(["a", "b"]);
    expect(result.startsAt.get("c")).toBe(70_000);
  });

  it("applies neither the delay nor the per-user limit to the timeline and renders queues", () => {
    for (const queue of ["timeline", "renders"] as const) {
      const result = plan({
        ...base,
        queue,
        limits: { slots: 3, perUser: 1, startDelayMs: 60_000 },
        running: [{ userId: "u1" }],
        lastLaunchAt: 9_000,
        waiting: [job("a"), job("b", { joinedAt: 2000 })],
      });
      expect(result.start).toEqual(["a", "b"]);
      expect(result.startsAt.size).toBe(0);
    }
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  emptyUsage,
  limitsFromRateLimitInfo,
  mergeLimits,
  parseRfc3339,
  parseUsage,
} from "../../src/agents/claude/usage.js";
import { control } from "../support/claudeControl.js";

/** @param {string} key @param {number} usedPercent @param {number | null} [resetsAt] */
const limit = (key, usedPercent, resetsAt = null) => ({
  key,
  label: key,
  usedPercent,
  resetsAt,
});

describe("parseRfc3339", () => {
  test("reads times with and without fractions and zones", () => {
    assert.equal(parseRfc3339("2026-11-14T06:20:00Z"), Date.UTC(2026, 10, 14, 6, 20, 0));
    assert.equal(parseRfc3339("2026-11-14T06:20:00.5Z"), Date.UTC(2026, 10, 14, 6, 20, 0, 500));
    assert.equal(
      parseRfc3339("2026-11-14T06:20:00.424305+00:00"),
      Date.UTC(2026, 10, 14, 6, 20, 0, 424),
    );
    assert.equal(parseRfc3339("2026-11-14T08:20:00+02:00"), Date.UTC(2026, 10, 14, 6, 20, 0));
    assert.equal(parseRfc3339(" 2026-11-14t06:20:00z "), Date.UTC(2026, 10, 14, 6, 20, 0));
  });

  test("rejects anything else", () => {
    for (const text of ["", "2026-11-14", "tomorrow", "2026-13-40T00:00:00Z", "06:20:00"]) {
      assert.equal(parseRfc3339(text), null, text);
    }
  });
});

describe("parseUsage", () => {
  test("maps the recorded get_usage answer", () => {
    const { available, limits } = parseUsage(control("get_usage.json"));
    assert.equal(available, true);
    assert.deepEqual(
      limits.map((l) => [l.key, l.usedPercent]),
      [
        ["fiveHour", 20],
        ["weekly", 33],
        ["weeklyFable", 11],
      ],
    );
    assert.deepEqual(
      limits.map((l) => l.label),
      ["5-hour limit", "Weekly limit", "Weekly limit (Fable)"],
    );
    assert.equal(limits[0]?.resetsAt, Date.UTC(2026, 10, 14, 6, 20, 0, 424));
    assert.equal(limits[1]?.resetsAt, Date.UTC(2026, 10, 19, 17, 0, 0, 424));
  });

  test("an unavailable plan has no limits", () => {
    assert.deepEqual(parseUsage(control("get_usage_unavailable.json")), {
      available: false,
      limits: [],
    });
  });

  test("garbage counts as unavailable", () => {
    for (const answer of [null, undefined, 7, "x", [], {}, { rate_limits_available: true }]) {
      assert.deepEqual(parseUsage(answer), { available: false, limits: [] });
    }
  });

  test("without the limits array the windows are used", () => {
    const answer = {
      rate_limits_available: true,
      rate_limits: {
        seven_day: { utilization: 40, resets_at: "2026-11-19T17:00:00Z" },
        five_hour: { utilization: 10.004, resets_at: null },
        seven_day_opus: { utilization: 5, resets_at: null },
        seven_day_sonnet: null,
        model_scoped: [{ display_name: "Claude Fable 5", utilization: 7, resets_at: null }],
      },
    };
    const { limits } = parseUsage(answer);
    assert.deepEqual(
      limits.map((l) => [l.key, l.usedPercent, l.resetsAt]),
      [
        ["fiveHour", 10, null],
        ["weekly", 40, Date.UTC(2026, 10, 19, 17, 0, 0)],
        ["weeklyOpus", 5, null],
        ["weeklyClaudeFable5", 7, null],
      ],
    );
  });

  test("the first entry per key wins, the limits array before the windows", () => {
    const answer = {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 99, resets_at: null },
        limits: [{ kind: "session", percent: 20, resets_at: null, scope: null }],
      },
    };
    assert.deepEqual(
      parseUsage(answer).limits.map((l) => [l.key, l.usedPercent]),
      [["fiveHour", 20]],
    );
  });

  test("ignores unknown kinds, unreadable numbers and unnamed scopes", () => {
    const answer = {
      rate_limits_available: true,
      rate_limits: {
        limits: [
          { kind: "mystery", percent: 50 },
          { kind: "session", percent: "lots" },
          { kind: "weekly_scoped", percent: 5, scope: { model: { display_name: "!!!" } } },
          { kind: "weekly_scoped", percent: 5, scope: { model: {} } },
          { kind: "weekly_all", percent: 42, resets_at: "not a time" },
          "text",
          null,
        ],
      },
    };
    assert.deepEqual(parseUsage(answer).limits, [
      { key: "weekly", label: "Weekly limit", usedPercent: 42, resetsAt: null },
    ]);
  });

  test("clamps to 0..100 and rounds to two decimals", () => {
    const answer = {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 140 },
        seven_day: { utilization: -3 },
        seven_day_opus: { utilization: 0.1 + 0.2 },
      },
    };
    assert.deepEqual(
      parseUsage(answer).limits.map((l) => [l.key, l.usedPercent]),
      [
        ["fiveHour", 100],
        ["weekly", 0],
        ["weeklyOpus", 0.3],
      ],
    );
  });

  test("a model name with spaces and symbols becomes an alphanumeric key", () => {
    const answer = {
      rate_limits_available: true,
      rate_limits: {
        model_scoped: [{ display_name: "  fable-5.2 (beta) ", utilization: 1 }],
      },
    };
    const [one] = parseUsage(answer).limits;
    assert.equal(one?.key, "weeklyFable52beta");
    assert.equal(one?.label, "Weekly limit (fable-5.2 (beta))");
  });
});

describe("limitsFromRateLimitInfo", () => {
  test("maps the recorded rate_limit_event", () => {
    const limits = limitsFromRateLimitInfo(control("rate_limit_event.json").rate_limit_info);
    assert.deepEqual(
      limits.map((l) => [l.key, l.usedPercent, l.resetsAt]),
      [
        ["fiveHour", 19, 1794637200 * 1000],
        ["weekly", 32, 1795107600 * 1000],
      ],
    );
  });

  test("a window without utilization is skipped, a missing reset is null", () => {
    const limits = limitsFromRateLimitInfo({
      unifiedWindows: { five_hour: { resetsAt: 5 }, seven_day: { utilization: 0.5 } },
    });
    assert.deepEqual(limits, [
      { key: "weekly", label: "Weekly limit", usedPercent: 50, resetsAt: null },
    ]);
  });

  test("an unknown shape gives nothing", () => {
    for (const info of [null, undefined, 3, {}, { unifiedWindows: [] }, { unifiedWindows: {} }]) {
      assert.deepEqual(limitsFromRateLimitInfo(info), []);
    }
  });
});

describe("mergeLimits", () => {
  test("replaces by key, keeps the rest and the order", () => {
    const current = [limit("fiveHour", 20), limit("weekly", 33), limit("weeklyFable", 11)];
    const { limits, changed } = mergeLimits(current, [limit("weekly", 32), limit("fiveHour", 19)]);
    assert.equal(changed, true);
    assert.deepEqual(
      limits.map((l) => [l.key, l.usedPercent]),
      [
        ["fiveHour", 19],
        ["weekly", 32],
        ["weeklyFable", 11],
      ],
    );
    assert.equal(current[0]?.usedPercent, 20, "the input is not changed");
  });

  test("the same values are not a change", () => {
    const current = [limit("fiveHour", 20, 5), limit("weekly", 33)];
    assert.equal(mergeLimits(current, [limit("fiveHour", 20, 5)]).changed, false);
    assert.equal(mergeLimits(current, []).changed, false);
  });

  test("adds a missing limit in canonical order", () => {
    const { limits, changed } = mergeLimits([limit("weeklyFable", 1)], [limit("fiveHour", 2)]);
    assert.equal(changed, true);
    assert.deepEqual(
      limits.map((l) => l.key),
      ["fiveHour", "weeklyFable"],
    );
  });
});

test("emptyUsage is unavailable and unfetched", () => {
  assert.deepEqual(emptyUsage(), { available: false, limits: [], fetchedAt: null, error: null });
});

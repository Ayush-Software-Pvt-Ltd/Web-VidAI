import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cpuBudget,
  cpuCoresEnv,
  gpuSlots,
  renderWorkers,
  renderWorkersAt,
} from "../../src/limits/budget.js";

const STEPS = Array.from({ length: 20 }, (_, i) => (i + 1) * 5);

/** The SPEC formula written out once more, with integer arithmetic. */
const share = (/** @type {number} */ n, /** @type {number} */ percent) =>
  Math.max(1, Math.floor((n * percent) / 100));

describe("cpuBudget", () => {
  for (const processors of [1, 4, 8, 16, 64]) {
    test(`a single job on ${processors} processors for every 5 percent step`, () => {
      for (const percent of STEPS) {
        const budget = cpuBudget({
          processors,
          perEditPercent: percent,
          totalPercent: 100,
          running: 1,
        });
        assert.equal(budget, share(processors, percent), `${processors} at ${percent}`);
      }
    });

    test(`the total is shared by the jobs on ${processors} processors`, () => {
      for (const percent of STEPS) {
        for (const running of [1, 2, 3, 5, 8, 100]) {
          const budget = cpuBudget({
            processors,
            perEditPercent: 100,
            totalPercent: percent,
            running,
          });
          const expected = Math.min(share(processors, 100), share(processors, percent) / running);
          assert.equal(budget, expected, `${processors} at ${percent} with ${running}`);
        }
      }
    });
  }

  test("the smaller of per edit and total divided by the jobs wins", () => {
    // 16 processors: perEdit 25% is 4, total 50% is 8.
    const at = (/** @type {number} */ running) =>
      cpuBudget({ processors: 16, perEditPercent: 25, totalPercent: 50, running });
    assert.equal(at(1), 4);
    assert.equal(at(2), 4);
    assert.equal(at(3), 8 / 3);
    assert.equal(at(8), 1);
  });

  test("edges: one processor, 5 percent, 100 percent, very many jobs", () => {
    assert.equal(cpuBudget({ processors: 1, perEditPercent: 5, totalPercent: 5, running: 1 }), 1);
    assert.equal(
      cpuBudget({ processors: 1, perEditPercent: 100, totalPercent: 100, running: 4 }),
      0.25,
    );
    assert.equal(cpuBudget({ processors: 64, perEditPercent: 5, totalPercent: 5, running: 1 }), 3);
    assert.equal(
      cpuBudget({ processors: 64, perEditPercent: 100, totalPercent: 100, running: 1 }),
      64,
    );
    assert.equal(
      cpuBudget({ processors: 8, perEditPercent: 100, totalPercent: 100, running: 1000 }),
      0.008,
    );
  });

  test("with no job running a first job's budget is given", () => {
    const input = { processors: 8, perEditPercent: 50, totalPercent: 100 };
    assert.equal(cpuBudget({ ...input, running: 0 }), cpuBudget({ ...input, running: 1 }));
  });

  test("products that are whole numbers in decimal are not rounded down", () => {
    // 3 * 70 / 100 is 2.0999999999999996 in floating point; 7 * 40 / 100 is 2.8000000000000003.
    assert.equal(
      cpuBudget({ processors: 3, perEditPercent: 70, totalPercent: 100, running: 1 }),
      2,
    );
    assert.equal(
      cpuBudget({ processors: 10, perEditPercent: 30, totalPercent: 100, running: 1 }),
      3,
    );
  });
});

describe("cpuCoresEnv", () => {
  test("rounds up and is at least 1", () => {
    assert.equal(cpuCoresEnv(0.008), 1);
    assert.equal(cpuCoresEnv(0.5), 1);
    assert.equal(cpuCoresEnv(1), 1);
    assert.equal(cpuCoresEnv(1.01), 2);
    assert.equal(cpuCoresEnv(8 / 3), 3);
    assert.equal(cpuCoresEnv(64), 64);
  });

  test("a division that did not come out even does not round up", () => {
    assert.equal(cpuCoresEnv(2.0000000000000004), 2);
    assert.equal(cpuCoresEnv(6 / 3), 2);
  });
});

describe("renderWorkers", () => {
  test("1 below a budget of 4, then the budget, at most 8", () => {
    /** @type {[number, number][]} */
    const table = [
      [0.25, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [3.99, 1],
      [4, 4],
      [4.5, 4],
      [5, 5],
      [7.9, 7],
      [8, 8],
      [16, 8],
      [64, 8],
    ];
    for (const [budget, workers] of table)
      assert.equal(renderWorkers(budget), workers, `${budget}`);
  });

  test("every budget the formula can give", () => {
    for (const processors of [1, 4, 8, 16, 64]) {
      for (const percent of STEPS) {
        for (const running of [1, 2, 3]) {
          const budget = cpuBudget({
            processors,
            perEditPercent: percent,
            totalPercent: percent,
            running,
          });
          const workers = renderWorkers(budget);
          assert.ok(workers >= 1 && workers <= 8);
          assert.ok(workers === 1 || (workers >= 4 && workers <= budget));
        }
      }
    }
  });
});

describe("gpuSlots", () => {
  test("the table for every 5 percent step", () => {
    /** @type {Record<number, number>} */
    const expected = {
      5: 1,
      10: 1,
      15: 1,
      20: 2,
      25: 2,
      30: 2,
      35: 3,
      40: 3,
      45: 4,
      50: 4,
      55: 4,
      60: 5,
      65: 5,
      70: 6,
      75: 6,
      80: 6,
      85: 7,
      90: 7,
      95: 8,
      100: 8,
    };
    for (const percent of STEPS) {
      assert.deepEqual(
        gpuSlots({ perEditPercent: 100, totalPercent: percent }),
        { total: expected[percent], perJob: expected[percent] },
        `total ${percent}`,
      );
      assert.equal(
        gpuSlots({ perEditPercent: percent, totalPercent: 100 }).perJob,
        expected[percent],
        `per edit ${percent}`,
      );
    }
  });

  test("per job never exceeds the total", () => {
    assert.deepEqual(gpuSlots({ perEditPercent: 100, totalPercent: 25 }), { total: 2, perJob: 2 });
    assert.deepEqual(gpuSlots({ perEditPercent: 50, totalPercent: 25 }), { total: 2, perJob: 2 });
    assert.deepEqual(gpuSlots({ perEditPercent: 15, totalPercent: 75 }), { total: 6, perJob: 1 });
  });

  test("at 5 percent everything runs one task at a time", () => {
    assert.deepEqual(gpuSlots({ perEditPercent: 5, totalPercent: 5 }), { total: 1, perJob: 1 });
  });
});

describe("renderWorkersAt", () => {
  test("at 1080 the budget's workers are kept", () => {
    for (const workers of [1, 4, 5, 8]) assert.equal(renderWorkersAt(workers, 1080), workers);
  });

  test("at 2160 at most 4, and never more than the budget gave", () => {
    /** @type {[number, number][]} */
    const table = [
      [1, 1],
      [4, 4],
      [5, 4],
      [8, 4],
    ];
    for (const [workers, capped] of table) assert.equal(renderWorkersAt(workers, 2160), capped);
  });

  test("the CPU limits of the admin still lower the workers at 2160", () => {
    // 16 processors at 50 percent per edit is a budget of 8; at 25 percent it is 4; at 20, 3.
    for (const [percent, workers] of /** @type {[number, number][]} */ ([
      [100, 4],
      [50, 4],
      [25, 4],
      [20, 1],
    ])) {
      const budget = cpuBudget({
        processors: 16,
        perEditPercent: percent,
        totalPercent: 100,
        running: 1,
      });
      assert.equal(renderWorkersAt(renderWorkers(budget), 2160), workers, `${percent}`);
    }
  });
});

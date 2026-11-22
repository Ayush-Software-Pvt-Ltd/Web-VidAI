import { afterEach, describe, expect, it } from "vitest";
import type { ScenarioName } from "../scenarios";
import type { UsageUpdate } from "../../types";
import { MockBackend } from "../backend";

const options = { latencyMs: 0, autoTick: false } as const;
const made: MockBackend[] = [];

function mock(scenarios: ScenarioName[] = ["default"], as?: "admin" | "user" | null) {
  const backend = new MockBackend({ ...options, scenarios, ...(as === undefined ? {} : { as }) });
  made.push(backend);
  return backend;
}

afterEach(() => {
  for (const backend of made.splice(0)) backend.dispose();
});

function updates(backend: MockBackend): UsageUpdate[] {
  const seen: UsageUpdate[] = [];
  backend.on.usageUpdated((update) => seen.push(update));
  return seen;
}

describe("mock usage", () => {
  it("is readable by every signed-in person and by nobody else", async () => {
    for (const as of ["admin", "user"] as const) {
      const view = await mock(["default"], as).getUsage();
      expect(view.claude.available).toBe(true);
      expect(view.claude.limits.map((l) => l.key)).toEqual(["fiveHour", "weekly", "weeklyOpus"]);
    }
    await expect(mock(["default"], null).getUsage()).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("carries the OpenCode Go quota only while the setup is OpenCode Go", async () => {
    const backend = mock();
    expect((await backend.getUsage()).opencode).toBeNull();
    backend.world.harness.setup = "opencodeGo";
    const view = await backend.getUsage();
    expect(view.opencode?.limits.map((l) => l.key)).toEqual(["fiveHour", "weekly", "monthly"]);
  });

  it("is critical in the scenario usage-critical", async () => {
    const view = await mock(["usage-critical"]).getUsage();
    expect(view.claude.limits.map((l) => l.usedPercent)).toEqual([93, 71, 64]);
  });

  it("refreshes on request and announces it with usage-updated", async () => {
    const backend = mock();
    const seen = updates(backend);
    const before = (await backend.getUsage()).claude.fetchedAt ?? 0;
    const view = await backend.getUsage({ refresh: true });
    expect(view.claude.fetchedAt).toBeGreaterThan(before);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.claude?.fetchedAt).toBe(view.claude.fetchedAt);
    expect(seen[0]?.opencode).toBeUndefined();
  });

  it("includes the OpenCode Go part of a refresh only on OpenCode Go", async () => {
    const backend = mock();
    backend.world.harness.setup = "opencodeGo";
    const seen = updates(backend);
    await backend.getUsage({ refresh: true });
    expect(seen[0]?.opencode?.limits).toHaveLength(3);
  });

  it("drifts on a tick while a job runs, and announces it", async () => {
    const backend = mock(["busy"]);
    const seen = updates(backend);
    const before = (await backend.getUsage()).claude.limits.map((l) => l.usedPercent);
    backend.tick();
    const after = (await backend.getUsage()).claude.limits.map((l) => l.usedPercent);
    after.forEach((value, i) => {
      expect(value).toBeGreaterThan(before[i] ?? 0);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.claude?.limits.map((l) => l.usedPercent)).toEqual(after);
  });

  it("drifts the 5-hour window faster than the others and never past 100", async () => {
    const backend = mock(["busy"]);
    const [five0, week0] = (await backend.getUsage()).claude.limits.map((l) => l.usedPercent);
    backend.tick();
    const [five1, week1] = (await backend.getUsage()).claude.limits.map((l) => l.usedPercent);
    expect((five1 ?? 0) - (five0 ?? 0)).toBeGreaterThan((week1 ?? 0) - (week0 ?? 0));

    const nearly = backend.world.usage.claude.limits[0];
    if (!nearly) throw new Error("seed limit missing");
    nearly.usedPercent = 99.99;
    backend.tick();
    expect((await backend.getUsage()).claude.limits[0]?.usedPercent).toBe(100);
  });

  it("stands still while nothing runs or the plan reports no limits", async () => {
    const idle = mock(["default"]);
    const seen = updates(idle);
    const before = await idle.getUsage();
    idle.tick();
    expect(await idle.getUsage()).toEqual(before);
    expect(seen).toEqual([]);

    const none = mock(["busy"]);
    none.world.usage.claude = { available: false, limits: [], fetchedAt: null, error: null };
    const seenNone = updates(none);
    none.tick();
    expect(seenNone).toEqual([]);
  });

  it("drifts the OpenCode Go quota too while it is the setup", async () => {
    const backend = mock(["busy"]);
    backend.world.harness.setup = "opencodeGo";
    const seen = updates(backend);
    const before = (await backend.getUsage()).opencode?.limits[0]?.usedPercent ?? 0;
    backend.tick();
    expect(seen.some((u) => u.opencode !== undefined)).toBe(true);
    expect((await backend.getUsage()).opencode?.limits[0]?.usedPercent).toBeGreaterThan(before);
  });
});

describe("mock getOpencodeUsage", () => {
  it("says why there is no quota while edits do not run on OpenCode Go", async () => {
    const view = await mock().getOpencodeUsage();
    expect(view.limits).toEqual([]);
    expect(view.unavailable).toBe("Edits do not run on OpenCode Go.");
  });

  it("answers the quota on OpenCode Go and announces a refresh", async () => {
    const backend = mock();
    backend.world.harness.setup = "opencodeGo";
    const seen = updates(backend);
    const before = (await backend.getOpencodeUsage()).fetchedAt ?? 0;
    const view = await backend.getOpencodeUsage({ refresh: true });
    expect(view.limits).toHaveLength(3);
    expect(view.fetchedAt).toBeGreaterThan(before);
    expect(seen).toEqual([{ opencode: view }]);
  });

  it("needs a signed-in person", async () => {
    await expect(mock(["default"], null).getOpencodeUsage()).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });
});

describe("mock readiness scenario not-ready", () => {
  it("tells an admin where to fix it and a user to ask", async () => {
    const admin = await mock(["not-ready"], "admin").getReadiness();
    const user = await mock(["not-ready"], "user").getReadiness();
    expect(admin.problem).toBe("claudeLoggedOut");
    expect(user.problem).toBe("claudeLoggedOut");
    expect(admin.message).toMatch(/Run claude once in a terminal/);
    expect(user.message).toMatch(/Ask an admin to fix it\.$/);
  });

  it("is ready in every other scenario", async () => {
    expect((await mock().getReadiness()).problem).toBeNull();
  });
});

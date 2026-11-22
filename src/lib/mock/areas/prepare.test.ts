import { afterEach, describe, expect, it } from "vitest";
import { MockBackend } from "../backend";
import type { ScenarioName } from "../scenarios";
import { prepareSim, STEPS } from "../seed/prepare";

const made: MockBackend[] = [];

function mock(scenarios: ScenarioName[] = ["default"], as?: "admin" | "user" | null) {
  const backend = new MockBackend({
    scenarios,
    latencyMs: 0,
    autoTick: false,
    ...(as === undefined ? {} : { as }),
  });
  made.push(backend);
  return backend;
}

afterEach(() => {
  for (const backend of made.splice(0)) backend.dispose();
});

const stepStates = (backend: MockBackend) =>
  Object.fromEntries(backend.world.system.prepare.steps.map((s) => [s.id, s.state]));

describe("mock system: adminGetSystem", () => {
  it("answers the server's facts with the live counts, for admins only", async () => {
    const backend = mock();
    const view = await backend.adminGetSystem();
    expect(view.programs.map((p) => p.id)).toEqual([
      "claude",
      "opencode",
      "hyperframes",
      "ffmpeg",
      "ffprobe",
      "python",
    ]);
    expect(view.programs.every((p) => p.found)).toBe(true);
    expect(view.prepare.editReady).toBe(true);
    expect(view.counts.users.total).toBe(backend.world.users.length);
    expect(view.counts.jobs.running).toBe(
      backend.world.jobs.filter((j) => j.view.state === "running").length,
    );
    await expect(mock(["default"], "user").adminGetSystem()).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(mock(["default"], null).adminPrepareToolkit()).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("shows programs missing and Prepare needed in system-problems", async () => {
    const view = await mock(["system-problems"]).adminGetSystem();
    expect(view.programs.filter((p) => !p.found).map((p) => p.id)).toEqual([
      "opencode",
      "ffmpeg",
      "ffprobe",
      "python",
    ]);
    expect(view.programs.find((p) => p.id === "ffmpeg")?.note).toContain("ffmpeg was not found");
    expect(view.prepare).toMatchObject({
      needsPrepare: true,
      editReady: false,
      reason: "The Python environment has not been created yet.",
    });
  });
});

describe("mock system: Prepare", () => {
  it("runs the eight steps one tick at a time and tells the admins on every change", async () => {
    const backend = mock(["system-problems"]);
    let changes = 0;
    backend.on.systemChanged(() => {
      changes += 1;
    });
    const started = await backend.adminPrepareToolkit();
    expect(started.running).toBe(true);
    expect(started.steps.map((s) => s.id)).toEqual(STEPS.map((s) => s.id));
    expect(started.steps[0]).toMatchObject({ id: "python", state: "running" });
    expect(started.log).toEqual(["== Python =="]);
    expect(changes).toBe(1);

    backend.tick();
    expect(stepStates(backend)).toMatchObject({ python: "done", venv: "running" });
    expect(backend.world.system.prepare.log.slice(-3)).toEqual([
      "== Python ==",
      "ok: Python 3.12 at /usr/bin/python3.12",
      "== Python environment ==",
    ]);

    for (let n = 0; n < 7; n += 1) backend.tick();
    const done = backend.world.system.prepare;
    expect(done.running).toBe(false);
    expect(done.steps.every((s) => s.state === "done")).toBe(true);
    expect(done).toMatchObject({
      needsPrepare: false,
      reason: null,
      editReady: true,
      renderReady: true,
    });
    expect(done.finishedAt).not.toBeNull();
    expect(changes).toBe(9);
  });

  it("clears the readiness problem when Prepare is done and tells everybody", async () => {
    const backend = mock(["system-problems"]);
    expect((await backend.getReadiness()).problem).toBe("notPrepared");
    const seen: (string | null | undefined)[] = [];
    backend.on.settingsChanged((payload) => seen.push(payload.harness?.setup));
    await backend.adminPrepareToolkit();
    for (let n = 0; n < 8; n += 1) backend.tick();
    expect((await backend.getReadiness()).problem).toBeNull();
    expect(seen).toEqual(["claudeSubscription"]);
  });

  it("joins a Prepare that runs instead of starting another", async () => {
    const backend = mock(["system-problems"]);
    await backend.adminPrepareToolkit();
    backend.tick();
    const again = await backend.adminPrepareToolkit();
    expect(again.steps[0]?.state).toBe("done");
    expect(again.steps[1]?.state).toBe("running");
  });

  it("fails a step with its sentence, marks the steps that need it as waiting and goes on", async () => {
    const backend = mock(["system-prepare-fails"]);
    await backend.adminPrepareToolkit();
    for (let n = 0; n < 8; n += 1) backend.tick();
    const state = backend.world.system.prepare;
    expect(state.running).toBe(false);
    expect(stepStates(backend)).toEqual({
      python: "done",
      venv: "done",
      packages: "failed",
      ffmpeg: "done",
      doctor: "pending",
      speech: "pending",
      browser: "done",
      render: "done",
    });
    expect(state.steps.find((s) => s.id === "packages")?.message).toContain(
      "Installing the Python packages failed. Is the internet reachable?",
    );
    expect(state.steps.find((s) => s.id === "doctor")?.message).toBe(
      'Waits for "Python packages".',
    );
    expect(state.log).toContain(
      "FAILED: Installing the Python packages failed. Is the internet reachable? pip said: Could not find a version that satisfies the requirement.",
    );
    expect(state).toMatchObject({
      needsPrepare: true,
      reason: "The Python packages are not installed yet.",
      editReady: false,
      renderReady: false,
    });
    expect((await backend.getReadiness()).problem).toBe("notPrepared");
  });

  it("holds back only rendering when a rendering step fails", async () => {
    const backend = mock(["system-problems"]);
    const sim = prepareSim(backend.world);
    sim.failStep = "browser";
    sim.failMessage = "The renderer browser could not be installed. Disk full.";
    await backend.adminPrepareToolkit();
    for (let n = 0; n < 8; n += 1) backend.tick();
    const state = backend.world.system.prepare;
    expect(state).toMatchObject({ editReady: true, renderReady: false, needsPrepare: false });
    expect(state.steps.find((s) => s.id === "render")?.message).toBe(
      'Waits for "Renderer browser".',
    );
    expect(state.steps.find((s) => s.id === "browser")?.message).toBe(
      "The renderer browser could not be installed. Disk full.",
    );
    expect((await backend.getReadiness()).problem).toBeNull();
  });

  it("refuses while the toolkit is not installed, with the server's sentence", async () => {
    const backend = mock();
    backend.world.system.toolkit.installError = "The data folder is read-only.";
    await expect(backend.adminPrepareToolkit()).rejects.toMatchObject({
      code: "notReady",
      message:
        "The toolkit is not installed, so it cannot be prepared. The data folder is read-only.",
    });
  });

  it("serves the steps through adminGetSystem while it runs", async () => {
    const backend = mock(["system-problems"]);
    await backend.adminPrepareToolkit();
    backend.tick();
    const view = await backend.adminGetSystem();
    expect(view.prepare.running).toBe(true);
    expect(view.prepare.steps.find((s) => s.state === "running")?.id).toBe("venv");
  });
});

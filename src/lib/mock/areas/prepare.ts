/**
 * The system area, the System page part: `adminGetSystem` (the server's facts with the live
 * counts) and `adminPrepareToolkit`, a tick-driven sequence over the eight Prepare steps
 * (`seed/prepare.ts`) as `server/src/toolkit/prepare.js` runs them:
 *
 * - starting answers at once with the state (the first step running); a Prepare that is already
 *   running is joined, not started again;
 * - every tick finishes the running step (`ok: ...` or `FAILED: ...` in the log) and starts the
 *   next one; a step whose needs are not done stays `pending` with `Waits for "<label>".`;
 * - every change sends `system-changed` to the admins; at the end `editReady` and `renderReady`
 *   are worked out and the readiness of the setup is set again (`settings-changed` when the
 *   problem changed);
 * - which step fails is a switch of the world (`prepareSim(world).failStep`).
 *
 * `forbidden` for non-admins; `notReady` while the toolkit could not be installed.
 */
import type { Api } from "../../api";
import type { PrepareState, PrepareStep, SystemView } from "../../types";
import type { MockCtx } from "../ctx";
import { holdsSlot } from "../queue";
import { syncHarness } from "../seed/harness";
import { DONE_MESSAGES, FAILED_MESSAGES, STEPS, prepareSim } from "../seed/prepare";

const LOG_LINES = 400;

export function prepareFunctions(
  ctx: MockCtx,
): Pick<Api, "adminGetSystem" | "adminPrepareToolkit"> {
  const { world } = ctx;
  const sim = prepareSim(world);
  /** Whether no step runs; a call, so the checks after `begin()` (which may set one) are not narrowed away. */
  const idle = (): boolean => sim.current === null;
  const prepare = () => world.system.prepare;

  const changed = () => {
    ctx.emit("system-changed", null, { admins: true });
  };

  const stepOf = (index: number): PrepareStep => {
    const found = prepare().steps[index];
    if (found === undefined) throw new Error(`No Prepare step at ${String(index)}`);
    return found;
  };

  const addLog = (line: string) => {
    const state = prepare();
    state.log.push(line);
    if (state.log.length > LOG_LINES) state.log.splice(0, state.log.length - LOG_LINES);
  };

  const view = (): SystemView => {
    const jobs = Object.fromEntries(
      Object.keys(world.system.counts.jobs).map((state) => [state, 0]),
    ) as SystemView["counts"]["jobs"];
    for (const job of world.jobs) jobs[job.view.state] += 1;
    return {
      ...world.system,
      counts: {
        users: {
          total: world.users.length,
          admins: world.users.filter((u) => u.role === "admin").length,
          disabled: world.users.filter((u) => u.disabled).length,
        },
        channels: world.channels.length,
        jobs,
      },
      cpu: { ...world.system.cpu, running: world.jobs.filter(holdsSlot).length },
    };
  };

  /** Starts the step at `index`, or marks it as waiting for a step that is not done. */
  const begin = (index: number): void => {
    const state = prepare();
    const def = STEPS[index];
    const step = stepOf(index);
    if (def === undefined) return;
    const waitingFor = def.needs.find(
      (need) => state.steps.find((s) => s.id === need)?.state !== "done",
    );
    if (waitingFor !== undefined) {
      const label = STEPS.find((s) => s.id === waitingFor)?.label ?? waitingFor;
      step.state = "pending";
      step.message = `Waits for "${label}".`;
      step.at = null;
      return;
    }
    step.state = "running";
    step.message = null;
    step.at = ctx.clock.now();
    addLog(`== ${def.label} ==`);
    sim.current = index;
  };

  /** Finishes Prepare: what is ready now, and what the readiness says about it. */
  const finish = (): void => {
    const state = prepare();
    const done = (blocks: "editing" | "rendering") =>
      state.steps.filter((s) => s.blocks === blocks).every((s) => s.state === "done");
    const stateOf = (id: string) => state.steps.find((s) => s.id === id)?.state;
    state.running = false;
    state.finishedAt = ctx.clock.now();
    sim.current = null;
    if (stateOf("venv") !== "done") {
      state.reason = "The Python environment has not been created yet.";
    } else if (stateOf("packages") !== "done") {
      state.reason = "The Python packages are not installed yet.";
    } else {
      state.reason = null;
    }
    state.needsPrepare = state.reason !== null;
    state.editReady = !state.needsPrepare && done("editing");
    state.renderReady = state.editReady && done("rendering");
    const before = world.readinessAdmin.problem;
    syncHarness(world);
    if (world.readinessAdmin.problem !== before) {
      const { setup, maxUploadGb, maxEditsPerUser, startDelayMinutes } = world.adminSettings;
      ctx.emit("settings-changed", {
        setup,
        maxUploadGb,
        maxEditsPerUser,
        startDelayMinutes,
        harness: { ...world.harnessPublic },
      });
    }
  };

  /** One tick of a running Prepare: the running step ends, the next one starts. */
  ctx.ticks.register("prepare", () => {
    if (!prepare().running || sim.current === null) return;
    const index = sim.current;
    const def = STEPS[index];
    const step = stepOf(index);
    if (def === undefined) return;
    const fails = sim.failStep === def.id;
    const message = fails ? (sim.failMessage ?? FAILED_MESSAGES[def.id]) : DONE_MESSAGES[def.id];
    addLog(`${fails ? "FAILED" : "ok"}: ${message.split("\n")[0] ?? message}`);
    step.state = fails ? "failed" : "done";
    step.message = message;
    step.at = ctx.clock.now();
    sim.current = null;
    // The next step that can start (the ones that wait are marked on the way).
    for (let next = index + 1; next < STEPS.length && idle(); next += 1) {
      begin(next);
    }
    if (idle()) finish();
    changed();
  });

  return {
    adminGetSystem: () =>
      ctx.run(() => {
        ctx.requireAdmin();
        return view();
      }),

    adminPrepareToolkit: () =>
      ctx.run((): PrepareState => {
        ctx.requireAdmin();
        const { installError } = world.system.toolkit;
        if (installError !== null) {
          throw ctx.errors.notReady(
            `The toolkit is not installed, so it cannot be prepared. ${installError}`,
          );
        }
        const state = prepare();
        if (state.running) return state;
        world.system.prepare = {
          ...state,
          running: true,
          steps: STEPS.map((def) => ({
            id: def.id,
            label: def.label,
            state: "pending" as const,
            message: null,
            at: null,
            blocks: def.blocks,
          })),
          log: [],
          startedAt: ctx.clock.now(),
          finishedAt: null,
          editReady: false,
          renderReady: false,
        };
        sim.current = null;
        for (let first = 0; first < STEPS.length && idle(); first += 1) begin(first);
        changed();
        return world.system.prepare;
      }),
  };
}

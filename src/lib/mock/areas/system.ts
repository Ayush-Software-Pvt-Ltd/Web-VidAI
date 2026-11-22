/**
 * The system area, the usage part: `getUsage` and `getOpencodeUsage` (the usage of the account
 * the SERVER runs on, shared by everybody and readable by every signed-in person), the usage
 * drift on a tick while jobs run, and `usage-updated` for every change. The OpenCode Go quota is
 * part of the view only while the setup is OpenCode Go, as on the server.
 *
 * Readiness (`getReadiness`) and the public harness (`getHarness`) live in the workspace area,
 * their world fields are filled by `seed/system.ts` for the scenario `not-ready`.
 *
 * `adminGetSystem` and `adminPrepareToolkit` (steps and `system-changed`) are `areas/prepare.ts`.
 */
import type { Api } from "../../api";
import type { OpencodeUsage, UsageLimit, UsageView } from "../../types";
import type { MockCtx } from "../ctx";
import { holdsSlot } from "../queue";
import { prepareFunctions } from "./prepare";

/** Why there is no OpenCode Go quota while edits run elsewhere (the server's own sentence). */
const NOT_SELECTED = "Edits do not run on OpenCode Go.";

/** Percent added per running job and tick: the 5-hour window moves faster than the others. */
const DRIFT_FIVE_HOUR = 0.05;
const DRIFT_OTHER = 0.01;

const round = (value: number) => Math.round(value * 100) / 100;

function drifted(limits: UsageLimit[], jobs: number): UsageLimit[] {
  return limits.map((limit) => ({
    ...limit,
    usedPercent: Math.min(
      100,
      round(limit.usedPercent + jobs * (limit.key === "fiveHour" ? DRIFT_FIVE_HOUR : DRIFT_OTHER)),
    ),
  }));
}

export function systemArea(ctx: MockCtx): Partial<Api> {
  const { world } = ctx;
  const onGo = () => world.harness.setup === "opencodeGo";

  const view = (): UsageView => ({
    claude: world.usage.claude,
    opencode: onGo() ? world.usage.opencode : null,
  });

  /** What the OpenCode Go quota answers: the quota, or the reason there is none. */
  const goUsage = (): OpencodeUsage =>
    view().opencode ?? { limits: [], unavailable: NOT_SELECTED, fetchedAt: null, error: null };

  // While a job runs the plan's usage grows a little on every tick.
  ctx.ticks.register("usage", (now) => {
    const running = world.jobs.filter(holdsSlot).length;
    if (running === 0) return;
    const { claude, opencode } = world.usage;
    if (claude.available) {
      world.usage = {
        ...world.usage,
        claude: { ...claude, limits: drifted(claude.limits, running), fetchedAt: now },
      };
      ctx.emit("usage-updated", { claude: world.usage.claude });
    }
    if (onGo() && opencode !== null && opencode.limits.length > 0) {
      const next = { ...opencode, limits: drifted(opencode.limits, running), fetchedAt: now };
      world.usage = { ...world.usage, opencode: next };
      ctx.emit("usage-updated", { opencode: next });
    }
  });

  return {
    // adminGetSystem and adminPrepareToolkit (the System page): `areas/prepare.ts`.
    ...prepareFunctions(ctx),
    getUsage: (input) =>
      ctx.run(() => {
        ctx.requireUser();
        if (input?.refresh) {
          const now = ctx.clock.now();
          const { claude, opencode } = world.usage;
          const next = {
            claude: { ...claude, fetchedAt: now },
            opencode: opencode && { ...opencode, fetchedAt: now },
          };
          world.usage = next;
          ctx.emit("usage-updated", {
            claude: next.claude,
            ...(onGo() && next.opencode ? { opencode: next.opencode } : {}),
          });
        }
        return view();
      }),
    getOpencodeUsage: (input) =>
      ctx.run(() => {
        ctx.requireUser();
        const { opencode } = world.usage;
        if (input?.refresh && onGo() && opencode) {
          const next = { ...opencode, fetchedAt: ctx.clock.now() };
          world.usage = { ...world.usage, opencode: next };
          ctx.emit("usage-updated", { opencode: next });
        }
        return goUsage();
      }),
  };
}
